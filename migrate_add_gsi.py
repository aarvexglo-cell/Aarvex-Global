#!/usr/bin/env python3
"""
Aarvex Global — GSI backfill migration (Phase 0, blocker #1)
============================================================

WHY
---
Every list-style read in the backend currently uses `_scan_by_pk_prefix()`,
which runs a FULL DynamoDB table Scan and filters client-side. Cost and
latency therefore scale with the SIZE OF THE WHOLE TABLE, not with how many
rows you actually want. At a few hundred users it's invisible; at scale the
Lambda times out and the bill explodes.

THE FIX
-------
Add one Global Secondary Index ("gsi1") and give every item two derived
attributes:

    pk = "FEEDLIKE#user-123#post-9"
          └──┬───┘ └───────┬───────┘
        gsi1pk="FEEDLIKE"  gsi1sk="user-123#post-9"

    Rule:  gsi1pk = first "#"-segment of pk
           gsi1sk = everything after the first "#"  (pk itself if no "#")

Any old prefix scan then becomes an indexed Query:

    _scan_by_pk_prefix("FEEDLIKE#user-123#")
      ->  Query(gsi1pk = "FEEDLIKE", begins_with(gsi1sk, "user-123#"))

This works for every prefix currently in use, because they all start at a
segment boundary:
    SHOP#          FEEDPOST#        STORY#            PAYOUT#
    REVIEW#        FOLLOW#          FEEDCOMMENT#      KYC#USER#
    PROFILE#USER#  NOTIFICATION#USER#   CATALOGUE#CATEGORY#   DEAL#SHOP#

HOW TO RUN  (order matters)
---------------------------
 1. Create the GSI FIRST (console or the CLI command printed by --show-cli).
    Wait until its status is ACTIVE — on a large table this can take a while.
 2. Deploy the application code. It is SAFE to deploy before/after: the new
    query helper automatically falls back to the old scan if the index is
    missing or an item has not been backfilled yet.
 3. Run this backfill:
        python migrate_add_gsi.py --dry-run      # inspect, writes nothing
        python migrate_add_gsi.py                # real run
        python migrate_add_gsi.py --verify       # confirm 0 items remain

SAFETY
------
* Idempotent — items that already carry correct gsi1pk/gsi1sk are skipped,
  so re-running is harmless and it can be resumed after an interruption.
* Only ever ADDS two attributes. It never deletes, moves or rewrites data.
* A ConditionExpression makes each write a no-op if another run already did it.
* --dry-run changes nothing.
"""

from __future__ import annotations

import argparse
import os
import sys
import time

try:
    import boto3
    from botocore.exceptions import ClientError
except ImportError:
    sys.exit("boto3 is required:  pip install boto3")

TABLE_NAME = (
    os.environ.get("DYNAMODB_TABLE_NAME")
    or os.environ.get("DYNAMODB_TABLE")
    or "aarvex-social-bot-state"
)
REGION = os.environ.get("AWS_REGION", "ap-southeast-1")
INDEX_NAME = "gsi1"
GSI_PK = "gsi1pk"
GSI_SK = "gsi1sk"


def gsi_keys(pk: str) -> tuple[str, str]:
    """Derive (gsi1pk, gsi1sk) from a primary key. Must stay byte-for-byte
    identical to `_gsi_keys()` in marketplace.py — if these two ever drift,
    reads silently miss rows."""
    if not pk:
        return "", ""
    head, sep, tail = pk.partition("#")
    return (head, tail) if sep else (pk, "")


CREATE_INDEX_CLI = f"""\
aws dynamodb update-table \\
  --region {REGION} \\
  --table-name {TABLE_NAME} \\
  --attribute-definitions \\
      AttributeName={GSI_PK},AttributeType=S \\
      AttributeName={GSI_SK},AttributeType=S \\
  --global-secondary-index-updates '[{{
    "Create": {{
      "IndexName": "{INDEX_NAME}",
      "KeySchema": [
        {{"AttributeName": "{GSI_PK}", "KeyType": "HASH"}},
        {{"AttributeName": "{GSI_SK}", "KeyType": "RANGE"}}
      ],
      "Projection": {{"ProjectionType": "ALL"}}
    }}
  }}]'

# Then watch until IndexStatus == ACTIVE:
aws dynamodb describe-table --region {REGION} --table-name {TABLE_NAME} \\
  --query "Table.GlobalSecondaryIndexes[?IndexName=='{INDEX_NAME}'].IndexStatus"
"""


def index_status(client) -> str | None:
    try:
        desc = client.describe_table(TableName=TABLE_NAME)["Table"]
    except ClientError as e:
        sys.exit(f"Could not describe table {TABLE_NAME}: {e}")
    for idx in desc.get("GlobalSecondaryIndexes", []) or []:
        if idx.get("IndexName") == INDEX_NAME:
            return idx.get("IndexStatus")
    return None


def scan_all(table):
    """Full scan — appropriate here precisely because this is the one-off job
    that makes future full scans unnecessary."""
    kwargs = {}
    while True:
        resp = table.scan(**kwargs)
        for item in resp.get("Items", []):
            yield item
        if "LastEvaluatedKey" not in resp:
            return
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]


def main() -> None:
    ap = argparse.ArgumentParser(description="Backfill gsi1pk/gsi1sk for the gsi1 index.")
    ap.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    ap.add_argument("--verify", action="store_true", help="count items still missing the keys")
    ap.add_argument("--show-cli", action="store_true", help="print the create-index CLI command and exit")
    ap.add_argument("--skip-index-check", action="store_true", help="backfill even if the index is not ACTIVE")
    args = ap.parse_args()

    if args.show_cli:
        print(CREATE_INDEX_CLI)
        return

    client = boto3.client("dynamodb", region_name=REGION)
    table = boto3.resource("dynamodb", region_name=REGION).Table(TABLE_NAME)

    print(f"Table  : {TABLE_NAME}   (region {REGION})")
    status = index_status(client)
    print(f"Index  : {INDEX_NAME} -> {status or 'NOT FOUND'}")

    if status != "ACTIVE" and not args.skip_index_check and not (args.dry_run or args.verify):
        print(
            f"\n'{INDEX_NAME}' is not ACTIVE yet. Create it first:\n\n{CREATE_INDEX_CLI}\n"
            "The app keeps working meanwhile — the query helper falls back to a scan.\n"
            "Backfilling before the index exists is allowed but pointless; use --skip-index-check to force."
        )
        return

    scanned = updated = skipped = failed = 0
    missing_after = 0
    started = time.time()

    for item in scan_all(table):
        scanned += 1
        pk = item.get("pk")
        if not isinstance(pk, str) or not pk:
            skipped += 1
            continue

        want_pk, want_sk = gsi_keys(pk)
        # DynamoDB rejects empty GSI key values. Items whose pk has no "#"
        # (counters/config — never prefix-queried) get an empty gsi1sk, so we
        # leave them out of the sparse index instead of erroring.
        if not want_pk or not want_sk:
            skipped += 1
            continue
        if item.get(GSI_PK) == want_pk and item.get(GSI_SK) == want_sk:
            skipped += 1
            continue

        if args.verify:
            missing_after += 1
            continue
        if args.dry_run:
            updated += 1
            if updated <= 10:
                print(f"  would set {pk!r} -> {GSI_PK}={want_pk!r}, {GSI_SK}={want_sk!r}")
            continue

        try:
            # attribute_not_exists() keeps this a no-op if a parallel/earlier
            # run already backfilled the row.
            table.update_item(
                Key={"pk": pk},
                UpdateExpression=f"SET {GSI_PK} = :p, {GSI_SK} = :s",
                ConditionExpression=f"attribute_not_exists({GSI_PK}) OR {GSI_PK} <> :p OR {GSI_SK} <> :s",
                ExpressionAttributeValues={":p": want_pk, ":s": want_sk},
            )
            updated += 1
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                skipped += 1
            else:
                failed += 1
                if failed <= 10:
                    print(f"  FAILED {pk!r}: {e}")

        if scanned % 500 == 0:
            print(f"  … {scanned} scanned, {updated} updated, {skipped} skipped")

    secs = time.time() - started
    print("\n── summary ──────────────────────────────")
    print(f"scanned : {scanned}")
    if args.verify:
        print(f"still missing keys : {missing_after}")
        print("RESULT  : " + ("OK — every item is indexed." if missing_after == 0
                              else f"{missing_after} item(s) still need a backfill run."))
    else:
        print(f"updated : {updated}{'  (dry run — nothing written)' if args.dry_run else ''}")
        print(f"skipped : {skipped}   (already correct / no pk)")
        print(f"failed  : {failed}")
    print(f"time    : {secs:.1f}s")

    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
