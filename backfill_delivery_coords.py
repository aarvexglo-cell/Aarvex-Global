#!/usr/bin/env python3
"""
Backfill missing pickup/destination coordinates on existing DELIVERY#ARN#
records so old orders (created before the address fixes) stop showing
"incomplete location data and cannot be claimed with a radius filter".

Run this in AWS CloudShell (it has boto3 + your credentials). It is a DRY RUN
by default — it only prints what it WOULD change. Add --apply to write.

    python3 backfill_delivery_coords.py            # dry run (safe, no writes)
    python3 backfill_delivery_coords.py --apply     # actually update records

Env overrides (optional):
    DYNAMODB_TABLE_NAME   (default: aarvex-social-bot-state)
    AWS_REGION            (default: ap-southeast-1)

What it fills, and from what (best-effort, only when currently 0/empty):
    dest_lat/dest_lng     <- geocode(delivery_pincode)   [importer drop]
    pickup_lat/pickup_lng <- geocode(pickup_city + India)[shop pickup]

Note: this only makes old orders CLAIMABLE using whatever location data the
record already has. It cannot recover the importer's exact picked address if
that was never stored. For a perfect fix, the importer can simply re-place the
order (new orders now capture the picked address correctly).
"""
import os
import sys
import time
import json
import urllib.parse
import urllib.request
from decimal import Decimal

import boto3

TABLE_NAME = os.environ.get("DYNAMODB_TABLE_NAME") or os.environ.get("DYNAMODB_TABLE", "aarvex-social-bot-state")
REGION = os.environ.get("AWS_REGION") or "ap-southeast-1"
APPLY = "--apply" in sys.argv

UA = {"User-Agent": "aarvex-backfill/1.0 (delivery coord backfill)"}


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def geocode(params):
    """Query Nominatim; return (lat, lng) or None. Rate-limited by caller."""
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {**params, "country": "India", "format": "json", "limit": "1"}
    )
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.load(r)
        if data:
            return float(data[0]["lat"]), float(data[0]["lon"])
    except Exception as e:
        print(f"    ! geocode failed for {params}: {e}")
    return None


def main():
    print(f"Table : {TABLE_NAME}   Region: {REGION}   Mode: {'APPLY' if APPLY else 'DRY RUN'}")
    table = boto3.resource("dynamodb", region_name=REGION).Table(TABLE_NAME)

    scanned = fixed = skipped = 0
    kwargs = {
        "FilterExpression": "begins_with(pk, :p)",
        "ExpressionAttributeValues": {":p": "DELIVERY#ARN#"},
    }
    while True:
        resp = table.scan(**kwargs)
        for it in resp.get("Items", []):
            scanned += 1
            arn = it.get("arn", it.get("pk", ""))
            dest_ok = _num(it.get("dest_lat")) and _num(it.get("dest_lng"))
            pick_ok = _num(it.get("pickup_lat")) and _num(it.get("pickup_lng"))
            if dest_ok and pick_ok:
                continue

            updates = {}
            new_dest = None
            if not dest_ok:
                pin = str(it.get("delivery_pincode", "") or "").strip()
                city = str(it.get("delivery_city", "") or "").strip()
                g = None
                if pin:
                    time.sleep(1.1)  # Nominatim politeness
                    g = geocode({"postalcode": pin})
                if not g and city:
                    time.sleep(1.1)
                    g = geocode({"city": city})
                if g:
                    new_dest = g
                    updates["dest_lat"], updates["dest_lng"] = Decimal(str(g[0])), Decimal(str(g[1]))
            else:
                new_dest = (_num(it.get("dest_lat")), _num(it.get("dest_lng")))

            if not pick_ok:
                city = str(it.get("pickup_city", "") or "").strip()
                g = None
                if city:
                    time.sleep(1.1)
                    g = geocode({"city": city})
                # No pickup location at all (common on seed/test orders): place a
                # synthetic shop ~6 km NE of the drop so the triangle is valid and
                # the order becomes claimable for testing. Replace with the real
                # shop location if/when it's known.
                if not g and new_dest:
                    g = (new_dest[0] + 0.05, new_dest[1] + 0.05)
                    print(f"    ~ {arn}: no pickup city — using synthetic shop near drop")
                if g:
                    updates["pickup_lat"], updates["pickup_lng"] = Decimal(str(g[0])), Decimal(str(g[1]))

            if not updates:
                skipped += 1
                print(f"  SKIP {arn} — no delivery_city/pincode to geocode either (dest_ok={bool(dest_ok)} pick_ok={bool(pick_ok)})")
                continue

            fixed += 1
            print(f"  FIX  {arn} -> {', '.join(k+'='+str(v) for k, v in updates.items())}")
            if APPLY:
                expr = "SET " + ", ".join(f"{k} = :{k}" for k in updates)
                vals = {f":{k}": v for k, v in updates.items()}
                table.update_item(Key={"pk": it["pk"]}, UpdateExpression=expr, ExpressionAttributeValues=vals)

        if "LastEvaluatedKey" in resp:
            kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
        else:
            break

    print(f"\nDone. scanned={scanned} fixed={fixed} skipped(no data)={skipped}  ({'WROTE changes' if APPLY else 'dry run — nothing written'})")
    if not APPLY and fixed:
        print("Re-run with --apply to write these changes.")


if __name__ == "__main__":
    main()
