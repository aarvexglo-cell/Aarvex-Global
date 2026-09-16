"""
Aarvex Global — Seller Marketplace, Portal, KYC, Reviews, Notifications.
Imported by advanced_features.py; routes wired in lambda_handler.py.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import shutil
import subprocess
import time
import traceback
import uuid
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import parse_qs, urlparse

import boto3
from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError

logger = logging.getLogger()

DYNAMODB_TABLE = os.environ.get("DYNAMODB_TABLE_NAME") or os.environ.get("DYNAMODB_TABLE", "aarvex-social-bot-state")
S3_BUCKET = os.environ.get("S3_BUCKET_FOR_INVOICES") or os.environ.get("S3_BUCKET_FOR_CATALOGUE_MEDIA") or "aarvex-invoices-prod"
CLOUDFRONT_BASE = os.environ.get("CLOUDFRONT_BASE_URL", "https://dskm35im55r5u.cloudfront.net")

# Secrets: env first, then Secrets Manager (never hard-code secret material).
try:
    from aws_secrets import ensure_env_from_sm, get_secret_env_or_sm
    ensure_env_from_sm([
        "GOOGLE_CLIENT_ID",
        "ADMIN_TOTP_SECRET",
        "RECAPTCHA_SECRET_KEY",
    ])
except ImportError:
    get_secret_env_or_sm = None  # type: ignore

GOOGLE_CLIENT_ID = (
    os.environ.get("GOOGLE_CLIENT_ID")
    or (get_secret_env_or_sm("GOOGLE_CLIENT_ID") if get_secret_env_or_sm else "")
    or ""
)
# Public OAuth client id is not a secret; keep as last-resort so portal login
# keeps working if env/SM is not wired yet. Never put AWS keys / Cashfree
# secrets / TOTP here.
if not GOOGLE_CLIENT_ID:
    GOOGLE_CLIENT_ID = "357965071326-2q1lss2e83ckuainhgrd0878p9i0oa3v.apps.googleusercontent.com"
    logger.warning(
        "[AUTH] GOOGLE_CLIENT_ID missing from env/SM — using public OAuth client fallback."
    )

ADMIN_TOTP_SECRET = (
    os.environ.get("ADMIN_TOTP_SECRET")
    or (get_secret_env_or_sm("ADMIN_TOTP_SECRET") if get_secret_env_or_sm else "")
    or ""
)
if not ADMIN_TOTP_SECRET:
    logger.critical(
        "[SECURITY] ADMIN_TOTP_SECRET is not set — admin endpoints will DENY ALL requests "
        "until this env var is configured. This is intentional (fail-closed)."
    )

_db = boto3.resource("dynamodb")
table = _db.Table(DYNAMODB_TABLE)
s3 = boto3.client("s3")

AADHAAR_RE = re.compile(r"^\d{12}$")
PAN_RE = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]$", re.I)
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
try:
    from platform_utils import (
        ARN_RE,
        IFSC_RE,
        arn_valid,
        calc_payment_breakdown,
        create_payout_entries,
        decrypt_bank_field,
        encrypt_bank_field,
        generate_arn,
        get_bank_details_for_payout,
        get_platform_settings,
        list_payouts,
        mark_lot_sold,
        mark_payout_paid,
        mask_bank_account,
        normalize_arn,
        reverse_product_reservation,
        verify_recaptcha,
    )
    PLATFORM_UTILS_OK = True
except ImportError:
    PLATFORM_UTILS_OK = False
    ARN_RE = re.compile(r"^(AX\d{6}\d{6}|ARN-\d{4}-\d{6})$", re.I)
    IFSC_RE = re.compile(r"^[A-Z]{4}0[A-Z0-9]{6}$", re.I)

    def verify_recaptcha(token: str) -> bool:
        return bool(token and str(token).strip())

try:
    import delivery as _delivery_mod
except Exception as _del_err:
    _delivery_mod = None
    logger.warning("[DELIVERY] module not loaded: %s", _del_err)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ttl(days: int) -> int:
    import time
    return int(time.time()) + days * 86400


def _decimal(value: Any, default: Decimal = Decimal("0")) -> Decimal:
    try:
        return Decimal(str(value).strip())
    except (InvalidOperation, AttributeError, TypeError):
        return default


def _json_num(value: Any) -> int | float:
    d = _decimal(value)
    return int(d) if d == d.to_integral_value() else float(d)


def _json_response(status: int, body: Any) -> dict:
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Admin-Session",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            # Without this, GET responses (e.g. /track, polled every 12s for
            # live delivery location) can get cached by the browser, a CDN,
            # or a mobile carrier's transparent proxy — the client then
            # silently keeps replaying the first response, so the map looks
            # frozen at one point even though the driver is actually moving
            # and the server has fresh coordinates on every request.
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
        },
        "body": json.dumps(body, default=str),
    }


def _event_body(event: dict) -> dict:
    body = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8")
    return json.loads(body or "{}")


# ── GSI-backed prefix reads ────────────────────────────────────────────
# Every item carries two derived attributes so prefix reads can use an index
# instead of scanning the whole table:
#     pk = "FEEDLIKE#user-123#post-9"
#           gsi1pk = "FEEDLIKE"   gsi1sk = "user-123#post-9"
# i.e. gsi1pk = first "#"-segment, gsi1sk = the rest. A prefix lookup then
# becomes Query(gsi1pk = <segment>, begins_with(gsi1sk, <remainder>)).
# See migrate_add_gsi.py — gsi_keys() there MUST match _gsi_keys() here.
_GSI_NAME = "gsi1"
_gsi_available: bool | None = None   # None = unknown, probed on first use


def _gsi_keys(pk: str) -> tuple[str, str]:
    if not pk:
        return "", ""
    head, sep, tail = pk.partition("#")
    return (head, tail) if sep else (pk, "")


def _with_gsi(item: dict) -> dict:
    """Stamp the index attributes onto an item before writing it. New rows are
    therefore queryable immediately, without waiting for a backfill."""
    pk = item.get("pk", "")
    if isinstance(pk, str) and pk:
        g_pk, g_sk = _gsi_keys(pk)
        # DynamoDB rejects an EMPTY STRING for a GSI key attribute. Items whose
        # pk has no "#" (counters/config — fetched by exact key, never by
        # prefix) would produce an empty gsi1sk, so we leave them OUT of the
        # sparse index instead of stamping empty keys (which errors the write).
        if g_pk and g_sk:
            item.setdefault("gsi1pk", g_pk)
            item.setdefault("gsi1sk", g_sk)
    return item


class _GsiTable:
    """Transparent proxy around the DynamoDB Table that stamps gsi1pk/gsi1sk
    onto every put_item. Doing it here rather than at ~40 individual call
    sites means new entity types are indexed automatically and nobody has to
    remember. Everything else passes straight through untouched."""

    def __init__(self, inner):
        self._inner = inner

    def put_item(self, **kwargs):
        if isinstance(kwargs.get("Item"), dict):
            kwargs["Item"] = _with_gsi(kwargs["Item"])
        return self._inner.put_item(**kwargs)

    def __getattr__(self, name):
        return getattr(self._inner, name)


# NOTE: update_item can also create a row (upsert). Those rows are picked up
# by migrate_add_gsi.py; the counter-style update_items in this file all target
# rows that put_item already created, so they inherit the keys.
table = _GsiTable(table)


def _scan_by_pk_prefix_raw(prefix: str) -> list[dict]:
    """The original full-table scan. Kept as the fallback path for when the
    index is absent (pre-migration) or an item has not been backfilled."""
    items = []
    kwargs = {"FilterExpression": Attr("pk").begins_with(prefix)}
    while True:
        resp = table.scan(**kwargs)
        items.extend(resp.get("Items", []))
        if "LastEvaluatedKey" not in resp:
            break
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    return items


def _scan_by_pk_prefix(prefix: str) -> list[dict]:
    """Prefix read. Uses the gsi1 index when it exists, otherwise transparently
    falls back to the old scan — so this is safe to deploy BEFORE the index is
    created and before the backfill has run."""
    global _gsi_available
    if _gsi_available is False:
        return _scan_by_pk_prefix_raw(prefix)

    g_pk, g_sk_prefix = _gsi_keys(prefix)
    if not g_pk:
        return _scan_by_pk_prefix_raw(prefix)

    cond = Key("gsi1pk").eq(g_pk)
    if g_sk_prefix:
        cond = cond & Key("gsi1sk").begins_with(g_sk_prefix)

    items: list[dict] = []
    kwargs: dict = {"IndexName": _GSI_NAME, "KeyConditionExpression": cond}
    try:
        while True:
            resp = table.query(**kwargs)
            items.extend(resp.get("Items", []))
            if "LastEvaluatedKey" not in resp:
                break
            kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
        _gsi_available = True
        return items
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        # Index not created yet (or not ACTIVE) — degrade to the scan and stop
        # retrying the query for the rest of this warm Lambda container.
        if code in ("ValidationException", "ResourceNotFoundException", "IndexNotFoundException"):
            _gsi_available = False
            logger.warning("[GSI] '%s' unavailable (%s) — falling back to table scan", _GSI_NAME, code)
            return _scan_by_pk_prefix_raw(prefix)
        raise


def _first_name(name: str) -> str:
    return (name or "Customer").strip().split()[0]


# ── Rate limiting (Phase 0, blocker #5) ────────────────────────────────
# Fixed-window per-user-per-action counter in DynamoDB. Without this a single
# account can flood the feed / stories / RFQs / disputes. Fail-OPEN: if the
# limiter itself errors we allow the request rather than block legitimate use.
def _rate_limited(user_sub: str, action: str, limit: int, window_seconds: int = 60, *, fail_closed: bool = False) -> bool:
    """Return True if this action should be BLOCKED (limit exceeded).

    fail_closed=True for sensitive writes (feed/chat/story/KYC/order) — if the
    limiter itself errors we BLOCK rather than allow floods.
    """
    if not user_sub:
        return False
    import time as _time
    now = int(_time.time())
    window = now // window_seconds
    pk = f"RATELIMIT#{user_sub}#{action}#{window}"
    try:
        resp = table.update_item(
            Key={"pk": pk},
            UpdateExpression="SET #c = if_not_exists(#c, :z) + :one, #t = :ttl, gsi1pk = :gp, gsi1sk = :gs",
            ExpressionAttributeNames={"#c": "count", "#t": "ttl"},
            ExpressionAttributeValues={
                ":z": 0, ":one": 1,
                ":ttl": now + window_seconds * 2,
                ":gp": "RATELIMIT", ":gs": f"{user_sub}#{action}#{window}",
            },
            ReturnValues="UPDATED_NEW",
        )
        count = int(_decimal(resp["Attributes"].get("count", 1)))
        return count > limit
    except Exception as e:
        logger.warning("[RATELIMIT] check failed for %s/%s: %s", user_sub, action, e)
        return bool(fail_closed)


def _rate_limit_response():
    return _json_response(429, {"error": "You're doing that too quickly — please wait a moment and try again."})


def _admin_session_token() -> str:
    try:
        from admin_session import legacy_hour_token
        return legacy_hour_token()
    except Exception:
        import hashlib
        import hmac
        seed = f"{ADMIN_TOTP_SECRET}:{datetime.utcnow().strftime('%Y%m%d%H')}"
        return hmac.new(seed.encode(), b"aarvex-admin", hashlib.sha256).hexdigest()


def _admin_authorized(event: dict) -> bool:
    if not ADMIN_TOTP_SECRET:
        logger.error("[SECURITY] Admin request denied — ADMIN_TOTP_SECRET not configured.")
        return False
    try:
        from admin_session import extract_admin_token, session_valid
        return session_valid(extract_admin_token(event))
    except Exception:
        import hashlib
        import hmac
        headers = event.get("headers") or {}
        token = (
            headers.get("X-Admin-Session")
            or headers.get("x-admin-session")
            or headers.get("Authorization", "").replace("Bearer ", "")
        )
        return bool(token and hmac.compare_digest(token, _admin_session_token()))


def admin_cc_apply_patch(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    patch_text = str(body.get("patch") or "").strip()
    if not patch_text:
        return _json_response(400, {"error": "patch text required"})
    if "diff --git" not in patch_text:
        return _json_response(400, {"error": "Patch text contains no valid diff sections"})

    try:
        from admin_patch_engine import PatchEngine
    except ImportError:
        return _json_response(500, {"error": "admin_patch_engine module missing"})

    engine = PatchEngine(
        repo_root=os.path.dirname(os.path.abspath(__file__)),
        table=table,
        s3_client=s3,
        s3_bucket=os.environ.get("FRONTEND_BUCKET") or os.environ.get("S3_FRONTEND_BUCKET") or "",
        cloudfront_id=os.environ.get("CLOUDFRONT_DISTRIBUTION") or os.environ.get("CLOUDFRONT_ID") or "",
        backend_lambda=os.environ.get("BACKEND_LAMBDA") or os.environ.get("LAMBDA_FUNCTION_NAME") or "",
        json_response=_json_response,
    )
    result = engine.apply(
        patch_text,
        dry_run=bool(body.get("dry_run")),
        auto_commit=False,  # AWS-only — no git commit
        commit_message=str(body.get("commit_message") or "Command Center AWS patch"),
        source=str(body.get("source") or "command-center"),
        admin=str(body.get("admin") or "admin"),
    )
    status = int(result.pop("status", 200 if result.get("success") else 500))
    return _json_response(status, result)


def admin_cc_patch_history(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    try:
        from admin_patch_engine import PatchEngine
    except ImportError:
        return _json_response(500, {"error": "admin_patch_engine module missing"})
    qs = event.get("queryStringParameters") or {}
    limit = int(qs.get("limit") or 25)
    engine = PatchEngine(
        repo_root=os.path.dirname(os.path.abspath(__file__)),
        table=table,
        s3_client=s3,
        s3_bucket=os.environ.get("FRONTEND_BUCKET") or os.environ.get("S3_FRONTEND_BUCKET") or "",
        cloudfront_id=os.environ.get("CLOUDFRONT_DISTRIBUTION") or os.environ.get("CLOUDFRONT_ID") or "",
        backend_lambda=os.environ.get("BACKEND_LAMBDA") or os.environ.get("LAMBDA_FUNCTION_NAME") or "",
    )
    return _json_response(200, engine.list_history(limit=limit))


def admin_cc_patch_rollback(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    history_id = str(body.get("history_id") or body.get("id") or "").strip()
    if not history_id:
        return _json_response(400, {"error": "history_id required"})
    try:
        from admin_patch_engine import PatchEngine
    except ImportError:
        return _json_response(500, {"error": "admin_patch_engine module missing"})
    engine = PatchEngine(
        repo_root=os.path.dirname(os.path.abspath(__file__)),
        table=table,
        s3_client=s3,
        s3_bucket=os.environ.get("FRONTEND_BUCKET") or os.environ.get("S3_FRONTEND_BUCKET") or "",
        cloudfront_id=os.environ.get("CLOUDFRONT_DISTRIBUTION") or os.environ.get("CLOUDFRONT_ID") or "",
        backend_lambda=os.environ.get("BACKEND_LAMBDA") or os.environ.get("LAMBDA_FUNCTION_NAME") or "",
    )
    result = engine.rollback(history_id)
    status = int(result.pop("status", 200 if result.get("success") else 500))
    return _json_response(status, result)


def admin_cc_explain_error(event: dict) -> dict:
    """Explain a telemetry row: stack → file:line + safe/unsafe triage + suggested AWS patch."""
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    message = str(body.get("message") or "")
    cause = str(body.get("cause") or "")
    stack = str(body.get("stack") or body.get("stacktrace") or "")
    feature = str(body.get("feature") or "")
    tab = str(body.get("tab") or "")
    blob = "\n".join([message, cause, stack, feature, tab])
    try:
        from admin_patch_engine import parse_stack_locations
        locations = parse_stack_locations(blob)
    except ImportError:
        locations = []

    unsafe_keys = ("payment", "cashfree", "razorpay", "otp", "auth", "password", "delete account", "invoice")
    lower = blob.lower()
    unsafe = any(k in lower for k in unsafe_keys)
    safe = not unsafe and bool(locations or message)

    explanation = []
    if locations:
        explanation.append(
            "Likely source: " + ", ".join(
                f"{x['file']}" + (f":{x['line']}" if x.get("line") else "") for x in locations[:4]
            )
        )
    else:
        explanation.append("No file:line found in stack — match by message keywords in Smart plan.")
    if unsafe:
        explanation.append("Triage: NEEDS HUMAN — payment/auth related. Do not auto-apply.")
    else:
        explanation.append("Triage: may be safe — Dry-run then Apply to AWS (S3).")
    if "popup" in lower or "window.open" in lower:
        explanation.append("Hint: browser blocked popup — prefer in-app sheet OAuth.")
    if "notif" in lower:
        explanation.append("Hint: open notifications sheet must call mpLoadNotifications().")
    if "insertbefore" in lower:
        explanation.append("Hint: guard DOM insertBefore with parent/reference checks.")

    suggested = _cc_suggest_patch(lower, feature, tab) if not unsafe else None
    if suggested:
        explanation.append(f"Suggested fix: {suggested.get('title')} → Apply to AWS after Dry-run.")

    return _json_response(200, {
        "success": True,
        "locations": locations,
        "safe": bool(safe and not unsafe and suggested),
        "needs_human": unsafe,
        "severity_guess": "critical" if unsafe else (body.get("severity") or "error"),
        "explanation": " ".join(explanation),
        "suggested_patch": (suggested or {}).get("patch") or "",
        "suggested_title": (suggested or {}).get("title") or "",
        "suggested_files": (suggested or {}).get("files") or [],
        "recommended_actions": (
            ["Mark needs-human", "Manual review", "Do not auto-apply"]
            if unsafe else
            (
                ["Dry-run suggested fix", "Apply to AWS (S3)", "Verify App Pulse"]
                if suggested else
                ["Generate plan", "Dry-run patch", "Apply after review"]
            )
        ),
    })


def _cc_suggest_patch(lower: str, feature: str = "", tab: str = "") -> dict | None:
    """Map common errors → ready AWS unified-diff patches."""
    recipes = [
        {
            "match": lambda t: "notif" in t or "notification" in t or "axnotif" in t,
            "title": "Notifications sheet load fix",
            "files": ["ax-social.js"],
            "patch": (
                "diff --git a/ax-social.js b/ax-social.js\n"
                "--- a/ax-social.js\n"
                "+++ b/ax-social.js\n"
                "@@\n"
                "   axNotifSheetDrag();\n"
                "+  if (typeof mpLoadNotifications === 'function') {\n"
                "+    try { mpLoadNotifications(); } catch (e) {}\n"
                "+  }\n"
            ),
        },
        {
            "match": lambda t: "cart" in t or "checkout" in t or ("btn-primary" in t and "white" in t),
            "title": "Cart Checkout dark ink on lime",
            "files": ["ax-ux-polish.css"],
            "patch": (
                "diff --git a/ax-ux-polish.css b/ax-ux-polish.css\n"
                "--- a/ax-ux-polish.css\n"
                "+++ b/ax-ux-polish.css\n"
                "@@\n"
                "+#axCartFoot .btn-primary,\n"
                "+html[data-theme=\"dark\"] #axCartFoot .btn-primary {\n"
                "+  background: var(--brand-lime, #D4ED6B) !important;\n"
                "+  color: var(--brand-lime-ink, #0A0A0A) !important;\n"
                "+}\n"
            ),
        },
        {
            "match": lambda t: "insertbefore" in t,
            "title": "Guard DOM insertBefore",
            "files": ["portal-order-flow.js"],
            "patch": (
                "diff --git a/portal-order-flow.js b/portal-order-flow.js\n"
                "--- a/portal-order-flow.js\n"
                "+++ b/portal-order-flow.js\n"
                "@@\n"
                "-    parent.insertBefore(newNode, referenceNode);\n"
                "+    if (parent && referenceNode && referenceNode.parentNode === parent) {\n"
                "+      parent.insertBefore(newNode, referenceNode);\n"
                "+    } else if (parent) {\n"
                "+      parent.appendChild(newNode);\n"
                "+    }\n"
            ),
        },
        {
            "match": lambda t: "failed to fetch" in t or "networkerror" in t or "net::err" in t or "503" in t,
            "title": "Telemetry flush retry",
            "files": ["ax-telemetry.js"],
            "patch": (
                "diff --git a/ax-telemetry.js b/ax-telemetry.js\n"
                "--- a/ax-telemetry.js\n"
                "+++ b/ax-telemetry.js\n"
                "@@\n"
                "+  function retryFlush() { setTimeout(flushCloud, 5000); }\n"
                "   fetch(base + '/telemetry/report', {\n"
                "     method: 'POST',\n"
                "     headers: headers,\n"
                "     body: JSON.stringify({ events: batch }),\n"
                "     keepalive: true\n"
                "   }).catch(function () {\n"
                "+    console.warn('Telemetry flush failed — retrying in 5s');\n"
                "+    retryFlush();\n"
            ),
        },
        {
            "match": lambda t: "menu" in t and ("active" in t or "accent" in t or "solid" in t),
            "title": "Menu accent ink (no solid fill)",
            "files": ["portal-menu.css"],
            "patch": (
                "diff --git a/portal-menu.css b/portal-menu.css\n"
                "--- a/portal-menu.css\n"
                "+++ b/portal-menu.css\n"
                "@@\n"
                "+.menu-tile.active,\n"
                "+.sidebar-nav-item.active {\n"
                "+  background: transparent !important;\n"
                "+  color: var(--accent) !important;\n"
                "+}\n"
            ),
        },
    ]
    blob = f"{lower} {feature} {tab}".lower()
    for r in recipes:
        try:
            if r["match"](blob):
                return {"title": r["title"], "files": r["files"], "patch": r["patch"]}
        except Exception:
            continue
    return None


def _get_bearer_token(event: dict) -> str:
    headers = event.get("headers") or {}
    auth = headers.get("Authorization") or headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return ""


def verify_google_token(token: str) -> dict | None:
    """Verify Google ID token via tokeninfo endpoint."""
    if not token:
        return None
    import urllib.parse
    import urllib.request
    import urllib.error
    try:
        url = f"https://oauth2.googleapis.com/tokeninfo?id_token={urllib.parse.quote(token)}"
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read())
        if data.get("aud") and data["aud"] != GOOGLE_CLIENT_ID:
            logger.warning("[AUTH] Token aud mismatch: %s", data.get("aud"))
        if data.get("email_verified") == "false":
            return None
        return {
            "sub": data.get("sub", ""),
            "email": data.get("email", ""),
            "name": data.get("name", ""),
            "picture": data.get("picture", ""),
        }
    except urllib.error.HTTPError as e:
        # Log Google's ACTUAL error + token shape so we can see WHY it's a 400:
        #   segments==3 → a JWT id-token (expected); segments==1 → an access token
        #   was sent by mistake (opaque, tokeninfo rejects it).
        try:
            gbody = e.read().decode("utf-8", "ignore")[:400]
        except Exception:
            gbody = ""
        tok = token or ""
        logger.error("[AUTH] Google tokeninfo HTTP %s | google_says=%s | tokenLen=%d segments=%d prefix=%s",
                     e.code, gbody, len(tok), tok.count(".") + 1, tok[:16])
        return None
    except Exception as e:
        logger.error("[AUTH] Google token verify failed: %s", e)
        return None


# ── Long-lived Aarvex session tokens ────────────────────────────────────────
# Google ID tokens expire in ~1 hour, and we used to send that short-lived token
# as the API bearer on every request — so an active user got kicked to a
# "Session expired → sign in again" prompt every hour. Fix: right after a Google
# login the client exchanges the Google ID token for a signed, 30-day Aarvex
# session token (issued here) and sends THAT as the bearer instead. The session
# token is HMAC-signed with a server-only secret (reuses ADMIN_TOTP_SECRET — no
# new env needed) and carries the resolved user claims, so verifying it needs no
# Google round-trip. The Google-token path stays fully working as a fallback.
_SESSION_SECRET = (
    os.environ.get("AX_SESSION_SECRET")
    or ADMIN_TOTP_SECRET
    or GOOGLE_CLIENT_ID
    or "aarvex-session-fallback"
)
_SESSION_TTL_DAYS = 30


def _sess_b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _sess_b64u_dec(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def issue_session_token(user: dict) -> str:
    import hashlib
    import hmac
    now = int(time.time())
    payload = {
        "sub": user.get("sub", ""),
        "email": user.get("email", ""),
        "name": user.get("name", ""),
        "picture": user.get("picture", ""),
        "provider": user.get("provider", "google"),
        "iat": now,
        "exp": now + _SESSION_TTL_DAYS * 86400,
    }
    body = _sess_b64u(json.dumps(payload, separators=(",", ":")).encode())
    sig = _sess_b64u(hmac.new(_SESSION_SECRET.encode(), body.encode(), hashlib.sha256).digest())
    return "axs1." + body + "." + sig


def verify_session_token(token: str) -> dict | None:
    import hashlib
    import hmac
    try:
        if not token or not token.startswith("axs1."):
            return None
        _, body, sig = token.split(".", 2)
        expected = _sess_b64u(hmac.new(_SESSION_SECRET.encode(), body.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected):
            return None
        claims = json.loads(_sess_b64u_dec(body))
        if int(claims.get("exp", 0)) < int(time.time()) or not claims.get("sub"):
            return None
        return {
            "sub": claims.get("sub", ""),
            "email": claims.get("email", ""),
            "name": claims.get("name", ""),
            "picture": claims.get("picture", ""),
            "provider": claims.get("provider", "google"),
        }
    except Exception as e:
        logger.warning("[AUTH] session token verify failed: %s", e)
        return None


def handle_auth_session(event: dict) -> dict:
    """Exchange the current valid auth (a fresh Google ID token, or an existing
    still-valid session token being rolled over) for a 30-day Aarvex session
    token, so the client no longer needs hourly Google re-auth."""
    user, err = _require_auth(event)
    if err:
        return err
    return _json_response(200, {
        "session_token": issue_session_token(user),
        "expires_days": _SESSION_TTL_DAYS,
    })


def handle_config_maps(event: dict) -> dict:
    """Public map-provider config for the client. The keys already live in the
    Lambda env (GOOGLE_MAPS_API_KEY / MAPPLS_API_KEY) but there was NO endpoint
    delivering them, so the client always fell back to the free public
    OSM/OSRM servers. This serves them so the keyed India-optimized Mappls (and
    Google) maps actually activate. These are client-side map keys by design —
    restrict them by HTTP referrer (CloudFront domain) in the provider console.
    No auth: the map keys are needed before/around sign-in (address picker)."""
    return _json_response(200, {
        "google_maps_key": os.environ.get("GOOGLE_MAPS_API_KEY", ""),
        "mappls_key": os.environ.get("MAPPLS_API_KEY", ""),
    })


def _semver_gt(a: str, b: str) -> bool:
    """True if version `a` is newer than `b` (dotted-numeric compare)."""
    def parts(v):
        out = []
        for p in str(v or "0").split("."):
            digits = "".join(ch for ch in p if ch.isdigit())
            out.append(int(digits) if digits else 0)
        return out
    pa, pb = parts(a), parts(b)
    n = max(len(pa), len(pb))
    pa += [0] * (n - len(pa))
    pb += [0] * (n - len(pb))
    return pa > pb


def handle_app_update(event: dict) -> dict:
    """Capgo self-hosted OTA endpoint. The app POSTs its current bundle version;
    we compare with the latest recorded at s3://FRONTEND_BUCKET/mobile/latest.json
    (written by the build/upload pipeline) and return {version, url, checksum}
    when a newer bundle exists, else up_to_date. The bundle is served over HTTPS
    from our own CloudFront; the checksum lets the device verify integrity before
    it applies the update."""
    body = {}
    try:
        body = _event_body(event) or {}
    except Exception:
        pass
    device_version = str(body.get("version") or "0.0.0")
    try:
        bucket = os.environ.get("FRONTEND_BUCKET") or ""
        if not bucket:
            return _json_response(200, {"kind": "up_to_date", "message": "No bundle configured"})
        s3 = boto3.client("s3")
        raw = s3.get_object(Bucket=bucket, Key="mobile/latest.json")["Body"].read()
        latest = json.loads(raw)
    except Exception as e:
        logger.warning("[APP_UPDATE] latest.json unavailable: %s", e)
        return _json_response(200, {"kind": "up_to_date", "message": "No new version available"})
    latest_version = str(latest.get("version") or "0.0.0")
    url = latest.get("url") or ""
    if url and _semver_gt(latest_version, device_version):
        return _json_response(200, {
            "version": latest_version,
            "url": url,
            "checksum": latest.get("checksum", ""),
            "kind": "update",
            "message": latest.get("message", "Update available"),
        })
    return _json_response(200, {"kind": "up_to_date", "message": "No new version available"})


def _auth_user(event: dict) -> dict | None:
    token = _get_bearer_token(event)
    if not token:
        logger.warning("[AUTH] No Bearer token in request")
        return None
    # Long-lived Aarvex session token (minted after a Google login) → no Google
    # round-trip and no hourly expiry. Falls through to Google verify otherwise.
    if token.startswith("axs1."):
        sess = verify_session_token(token)
        if sess and sess.get("sub"):
            return sess
        logger.warning("[AUTH] Session token invalid/expired")
        return None
    user = verify_google_token(token)
    if not user or not user.get("sub"):
        logger.warning("[AUTH] Token verification failed — invalid or expired token")
        return None
    logger.info(f"[AUTH] OK — sub={user.get('sub','')[:12]}... email={user.get('email','')}")
    body = {}
    try:
        body = _event_body(event)
    except Exception:
        pass
    if body.get("user_sub") and body["user_sub"].startswith("email_"):
        return {
            "sub": body["user_sub"],
            "email": body.get("user_email") or user.get("email", ""),
            "name": body.get("user_name") or user.get("name", ""),
            "picture": user.get("picture", ""),
            "provider": "email",
        }
    return user


def _require_auth(event: dict) -> tuple[dict | None, dict | None]:
    user = _auth_user(event)
    if not user:
        return None, _json_response(401, {"error": "Unauthorized — valid Google token required"})
    profile = get_profile(user["sub"])
    if profile.get("account_status") in ("blocked", "blacklisted"):
        return None, _json_response(403, {"error": "Account blocked"})
    return user, None


def get_profile(user_sub: str) -> dict:
    return table.get_item(Key={"pk": f"PROFILE#USER#{user_sub}"}).get("Item") or {}


def upsert_profile(user_sub: str, data: dict) -> None:
    item = get_profile(user_sub)
    item.update(data)
    item["pk"] = f"PROFILE#USER#{user_sub}"
    item["user_sub"] = user_sub
    item.setdefault("created_at", _now())
    item.setdefault("joined_at", item.get("created_at") or _now())
    item["updated_at"] = _now()
    # Sparse GSI for admin user lists (newest first): PROFILE / joined_at#sub
    joined = str(item.get("joined_at") or item.get("created_at") or _now())
    item["gsi1pk"] = "PROFILE"
    item["gsi1sk"] = f"{joined}#{user_sub}"
    table.put_item(Item=item)


def register_push_token(event: dict) -> dict:
    """M7: store the device's FCM push token on the user's profile so the
    backend can send order / OTP / delivery notifications to their phone(s).
    De-duplicated, bounded list of {token, platform, updated}."""
    user, err = _require_auth(event)
    if err:
        return err
    try:
        body = _event_body(event) or {}
    except Exception:
        body = {}
    token = (body.get("token") or "").strip()
    if not token:
        return _json_response(400, {"error": "token required"})
    platform = (str(body.get("platform") or "android"))[:16]
    prof = get_profile(user["sub"])
    toks = prof.get("fcm_tokens") or []
    if not isinstance(toks, list):
        toks = []
    toks = [t for t in toks if isinstance(t, dict) and t.get("token") != token]
    toks.insert(0, {"token": token, "platform": platform, "updated": _now()})
    toks = toks[:10]
    upsert_profile(user["sub"], {"fcm_tokens": toks})
    return _json_response(200, {"ok": True})


def notify_user_push(user_sub: str, title: str, body: str, data: dict = None) -> None:
    """M7: send an FCM push to all of a user's registered devices, then prune
    any tokens FCM reports as dead. No-op (logged) if push isn't configured."""
    try:
        prof = get_profile(user_sub)
        toks_meta = prof.get("fcm_tokens") or []
        tokens = [t.get("token") for t in toks_meta if isinstance(t, dict) and t.get("token")]
        if not tokens:
            return
        import fcm_push
        res = fcm_push.send_to_tokens(tokens, title, body, data)
        dead = set(res.get("dead") or [])
        if dead:
            kept = [t for t in toks_meta if isinstance(t, dict) and t.get("token") not in dead]
            upsert_profile(user_sub, {"fcm_tokens": kept})
    except Exception as e:
        logger.warning("[PUSH] notify_user_push failed: %s", e)


def register_portal_user(user: dict) -> None:
    existing = get_profile(user["sub"])
    if existing:
        upsert_profile(user["sub"], {
            "user_name": user.get("name") or existing.get("user_name", ""),
            "user_email": user.get("email") or existing.get("user_email", ""),
            "picture": user.get("picture") or existing.get("picture", ""),
            "last_login": _now(),
        })
        return
    upsert_profile(user["sub"], {
        "user_name": user.get("name", ""),
        "user_email": user.get("email", ""),
        "user_email_verified": True,
        "picture": user.get("picture", ""),
        "account_status": "active",
        "joined_at": _now(),
        "last_login": _now(),
        "saved_addresses": [],
    })


def get_kyc(user_sub: str) -> dict:
    return table.get_item(Key={"pk": f"KYC#USER#{user_sub}"}).get("Item") or {}


def get_delivery_partner_contact(user_sub: str) -> dict:
    """Public-safe name + phone for a delivery partner who has claimed an
    order — shown to the buyer on the live tracking map (call button),
    the way Zomato/Swiggy show the rider's number. Only ever call this
    for a delivery partner who has actually claimed the specific order;
    never expose this for an unrelated user_sub."""
    if not user_sub:
        return {}
    profile = get_profile(user_sub)
    kyc = get_kyc(user_sub)
    return {
        "name": profile.get("user_name") or kyc.get("user_name") or "Delivery Partner",
        "phone": profile.get("mobile") or profile.get("phone", ""),
        # sub + photo let the track/delivery strips open an in-app chat
        # (axOpenChat) and show a real DP avatar instead of a generic icon.
        "sub": user_sub,
        "photo": _profile_photo(profile),
        # Trust info shown on the importer's Track strip: star rating (from the
        # aggregate on the partner's KYC record) + vehicle number if they set
        # one on their profile.
        "rating": round(float(kyc.get("delivery_avg_rating", 0) or 0), 1),
        "rating_count": int(kyc.get("delivery_rating_count", 0) or 0),
        "vehicle": (profile.get("vehicle_number") or kyc.get("vehicle_number") or "").strip(),
    }


def list_approved_delivery_partners() -> list[dict]:
    """All KYC-approved delivery partners (role delivery_partner or both),
    excluding anyone auto-suspended for repeated order rejection. Used to
    broadcast newly-placed orders to the delivery partner pool."""
    out = []
    for item in _scan_by_pk_prefix("KYC#USER#"):
        if item.get("status") != "approved":
            continue
        if item.get("kyc_role") not in ("delivery_partner", "both"):
            continue
        if item.get("delivery_suspended"):
            continue
        user_sub = item.get("user_sub", "")
        if not user_sub:
            continue
        prof = get_profile(user_sub)
        out.append({
            "user_sub": user_sub,
            "name": prof.get("user_name") or item.get("user_name") or "Delivery Partner",
            "phone": prof.get("mobile") or prof.get("phone", ""),
        })
    return out


def suspend_delivery_partner(user_sub: str, reason: str = "Repeated order rejection") -> None:
    """Auto-suspend a delivery partner's ability to receive/claim delivery
    orders (fraud-prevention: too many consecutive rejects). Their KYC
    record is kept for admin review — only the delivery capability is
    switched off, not the whole account."""
    if not user_sub:
        return
    table.update_item(
        Key={"pk": f"KYC#USER#{user_sub}"},
        UpdateExpression="SET delivery_suspended = :t, delivery_suspended_reason = :r, delivery_suspended_at = :d",
        ExpressionAttributeValues={":t": True, ":r": reason, ":d": _now()},
    )
    try:
        create_notification(
            user_sub, "kyc_update", "Delivery access suspended",
            f"Your delivery partner access has been suspended: {reason}. Contact support if you believe this is a mistake.",
        )
    except Exception as e:
        logger.warning("[DELIVERY] suspend notification failed: %s", e)


def get_shop(shop_id: str) -> dict:
    return table.get_item(Key={"pk": f"SHOP#{shop_id}"}).get("Item") or {}


def get_shop_by_user(user_sub: str) -> dict:
    kyc = get_kyc(user_sub)
    shop_id = kyc.get("shop_id", "")
    if shop_id:
        return get_shop(shop_id)
    for item in _scan_by_pk_prefix("SHOP#"):
        if item.get("user_sub") == user_sub:
            return item
    return {}


def _next_shop_id() -> str:
    try:
        resp = table.update_item(
            Key={"pk": "SHOP_SEQ#COUNTER"},
            UpdateExpression="SET seq = if_not_exists(seq, :zero) + :inc",
            ExpressionAttributeValues={":inc": 1, ":zero": 0},
            ReturnValues="UPDATED_NEW",
        )
        seq = int(resp["Attributes"]["seq"])
    except ClientError:
        seq = int(uuid.uuid4().int % 90000) + 10000
    return f"SHOP-AX-{seq:05d}"


def _optimize_image(raw: bytes, ext: str) -> tuple[bytes, str]:
    """Downscale + recompress an uploaded image (Phase 0, blocker #4).

    Products/feeds/stories previously stored the seller's raw camera photo
    (often several MB) and served it at full size to every viewer — slow on
    mobile and expensive on bandwidth. This caps the long edge at 1600px and
    re-encodes at a sensible quality.

    Pillow isn't in the base Lambda runtime, so this is a NO-OP until a Pillow
    layer is attached — it never raises, it just returns the original bytes.
    Animated GIFs and non-images pass straight through.
    """
    if ext in ("gif", "webm", "mp4"):
        return raw, ext
    try:
        import io
        from PIL import Image  # type: ignore
    except Exception:
        return raw, ext  # Pillow not installed yet — ship the original
    try:
        img = Image.open(io.BytesIO(raw))
        img = img.convert("RGB") if img.mode in ("RGBA", "P", "LA") else img
        max_edge = 1600
        if max(img.size) > max_edge:
            ratio = max_edge / float(max(img.size))
            img = img.resize((int(img.size[0] * ratio), int(img.size[1] * ratio)), Image.LANCZOS)
        out = io.BytesIO()
        img.save(out, format="JPEG", quality=82, optimize=True, progressive=True)
        data = out.getvalue()
        # Keep whichever is smaller — never make a file bigger.
        return (data, "jpg") if len(data) < len(raw) else (raw, ext)
    except Exception as e:
        logger.warning("[S3] image optimize skipped: %s", e)
        return raw, ext


_ALLOWED_UPLOAD_EXT = {"jpg", "jpeg", "png", "webp", "gif", "mp4", "webm"}
_MAX_UPLOAD_BYTES = 6 * 1024 * 1024  # 6MB decoded


def _upload_b64_to_s3(b64_data: str, key_prefix: str, filename: str) -> str:
    if not b64_data:
        return ""
    # Reject pathological payloads before decode (base64 ~4/3 raw)
    if len(b64_data) > int(_MAX_UPLOAD_BYTES * 1.4) + 128:
        logger.warning("[S3] upload rejected — payload too large")
        return ""
    ext = "jpg"
    data = b64_data
    if "," in b64_data:
        header, data = b64_data.split(",", 1)
        header_l = header.lower()
        for candidate in ("png", "gif", "webp", "webm", "mp4", "jpeg", "jpg"):
            if candidate in header_l:
                ext = candidate
                break
        # MIME allowlist from data-URL header when present
        if "image/" not in header_l and "video/" not in header_l and "base64" in header_l:
            # bare ;base64 without type — keep sniff after decode
            pass
        elif "image/" in header_l or "video/" in header_l:
            ok_mime = any(x in header_l for x in (
                "image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif",
                "video/mp4", "video/webm",
            ))
            if not ok_mime:
                logger.warning("[S3] upload rejected — MIME not allowed: %s", header[:80])
                return ""
    try:
        raw = base64.b64decode(data, validate=False)
        if len(raw) > _MAX_UPLOAD_BYTES:
            logger.warning("[S3] upload rejected — decoded size %s", len(raw))
            return ""
        # Magic-byte sniff (reject executables disguised as images)
        if raw.startswith(b"MZ") or raw.startswith(b"\x7fELF") or raw[:4] == b"%PDF":
            logger.warning("[S3] upload rejected — executable/pdf magic")
            return ""
        if raw.startswith(b"\x89PNG"):
            ext = "png"
        elif raw.startswith(b"\xff\xd8\xff"):
            ext = "jpg"
        elif raw.startswith(b"GIF8"):
            ext = "gif"
        elif raw.startswith(b"RIFF") and b"WEBP" in raw[:16]:
            ext = "webp"
        elif len(raw) > 8 and raw[4:8] == b"ftyp":
            ext = "mp4"
        if ext == "jpeg":
            ext = "jpg"
        if ext not in _ALLOWED_UPLOAD_EXT:
            logger.warning("[S3] upload rejected — ext %s", ext)
            return ""
        # Optimize images before storing (no-op without a Pillow layer).
        raw, ext = _optimize_image(raw, "jpg" if ext == "jpeg" else ext)
        # Strip EXIF by re-encode path inside _optimize_image when Pillow present
        key = f"{key_prefix}/{filename}.{ext}"
        content_types = {
            "png": "image/png", "gif": "image/gif", "webp": "image/webp",
            "webm": "video/webm", "mp4": "video/mp4", "jpeg": "image/jpeg", "jpg": "image/jpeg",
        }
        ct = content_types.get(ext, "application/octet-stream")
        s3.put_object(Bucket=S3_BUCKET, Key=key, Body=raw, ContentType=ct, CacheControl="public, max-age=31536000, immutable")
        return key
    except Exception as e:
        logger.error("[S3] Upload failed %s: %s", key_prefix, e)
        return ""


def _presigned_get(key: str, expires: int = 3600) -> str:
    if not key:
        return ""
    try:
        return s3.generate_presigned_url("get_object", Params={"Bucket": S3_BUCKET, "Key": key}, ExpiresIn=expires)
    except Exception:
        return ""


def _public_s3_url(key: str) -> str:
    if not key:
        return ""
    if key.startswith("http"):
        return key
    # Use CloudFront CDN URL instead of direct S3 URL (S3 bucket has public access blocked)
    base = CLOUDFRONT_BASE.rstrip("/")
    return f"{base}/{key}"


def create_notification(user_sub: str, ntype: str, title: str, body: str, **extra: Any) -> str:
    nid = str(uuid.uuid4())
    item = {
        "pk": f"NOTIFICATION#USER#{user_sub}#{nid}",
        "user_sub": user_sub,
        "notification_id": nid,
        "type": ntype,
        "title": title,
        "body": body,
        "is_read": False,
        "created_at": _now(),
        "ttl": _ttl(90),
    }
    item.update(extra)
    table.put_item(Item=item)
    # Fan out to SMS / email if a provider is configured (Phase 2). Safe no-op
    # otherwise, and never allowed to break the in-app notification write.
    try:
        _dispatch_external_notification(user_sub, ntype, title, body)
    except Exception as e:
        logger.warning("[NOTIFY] external dispatch failed: %s", e)
    # M7: also push to the user's phone(s) via FCM. Safe no-op if not configured
    # or the user has no app tokens; never breaks the in-app notification write.
    try:
        _push_data = {"type": ntype}
        if extra.get("arn"):
            _push_data["arn"] = str(extra["arn"])
        notify_user_push(user_sub, title, body, _push_data)
    except Exception as e:
        logger.warning("[NOTIFY] push dispatch failed: %s", e)
    return nid


# ── SMS / Email fan-out (Phase 2) ──────────────────────────────────────
# In-app notifications are the source of truth; these ALSO push urgent updates
# out over SMS / email. Providers are pluggable via env vars and the whole
# thing is a NO-OP until they're set, so nothing breaks before you provision:
#   SMS:   SMS_PROVIDER=twilio  TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM
#   Email: EMAIL_PROVIDER=ses   SES_FROM_EMAIL   (uses this Lambda's IAM role)
# Only a short list of high-value notification types are pushed externally so
# buyers/sellers aren't spammed for every feed like.
_EXTERNAL_NTYPES = {"order", "kyc_update", "shop_status", "delivery_assigned",
                    "delivery_rating", "dispute", "rfq", "price_alert", "cod_invoice",
                    "low_stock"}


def _dispatch_external_notification(user_sub: str, ntype: str, title: str, body: str) -> None:
    if ntype not in _EXTERNAL_NTYPES:
        return
    sms_provider = os.environ.get("SMS_PROVIDER", "").lower()
    email_provider = os.environ.get("EMAIL_PROVIDER", "").lower()
    if not sms_provider and not email_provider:
        return  # nothing configured yet — no-op
    prof = get_profile(user_sub) or {}
    msg = f"{title}: {body}"[:300]
    if sms_provider == "twilio":
        _send_sms_twilio(prof.get("mobile") or prof.get("phone", ""), msg)
    if email_provider == "ses":
        _send_email_ses(prof.get("user_email") or prof.get("email", ""), title, body)


def _send_sms_twilio(to_number: str, message: str) -> None:
    to_number = re.sub(r"[^\d+]", "", to_number or "")
    if not to_number:
        return
    if len(to_number) == 10:
        to_number = "+91" + to_number
    sid = os.environ.get("TWILIO_ACCOUNT_SID", "")
    token = os.environ.get("TWILIO_AUTH_TOKEN", "")
    frm = os.environ.get("TWILIO_FROM", "")
    if not (sid and token and frm):
        return
    try:
        import urllib.request
        import urllib.parse
        data = urllib.parse.urlencode({"To": to_number, "From": frm, "Body": message}).encode()
        req = urllib.request.Request(
            f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
            data=data, method="POST")
        auth = base64.b64encode(f"{sid}:{token}".encode()).decode()
        req.add_header("Authorization", "Basic " + auth)
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:
        logger.warning("[SMS] Twilio send failed: %s", e)


def _send_email_ses(to_email: str, subject: str, body: str) -> None:
    if not to_email or "@" not in to_email:
        return
    sender = os.environ.get("SES_FROM_EMAIL", "")
    if not sender:
        return
    try:
        ses = boto3.client("ses")
        ses.send_email(
            Source=sender,
            Destination={"ToAddresses": [to_email]},
            Message={"Subject": {"Data": subject[:120]},
                     "Body": {"Text": {"Data": body[:2000]}}},
        )
    except Exception as e:
        logger.warning("[EMAIL] SES send failed: %s", e)


def notify_seller_lead(product: dict, buyer_name: str, order_type: str, qty: Any) -> None:
    seller_sub = product.get("seller_user_sub") or product.get("shop_owner_sub")
    if not seller_sub:
        shop_id = product.get("shop_id", "")
        shop = get_shop(shop_id) if shop_id else {}
        seller_sub = shop.get("user_sub", "")
    if not seller_sub:
        return
    pname = product.get("product_name", "Product")
    create_notification(
        seller_sub,
        "new_lead",
        f"New lead on {pname}",
        f"Someone is interested in your {pname} — Qty: {qty} kg ({order_type})",
    )


def _shop_status_ok(shop_id: str) -> bool:
    if not shop_id:
        return True
    shop = get_shop(shop_id)
    return shop.get("status", "active") == "active"


def filter_catalogue_item(item: dict) -> bool:
    if not item.get("is_active", True):
        return False
    if item.get("lot_status") in ("sold", "sold_out", "reserved"):
        return False
    if item.get("is_paused"):
        return False
    shop_id = item.get("shop_id", "")
    if shop_id and not _shop_status_ok(shop_id):
        return False
    if item.get("is_seller_product"):
        owner = item.get("seller_user_sub", "")
        if owner:
            prof = get_profile(owner)
            if prof.get("account_status") in ("blocked", "frozen"):
                return False
    return True


def serialize_product(item: dict, include_paused: bool = False) -> dict | None:
    if not include_paused and not filter_catalogue_item(item):
        if not (include_paused and item.get("is_active", True)):
            return None
    is_paused = bool(item.get("is_paused"))
    shop_id = item.get("shop_id", "")
    shop_blocked = shop_id and not _shop_status_ok(shop_id)
    lot_size = _decimal(item.get("lot_size_kg", 0))
    price_kg = _decimal(item.get("price_per_kg", 0))
    lot_price = _decimal(item.get("lot_price", 0))
    if lot_size > 0 and lot_price <= 0 and price_kg > 0:
        lot_price = lot_size * price_kg
    # ── MRP / discount (optional, fully backward-compatible) ──
    # Sellers may optionally set an "original" comparison price per kg.
    # discount_percent is 0 (and mrp fields are None) whenever no MRP is
    # set or the MRP isn't actually higher than the selling price — the
    # frontend hides the discount badge entirely in that case rather than
    # showing "0% OFF".
    mrp_kg = _decimal(item.get("mrp_price_per_kg", 0))
    discount_percent = 0
    mrp_lot_price = None
    if mrp_kg > 0 and price_kg > 0 and mrp_kg > price_kg:
        discount_percent = int(((mrp_kg - price_kg) / mrp_kg * 100).to_integral_value())
        if lot_size > 0:
            mrp_lot_price = lot_size * mrp_kg
    else:
        mrp_kg = Decimal("0")
    # available_stock_kg tracks REMAINING stock (starts == lot_size_kg at
    # creation, decremented atomically on every confirmed order). Older
    # listings created before this field existed fall back to lot_size.
    stock_kg = item.get("available_stock_kg")
    stock_kg = lot_size if stock_kg is None else _decimal(stock_kg)
    committed_kg = _decimal(item.get("committed_kg", 0))
    initial_kg = item.get("initial_stock_kg")
    initial_kg = stock_kg if initial_kg is None else _decimal(initial_kg)
    free_kg = stock_kg - committed_kg
    if free_kg < 0:
        free_kg = Decimal("0")
    return {
        "product_id": item.get("product_id", ""),
        "product_name": item.get("product_name", ""),
        "category_id": item.get("category_id", ""),
        "category_name": item.get("category_name", ""),
        "description": item.get("description", ""),
        "price_per_kg": _json_num(price_kg),
        "mrp_price_per_kg": _json_num(mrp_kg) if mrp_kg > 0 else None,
        "discount_percent": discount_percent,
        "lot_size_kg": _json_num(lot_size) if lot_size > 0 else None,
        "lot_price": _json_num(lot_price) if lot_size > 0 else None,
        "mrp_lot_price": _json_num(mrp_lot_price) if mrp_lot_price is not None else None,
        "lot_status": item.get("lot_status", "available"),
        "min_order_kg": _json_num(item.get("min_order_kg", 0)),
        "available_stock_kg": _json_num(stock_kg),
        "initial_stock_kg": _json_num(initial_kg),
        "committed_kg": _json_num(committed_kg),
        "free_stock_kg": _json_num(free_kg),
        "available_stock": item.get("available_stock", "In Stock"),
        "image_url": item.get("image_url", ""),
        "image_urls": item.get("image_urls") or ([item.get("image_url")] if item.get("image_url") else []),
        "shop_id": shop_id,
        "shop_name": item.get("shop_name", ""),
        "avg_rating": _json_num(item.get("avg_rating", 0)),
        "total_reviews": int(_decimal(item.get("total_reviews", 0))),
        "is_seller_product": bool(item.get("is_seller_product")),
        "is_paused": is_paused or shop_blocked,
        "pk": item.get("pk", ""),
    }


def _all_active_products(include_paused: bool = True) -> list[dict]:
    """Serialized active catalogue products. After the GSI migration the
    underlying `_scan_by_pk_prefix("CATALOGUE#CATEGORY#")` is a single indexed
    Query, not a full-table Scan (Phase 0)."""
    out = []
    for item in _scan_by_pk_prefix("CATALOGUE#CATEGORY#"):
        if not item.get("is_active", True):
            continue
        ser = serialize_product(item, include_paused=include_paused)
        if ser:
            out.append(ser)
    return out


def get_public_catalogue_enriched(include_paused: bool = True) -> dict:
    """Full catalogue (legacy /catalogue). Kept for backward-compatibility; the
    scalable frontend now uses /catalogue/sections + /catalogue/search instead
    of pulling the entire catalogue into the browser."""
    try:
        products = _all_active_products(include_paused)
        products.sort(key=lambda p: (p["category_name"], p["product_name"]))
        categories = sorted({p["category_name"] for p in products if p.get("category_name")})
        return {"products": products, "total": len(products), "categories": categories}
    except Exception as e:
        logger.error("[CATALOGUE] enriched failed: %s", e, exc_info=True)
        return {"products": [], "total": 0, "categories": []}


# ── Scalable catalogue: bounded sections + paginated search (Phase 0) ──────
_SECTION_SIZE = 6


def handle_catalogue_sections(event: dict) -> dict:
    """The Trade tab's default feed, built SERVER-side and BOUNDED — best
    offers, per-category top-6, top-rated — so the browser never has to pull
    the whole catalogue to render the home view. Payload is a few dozen
    products regardless of how large the catalogue grows."""
    method = event.get("requestContext", {}).get("http", {}).get("method") or event.get("httpMethod", "GET")
    if method == "OPTIONS":
        return _json_response(200, {})
    try:
        products = _all_active_products(include_paused=True)
        # Phase D: keep only products within the viewer's saved radius.
        products = _geo_filter_products(products, _optional_user_geo(event))
    except Exception as e:
        logger.error("[CATALOGUE][SECTIONS] failed: %s", e, exc_info=True)
        return _json_response(200, {"best_offers": [], "categories": [], "top_rated": [], "total": 0})

    best_offers = sorted(
        [p for p in products if (p.get("discount_percent") or 0) >= 5],
        key=lambda p: -(p.get("discount_percent") or 0),
    )[:_SECTION_SIZE]

    top_rated = sorted(
        [p for p in products if (p.get("avg_rating") or 0) >= 4],
        key=lambda p: -(p.get("avg_rating") or 0),
    )[:_SECTION_SIZE]

    groups: dict[str, list] = {}
    for p in products:
        groups.setdefault(p.get("category_name") or "Other", []).append(p)
    categories = [
        {"name": name, "total": len(items), "products": items[:_SECTION_SIZE]}
        for name, items in sorted(groups.items(), key=lambda kv: -len(kv[1]))
    ]
    return _json_response(200, {
        "best_offers": best_offers,
        "best_offers_total": len([p for p in products if (p.get("discount_percent") or 0) >= 5]),
        "top_rated": top_rated,
        "top_rated_total": len([p for p in products if (p.get("avg_rating") or 0) >= 4]),
        "categories": categories,
        "all_categories": sorted(groups.keys()),
        "total": len(products),
    })


def handle_catalogue_search(event: dict) -> dict:
    """Paginated, server-side filtered product query (Phase 0). Replaces the
    old client-side search that could only ever match the products already
    loaded in the browser — so products beyond the first page were invisible.

    Params: q, category, sort (offers|rated|price_asc|price_desc|name),
            shop_id, limit (<=48), offset.
    """
    method = event.get("requestContext", {}).get("http", {}).get("method") or event.get("httpMethod", "GET")
    if method == "OPTIONS":
        return _json_response(200, {})
    params = event.get("queryStringParameters") or {}
    q = (params.get("q") or "").strip().lower()
    category = (params.get("category") or "").strip()
    shop_id = _normalize_shop_id(params.get("shop_id") or "") if params.get("shop_id") else ""
    sort = (params.get("sort") or "").strip().lower()
    try:
        limit = min(max(int(params.get("limit", 24)), 1), 48)
    except (TypeError, ValueError):
        limit = 24
    try:
        offset = max(int(params.get("offset", 0)), 0)
    except (TypeError, ValueError):
        offset = 0

    try:
        products = _all_active_products(include_paused=True)
        # Search, category browsing and a shop-specific product view all use
        # the same strict public-discovery radius. Favourites have their own
        # endpoint and are intentionally never filtered here.
        products = _geo_filter_products(products, _optional_user_geo(event))
    except Exception as e:
        logger.error("[CATALOGUE][SEARCH] failed: %s", e, exc_info=True)
        return _json_response(200, {"products": [], "total": 0, "next_offset": None})

    def keep(p):
        if category and category.lower() != "all" and (p.get("category_name") or "Other") != category:
            return False
        if shop_id and p.get("shop_id") != shop_id:
            return False
        if q:
            hay = f"{p.get('product_name','')} {p.get('description','')} {p.get('category_name','')} {p.get('shop_name','')}".lower()
            if q not in hay:
                return False
        return True

    filtered = [p for p in products if keep(p)]

    if sort == "offers":
        filtered.sort(key=lambda p: -(p.get("discount_percent") or 0))
    elif sort == "rated":
        filtered.sort(key=lambda p: -(p.get("avg_rating") or 0))
    elif sort == "price_asc":
        filtered.sort(key=lambda p: (p.get("price_per_kg") or 0))
    elif sort == "price_desc":
        filtered.sort(key=lambda p: -(p.get("price_per_kg") or 0))
    else:
        filtered.sort(key=lambda p: (p.get("category_name", ""), p.get("product_name", "")))

    total = len(filtered)
    page = filtered[offset:offset + limit]
    return _json_response(200, {
        "products": page,
        "total": total,
        "next_offset": offset + limit if offset + limit < total else None,
    })


def handle_track_order(event: dict) -> dict:
    method = event.get("requestContext", {}).get("http", {}).get("method") or event.get("httpMethod", "GET")
    if method == "OPTIONS":
        return _json_response(200, {})
    if _delivery_mod:
        return _delivery_mod.handle_track_enriched(event)
    params = event.get("queryStringParameters") or {}
    arn = normalize_arn(params.get("arn") or "")
    if not arn_valid(arn):
        return _json_response(400, {"error": "Invalid Order ID format"})
    item = table.get_item(Key={"pk": f"ORDER#{arn}"}).get("Item") or {}
    if not item:
        return _json_response(404, {"error": "Order not found"})
    return _json_response(200, {"order": item, "arn": arn})


def handle_order_cancel(event: dict) -> dict:
    """Self-service order cancellation (new in the claim-time stock
    reservation phase — this endpoint did not exist before).

    Cancellable window:
      - status == "PENDING_DELIVERY" (nothing claimed yet): nothing was
        ever reserved, so this is a pure status-only cancellation — no
        stock effect.
      - status == "DELIVERY_ASSIGNED" (claimed, journey not yet started):
        a claim-time stock reservation exists (see
        delivery.handle_delivery_claim / platform_utils.reserve_product_stock)
        and must be reversed so available stock / public catalogue
        visibility goes back to exactly what it was before the claim —
        automatically, no admin action required.
    Once status is "IN_TRANSIT"/"NEAR_DESTINATION"/"COMPLETED" (or anything
    else), this self-service endpoint rejects the cancellation with 409.
    ASSUMPTION (flag for the owner to confirm or adjust): the cutoff is set
    at journey-start because cash/the delivery run has already begun by
    then, so cancelling past that point needs a support conversation
    instead of a one-tap self-service button.
    """
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    arn = normalize_arn(body.get("arn", ""))
    if not arn_valid(arn):
        return _json_response(400, {"error": "Invalid ARN"})
    if not _delivery_mod:
        return _json_response(503, {"error": "Delivery service unavailable"})

    rec = _delivery_mod._get_delivery_record(arn)
    if not rec:
        return _json_response(404, {"error": "Order not found"})
    if rec.get("importer_sub") != user["sub"]:
        return _json_response(403, {"error": "You can only cancel your own orders"})

    status = rec.get("status", "")
    if status not in ("PENDING_DELIVERY", "DELIVERY_ASSIGNED"):
        return _json_response(409, {"error": "Delivery already in progress — contact support to cancel"})

    # ── Release stock commit (complete-only model). Public available is
    # unchanged unless this was a legacy claim-time reservation.
    product_pk = rec.get("product_pk", "")
    reserved_kg = rec.get("committed_kg") or rec.get("reserved_kg") or rec.get("lot_size_kg", 0)
    reversed_stock = False
    try:
        reversed_stock = bool(reverse_product_reservation(product_pk, reserved_kg, arn))
    except Exception as e:
        logger.error("[ORDER][CANCEL] stock release failed for %s: %s", arn, e, exc_info=True)

    try:
        table.update_item(
            Key={"pk": f"DELIVERY#ARN#{arn}"},
            UpdateExpression="SET #s = :s, cancelled_at = :t, cancelled_by = :who",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": "CANCELLED", ":t": _now(), ":who": "buyer"},
        )
    except Exception as e:
        logger.error("[ORDER][CANCEL] delivery record update failed for %s: %s", arn, e)
    try:
        table.update_item(
            Key={"pk": f"ORDER#{arn}"},
            UpdateExpression="SET current_status = :s, last_updated = :u",
            ExpressionAttributeValues={":s": "Cancelled", ":u": _now()},
        )
    except Exception as e:
        logger.warning("[ORDER][CANCEL] order record update failed for %s: %s", arn, e)

    seller_sub = rec.get("seller_sub", "")
    if seller_sub:
        try:
            create_notification(
                seller_sub, "shop_status", "Order cancelled",
                f"Order {arn} for {rec.get('product_name', 'your product')} was cancelled by the buyer."
                + (" The order booking was released." if reversed_stock else ""),
                arn=arn,
            )
        except Exception as e:
            logger.warning("[ORDER][CANCEL] seller notification failed: %s", e)

    claimed_by = rec.get("claimed_by", "")
    if status == "DELIVERY_ASSIGNED" and claimed_by:
        try:
            create_notification(
                claimed_by, "shop_status", "Order cancelled",
                f"The buyer cancelled order {arn} — no action needed on your end.",
                arn=arn,
            )
        except Exception as e:
            logger.warning("[ORDER][CANCEL] delivery partner notification failed: %s", e)
        try:
            partner_contact = get_delivery_partner_contact(claimed_by)
            if partner_contact.get("phone"):
                from advanced_features import send_whatsapp_text
                send_whatsapp_text(
                    partner_contact["phone"],
                    f"❌ Order {arn} was cancelled by the buyer before the journey started. No action needed.",
                )
        except Exception as e:
            logger.warning("[ORDER][CANCEL] WhatsApp to delivery partner failed: %s", e)

    return _json_response(200, {"success": True, "arn": arn, "stock_restored": reversed_stock})


def _validate_bank_details(body: dict) -> str | None:
    holder = (body.get("bank_account_holder") or body.get("bank_holder") or "").strip()
    bank_name = (body.get("bank_name") or "").strip()
    acct = re.sub(r"\D", "", body.get("bank_account_number") or body.get("bank_account") or "")
    ifsc = (body.get("bank_ifsc") or body.get("ifsc") or "").strip().upper()
    if not holder or not bank_name or not acct or not ifsc:
        return "Bank account holder, bank name, account number and IFSC are required"
    if not (9 <= len(acct) <= 18):
        return "Account number must be 9-18 digits"
    if not IFSC_RE.match(ifsc):
        return "Invalid IFSC code format"
    return None


def _encrypt_bank_field(value: str) -> str:
    """Reversible encryption (was a one-way HMAC hash before — that made
    the account number permanently unrecoverable, so payouts could never
    actually be sent). See platform_utils.encrypt_bank_field / BANK_ENCRYPTION_KEY."""
    if not PLATFORM_UTILS_OK:
        raise RuntimeError("platform_utils not available — cannot safely store bank details")
    return encrypt_bank_field(value)


def get_shop_subscription(user_sub: str) -> dict:
    return table.get_item(Key={"pk": f"SUBSCRIPTION#USER#{user_sub}"}).get("Item") or {}


def is_subscription_active(user_sub: str) -> bool:
    sub = get_shop_subscription(user_sub)
    if sub.get("status") != "active":
        return False
    expires = int(sub.get("expires_at_ts") or 0)
    if expires and expires < int(__import__("time").time()):
        return False
    return True


# ── KYC cross-verification (Batch 5) ────────────────────────────────────
# Real UIDAI/NSDL/penny-drop verification needs a licensed provider (Signzy,
# Cashfree, Karza…). Until that's wired, this does the strongest checks we CAN
# do offline: exact format validation, the Aadhaar Verhoeff checksum, and
# cross-matching the holder's name across PAN, Aadhaar and the bank account.
# Results are stored on the KYC record so admin sees mismatches at a glance.
_VERHOEFF_D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]
_VERHOEFF_P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]


def _aadhaar_checksum_ok(aadhaar: str) -> bool:
    if not aadhaar or not aadhaar.isdigit() or len(aadhaar) != 12:
        return False
    c = 0
    for i, ch in enumerate(reversed(aadhaar)):
        c = _VERHOEFF_D[c][_VERHOEFF_P[i % 8][int(ch)]]
    return c == 0


def _norm_name(name: str) -> str:
    n = (name or "").upper()
    n = re.sub(r"\b(MR|MRS|MS|SHRI|SMT|DR|KUMARI|KM)\b", " ", n)
    n = re.sub(r"[^A-Z ]", " ", n)
    return " ".join(n.split())


def _name_tokens(name: str) -> set:
    return {t for t in _norm_name(name).split() if len(t) > 1}


def _name_similar(a: str, b: str) -> bool:
    """Conservative same-person check: identical token sets (any order), a
    subset relationship (missing middle name / initials), or ≥2 shared tokens."""
    ta, tb = _name_tokens(a), _name_tokens(b)
    if not ta or not tb:
        return False
    if ta == tb:
        return True
    inter = ta & tb
    if inter == ta or inter == tb or len(inter) >= 2:
        return True
    return min(len(ta), len(tb)) == 1 and len(inter) == 1


def _kyc_cross_check(legal_name: str, pan_name: str, aadhaar_name: str,
                     holder: str, pan: str, aadhaar: str, ifsc: str) -> dict:
    pan_name = pan_name or legal_name
    aadhaar_name = aadhaar_name or legal_name
    checks = {
        "pan_format": bool(pan and PAN_RE.match(pan)),
        "aadhaar_checksum": _aadhaar_checksum_ok(aadhaar),
        "ifsc_format": bool(ifsc and IFSC_RE.match(ifsc)),
        "name_pan_match": _name_similar(legal_name, pan_name),
        "name_aadhaar_match": _name_similar(legal_name, aadhaar_name),
        "name_bank_match": _name_similar(legal_name, holder),
        "pan_aadhaar_name_match": _name_similar(pan_name, aadhaar_name),
    }
    checks["all_passed"] = all(checks.values())
    return checks


def handle_kyc_submit(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    aadhaar = re.sub(r"\D", "", body.get("aadhaar_number", ""))
    pan = (body.get("pan_number") or "").strip().upper()
    kyc_role = (body.get("kyc_role") or "shop_owner").strip().lower()
    if kyc_role not in ("shop_owner", "delivery_partner", "both"):
        kyc_role = "shop_owner"
    bank_err = _validate_bank_details(body)
    if bank_err:
        return _json_response(400, {"error": bank_err})
    if not AADHAAR_RE.match(aadhaar):
        return _json_response(400, {"error": "Invalid Aadhaar number (12 digits required)"})
    if not _aadhaar_checksum_ok(aadhaar):
        return _json_response(400, {"error": "Aadhaar number failed its checksum — please re-check the 12 digits"})
    if pan and not PAN_RE.match(pan):
        return _json_response(400, {"error": "Invalid PAN format"})
    if not body.get("declaration_accepted"):
        return _json_response(400, {"error": "Declaration must be accepted"})
    recaptcha_token = (body.get("recaptcha_token") or "").strip()
    # Native app: 'native-app' marker accepted only for an authenticated request.
    # `user` here is already the verified caller, so this is unforgeable; web keeps captcha.
    _native_ok = (recaptcha_token == "native-app" and bool(user))
    if not _native_ok and not verify_recaptcha(recaptcha_token):
        return _json_response(400, {"error": "Captcha verification failed. Please try again."})

    register_portal_user(user)
    user_sub = user["sub"]
    prefix = f"kyc/{user_sub}"
    front_key = _upload_b64_to_s3(body.get("aadhaar_front_b64", ""), prefix, "aadhaar_front")
    back_key = _upload_b64_to_s3(body.get("aadhaar_back_b64", ""), prefix, "aadhaar_back")
    sig_key = _upload_b64_to_s3(body.get("signature_b64", ""), prefix, "signature")
    if not front_key or not back_key or not sig_key:
        return _json_response(400, {"error": "All KYC document uploads are required (front, back, signature)"})

    acct = re.sub(r"\D", "", body.get("bank_account_number") or body.get("bank_account") or "")
    legal_name = body.get("full_name") or user.get("name", "")
    holder = body.get("bank_account_holder") or body.get("bank_holder", "")
    ifsc = (body.get("bank_ifsc") or "").strip().upper()
    pan_name = (body.get("pan_name") or "").strip()
    aadhaar_name = (body.get("aadhaar_name") or "").strip()
    kyc_checks = _kyc_cross_check(legal_name, pan_name, aadhaar_name, holder, pan, aadhaar, ifsc)
    item = {
        "pk": f"KYC#USER#{user_sub}",
        "user_sub": user_sub,
        "user_name": legal_name,
        "user_email": user.get("email", ""),
        "aadhaar_last4": aadhaar[-4:],
        "aadhaar_front_s3_key": front_key,
        "aadhaar_back_s3_key": back_key,
        "signature_s3_key": sig_key,
        "pan_number": pan,
        "pan_name": pan_name,
        "aadhaar_name": aadhaar_name,
        "kyc_role": kyc_role,
        "bank_account_holder": holder,
        "bank_name": body.get("bank_name", ""),
        "bank_account_enc": _encrypt_bank_field(acct),
        "bank_account_masked": mask_bank_account(acct) if PLATFORM_UTILS_OK else "",
        "bank_ifsc": ifsc,
        "bank_branch": body.get("bank_branch", ""),
        # Offline cross-verification results (see _kyc_cross_check).
        "kyc_checks": kyc_checks,
        "auto_flags": [k for k, v in kyc_checks.items() if k != "all_passed" and not v],
        "status": "pending",
        "submitted_at": _now(),
        "reviewed_at": "",
        "rejection_reason": "",
        "shop_id": "",
    }
    table.put_item(Item=item)
    create_notification(user_sub, "kyc_update", "KYC Submitted", "Your KYC has been submitted and is under review.")
    return _json_response(200, {"success": True, "status": "pending"})


def handle_kyc_status(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    register_portal_user(user)
    kyc = get_kyc(user["sub"])
    shop = get_shop_by_user(user["sub"])
    prof = get_profile(user["sub"])
    sub = get_shop_subscription(user["sub"])
    return _json_response(200, {
        "kyc": {
            "status": kyc.get("status", "none"),
            "kyc_role": kyc.get("kyc_role", "shop_owner"),
            "submitted_at": kyc.get("submitted_at", ""),
            "rejection_reason": kyc.get("rejection_reason", ""),
            "shop_id": kyc.get("shop_id", ""),
            "delivery_suspended": bool(kyc.get("delivery_suspended", False)),
        },
        "subscription": {
            "status": sub.get("status", "none"),
            "active": is_subscription_active(user["sub"]),
            "expires_at": sub.get("expires_at", ""),
        },
        "shop": {
            "shop_id": shop.get("shop_id", ""),
            # Backward-compat: shops created before the custom shop-name field
            # existed have no "shop_name" attribute at all -- fall back to
            # their system-generated shop_id so nothing renders blank.
            "shop_name": shop.get("shop_name") or shop.get("shop_id", ""),
            "status": shop.get("status", ""),
            "product_count": int(_decimal(shop.get("product_count", 0))),
        } if shop else None,
        "profile": {
            "account_status": prof.get("account_status", "active"),
            "phone": prof.get("phone", ""),
        },
    })


def _owner_address(user_sub: str) -> dict:
    """A2 / Delivery V2 — the shop's PICKUP address.

    Historically a shop's address was always the owner's Personal Information
    address. V2 lets a seller set a DEDICATED Shop Pickup Address (shop_* on the
    profile) that is separate from their personal / delivery address. When that
    is set we use it; otherwise we fall back to the personal address (legacy
    behaviour), so existing shops keep working with no migration."""
    p = get_profile(user_sub) or {}
    _slat = str(p.get("shop_lat", "") or "").strip()
    _slng = str(p.get("shop_lng", "") or "").strip()
    if _slat and _slng:
        return {
            "address_full": p.get("shop_address", "") or p.get("address", "") or "",
            "address_city": p.get("shop_city", "") or p.get("city", "") or "",
            "address_state": p.get("shop_state", "") or p.get("state", "") or "",
            "address_pincode": p.get("shop_pincode", "") or p.get("pincode", "") or "",
            "address_lat": _slat,
            "address_lng": _slng,
        }
    return {
        "address_full": p.get("address", "") or "",
        "address_city": p.get("city", "") or "",
        "address_state": p.get("state", "") or "",
        "address_pincode": p.get("pincode", "") or "",
        "address_lat": str(p.get("address_lat", "") or ""),
        "address_lng": str(p.get("address_lng", "") or ""),
    }


def handle_shop_create(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    kyc = get_kyc(user["sub"])
    if kyc.get("status") != "approved":
        return _json_response(403, {"error": "KYC must be approved before creating a shop"})
    if kyc.get("kyc_role") not in ("shop_owner", "both"):
        return _json_response(403, {"error": "Shop owner role required in KYC"})
    if not is_subscription_active(user["sub"]):
        return _json_response(402, {"error": "Active shop subscription required (₹200/month). Please subscribe first.", "needs_subscription": True})
    if get_shop_by_user(user["sub"]):
        return _json_response(400, {"error": "Shop already exists"})
    if not body.get("terms_accepted"):
        return _json_response(400, {"error": "Terms must be accepted"})

    shop_name = (body.get("shop_name") or "").strip()
    if not shop_name:
        return _json_response(400, {"error": "Shop name is required"})
    if len(shop_name) > 60:
        return _json_response(400, {"error": "Shop name must be 60 characters or fewer"})
    # Publicly displayed field -- keep it to plain alphanumerics + common
    # punctuation so nothing that looks like markup/script can be stored.
    if not re.match(r"^[A-Za-z0-9À-ÿ .,&\x27\-]+$", shop_name):
        return _json_response(400, {"error": "Shop name contains invalid characters"})

    # A2: the shop's address always mirrors the owner's Personal Information.
    owner_addr = _owner_address(user["sub"])
    if not (owner_addr["address_full"] and owner_addr["address_city"] and owner_addr["address_pincode"]):
        return _json_response(400, {
            "error": "Complete your Personal Information (address, city, pincode) first — "
                     "your shop uses it as its permanent pickup address.",
            "needs_profile": True,
        })

    shop_id = _next_shop_id()
    shop = {
        "pk": f"SHOP#{shop_id}",
        "shop_id": shop_id,
        "shop_name": shop_name,
        "user_sub": user["sub"],
        "user_name": user.get("name", ""),
        "user_email": user.get("email", ""),
        "shop_description": (body.get("shop_description") or "")[:200],
        "shop_category": body.get("shop_category", "Other"),
        "address_full": owner_addr["address_full"],
        "address_lat": owner_addr["address_lat"],
        "address_lng": owner_addr["address_lng"],
        "address_city": owner_addr["address_city"],
        "address_state": owner_addr["address_state"],
        "address_pincode": owner_addr["address_pincode"],
        "gst_number": body.get("gst_number", ""),
        "status": "active",
        "created_at": _now(),
        "kyc_verified": True,
        "product_count": 0,
        "avg_rating": Decimal("0"),
        "total_reviews": 0,
        "like_count": 0,
    }
    table.put_item(Item=shop)
    table.update_item(
        Key={"pk": f"KYC#USER#{user['sub']}"},
        UpdateExpression="SET shop_id = :s",
        ExpressionAttributeValues={":s": shop_id},
    )
    create_notification(user["sub"], "kyc_update", "Shop Created", f"Your shop '{shop_name}' has been created!")
    return _json_response(200, {"success": True, "shop_id": shop_id, "shop_name": shop_name})


def handle_shop_info(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    shop = get_shop_by_user(user["sub"])
    if not shop:
        return _json_response(404, {"error": "No shop found"})
    out = dict(shop)
    out["shop_name"] = shop.get("shop_name") or shop.get("shop_id", "")
    out["avg_rating"] = _json_num(out.get("avg_rating", 0))
    out["product_count"] = int(_decimal(out.get("product_count", 0)))
    return _json_response(200, {"shop": out})


def handle_shop_toggle(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    shop = get_shop_by_user(user["sub"])
    if not shop:
        return _json_response(404, {"error": "No shop found"})
    new_status = "paused" if shop.get("status") == "active" else "active"
    table.update_item(
        Key={"pk": f"SHOP#{shop['shop_id']}"},
        UpdateExpression="SET #s = :s, updated_at = :u",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": new_status, ":u": _now()},
    )
    create_notification(user["sub"], "shop_status", "Shop Status Updated", f"Your shop is now {new_status}.")
    return _json_response(200, {"success": True, "status": new_status})


def handle_shop_update(event: dict) -> dict:
    """Edit the signed-in owner's own shop: display name, description,
    category, city/state, and logo/cover photos (uploaded as base64 → S3).
    Only fields present in the body are changed."""
    user, err = _require_auth(event)
    if err:
        return err
    shop = get_shop_by_user(user["sub"])
    if not shop:
        return _json_response(404, {"error": "No shop found"})
    body = _event_body(event)
    sets, names, values = [], {}, {}

    if "shop_name" in body:
        shop_name = (body.get("shop_name") or "").strip()
        if not shop_name:
            return _json_response(400, {"error": "Shop name is required"})
        if len(shop_name) > 60:
            return _json_response(400, {"error": "Shop name must be 60 characters or fewer"})
        if not re.match(r"^[A-Za-z0-9À-ÿ .,&\x27\-]+$", shop_name):
            return _json_response(400, {"error": "Shop name contains invalid characters"})
        sets.append("shop_name = :n"); values[":n"] = shop_name
    if "shop_description" in body:
        sets.append("shop_description = :d"); values[":d"] = (body.get("shop_description") or "")[:200]
    if "shop_category" in body:
        sets.append("shop_category = :c"); values[":c"] = (body.get("shop_category") or "Other")[:40]
    # A2: the shop address is NOT editable here — it always re-syncs from the
    # owner's Personal Information, so editing the profile address updates the
    # shop's pickup address automatically and they can never diverge.
    _oa = _owner_address(user["sub"])
    if _oa["address_full"]:
        sets.append("address_full = :afull"); values[":afull"] = _oa["address_full"]
        sets.append("address_city = :city"); values[":city"] = _oa["address_city"]
        sets.append("address_state = :st"); values[":st"] = _oa["address_state"]
        sets.append("address_pincode = :apin"); values[":apin"] = _oa["address_pincode"]
        sets.append("address_lat = :alat"); values[":alat"] = _oa["address_lat"]
        sets.append("address_lng = :alng"); values[":alng"] = _oa["address_lng"]

    # Logo / cover: accept either a base64 upload (image_b64 / cover_b64) or a
    # direct URL. Reuse the same S3 helper the banner uploader uses.
    logo_b64 = body.get("logo_b64") or body.get("image_b64")
    if logo_b64:
        key = _upload_b64_to_s3(logo_b64, f"shop-media/{shop['shop_id']}", "logo")
        if key:
            sets.append("shop_logo_url = :logo"); values[":logo"] = _public_s3_url(key)
    elif "shop_logo_url" in body:
        sets.append("shop_logo_url = :logo"); values[":logo"] = body.get("shop_logo_url", "")
    cover_b64 = body.get("cover_b64")
    if cover_b64:
        key = _upload_b64_to_s3(cover_b64, f"shop-media/{shop['shop_id']}", "cover")
        if key:
            sets.append("shop_cover_url = :cover"); values[":cover"] = _public_s3_url(key)
    elif "shop_cover_url" in body:
        sets.append("shop_cover_url = :cover"); values[":cover"] = body.get("shop_cover_url", "")

    if not sets:
        return _json_response(400, {"error": "Nothing to update"})
    sets.append("updated_at = :u"); values[":u"] = _now()
    kwargs = {
        "Key": {"pk": f"SHOP#{shop['shop_id']}"},
        "UpdateExpression": "SET " + ", ".join(sets),
        "ExpressionAttributeValues": values,
    }
    if names:
        kwargs["ExpressionAttributeNames"] = names
    try:
        table.update_item(**kwargs)
    except ClientError:
        logger.exception("[SHOP] update failed")
        return _json_response(500, {"error": "Could not update shop"})
    updated = get_shop(shop["shop_id"]) or {}
    return _json_response(200, {"success": True, "shop": {
        "shop_id": shop["shop_id"],
        "shop_name": updated.get("shop_name", ""),
        "shop_description": updated.get("shop_description", ""),
        "shop_category": updated.get("shop_category", ""),
        "shop_logo_url": updated.get("shop_logo_url", ""),
        "shop_cover_url": updated.get("shop_cover_url", ""),
    }})


def handle_shop_delete(event: dict) -> dict:
    """Owner deletes their own shop. Removes the SHOP# record and unlinks it
    from the owner's KYC record so they can create a fresh shop later.
    Products are left orphaned-inactive (a later listing scan drops them);
    we avoid a large synchronous delete here."""
    user, err = _require_auth(event)
    if err:
        return err
    shop = get_shop_by_user(user["sub"])
    if not shop:
        return _json_response(404, {"error": "No shop found"})
    try:
        table.delete_item(Key={"pk": f"SHOP#{shop['shop_id']}"})
        table.update_item(
            Key={"pk": f"KYC#USER#{user['sub']}"},
            UpdateExpression="REMOVE shop_id",
        )
    except ClientError:
        logger.exception("[SHOP] delete failed")
        return _json_response(500, {"error": "Could not delete shop"})
    create_notification(user["sub"], "shop_status", "Shop Deleted", "Your shop has been deleted.")
    return _json_response(200, {"success": True})


def _delete_s3_prefix(prefix: str) -> int:
    """Best-effort delete of S3 objects under prefix. Returns deleted count."""
    if not prefix or not S3_BUCKET:
        return 0
    deleted = 0
    try:
        token = None
        while True:
            kwargs = {"Bucket": S3_BUCKET, "Prefix": prefix, "MaxKeys": 100}
            if token:
                kwargs["ContinuationToken"] = token
            resp = s3.list_objects_v2(**kwargs)
            objs = [{"Key": o["Key"]} for o in resp.get("Contents") or []]
            if objs:
                s3.delete_objects(Bucket=S3_BUCKET, Delete={"Objects": objs, "Quiet": True})
                deleted += len(objs)
            if not resp.get("IsTruncated"):
                break
            token = resp.get("NextContinuationToken")
    except Exception:
        logger.exception("[PURGE] S3 prefix delete failed: %s", prefix)
    return deleted


def _purge_user(sub: str, *, by_admin: bool = False, reason: str = "") -> dict:
    """Permanently erase user data (shared by self-delete and admin delete)."""
    if not sub:
        return {"deleted_approx": 0}
    kyc = get_kyc(sub)
    shop = get_shop_by_user(sub)
    role = (kyc.get("kyc_role") or "").strip()
    kyc_ok = kyc.get("status") == "approved"
    had_shop = bool(shop)
    had_delivery = kyc_ok and role in ("delivery_partner", "both")
    had_shop_tab = kyc_ok and (had_shop or role in ("shop_owner", "both", ""))
    deleted = 0

    def _del(pk: str) -> None:
        nonlocal deleted
        if not pk:
            return
        try:
            table.delete_item(Key={"pk": pk})
            deleted += 1
        except Exception:
            logger.exception("[PURGE] failed for %s", pk)

    shop_id = (shop or {}).get("shop_id", "") or kyc.get("shop_id", "")
    if shop_id:
        for item in _scan_by_pk_prefix("CATALOGUE#CATEGORY#"):
            if item.get("shop_id") == shop_id or item.get("seller_user_sub") == sub:
                _del(item.get("pk", ""))
        _del(f"SHOP#{shop_id}")
        deleted += _delete_s3_prefix(f"shop-media/{shop_id}/")
    else:
        for item in _scan_by_pk_prefix("CATALOGUE#CATEGORY#"):
            if item.get("seller_user_sub") == sub:
                _del(item.get("pk", ""))

    _del(f"PROFILE#USER#{sub}")
    _del(f"KYC#USER#{sub}")
    _del(f"SUBSCRIPTION#USER#{sub}")
    _del(f"USERSTRIKE#{sub}")

    for it in _scan_by_pk_prefix(f"NOTIFICATION#USER#{sub}#"):
        _del(it.get("pk", ""))
    for it in _scan_by_pk_prefix(f"PRICEALERT#{sub}#"):
        _del(it.get("pk", ""))
    for it in _scan_by_pk_prefix(f"REVIEW#USER#{sub}#"):
        _del(it.get("pk", ""))
    for it in _scan_by_pk_prefix(f"FEEDLIKE#{sub}#"):
        _del(it.get("pk", ""))
    for it in _scan_by_pk_prefix(f"FEEDCLIKE#{sub}#"):
        _del(it.get("pk", ""))
    for it in _scan_by_pk_prefix(f"BLOCK#{sub}#"):
        _del(it.get("pk", ""))
    for it in _scan_by_pk_prefix(f"ADDRESS#{sub}#"):
        _del(it.get("pk", ""))

    for it in _scan_by_pk_prefix(f"FOLLOW#{sub}#"):
        _del(it.get("pk", ""))
    for it in _scan_by_pk_prefix("FOLLOW#"):
        if it.get("followee_sub") == sub or str(it.get("pk", "")).endswith("#" + sub):
            _del(it.get("pk", ""))

    for it in _scan_by_pk_prefix("FEEDPOST#"):
        if it.get("user_sub") == sub:
            pid = it.get("post_id") or str(it.get("pk", "")).replace("FEEDPOST#", "")
            for c in _scan_by_pk_prefix(f"FEEDCOMMENT#{pid}#"):
                _del(c.get("pk", ""))
            _del(it.get("pk", ""))
    for it in _scan_by_pk_prefix("STORY#"):
        if it.get("user_sub") == sub:
            _del(it.get("pk", ""))

    deleted += _delete_s3_prefix(f"feed/{sub[:24]}/")
    deleted += _delete_s3_prefix(f"stories/{sub[:24]}/")
    deleted += _delete_s3_prefix(f"kyc/{sub[:24]}/")
    deleted += _delete_s3_prefix(f"chat/")  # chat keys are conv-based; best-effort later

    try:
        for it in _scan_by_pk_prefix("USERNAME#"):
            if it.get("user_sub") == sub:
                _del(it.get("pk", ""))
    except Exception:
        pass

    # Messenger: remove messages where user is a participant (bounded)
    try:
        for it in _scan_by_pk_prefix("MSG#"):
            if it.get("from_sub") == sub or it.get("to_sub") == sub:
                _del(it.get("pk", ""))
        for it in _scan_by_pk_prefix(f"CONVMETA#{sub}#"):
            _del(it.get("pk", ""))
    except Exception:
        logger.exception("[PURGE] messenger cleanup failed")

    try:
        for it in _scan_by_pk_prefix("DELIVERY#ARN#"):
            touch = False
            sets = []
            if it.get("importer_sub") == sub or it.get("buyer_sub") == sub:
                touch = True
                sets += ["buyer_name = :anon", "buyer_mobile = :empty", "importer_sub = :empty"]
            if it.get("seller_sub") == sub:
                touch = True
                sets.append("seller_sub = :empty")
            if it.get("claimed_by") == sub:
                touch = True
                sets.append("claimed_by = :empty")
            if touch and sets:
                table.update_item(
                    Key={"pk": it["pk"]},
                    UpdateExpression="SET " + ", ".join(sets),
                    ExpressionAttributeValues={":anon": "Deleted user", ":empty": ""},
                )
                deleted += 1
    except Exception:
        logger.exception("[PURGE] order anonymize failed")

    try:
        import content_moderation as _cm
        _cm.write_admin_audit(
            "purge_user",
            f"by_admin={by_admin} reason={reason[:120]}",
            target=sub,
        )
    except Exception:
        pass

    logger.info("[PURGE] sub=%s removed≈%s admin=%s", sub, deleted, by_admin)
    return {
        "deleted_approx": deleted,
        "had_shop": had_shop_tab,
        "had_delivery": had_delivery,
    }


def handle_account_delete(event: dict) -> dict:
    """Permanently erase this user's account data from DynamoDB."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    if not body.get("confirm"):
        return _json_response(400, {"error": "Confirmation required"})
    sub = user["sub"]
    result = _purge_user(sub, by_admin=False, reason="self_delete")
    return _json_response(200, {
        "success": True,
        "deleted_approx": result.get("deleted_approx", 0),
        "had_shop": result.get("had_shop"),
        "had_delivery": result.get("had_delivery"),
        "message": "Account permanently deleted. Sign in again to start as a new user.",
    })


# ══════════════════════════════════════════════════════════════
# PRICE ALERTS (Phase 1)
#   PRICEALERT#<user_sub>#<id>   "tell me when <term> is at/below <price>/kg"
# Fired when a matching product is listed (or re-priced lower). Repeat buyers
# come back for exactly this.
# ══════════════════════════════════════════════════════════════
def handle_alert_create(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    term = str(body.get("term") or "").strip()[:60]
    try:
        target = float(body.get("target_price", 0))
    except (TypeError, ValueError):
        target = 0.0
    if not term or target <= 0:
        return _json_response(400, {"error": "A product/category term and a target price are required"})
    alert_id = uuid.uuid4().hex[:10]
    table.put_item(Item={
        "pk": f"PRICEALERT#{user['sub']}#{alert_id}",
        "alert_id": alert_id,
        "user_sub": user["sub"],
        "term": term,
        "term_lc": term.lower(),
        "target_price": _decimal(target),
        "created_at": _now(),
        "ttl": _ttl(180),
    })
    return _json_response(200, {"success": True, "alert_id": alert_id})


def handle_alert_list(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    alerts = [{
        "alert_id": it.get("alert_id", ""),
        "term": it.get("term", ""),
        "target_price": _json_num(it.get("target_price", 0)),
        "created_at": it.get("created_at", ""),
    } for it in _scan_by_pk_prefix(f"PRICEALERT#{user['sub']}#")]
    alerts.sort(key=lambda a: a.get("created_at", ""), reverse=True)
    return _json_response(200, {"alerts": alerts})


def handle_alert_delete(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    alert_id = str(body.get("alert_id") or "").strip()
    if not alert_id:
        return _json_response(400, {"error": "alert_id required"})
    table.delete_item(Key={"pk": f"PRICEALERT#{user['sub']}#{alert_id}"})
    return _json_response(200, {"success": True})


def _fire_price_alerts(product_name: str, category_name: str, price: float) -> None:
    """Notify every user whose alert term appears in this product's name or
    category and whose target price is now met. Best-effort — never blocks the
    product write."""
    if price <= 0:
        return
    haystack = f"{product_name} {category_name}".lower()
    try:
        for it in _scan_by_pk_prefix("PRICEALERT#"):
            term = it.get("term_lc", "")
            target = float(_decimal(it.get("target_price", 0)))
            if term and target > 0 and term in haystack and price <= target:
                create_notification(
                    it.get("user_sub", ""), "price_alert", "Price drop alert",
                    f"{product_name} is now ₹{price:g}/kg — at or below your ₹{target:g} target.",
                )
    except Exception as e:
        logger.warning("[PRICEALERT] fire failed: %s", e)


# ══════════════════════════════════════════════════════════════
# RFQ / PRICE NEGOTIATION (Phase 1)
#   RFQ#<rfq_id>                       the thread header
#   RFQMSG#<rfq_id>#<millis>-<uuid6>   one message (offer / counter / text)
# A buyer opens an RFQ on a product; buyer and seller trade offers until one
# side accepts. "Quote" bulk orders finally have a real back-and-forth.
# ══════════════════════════════════════════════════════════════
def _rfq_public(header: dict, messages: list, viewer_sub: str) -> dict:
    return {
        "rfq_id": header.get("rfq_id", ""),
        "product_id": header.get("product_id", ""),
        "product_name": header.get("product_name", ""),
        "shop_id": header.get("shop_id", ""),
        "buyer_sub": header.get("buyer_sub", ""),
        "buyer_name": header.get("buyer_name", ""),
        "seller_sub": header.get("seller_sub", ""),
        "status": header.get("status", "open"),          # open | accepted | closed
        "agreed_price": _json_num(header.get("agreed_price", 0)),
        "quantity_kg": _json_num(header.get("quantity_kg", 0)),
        "i_am_buyer": viewer_sub == header.get("buyer_sub", ""),
        "i_am_seller": viewer_sub == header.get("seller_sub", ""),
        "updated_at": header.get("updated_at", ""),
        "messages": [{
            "from_sub": m.get("from_sub", ""),
            "from_name": m.get("from_name", ""),
            "kind": m.get("kind", "text"),                # text | offer | accept
            "price": _json_num(m.get("price", 0)),
            "quantity_kg": _json_num(m.get("quantity_kg", 0)),
            "text": m.get("text", ""),
            "created_at": m.get("created_at", ""),
            "mine": m.get("from_sub", "") == viewer_sub,
        } for m in messages],
    }


def _load_rfq(rfq_id: str) -> tuple[dict, list]:
    header = table.get_item(Key={"pk": f"RFQ#{rfq_id}"}).get("Item") or {}
    if not header:
        return {}, []
    msgs = list(_scan_by_pk_prefix(f"RFQMSG#{rfq_id}#"))
    msgs.sort(key=lambda m: m.get("pk", ""))
    return header, msgs


def handle_rfq_create(event: dict) -> dict:
    """Buyer opens a negotiation on a product with an opening offer."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    product_id = str(body.get("product_id") or "").strip()
    category_id = str(body.get("category_id") or "").strip()
    if not product_id:
        return _json_response(400, {"error": "product_id required"})
    if _rate_limited(user["sub"], "rfq_create", limit=10, window_seconds=300):
        return _rate_limit_response()
    product = _get_product_any(product_id, category_id)
    if not product:
        return _json_response(404, {"error": "Product not found"})
    seller_sub = product.get("seller_user_sub") or product.get("shop_owner_sub") or ""
    if seller_sub == user["sub"]:
        return _json_response(400, {"error": "You cannot negotiate on your own product"})

    try:
        price = float(body.get("price", 0))
        qty = float(body.get("quantity_kg", 0))
    except (TypeError, ValueError):
        price = qty = 0.0
    text = str(body.get("text") or "").strip()[:300]

    import time as _time
    rfq_id = f"{int(_time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
    author = _feed_author(user)
    now = _now()
    table.put_item(Item={
        "pk": f"RFQ#{rfq_id}",
        "rfq_id": rfq_id,
        "product_id": product_id,
        "category_id": category_id,
        "product_name": product.get("product_name", ""),
        "shop_id": product.get("shop_id", ""),
        "buyer_sub": user["sub"],
        "buyer_name": author["user_name"],
        "seller_sub": seller_sub,
        "status": "open",
        "agreed_price": _decimal(0),
        "quantity_kg": _decimal(qty),
        "created_at": now,
        "updated_at": now,
        "ttl": _ttl(120),
    })
    _rfq_add_message(rfq_id, user, kind="offer", price=price, qty=qty, text=text)
    if seller_sub:
        create_notification(
            seller_sub, "rfq", "New price request",
            f"{author['user_name']} wants to negotiate on {product.get('product_name', 'your product')}"
            + (f" — offered ₹{price:g}/kg" if price else "") + ".",
        )
    header, msgs = _load_rfq(rfq_id)
    return _json_response(200, {"success": True, "rfq": _rfq_public(header, msgs, user["sub"])})


def _rfq_add_message(rfq_id: str, user: dict, *, kind: str, price=0, qty=0, text="") -> None:
    import time as _time
    author = _feed_author(user)
    mid = f"{int(_time.time() * 1000)}-{uuid.uuid4().hex[:6]}"
    table.put_item(Item={
        "pk": f"RFQMSG#{rfq_id}#{mid}",
        "rfq_id": rfq_id,
        "from_sub": user["sub"],
        "from_name": author["user_name"],
        "kind": kind,
        "price": _decimal(price or 0),
        "quantity_kg": _decimal(qty or 0),
        "text": text,
        "created_at": _now(),
        "ttl": _ttl(120),
    })


def handle_rfq_message(event: dict) -> dict:
    """Post a counter-offer, plain message, or ACCEPT into an open RFQ."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    rfq_id = str(body.get("rfq_id") or "").strip()
    header, _ = _load_rfq(rfq_id)
    if not header:
        return _json_response(404, {"error": "Negotiation not found"})
    if user["sub"] not in (header.get("buyer_sub"), header.get("seller_sub")):
        return _json_response(403, {"error": "You are not part of this negotiation"})
    if header.get("status") != "open":
        return _json_response(400, {"error": "This negotiation is already " + header.get("status", "closed")})

    kind = str(body.get("kind") or "text").strip().lower()
    if kind not in ("text", "offer", "accept"):
        kind = "text"
    try:
        price = float(body.get("price", 0))
        qty = float(body.get("quantity_kg", header.get("quantity_kg", 0)))
    except (TypeError, ValueError):
        price = qty = 0.0
    text = str(body.get("text") or "").strip()[:300]

    _rfq_add_message(rfq_id, user, kind=kind, price=price, qty=qty, text=text)

    other = header["seller_sub"] if user["sub"] == header["buyer_sub"] else header["buyer_sub"]
    author = _feed_author(user)
    updates = "SET updated_at = :t"
    values = {":t": _now()}
    if kind == "accept":
        updates += ", #st = :s, agreed_price = :p, quantity_kg = :q"
        values.update({":s": "accepted", ":p": _decimal(price or 0), ":q": _decimal(qty or 0)})
    table.update_item(
        Key={"pk": f"RFQ#{rfq_id}"},
        UpdateExpression=updates,
        ExpressionAttributeValues=values,
        **({"ExpressionAttributeNames": {"#st": "status"}} if kind == "accept" else {}),
    )
    if other:
        if kind == "accept":
            create_notification(other, "rfq", "Price agreed",
                                f"{author['user_name']} accepted — ₹{price:g}/kg on {header.get('product_name', '')}. Place the order to confirm.")
        else:
            create_notification(other, "rfq", "New reply on your negotiation",
                                f"{author['user_name']}: " + (f"₹{price:g}/kg" if kind == 'offer' and price else (text[:60] or 'replied')))
    header, msgs = _load_rfq(rfq_id)
    return _json_response(200, {"success": True, "rfq": _rfq_public(header, msgs, user["sub"])})


def handle_rfq_list(event: dict) -> dict:
    """All negotiations the signed-in user is part of (as buyer or seller)."""
    user, err = _require_auth(event)
    if err:
        return err
    out = []
    for it in _scan_by_pk_prefix("RFQ#"):
        if user["sub"] in (it.get("buyer_sub"), it.get("seller_sub")):
            out.append(it)
    out.sort(key=lambda h: h.get("updated_at", ""), reverse=True)
    return _json_response(200, {"rfqs": [_rfq_public(h, [], user["sub"]) for h in out]})


def handle_rfq_get(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    params = event.get("queryStringParameters") or {}
    rfq_id = str(params.get("rfq_id") or "").strip()
    header, msgs = _load_rfq(rfq_id)
    if not header:
        return _json_response(404, {"error": "Negotiation not found"})
    if user["sub"] not in (header.get("buyer_sub"), header.get("seller_sub")):
        return _json_response(403, {"error": "You are not part of this negotiation"})
    return _json_response(200, {"rfq": _rfq_public(header, msgs, user["sub"])})


def _get_product_any(product_id: str, category_id: str = "") -> dict:
    """Find a catalogue product by id (optionally scoped to a category)."""
    for item in _scan_by_pk_prefix("CATALOGUE#CATEGORY#"):
        if item.get("product_id") == product_id and (not category_id or item.get("category_id") == category_id):
            return item
    return {}


# ══════════════════════════════════════════════════════════════
# DISPUTES / REFUNDS / RETURNS (Phase 1)
#   DISPUTE#<arn>   one dispute per order; buyer raises, admin resolves.
# A COD marketplace with no dispute path can't build trust — this gives the
# buyer a formal channel and the admin a queue to action.
# ══════════════════════════════════════════════════════════════
_DISPUTE_REASONS = ("not_delivered", "damaged", "wrong_item", "quality", "quantity_short", "other")


def _dispute_public(d: dict) -> dict:
    return {
        "arn": d.get("arn", ""),
        "reason": d.get("reason", ""),
        "detail": d.get("detail", ""),
        "resolution_wanted": d.get("resolution_wanted", ""),
        "status": d.get("status", "open"),          # open | under_review | resolved | rejected
        "resolution_note": d.get("resolution_note", ""),
        "photos": d.get("photos", []),
        "buyer_name": d.get("buyer_name", ""),
        "created_at": d.get("created_at", ""),
        "updated_at": d.get("updated_at", ""),
    }


def handle_dispute_create(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    arn = str(body.get("arn") or "").strip()
    reason = str(body.get("reason") or "").strip().lower()
    detail = str(body.get("detail") or "").strip()[:1000]
    resolution = str(body.get("resolution_wanted") or "refund").strip().lower()
    if not arn or reason not in _DISPUTE_REASONS:
        return _json_response(400, {"error": "arn and a valid reason are required"})
    if resolution not in ("refund", "replacement", "return"):
        resolution = "refund"

    rec = table.get_item(Key={"pk": f"DELIVERY#ARN#{arn}"}).get("Item") or {}
    if not rec:
        rec = table.get_item(Key={"pk": f"ORDER#{arn}"}).get("Item") or {}
    if not rec:
        return _json_response(404, {"error": "Order not found"})
    if rec.get("importer_sub") and rec.get("importer_sub") != user["sub"]:
        return _json_response(403, {"error": "Only the buyer of this order can raise a dispute"})

    dispute_pk = f"DISPUTE#{arn}"
    if table.get_item(Key={"pk": dispute_pk}).get("Item"):
        return _json_response(400, {"error": "A dispute is already open for this order"})

    # Photos: up to 3 base64 evidence images → S3.
    photo_urls = []
    for i, b64 in enumerate((body.get("photos_b64") or [])[:3]):
        key = _upload_b64_to_s3(b64, f"disputes/{arn}", f"evidence-{i}")
        if key:
            photo_urls.append(_public_s3_url(key))

    author = _feed_author(user)
    now = _now()
    table.put_item(Item={
        "pk": dispute_pk,
        "arn": arn,
        "buyer_sub": user["sub"],
        "buyer_name": author["user_name"],
        "seller_sub": rec.get("seller_user_sub") or rec.get("seller_sub", ""),
        "shop_id": rec.get("shop_id", ""),
        "reason": reason,
        "detail": detail,
        "resolution_wanted": resolution,
        "photos": photo_urls,
        "status": "open",
        "resolution_note": "",
        "created_at": now,
        "updated_at": now,
        "ttl": _ttl(365),
    })
    seller_sub = rec.get("seller_user_sub") or rec.get("seller_sub", "")
    if seller_sub:
        create_notification(seller_sub, "dispute", "A buyer opened a dispute",
                            f"Order {arn}: {reason.replace('_', ' ')}. Our team is reviewing it.")
    return _json_response(200, {"success": True, "dispute": _dispute_public(
        table.get_item(Key={"pk": dispute_pk}).get("Item") or {})})


def handle_dispute_get(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    params = event.get("queryStringParameters") or {}
    arn = str(params.get("arn") or "").strip()
    d = table.get_item(Key={"pk": f"DISPUTE#{arn}"}).get("Item") or {}
    if not d:
        return _json_response(200, {"dispute": None})
    if user["sub"] not in (d.get("buyer_sub"), d.get("seller_sub")):
        return _json_response(403, {"error": "Not your dispute"})
    return _json_response(200, {"dispute": _dispute_public(d)})


def handle_dispute_list(event: dict) -> dict:
    """My disputes (buyer or seller side)."""
    user, err = _require_auth(event)
    if err:
        return err
    out = []
    for it in _scan_by_pk_prefix("DISPUTE#"):
        if user["sub"] in (it.get("buyer_sub"), it.get("seller_sub")):
            out.append(_dispute_public(it))
    out.sort(key=lambda d: d.get("created_at", ""), reverse=True)
    return _json_response(200, {"disputes": out})


def admin_dispute_list(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    out = [_dispute_public(it) for it in _scan_by_pk_prefix("DISPUTE#")]
    out.sort(key=lambda d: (d.get("status") != "open", d.get("created_at", "")), reverse=False)
    return _json_response(200, {"disputes": out})


def admin_dispute_resolve(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    arn = str(body.get("arn") or "").strip()
    status = str(body.get("status") or "").strip().lower()
    note = str(body.get("resolution_note") or "").strip()[:1000]
    if status not in ("under_review", "resolved", "rejected"):
        return _json_response(400, {"error": "Invalid status"})
    d = table.get_item(Key={"pk": f"DISPUTE#{arn}"}).get("Item") or {}
    if not d:
        return _json_response(404, {"error": "Dispute not found"})
    table.update_item(
        Key={"pk": f"DISPUTE#{arn}"},
        UpdateExpression="SET #s = :s, resolution_note = :n, updated_at = :t",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": status, ":n": note, ":t": _now()},
    )
    if d.get("buyer_sub"):
        msg = {"resolved": "resolved in your favour", "rejected": "reviewed and closed",
               "under_review": "now under review"}.get(status, "updated")
        create_notification(d["buyer_sub"], "dispute", "Dispute update",
                            f"Order {arn}: your dispute has been {msg}." + (f" {note}" if note else ""))
    return _json_response(200, {"success": True})


def handle_order_invoice(event: dict) -> dict:
    """Fetch the GST invoice for one order (Batch: Phase 1).

    The invoice was previously generated on delivery-completion and pushed out
    once over WhatsApp/email, then forgotten — nothing stored the URL, so a
    buyer could never re-download it. delivery.handle_delivery_complete now
    persists `invoice_url`; this exposes it to the three parties who are
    entitled to it (buyer, the shop that sold it, the partner who delivered).
    """
    user, err = _require_auth(event)
    if err:
        return err
    params = event.get("queryStringParameters") or {}
    arn = str(params.get("arn") or "").strip()
    if not arn:
        return _json_response(400, {"error": "arn required"})

    rec = table.get_item(Key={"pk": f"DELIVERY#ARN#{arn}"}).get("Item") or {}
    if not rec:
        rec = table.get_item(Key={"pk": f"ORDER#{arn}"}).get("Item") or {}
    if not rec:
        return _json_response(404, {"error": "Order not found"})

    sub = user["sub"]
    seller_subs = {rec.get("seller_user_sub", ""), rec.get("seller_sub", "")}
    shop = get_shop_by_user(sub) or {}
    is_seller = sub in seller_subs or (shop.get("shop_id") and shop["shop_id"] == rec.get("shop_id"))
    if not (sub == rec.get("importer_sub") or sub == rec.get("claimed_by") or is_seller):
        return _json_response(403, {"error": "You are not a party to this order"})

    url = rec.get("invoice_url", "")
    if not url:
        return _json_response(200, {
            "invoice_url": "",
            "status": rec.get("status", ""),
            "message": "Invoice is generated once the delivery is completed.",
        })
    return _json_response(200, {
        "invoice_url": url,
        "generated_at": rec.get("invoice_generated_at", ""),
        "arn": arn,
    })


def handle_product_view(event: dict) -> dict:
    """Increment a product's view counter (Phase 2, powers seller analytics).
    Fired when a buyer opens the product detail. The client sends the product's
    own pk so this is an O(1) update, not a scan. Public — no auth needed."""
    body = _event_body(event)
    pk = str(body.get("pk") or "").strip()
    # Only ever touch catalogue product rows.
    if not pk.startswith("CATALOGUE#CATEGORY#"):
        return _json_response(400, {"error": "invalid product reference"})
    try:
        table.update_item(
            Key={"pk": pk},
            UpdateExpression="SET view_count = if_not_exists(view_count, :z) + :one",
            ConditionExpression="attribute_exists(pk)",
            ExpressionAttributeValues={":z": 0, ":one": 1},
        )
    except ClientError:
        pass  # product may have been removed — views are best-effort
    return _json_response(200, {"success": True})


# ══════════════════════════════════════════════════════════════
# REFERRAL PROGRAM (Phase 2 · growth)
#   REFERRALCODE#<code>            -> referrer's user_sub  (code lookup)
#   REFERRAL#<referrer>#<referee>  the referral link + status/reward
#   profile.referral_code / .referral_count / .referral_credits / .referred_by
# Referrer earns credit once the referee completes their FIRST order (gated so
# fake signups don't pay out). Both sides get REFERRAL_REWARD_INR.
# ══════════════════════════════════════════════════════════════
REFERRAL_REWARD_INR = int(os.environ.get("REFERRAL_REWARD_INR", "100"))
_REFERRAL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no ambiguous chars


def _gen_referral_code(user_sub: str) -> str:
    """Return this user's referral code, generating + persisting one on first
    use. The REFERRALCODE# row lets us resolve a code back to its owner."""
    prof = get_profile(user_sub) or {}
    if prof.get("referral_code"):
        return prof["referral_code"]
    import random
    name = (prof.get("user_name") or "AX").upper()
    prefix = "".join([c for c in name if c in _REFERRAL_ALPHABET])[:3] or "AX"
    for _ in range(6):
        code = prefix + "".join(random.choice(_REFERRAL_ALPHABET) for _ in range(4))
        if not table.get_item(Key={"pk": f"REFERRALCODE#{code}"}).get("Item"):
            table.put_item(Item={"pk": f"REFERRALCODE#{code}", "code": code, "user_sub": user_sub, "created_at": _now()})
            upsert_profile(user_sub, {"referral_code": code})
            return code
    # extremely unlikely fallback
    code = prefix + user_sub[-4:].upper()
    upsert_profile(user_sub, {"referral_code": code})
    return code


def handle_referral_code(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    code = _gen_referral_code(user["sub"])
    prof = get_profile(user["sub"]) or {}
    base = CLOUDFRONT_BASE.rstrip("/")
    return _json_response(200, {
        "code": code,
        "share_url": f"{base}/portal.html?ref={code}",
        "referral_count": int(_decimal(prof.get("referral_count", 0))),
        "referral_credits": int(_decimal(prof.get("referral_credits", 0))),
        "referred_by": prof.get("referred_by", ""),
        "reward_inr": REFERRAL_REWARD_INR,
    })


def handle_referral_apply(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    code = str(body.get("code") or "").strip().upper()
    if not code:
        return _json_response(400, {"error": "Referral code required"})
    prof = get_profile(user["sub"]) or {}
    if prof.get("referred_by"):
        return _json_response(400, {"error": "You've already used a referral code"})
    ref = table.get_item(Key={"pk": f"REFERRALCODE#{code}"}).get("Item")
    if not ref:
        return _json_response(404, {"error": "Invalid referral code"})
    referrer_sub = ref.get("user_sub", "")
    if referrer_sub == user["sub"]:
        return _json_response(400, {"error": "You can't use your own code"})
    # Record the (pending) referral and stamp the referee's profile.
    table.put_item(Item={
        "pk": f"REFERRAL#{referrer_sub}#{user['sub']}",
        "referrer_sub": referrer_sub,
        "referee_sub": user["sub"],
        "referee_name": (get_profile(user["sub"]) or {}).get("user_name", ""),
        "status": "pending",
        "created_at": _now(),
    })
    upsert_profile(user["sub"], {"referred_by": code})
    referrer_prof = get_profile(referrer_sub) or {}
    create_notification(referrer_sub, "referral", "New referral joined",
                        f"{prof.get('user_name', 'Someone')} joined with your code. You'll earn ₹{REFERRAL_REWARD_INR} when they place their first order.")
    return _json_response(200, {"success": True, "referrer_name": referrer_prof.get("user_name", "")})


def handle_referral_list(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    out = []
    for it in _scan_by_pk_prefix(f"REFERRAL#{user['sub']}#"):
        out.append({
            "referee_name": it.get("referee_name", "Aarvex user"),
            "status": it.get("status", "pending"),
            "created_at": it.get("created_at", ""),
            "reward_inr": int(_decimal(it.get("reward_inr", 0))),
        })
    out.sort(key=lambda r: r.get("created_at", ""), reverse=True)
    prof = get_profile(user["sub"]) or {}
    return _json_response(200, {
        "referrals": out,
        "referral_count": int(_decimal(prof.get("referral_count", 0))),
        "referral_credits": int(_decimal(prof.get("referral_credits", 0))),
    })


def _maybe_reward_referral(referee_sub: str) -> None:
    """Called after a buyer's order is created. If this buyer was referred and
    the referral is still pending, reward both sides once. Best-effort — never
    blocks the order."""
    if not referee_sub:
        return
    try:
        prof = get_profile(referee_sub) or {}
        code = prof.get("referred_by")
        if not code:
            return
        ref_code = table.get_item(Key={"pk": f"REFERRALCODE#{code}"}).get("Item")
        if not ref_code:
            return
        referrer_sub = ref_code.get("user_sub", "")
        link_pk = f"REFERRAL#{referrer_sub}#{referee_sub}"
        link = table.get_item(Key={"pk": link_pk}).get("Item")
        if not link or link.get("status") != "pending":
            return  # already rewarded or missing
        # Mark rewarded + credit both sides.
        table.update_item(
            Key={"pk": link_pk},
            UpdateExpression="SET #s = :s, reward_inr = :r, rewarded_at = :t",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": "rewarded", ":r": REFERRAL_REWARD_INR, ":t": _now()},
        )
        for sub in (referrer_sub, referee_sub):
            p = get_profile(sub) or {}
            upsert_profile(sub, {
                "referral_credits": int(_decimal(p.get("referral_credits", 0))) + REFERRAL_REWARD_INR,
                "referral_count": int(_decimal(p.get("referral_count", 0))) + (1 if sub == referrer_sub else 0),
            })
        create_notification(referrer_sub, "referral", "Referral reward earned! 🎉",
                            f"You earned ₹{REFERRAL_REWARD_INR} — your referral placed their first order.")
        create_notification(referee_sub, "referral", "Welcome bonus! 🎉",
                            f"You earned ₹{REFERRAL_REWARD_INR} in referral credit on your first order.")
    except Exception as e:
        logger.warning("[REFERRAL] reward failed: %s", e)


def handle_shop_analytics(event: dict) -> dict:
    """Seller dashboard metrics (Phase 2). Aggregated from data that already
    exists — products, ratings, the payout ledger and RFQs — so no new
    tracking infra is required. Sellers stay engaged when they can see how
    their shop is performing."""
    user, err = _require_auth(event)
    if err:
        return err
    shop = get_shop_by_user(user["sub"])
    if not shop:
        return _json_response(404, {"error": "No shop found"})
    shop_id = shop.get("shop_id", "")

    products, ratings_sum, rated = [], 0.0, 0
    for it in _scan_by_pk_prefix("CATALOGUE#CATEGORY#"):
        if it.get("shop_id") != shop_id:
            continue
        r = float(_decimal(it.get("avg_rating", 0)))
        if r > 0:
            ratings_sum += r
            rated += 1
        products.append({
            "product_id": it.get("product_id", ""),
            "product_name": it.get("product_name", ""),
            "price_per_kg": _json_num(it.get("price_per_kg", 0)),
            "avg_rating": r,
            "total_reviews": int(_decimal(it.get("total_reviews", 0))),
            "views": int(_decimal(it.get("view_count", 0))),
            "lot_status": it.get("lot_status", "available"),
        })

    sold = pending = paid = cod = online = order_count = 0.0
    for it in _scan_by_pk_prefix("PAYOUT#"):
        if it.get("payee_sub") != user["sub"] or it.get("payee_type") != "seller":
            continue
        amt = float(_decimal(it.get("amount", 0)))
        sold += amt
        order_count += 1
        if it.get("status") == "paid":
            paid += amt
        else:
            pending += amt
        pm = it.get("payment_method", "online")
        if pm == "cod":
            cod += amt
        else:
            online += amt

    open_rfqs = sum(1 for it in _scan_by_pk_prefix("RFQ#")
                    if it.get("seller_sub") == user["sub"] and it.get("status") == "open")

    top_products = sorted(products, key=lambda p: (p["total_reviews"], p["avg_rating"], p["views"]), reverse=True)[:5]
    return _json_response(200, {
        "shop_id": shop_id,
        "shop_name": shop.get("shop_name") or shop_id,
        "product_count": len(products),
        "total_views": sum(p["views"] for p in products),
        "avg_rating": round(ratings_sum / rated, 2) if rated else 0.0,
        "total_reviews": sum(p["total_reviews"] for p in products),
        "like_count": int(_decimal(shop.get("like_count", 0))),
        "sales": {
            "revenue": round(sold, 2), "orders": int(order_count),
            "paid": round(paid, 2), "pending": round(pending, 2),
            "cod": round(cod, 2), "online": round(online, 2),
        },
        "open_negotiations": open_rfqs,
        "top_products": top_products,
    })


def handle_account_summary(event: dict) -> dict:
    """Per-role account + history (Batch G). Aggregates the signed-in user's
    payout-ledger entries (PAYOUT#…) — the same records created on every
    delivered order — into seller and/or delivery-partner accounts: total
    owed, pending vs paid, COD-vs-online split, and a recent-transactions
    list. Company GST + platform fee are retained (not payout entries), so we
    surface them as a note rather than a line the payee is owed."""
    user, err = _require_auth(event)
    if err:
        return err

    def _blank():
        return {"total": 0.0, "pending": 0.0, "paid": 0.0, "cod": 0.0, "online": 0.0, "count": 0}

    roles = {}
    txns = []
    for it in _scan_by_pk_prefix("PAYOUT#"):
        if it.get("payee_sub") != user["sub"]:
            continue
        ptype = it.get("payee_type", "seller")
        amt = float(_decimal(it.get("amount", 0)))
        status = it.get("status", "pending")
        pm = it.get("payment_method", "online")
        pm = pm if pm in ("cod", "online") else "online"
        r = roles.setdefault(ptype, _blank())
        r["total"] += amt
        r["count"] += 1
        r["paid" if status == "paid" else "pending"] += amt
        r[pm] += amt
        txns.append({
            "arn": it.get("arn", ""),
            "payee_type": ptype,
            "amount": amt,
            "status": status,
            "payment_method": pm,
            "created_at": it.get("created_at", ""),
            "paid_at": it.get("paid_at", ""),
        })
    txns.sort(key=lambda t: t.get("created_at", ""), reverse=True)
    return _json_response(200, {"roles": roles, "transactions": txns[:50]})


def _safe_product_id(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", value or "")[:80]


def _get_seller_product(user_sub: str, product_id: str, category_id: str = "") -> dict:
    for item in _scan_by_pk_prefix("CATALOGUE#CATEGORY#"):
        if item.get("seller_user_sub") != user_sub:
            continue
        pid = item.get("product_id", "")
        if pid == product_id and (not category_id or item.get("category_id") == category_id):
            return item
    return {}


def _get_claimed_orders_by_product() -> dict:
    """Seller-side open-order visibility: any in-flight delivery for this
    product (placed → claimed → transit) until COMPLETE or CANCEL."""
    out: dict[str, list] = {}
    if not _delivery_mod:
        return out
    active_statuses = (
        "PENDING_DELIVERY", "PENDING_APPROVAL",
        "DELIVERY_ASSIGNED", "IN_TRANSIT", "NEAR_DESTINATION",
    )
    for item in _delivery_mod._scan_prefix("DELIVERY#ARN#"):
        product_pk = item.get("product_pk", "")
        if not product_pk or item.get("status") not in active_statuses:
            continue
        claimed_by = item.get("claimed_by", "")
        partner_contact = get_delivery_partner_contact(claimed_by) if claimed_by else {}
        qty = item.get("committed_kg") or item.get("reserved_kg") or item.get("lot_size_kg", 0)
        out.setdefault(product_pk, []).append({
            "arn": item.get("arn", ""),
            "buyer_name": item.get("buyer_name", ""),
            "buyer_mobile": item.get("buyer_mobile", ""),
            "delivery_partner_name": partner_contact.get("name", ""),
            "delivery_partner_mobile": partner_contact.get("phone", ""),
            "status": item.get("status", ""),
            "reserved_kg": _json_num(qty),
            "ordered_kg": _json_num(qty),
        })
    return out


def handle_shop_products_list(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    shop = get_shop_by_user(user["sub"])
    claimed_by_product = _get_claimed_orders_by_product()
    products = []
    for item in _scan_by_pk_prefix("CATALOGUE#CATEGORY#"):
        if item.get("seller_user_sub") == user["sub"]:
            ser = serialize_product(item, include_paused=True)
            if ser:
                claims = claimed_by_product.get(ser.get("pk", ""), [])
                if claims:
                    ser["claimed_orders"] = claims
                products.append(ser)
    return _json_response(200, {"products": products, "shop": shop.get("shop_id", "")})


def handle_shop_product_add(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    shop = get_shop_by_user(user["sub"])
    if not shop or shop.get("status") == "blocked":
        return _json_response(403, {"error": "Active shop required"})
    kyc = get_kyc(user["sub"])
    if kyc.get("status") != "approved":
        return _json_response(403, {"error": "KYC not approved"})

    category_id = (body.get("category_id") or body.get("category_name") or "other").strip().lower().replace(" ", "_")
    category_name = (body.get("category_name") or category_id.replace("_", " ").title()).strip()
    product_name = (body.get("product_name") or "").strip()
    if not product_name:
        return _json_response(400, {"error": "product_name required"})
    product_id = (body.get("product_id") or "").strip() or _safe_product_id(product_name.lower().replace(" ", "_"))[:40]

    lot_size = _decimal(body.get("lot_size_kg"), Decimal("0"))
    price_kg = _decimal(body.get("price_per_kg") or 0)
    if lot_size <= 0:
        return _json_response(400, {"error": "lot_size_kg is required (fixed lot listing)"})
    lot_price = lot_size * price_kg if price_kg > 0 else _decimal(body.get("lot_price"), Decimal("0"))
    # Optional "original"/comparison price the seller can set to show a
    # strikethrough MRP + discount badge on the storefront. Left at 0 when
    # not provided — serialize_product() then omits the discount entirely.
    mrp_kg = _decimal(body.get("mrp_price_per_kg") or 0)

    image_urls = []
    for i, b64 in enumerate(body.get("images_b64") or []):
        if b64:
            key = _upload_b64_to_s3(b64, f"products/{shop['shop_id']}", f"{product_id}_{i}")
            if key:
                image_urls.append(_public_s3_url(key))
    if body.get("image_url"):
        image_urls.append(body["image_url"])

    pk = f"CATALOGUE#CATEGORY#{category_id}#{product_id}"
    item = {
        "pk": pk,
        "category_id": category_id,
        "category_name": category_name,
        "product_id": product_id,
        "product_name": product_name,
        "description": (body.get("description") or "")[:500],
        "price_per_kg": price_kg,
        "mrp_price_per_kg": mrp_kg,
        "lot_size_kg": lot_size,
        "available_stock_kg": lot_size,
        "initial_stock_kg": lot_size,
        "committed_kg": Decimal("0"),
        "lot_price": lot_price,
        "lot_status": "available",
        "min_order_kg": lot_size,
        "available_stock": f"1 lot ({int(lot_size)} kg)",
        "image_url": image_urls[0] if image_urls else "",
        "image_urls": image_urls,
        "is_active": True,
        "is_paused": False,
        "is_seller_product": True,
        "seller_user_sub": user["sub"],
        "shop_id": shop["shop_id"],
        "shop_name": shop.get("shop_name") or shop["shop_id"],
        "avg_rating": Decimal("0"),
        "total_reviews": 0,
        "updated_at": _now(),
    }
    table.put_item(Item=item)
    table.update_item(
        Key={"pk": f"SHOP#{shop['shop_id']}"},
        UpdateExpression="SET product_count = if_not_exists(product_count, :z) + :one",
        ExpressionAttributeValues={":z": 0, ":one": 1},
    )
    _fire_price_alerts(product_name, category_name, float(_decimal(price_kg)))
    return _json_response(200, {"success": True, "product_id": product_id, "pk": pk})


def handle_shop_product_edit(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    product_id = body.get("product_id", "")
    category_id = body.get("category_id", "")
    existing = _get_seller_product(user["sub"], product_id, category_id)
    if not existing:
        return _json_response(404, {"error": "Product not found"})

    updates = {}
    for field, key in (
        ("product_name", "product_name"), ("description", "description"),
        ("available_stock", "available_stock"), ("category_name", "category_name"),
    ):
        if body.get(field) is not None:
            updates[key] = body[field]

    # Refill: add kg to available without wiping open commits
    if body.get("refill_kg") is not None:
        add = _decimal(body.get("refill_kg"), Decimal("0"))
        if add > 0:
            cur = _decimal(existing.get("available_stock_kg"), _decimal(existing.get("lot_size_kg", 0)))
            new_avail = cur + add
            updates["available_stock_kg"] = new_avail
            updates["lot_size_kg"] = max(_decimal(existing.get("lot_size_kg", 0)), new_avail)
            init = _decimal(existing.get("initial_stock_kg"), _decimal(existing.get("lot_size_kg", 0)))
            if new_avail > init:
                updates["initial_stock_kg"] = new_avail
            updates["is_active"] = True
            updates["lot_status"] = "available"
            updates["available_stock"] = f"In stock ({int(new_avail)} kg)"
            # Clear low-stock flag when restocked
            try:
                table.update_item(
                    Key={"pk": existing["pk"]},
                    UpdateExpression="REMOVE low_stock_alerted, low_stock_alerted_at",
                )
            except Exception:
                pass

    if body.get("lot_size_kg") is not None and body.get("refill_kg") is None:
        ls = _decimal(body["lot_size_kg"])
        updates["lot_size_kg"] = ls
        # Explicit set-new-lot (seller confirm on UI) — reset remaining
        updates["available_stock_kg"] = ls
        updates["initial_stock_kg"] = ls
        updates["committed_kg"] = Decimal("0")
        updates["is_active"] = True
        updates["lot_status"] = "available"
        pk = _decimal(body.get("price_per_kg") or existing.get("price_per_kg", 0))
        updates["lot_price"] = ls * pk
        updates["min_order_kg"] = ls
        updates["available_stock"] = f"1 lot ({int(ls)} kg)"
        try:
            table.update_item(
                Key={"pk": existing["pk"]},
                UpdateExpression="REMOVE low_stock_alerted, low_stock_alerted_at",
            )
        except Exception:
            pass
    if body.get("price_per_kg") is not None:
        updates["price_per_kg"] = Decimal(str(body["price_per_kg"]))
        ls = _decimal(updates.get("lot_size_kg", existing.get("lot_size_kg", 0)))
        if ls > 0:
            updates["lot_price"] = ls * updates["price_per_kg"]
    if body.get("mrp_price_per_kg") is not None:
        # Optional — sending an empty string / 0 clears the MRP (no discount shown).
        updates["mrp_price_per_kg"] = _decimal(body.get("mrp_price_per_kg") or 0)
    if body.get("min_order_kg") is not None and not body.get("lot_size_kg") and body.get("refill_kg") is None:
        updates["min_order_kg"] = Decimal(str(body["min_order_kg"]))
    if body.get("images_b64"):
        urls = list(existing.get("image_urls") or [])
        for i, b64 in enumerate(body["images_b64"]):
            if b64:
                key = _upload_b64_to_s3(b64, f"products/{existing.get('shop_id')}", f"{product_id}_e{i}")
                if key:
                    urls.append(_public_s3_url(key))
        if urls:
            updates["image_urls"] = urls
            updates["image_url"] = urls[0]
    updates["updated_at"] = _now()

    if not updates:
        return _json_response(400, {"error": "No fields to update"})

    names = {f"#k{i}": k for i, k in enumerate(updates)}
    values = {f":v{i}": v for i, v in enumerate(updates.values())}
    expr = "SET " + ", ".join(f"{n} = {v}" for n, v in zip(names, values))
    table.update_item(
        Key={"pk": existing["pk"]},
        UpdateExpression=expr,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )
    # If the price dropped, wake up any matching price alerts.
    if "price_per_kg" in updates:
        try:
            new_price = float(updates["price_per_kg"])
            old_price = float(_decimal(existing.get("price_per_kg", 0)))
            if new_price > 0 and (old_price == 0 or new_price < old_price):
                _fire_price_alerts(
                    updates.get("product_name", existing.get("product_name", "")),
                    updates.get("category_name", existing.get("category_name", "")),
                    new_price,
                )
        except Exception:
            pass
    return _json_response(200, {"success": True})


def handle_shop_product_delete(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    existing = _get_seller_product(user["sub"], body.get("product_id", ""), body.get("category_id", ""))
    if not existing:
        return _json_response(404, {"error": "Product not found"})
    table.delete_item(Key={"pk": existing["pk"]})
    shop_id = existing.get("shop_id", "")
    if shop_id:
        try:
            table.update_item(
                Key={"pk": f"SHOP#{shop_id}"},
                UpdateExpression="SET product_count = product_count - :one",
                ExpressionAttributeValues={":one": 1},
            )
        except Exception:
            pass
    return _json_response(200, {"success": True})


def handle_shop_product_pause(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    existing = _get_seller_product(user["sub"], body.get("product_id", ""), body.get("category_id", ""))
    if not existing:
        return _json_response(404, {"error": "Product not found"})
    paused = body.get("is_paused")
    if paused is None:
        paused = not existing.get("is_paused", False)
    table.update_item(
        Key={"pk": existing["pk"]},
        UpdateExpression="SET is_paused = :p, updated_at = :u",
        ExpressionAttributeValues={":p": bool(paused), ":u": _now()},
    )
    return _json_response(200, {"success": True, "is_paused": bool(paused)})


def handle_review_submit(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    product_id = body.get("product_id", "")
    category_id = body.get("category_id", "")
    rating = int(body.get("rating") or 0)
    comment = (body.get("comment") or "")[:300]
    if rating < 1 or rating > 5:
        return _json_response(400, {"error": "Rating must be 1-5"})
    if not product_id:
        return _json_response(400, {"error": "product_id required"})

    dup_pk = f"REVIEW#USER#{user['sub']}#{product_id}"
    if table.get_item(Key={"pk": dup_pk}).get("Item"):
        return _json_response(400, {"error": "You already reviewed this product"})

    product = None
    for item in _scan_by_pk_prefix("CATALOGUE#CATEGORY#"):
        if item.get("product_id") == product_id and (not category_id or item.get("category_id") == category_id):
            product = item
            break
    if not product:
        return _json_response(404, {"error": "Product not found"})

    rid = str(uuid.uuid4())
    table.put_item(Item={
        "pk": f"REVIEW#{product_id}#{rid}",
        "sk": "METADATA",
        "review_id": rid,
        "product_id": product_id,
        "category_id": product.get("category_id", ""),
        "shop_id": product.get("shop_id", ""),
        "reviewer_sub": user["sub"],
        "reviewer_name": _first_name(user.get("name", "")),
        "rating": rating,
        "comment": comment,
        "created_at": _now(),
    })
    table.put_item(Item={"pk": dup_pk, "review_id": rid, "created_at": _now()})

    total = int(_decimal(product.get("total_reviews", 0))) + 1
    old_avg = _decimal(product.get("avg_rating", 0))
    new_avg = ((old_avg * (total - 1)) + Decimal(rating)) / Decimal(total)
    table.update_item(
        Key={"pk": product["pk"]},
        UpdateExpression="SET avg_rating = :a, total_reviews = :t",
        ExpressionAttributeValues={":a": new_avg.quantize(Decimal("0.1")), ":t": total},
    )
    shop_id = product.get("shop_id", "")
    if shop_id:
        shop = get_shop(shop_id)
        owner = shop.get("user_sub", "")
        if owner:
            stars = "★" * rating + "☆" * (5 - rating)
            create_notification(
                owner, "new_review",
                f"New review on {product.get('product_name', 'product')}",
                f"Someone left a {stars} review on your {product.get('product_name', 'product')}",
            )
    return _json_response(200, {"success": True})


def handle_reviews_list(event: dict) -> dict:
    params = event.get("queryStringParameters") or {}
    product_id = params.get("product_id", "")
    if not product_id:
        return _json_response(400, {"error": "product_id required"})
    reviews = []
    for item in _scan_by_pk_prefix(f"REVIEW#{product_id}#"):
        if item.get("sk") == "METADATA" or "rating" in item:
            reviews.append({
                "reviewer_name": item.get("reviewer_name", "Customer"),
                "rating": int(item.get("rating", 0)),
                "comment": item.get("comment", ""),
                "created_at": item.get("created_at", ""),
            })
    reviews.sort(key=lambda r: r.get("created_at", ""), reverse=True)
    return _json_response(200, {"reviews": reviews[:50]})


def handle_notifications_list(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    prefix = f"NOTIFICATION#USER#{user['sub']}#"
    items = _scan_by_pk_prefix(prefix)
    items.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    unread = sum(1 for i in items if not i.get("is_read"))
    out = [{
        "notification_id": i.get("notification_id", i["pk"].split("#")[-1]),
        "type": i.get("type", ""),
        "title": i.get("title", ""),
        "body": i.get("body", ""),
        "is_read": bool(i.get("is_read")),
        "created_at": i.get("created_at", ""),
        "ticket_id": i.get("ticket_id", ""),
        "reference_id": i.get("reference_id", ""),
        "listing_crop": i.get("listing_crop", ""),
        # Deep-link routing (B1) — these were stored on the record but never
        # passed through, so the Track/Call buttons + tap-to-open never worked.
        "arn": i.get("arn", ""),
        "track_arn": i.get("track_arn", ""),
        "call_phone": i.get("call_phone", ""),
        "call_name": i.get("call_name", ""),
        "link_type": i.get("link_type", ""),
        "link_id": i.get("link_id", ""),
        "from_sub": i.get("from_sub", ""),
        "from_name": i.get("from_name", ""),
        "from_photo": i.get("from_photo", ""),
        "post_id": i.get("post_id", ""),
    } for i in items[:100]]
    return _json_response(200, {"notifications": out, "unread": unread})


def handle_notifications_read(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    mark_all = body.get("mark_all")
    nid = body.get("notification_id", "")
    prefix = f"NOTIFICATION#USER#{user['sub']}#"
    if mark_all:
        for item in _scan_by_pk_prefix(prefix):
            if not item.get("is_read"):
                table.update_item(
                    Key={"pk": item["pk"]},
                    UpdateExpression="SET is_read = :r",
                    ExpressionAttributeValues={":r": True},
                )
        return _json_response(200, {"success": True})
    if nid:
        pk = f"{prefix}{nid}" if not nid.startswith("NOTIFICATION#") else nid
        table.update_item(
            Key={"pk": pk},
            UpdateExpression="SET is_read = :r",
            ExpressionAttributeValues={":r": True},
        )
    return _json_response(200, {"success": True})


def handle_notifications_delete(event: dict) -> dict:
    """Permanently remove one of the caller's own notifications (or all
    already-read ones with delete_all_read) — the pk-prefix guard makes it
    impossible to delete another user's records no matter what id is sent."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    prefix = f"NOTIFICATION#USER#{user['sub']}#"
    if body.get("delete_all_read"):
        deleted = 0
        for item in _scan_by_pk_prefix(prefix):
            if item.get("is_read"):
                try:
                    table.delete_item(Key={"pk": item["pk"]})
                    deleted += 1
                except Exception:
                    logger.exception("[NOTIFICATIONS] bulk delete failed for %s", item.get("pk"))
        return _json_response(200, {"success": True, "deleted": deleted})
    nid = str(body.get("notification_id") or "").strip()
    if not nid:
        return _json_response(400, {"error": "notification_id is required"})
    pk = f"{prefix}{nid}" if not nid.startswith("NOTIFICATION#") else nid
    if not pk.startswith(prefix):
        return _json_response(403, {"error": "Not your notification"})
    try:
        table.delete_item(Key={"pk": pk})
    except Exception:
        logger.exception("[NOTIFICATIONS] delete failed")
        return _json_response(500, {"error": "Could not delete notification"})
    return _json_response(200, {"success": True})


def handle_profile_update(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    register_portal_user(user)
    allowed = {}
    # NOTE: "mobile" added so a delivery partner's contact number is
    # reliably persisted server-side (previously silently dropped here) —
    # needed to show a "call delivery partner" number on the buyer's
    # live tracking map.
    #
    # NOTE (profile-persistence fix): the portal's "Complete your profile"
    # form (saveProfile() in portal.html) sends name/email/address/city/
    # state/pincode/country/gst/farm_location/lat/lng too, but this
    # whitelist used to silently drop all of them — only mobile/phone/dob/
    # gender/account_status ever reached DynamoDB. That's why the profile
    # looked "saved" (localStorage) on the same browser but came back
    # empty on any other device/browser: there was nothing to restore.
    # Expanded the whitelist to cover every field the form actually saves.
    # SECURITY: account_status is NOT here — a user must never be able to change
    # their own moderation status (that would let a blacklisted user reactivate
    # themselves). Only admin_user_moderate() can write account_status.
    for k in (
        "name", "phone", "mobile", "email", "company_name", "address", "city", "state",
        "pincode", "country", "gst_number", "farm_location", "address_lat", "address_lng",
        # Delivery V2 — dedicated Shop Pickup Address, separate from the personal
        # / delivery address so the delivery triangle's shop leg is correct.
        "shop_address", "shop_city", "shop_state", "shop_pincode", "shop_lat", "shop_lng",
        "dob", "gender", "saved_addresses",
        # delivery partner's vehicle number — shown to the importer on the
        # Track strip so they can identify the rider (like Zomato/Swiggy).
        "vehicle_number", "delivery_radius_km",
        "bio", "username",
    ):
        if k in body:
            allowed[k] = body[k]
    if "delivery_radius_km" in allowed:
        try:
            radius = float(allowed["delivery_radius_km"] or 0)
            if radius < 0 or radius > 500:
                return _json_response(400, {"error": "Delivery radius must be between 0 and 500 km"})
            allowed["delivery_radius_km"] = str(radius)
        except (TypeError, ValueError):
            return _json_response(400, {"error": "Invalid delivery radius"})
    if allowed.get("username"):
        un = str(allowed["username"]).strip().lower()
        import re
        if re.match(r"^[a-z0-9_]{3,30}$", un):
            allowed["username"] = un
        else:
            del allowed["username"]
    if allowed.get("name"):
        allowed["user_name"] = str(allowed["name"]).strip()[:120]
    if allowed:
        has_lat = str(allowed.get("address_lat") or get_profile(user["sub"]).get("address_lat") or "").strip()
        has_lng = str(allowed.get("address_lng") or get_profile(user["sub"]).get("address_lng") or "").strip()
        if not (has_lat and has_lng):
            pin = str(allowed.get("pincode") or get_profile(user["sub"]).get("pincode") or "").strip()
            if pin and PLATFORM_UTILS_OK:
                try:
                    from platform_utils import geocode_pincode

                    g = geocode_pincode(pin)
                    if g:
                        allowed["address_lat"] = str(g[0])
                        allowed["address_lng"] = str(g[1])
                except Exception:
                    pass
    # Delivery V2: geocode the dedicated Shop Pickup Address from its pincode
    # when the seller set a shop address/pincode but no map pin.
    if allowed and (allowed.get("shop_lat") or allowed.get("shop_lng") or allowed.get("shop_pincode")):
        _has_slat = str(allowed.get("shop_lat") or get_profile(user["sub"]).get("shop_lat") or "").strip()
        _has_slng = str(allowed.get("shop_lng") or get_profile(user["sub"]).get("shop_lng") or "").strip()
        if not (_has_slat and _has_slng):
            _spin = str(allowed.get("shop_pincode") or get_profile(user["sub"]).get("shop_pincode") or "").strip()
            if _spin and PLATFORM_UTILS_OK:
                try:
                    from platform_utils import geocode_pincode

                    _sg = geocode_pincode(_spin)
                    if _sg:
                        allowed["shop_lat"] = str(_sg[0])
                        allowed["shop_lng"] = str(_sg[1])
                except Exception:
                    pass
    if allowed:
        upsert_profile(user["sub"], allowed)
    prof = get_profile(user["sub"])
    # A Personal Information address is the single source of truth for a shop
    # too. Updating it from either Profile or Home → All areas must therefore
    # update the existing shop immediately, rather than waiting for a later
    # shop-edit action to happen.
    if any(k in allowed for k in ("address", "city", "state", "pincode", "address_lat", "address_lng",
                                  "shop_address", "shop_city", "shop_state", "shop_pincode",
                                  "shop_lat", "shop_lng")):
        shop = get_shop_by_user(user["sub"])
        if shop:
            owner_addr = _owner_address(user["sub"])
            table.update_item(
                Key={"pk": shop["pk"]},
                UpdateExpression=(
                    "SET address_full = :full, address_city = :city, address_state = :state, "
                    "address_pincode = :pin, address_lat = :lat, address_lng = :lng"
                ),
                ExpressionAttributeValues={
                    ":full": owner_addr["address_full"], ":city": owner_addr["address_city"],
                    ":state": owner_addr["address_state"], ":pin": owner_addr["address_pincode"],
                    ":lat": owner_addr["address_lat"], ":lng": owner_addr["address_lng"],
                },
            )
    return _json_response(200, {"success": True, "profile": prof})


def handle_profile_get(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    register_portal_user(user)
    prof = get_profile(user["sub"])
    kyc = get_kyc(user["sub"])
    shop = get_shop_by_user(user["sub"])
    return _json_response(200, {"profile": prof, "kyc_status": kyc.get("status", "none"), "shop_id": shop.get("shop_id", "")})


def _ad_placement(event: dict, body: dict | None = None) -> str:
    params = event.get("queryStringParameters") or {}
    placement = (body or {}).get("placement") or params.get("placement") or "dashboard"
    # Independently-managed ad slots:
    #   dashboard → Home banner
    #   trade     → Trade tab header banner
    #   trade_mid / trade_mid2 / trade_mid3 → the swipeable promo carousel
    #        between category sections in the Trade feed (up to 3 slides,
    #        each with its own title + subline)
    #   trade_bottom → slot below the product grid
    return placement if placement in {
        "dashboard", "trade", "trade_mid", "trade_mid2", "trade_mid3", "trade_bottom"
    } else "dashboard"


# ── District-aware ad targeting (Phase 1) ──────────────────────────────
# An ad can be scoped to a single district, a whole state, or nationally.
# When serving, the most specific active ad wins and we fall back outward so
# a slot is never left empty:
#     district  →  state  →  national  →  legacy national
# State/district names are slugified, so the admin and the client can send
# readable names ("Nagpur") and still match on the same key.

def _ad_slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (value or "").strip().lower()).strip("-")


def _ad_key(placement: str) -> str:
    """Legacy national key — kept so ads published before targeting still show."""
    return f"AD#ACTIVE#{placement.upper()}"


def _ad_serve_keys(placement: str, state: str = "", district: str = "") -> list[str]:
    """Ordered list of pks to try when serving — most specific first."""
    p = placement.upper()
    d, s = _ad_slug(district), _ad_slug(state)
    keys = []
    if d:
        keys.append(f"AD#SLOT#{p}#DISTRICT#{d}")
    if s:
        keys.append(f"AD#SLOT#{p}#STATE#{s}")
    keys.append(f"AD#SLOT#{p}#NATIONAL")
    keys.append(_ad_key(placement))  # legacy back-compat
    return keys


def _ad_store_key(placement: str, scope: str, state: str = "", district: str = "") -> str:
    """Where an uploaded ad is stored, based on the admin-chosen scope."""
    p = placement.upper()
    scope = (scope or "national").lower()
    if scope == "district" and _ad_slug(district):
        return f"AD#SLOT#{p}#DISTRICT#{_ad_slug(district)}"
    if scope == "state" and _ad_slug(state):
        return f"AD#SLOT#{p}#STATE#{_ad_slug(state)}"
    return f"AD#SLOT#{p}#NATIONAL"


def _ad_payload(item: dict, placement: str) -> dict:
    return {"ad": {
        "image_url": item.get("image_url", ""),
        "link_url": item.get("link_url", ""),
        "alt_text": item.get("alt_text", ""),
        "title": item.get("title", ""),
        "subtitle": item.get("subtitle", ""),
        "media_type": item.get("media_type", "image"),
        "placement": placement,
        "scope": item.get("scope", ""),
        "target_state": item.get("target_state", ""),
        "target_district": item.get("target_district", ""),
    }}


def handle_ad_active(event: dict) -> dict:
    placement = _ad_placement(event)
    params = event.get("queryStringParameters") or {}
    state = params.get("state") or ""
    district = params.get("district") or ""
    # Phase 2 campaigns (scheduled/rotated/tracked) win over a Phase-1 single ad.
    camp = _serve_campaign(placement, state, district)
    if camp:
        return _json_response(200, _camp_payload(camp, placement))
    for key in _ad_serve_keys(placement, state, district):
        item = table.get_item(Key={"pk": key}).get("Item") or {}
        if item.get("image_url"):
            return _json_response(200, _ad_payload(item, placement))
    # Very old global default (pre-placement) — dashboard only.
    if placement == "dashboard":
        item = table.get_item(Key={"pk": "AD#ACTIVE"}).get("Item") or {}
        if item.get("image_url"):
            return _json_response(200, _ad_payload(item, placement))
    return _json_response(200, {"ad": None})


def handle_ad_upload(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    placement = _ad_placement(event, body)
    scope = (body.get("scope") or "national").lower()
    if scope not in {"national", "state", "district"}:
        scope = "national"
    target_state = (body.get("state") or "")[:60]
    target_district = (body.get("district") or "")[:60]
    if scope == "state" and not _ad_slug(target_state):
        return _json_response(400, {"error": "State required for a state-level ad"})
    if scope == "district" and not _ad_slug(target_district):
        return _json_response(400, {"error": "District required for a district-level ad"})
    media_type = body.get("media_type", "image")
    if media_type not in {"image", "gif", "video"}:
        return _json_response(400, {"error": "Invalid media type"})
    b64 = body.get("image_b64", "")
    link_url = body.get("link_url", "")
    alt_text = body.get("alt_text", "Aarvex Global")
    title = (body.get("title") or "")[:80]
    subtitle = (body.get("subtitle") or "")[:120]
    key = _upload_b64_to_s3(b64, f"banner-media/{placement}", "active_banner")
    if not key:
        url = body.get("image_url", "")
    else:
        url = _public_s3_url(key)
    if not url:
        return _json_response(400, {"error": "Media file required"})
    pk = _ad_store_key(placement, scope, target_state, target_district)
    table.put_item(Item={
        "pk": pk,
        "image_url": url,
        "link_url": link_url,
        "alt_text": alt_text,
        "title": title,
        "subtitle": subtitle,
        "media_type": media_type,
        "placement": placement,
        "scope": scope,
        "target_state": target_state,
        "target_district": target_district,
        "created_at": _now(),
        "created_by": "admin",
    })
    return _json_response(200, {
        "success": True, "image_url": url, "placement": placement,
        "media_type": media_type, "scope": scope,
        "target_state": target_state, "target_district": target_district,
    })


def handle_ad_remove(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    placement = _ad_placement(event, body)
    scope = (body.get("scope") or "national").lower()
    pk = _ad_store_key(placement, scope, body.get("state") or "", body.get("district") or "")
    try:
        table.delete_item(Key={"pk": pk})
    except Exception:
        pass
    return _json_response(200, {"success": True})


# ── Ad campaigns (Phase 2): scheduling, rotation, caps, impression/click stats ─
# A campaign is a scheduled, trackable ad. Multiple campaigns can target the same
# placement+area and are rotated. The pk encodes the serve-bucket so listing and
# serving both use the standard gsi1 prefix reader (see migrate_add_gsi.py) — the
# first pk segment is "ADCAMP", so gsi1pk/gsi1sk are derived the normal way.
#
#     pk = ADCAMP#<PLACEMENT>#<SCOPEKEY>#<cid>
#     SCOPEKEY = DISTRICT#<slug> | STATE#<slug> | NATIONAL
#
# Serving falls back district → state → national, exactly like the Phase-1 single
# ads, and campaigns take priority over a Phase-1 single ad for the same slot.

_AD_ROTATE_SECONDS = 20  # every viewer sees the same rotating pick within a window


def _camp_scopekey(scope: str, state: str = "", district: str = "") -> str | None:
    scope = (scope or "national").lower()
    if scope == "district":
        d = _ad_slug(district)
        return f"DISTRICT#{d}" if d else None
    if scope == "state":
        s = _ad_slug(state)
        return f"STATE#{s}" if s else None
    return "NATIONAL"


def _camp_prefix(placement: str, scopekey: str) -> str:
    return f"ADCAMP#{placement.upper()}#{scopekey}#"


def _camp_serve_prefixes(placement: str, state: str = "", district: str = "") -> list[str]:
    p = placement.upper()
    d, s = _ad_slug(district), _ad_slug(state)
    out = []
    if d:
        out.append(f"ADCAMP#{p}#DISTRICT#{d}#")
    if s:
        out.append(f"ADCAMP#{p}#STATE#{s}#")
    out.append(f"ADCAMP#{p}#NATIONAL#")
    return out


def _parse_iso(s: str):
    """Parse an ISO datetime; assume UTC when no offset is given. None if blank/bad."""
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _camp_active(c: dict, now_dt) -> bool:
    if c.get("status", "active") != "active":
        return False
    sa = _parse_iso(c.get("start_at"))
    ea = _parse_iso(c.get("end_at"))
    if sa and now_dt < sa:
        return False
    if ea and now_dt > ea:
        return False
    try:
        cap = int(_json_num(c.get("impression_cap", 0)))
    except (TypeError, ValueError):
        cap = 0
    if cap and int(_json_num(c.get("impressions", 0))) >= cap:
        return False
    return True


def _camp_pick(items: list[dict]) -> dict:
    """Highest priority wins; rotate evenly among a tie by a time window so all
    viewers see the same pick at a given moment (fair, stateless rotation)."""
    items.sort(key=lambda c: int(_json_num(c.get("priority", 0))), reverse=True)
    top = int(_json_num(items[0].get("priority", 0)))
    group = [c for c in items if int(_json_num(c.get("priority", 0))) == top]
    idx = int(time.time() // _AD_ROTATE_SECONDS) % len(group)
    return group[idx]


def _camp_payload(c: dict, placement: str) -> dict:
    return {"ad": {
        "image_url": c.get("image_url", ""),
        "link_url": c.get("link_url", ""),
        "alt_text": c.get("alt_text", ""),
        "title": c.get("title", ""),
        "subtitle": c.get("subtitle", ""),
        "media_type": c.get("media_type", "image"),
        "placement": placement,
        "scope": c.get("scope", ""),
        "target_state": c.get("target_state", ""),
        "target_district": c.get("target_district", ""),
        "ad_id": c.get("pk", ""),           # opaque id for impression/click tracking
        "campaign_id": c.get("campaign_id", ""),
    }}


def _serve_campaign(placement: str, state: str = "", district: str = "") -> dict | None:
    now = datetime.now(timezone.utc)
    for prefix in _camp_serve_prefixes(placement, state, district):
        try:
            items = _scan_by_pk_prefix(prefix)
        except Exception:
            items = []
        active = [c for c in items if _camp_active(c, now)]
        if active:
            return _camp_pick(active)
    return None


def handle_campaign_save(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    placement = _ad_placement(event, body)
    scope = (body.get("scope") or "national").lower()
    if scope not in {"national", "state", "district"}:
        scope = "national"
    target_state = (body.get("state") or "")[:60]
    target_district = (body.get("district") or "")[:60]
    scopekey = _camp_scopekey(scope, target_state, target_district)
    if scopekey is None:
        return _json_response(400, {"error": "State/District required for that scope"})
    media_type = body.get("media_type", "image")
    if media_type not in {"image", "gif", "video"}:
        return _json_response(400, {"error": "Invalid media type"})

    old_pk = (body.get("ad_id") or "").strip()
    prev = {}
    if old_pk.startswith("ADCAMP#"):
        prev = table.get_item(Key={"pk": old_pk}).get("Item") or {}
        cid = prev.get("campaign_id") or old_pk.split("#")[-1]
    else:
        cid = f"CMP-{uuid.uuid4().hex[:12]}"
    new_pk = f"ADCAMP#{placement.upper()}#{scopekey}#{cid}"

    b64 = body.get("image_b64", "")
    if b64:
        key = _upload_b64_to_s3(b64, f"banner-media/{placement}", "campaign")
        url = _public_s3_url(key) if key else body.get("image_url", "")
    else:
        url = body.get("image_url", "") or prev.get("image_url", "")
    if not url:
        return _json_response(400, {"error": "Media file required"})

    try:
        priority = int(body.get("priority") or 0)
    except (TypeError, ValueError):
        priority = 0
    try:
        cap = int(body.get("impression_cap") or 0)
    except (TypeError, ValueError):
        cap = 0

    item = {
        "pk": new_pk,
        "campaign_id": cid,
        "placement": placement,
        "scope": scope,
        "target_state": target_state,
        "target_district": target_district,
        "image_url": url,
        "link_url": body.get("link_url", ""),
        "alt_text": (body.get("alt_text") or "Aarvex Global")[:120],
        "title": (body.get("title") or "")[:80],
        "subtitle": (body.get("subtitle") or "")[:120],
        "media_type": media_type,
        "start_at": (body.get("start_at") or "")[:32],
        "end_at": (body.get("end_at") or "")[:32],
        "priority": priority,
        "impression_cap": cap,
        "status": (body.get("status") or prev.get("status") or "active"),
        "impressions": prev.get("impressions", _decimal(0)),
        "clicks": prev.get("clicks", _decimal(0)),
        "created_at": prev.get("created_at") or _now(),
        "updated_at": _now(),
        "created_by": "admin",
    }
    table.put_item(Item=item)
    # Targeting change moves the pk — remove the stale row so it isn't served twice.
    if old_pk and old_pk != new_pk:
        try:
            table.delete_item(Key={"pk": old_pk})
        except Exception:
            pass
    return _json_response(200, {"success": True, "ad_id": new_pk, "campaign_id": cid, "image_url": url})


def _camp_admin_view(c: dict) -> dict:
    imp = int(_json_num(c.get("impressions", 0)))
    clk = int(_json_num(c.get("clicks", 0)))
    return {
        "ad_id": c.get("pk", ""),
        "campaign_id": c.get("campaign_id", ""),
        "placement": c.get("placement", ""),
        "scope": c.get("scope", ""),
        "target_state": c.get("target_state", ""),
        "target_district": c.get("target_district", ""),
        "image_url": c.get("image_url", ""),
        "link_url": c.get("link_url", ""),
        "title": c.get("title", ""),
        "subtitle": c.get("subtitle", ""),
        "media_type": c.get("media_type", "image"),
        "start_at": c.get("start_at", ""),
        "end_at": c.get("end_at", ""),
        "priority": int(_json_num(c.get("priority", 0))),
        "impression_cap": int(_json_num(c.get("impression_cap", 0))),
        "status": c.get("status", "active"),
        "impressions": imp,
        "clicks": clk,
        "ctr": round((clk / imp * 100), 2) if imp else 0.0,
        "created_at": c.get("created_at", ""),
    }


def handle_campaign_list(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    try:
        raw = _scan_by_pk_prefix("ADCAMP#")
    except Exception:
        raw = []
    params = event.get("queryStringParameters") or {}
    f_placement = (params.get("placement") or "").strip()
    f_status = (params.get("status") or "").strip()
    rows = [_camp_admin_view(c) for c in raw]
    if f_placement:
        rows = [r for r in rows if r["placement"] == f_placement]
    if f_status:
        rows = [r for r in rows if r["status"] == f_status]
    rows.sort(key=lambda r: r.get("created_at", ""), reverse=True)
    return _json_response(200, {"success": True, "campaigns": rows})


def handle_campaign_delete(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    ad_id = (_event_body(event).get("ad_id") or "").strip()
    if not ad_id.startswith("ADCAMP#"):
        return _json_response(400, {"error": "Invalid campaign id"})
    try:
        table.delete_item(Key={"pk": ad_id})
    except Exception:
        pass
    return _json_response(200, {"success": True})


def handle_campaign_toggle(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    ad_id = (_event_body(event).get("ad_id") or "").strip()
    if not ad_id.startswith("ADCAMP#"):
        return _json_response(400, {"error": "Invalid campaign id"})
    item = table.get_item(Key={"pk": ad_id}).get("Item") or {}
    if not item:
        return _json_response(404, {"error": "Not found"})
    new_status = "paused" if item.get("status", "active") == "active" else "active"
    try:
        table.update_item(
            Key={"pk": ad_id},
            UpdateExpression="SET #s = :s, updated_at = :u",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": new_status, ":u": _now()},
        )
    except Exception:
        pass
    return _json_response(200, {"success": True, "status": new_status})


def _client_ip(event: dict) -> str:
    rc = event.get("requestContext") or {}
    ip = ((rc.get("http") or {}).get("sourceIp") or (rc.get("identity") or {}).get("sourceIp") or "")
    if not ip:
        h = {(k or "").lower(): v for k, v in (event.get("headers") or {}).items()}
        ip = (h.get("x-forwarded-for") or "").split(",")[0].strip()
    return ip or "unknown"


def handle_ad_event(event: dict) -> dict:
    """Public: count an impression or click for a campaign. Atomic ADD; the
    ConditionExpression stops a bogus id from creating a phantom row. Rate-limited
    per client IP so one source can't inflate a campaign's stats."""
    body = _event_body(event)
    ad_id = (body.get("ad_id") or "").strip()
    etype = (body.get("type") or "").lower()
    if not ad_id.startswith("ADCAMP#") or etype not in {"impression", "click"}:
        return _json_response(400, {"error": "Bad event"})
    # Silently drop once an IP is past the cap — never reveal the limit.
    if _rate_limited(_client_ip(event), "ad_event", 120, 60):
        return _json_response(200, {"success": True})
    field = "impressions" if etype == "impression" else "clicks"
    try:
        table.update_item(
            Key={"pk": ad_id},
            UpdateExpression="ADD #f :one",
            ExpressionAttributeNames={"#f": field},
            ExpressionAttributeValues={":one": _decimal(1)},
            ConditionExpression=Attr("pk").exists(),
        )
    except Exception:
        pass
    return _json_response(200, {"success": True})


# ── Self-serve ad bookings (Phase 3): advertiser pays → pending-review campaign ─
# Rate card is intentionally simple and code-configurable (admin-tunable later).
# Price = placement base (₹/day for a district ad) × scope multiplier × days.
_AD_PLACEMENT_RATE = {
    "dashboard": 60, "trade": 50,
    "trade_mid": 30, "trade_mid2": 30, "trade_mid3": 30, "trade_bottom": 25,
}
_AD_SCOPE_MULT = {"district": 1, "state": 5, "national": 25}


def _ad_rate_card() -> tuple[dict, dict]:
    """Effective rate card: admin-saved values (pk AD#RATECARD) over code defaults."""
    rates = dict(_AD_PLACEMENT_RATE)
    mults = dict(_AD_SCOPE_MULT)
    try:
        item = table.get_item(Key={"pk": "AD#RATECARD"}).get("Item") or {}
        for k, v in (item.get("placement_rate") or {}).items():
            if k in rates:
                rates[k] = int(_json_num(v))
        for k, v in (item.get("scope_mult") or {}).items():
            if k in mults:
                mults[k] = int(_json_num(v))
    except Exception:
        pass
    return rates, mults


def _ad_quote(placement: str, scope: str, days) -> dict:
    try:
        days = int(days or 1)
    except (TypeError, ValueError):
        days = 1
    days = max(1, min(days, 365))
    scope = (scope or "national").lower()
    rates, mults = _ad_rate_card()
    base = rates.get(placement, 40)
    mult = mults.get(scope, 1)
    per_day = base * mult
    return {
        "amount": per_day * days, "per_day": per_day, "days": days,
        "currency": "INR", "placement": placement, "scope": scope,
    }


_AD_HOLD_MINUTES = 20  # a pending (unpaid) booking reserves the slot this long


def _ranges_overlap(a1, a2, b1, b2) -> bool:
    return a1 <= b2 and b1 <= a2


def _slot_occupancy(placement, scope, state, district, start_dt, end_dt, exclude_bid="") -> int:
    """How many ads already occupy this exact slot over the requested date range:
    live/scheduled/pending-review campaigns + un-expired unpaid booking holds."""
    from datetime import timedelta
    scopekey = _camp_scopekey(scope, state, district) or "NATIONAL"
    P = placement.upper()
    now = datetime.now(timezone.utc)
    far = now + timedelta(days=3650)
    count = 0
    # 1) Campaigns sold for this slot (any non-rejected, non-expired one counts).
    try:
        camps = _scan_by_pk_prefix(f"ADCAMP#{P}#{scopekey}#")
    except Exception:
        camps = []
    for c in camps:
        if c.get("status") in ("rejected", "expired"):
            continue
        if c.get("campaign_id") == exclude_bid:
            continue
        cs = _parse_iso(c.get("start_at")) or now
        ce = _parse_iso(c.get("end_at")) or far
        if ce < now:
            continue
        if _ranges_overlap(cs, ce, start_dt, end_dt):
            count += 1
    # 2) Unpaid bookings still holding the slot (within the hold window).
    hold = timedelta(minutes=_AD_HOLD_MINUTES)
    try:
        books = _scan_by_pk_prefix("ADBOOKING#")
    except Exception:
        books = []
    for b in books:
        if b.get("status") != "pending_payment" or b.get("booking_id") == exclude_bid:
            continue
        if (b.get("placement", "") or "").upper() != P:
            continue
        if (_camp_scopekey(b.get("scope", "national"), b.get("target_state", ""), b.get("target_district", "")) or "NATIONAL") != scopekey:
            continue
        created = _parse_iso(b.get("created_at")) or now
        if created + hold < now:
            continue
        bs = _parse_iso(b.get("start_at")) or now
        be = _parse_iso(b.get("end_at")) or now
        if _ranges_overlap(bs, be, start_dt, end_dt):
            count += 1
    return count


def _slot_status(placement, scope, state, district, start_dt, end_dt, exclude_bid=""):
    cap = _ad_capacity()
    taken = _slot_occupancy(placement, scope, state, district, start_dt, end_dt, exclude_bid)
    return (taken < cap), cap, taken


def _booking_dates(days, start_at=""):
    from datetime import timedelta
    start_dt = _parse_iso(start_at) or datetime.now(timezone.utc)
    return start_dt, start_dt + timedelta(days=max(1, int(days or 1)))


def handle_ad_booking_quote(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    params = event.get("queryStringParameters") or {}
    placement = _ad_placement(event)
    scope = params.get("scope") or "national"
    q = _ad_quote(placement, scope, params.get("days") or 1)
    # Availability for the chosen area + dates so the UI can block a full slot.
    start_dt, end_dt = _booking_dates(q["days"], params.get("start") or "")
    available, cap, taken = _slot_status(
        placement, scope, params.get("state") or "", params.get("district") or "", start_dt, end_dt)
    return _json_response(200, {
        "success": True, **q,
        "available": available, "capacity": cap, "taken": taken,
        "slots_left": max(0, cap - taken),
    })


def handle_ad_booking_create(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    placement = _ad_placement(event, body)
    scope = (body.get("scope") or "national").lower()
    if scope not in {"national", "state", "district"}:
        scope = "national"
    target_state = (body.get("state") or "")[:60]
    target_district = (body.get("district") or "")[:60]
    scopekey = _camp_scopekey(scope, target_state, target_district)
    if scopekey is None:
        return _json_response(400, {"error": "State/District required for that scope"})
    media_type = body.get("media_type", "image")
    if media_type not in {"image", "gif", "video"}:
        return _json_response(400, {"error": "Invalid media type"})
    quote = _ad_quote(placement, scope, body.get("days") or 1)
    amount = quote["amount"]
    days = quote["days"]

    b64 = body.get("image_b64", "")
    key = _upload_b64_to_s3(b64, f"banner-media/{placement}", "adbooking") if b64 else ""
    url = _public_s3_url(key) if key else body.get("image_url", "")
    if not url:
        return _json_response(400, {"error": "Media file required"})

    from datetime import timedelta
    start_dt = _parse_iso(body.get("start_at")) or datetime.now(timezone.utc)
    end_dt = start_dt + timedelta(days=days)
    # Slot must be free for these dates before we take money for it.
    available, cap, taken = _slot_status(placement, scope, target_state, target_district, start_dt, end_dt)
    if not available:
        return _json_response(409, {
            "error": "slot_full",
            "message": "This slot is already booked for these dates. Try different dates, another placement, or a wider reach.",
            "capacity": cap, "taken": taken,
        })
    bid = f"ADB-{uuid.uuid4().hex[:12]}"
    booking_pk = f"ADBOOKING#{user['sub']}#{bid}"

    prof = get_profile(user["sub"]) or {}
    booking = {
        "pk": booking_pk,
        "booking_id": bid,
        "user_sub": user["sub"],
        "status": "pending_payment",
        "placement": placement,
        "scope": scope,
        "target_state": target_state,
        "target_district": target_district,
        "image_url": url,
        "media_type": media_type,
        "link_url": body.get("link_url", ""),
        "alt_text": (body.get("alt_text") or "Sponsored")[:120],
        "title": (body.get("title") or "")[:80],
        "subtitle": (body.get("subtitle") or "")[:120],
        "days": days,
        "amount_inr": _decimal(amount),
        "start_at": start_dt.isoformat(),
        "end_at": end_dt.isoformat(),
        "created_at": _now(),
    }
    table.put_item(Item=booking)

    session = {}
    try:
        from advanced_features import create_cashfree_order
        session = create_cashfree_order({
            "arn": bid,
            "ticket_id": bid,
            "user_sub": user["sub"],
            "kind": "ad_booking",
            "product_name": f"Ad — {placement} ({scope})",
            "payment_amount": amount,
            "payment_currency": "INR",
            "customer_name": user.get("name", "") or prof.get("name", ""),
            "email": user.get("email", "") or prof.get("email", ""),
            "mobile": prof.get("phone", ""),
        }) or {}
    except Exception as e:
        logger.error("[AD_BOOKING] order create failed: %s", e)

    if session.get("cf_order_id") or session.get("order_id"):
        table.update_item(
            Key={"pk": booking_pk},
            UpdateExpression="SET cf_order_id = :o",
            ExpressionAttributeValues={":o": session.get("order_id", "")},
        )
    return _json_response(200, {
        "success": True,
        "booking_id": bid,
        "amount": amount,
        "currency": "INR",
        "days": days,
        "payment_session_id": session.get("payment_session_id", ""),
        "payment_mode": session.get("mode", "sandbox"),
        "cf_order_id": session.get("order_id", ""),
    })


def _finalize_ad_booking(notes: dict, payment_id: str) -> dict:
    """Webhook-side: turn a paid booking into a pending-review campaign. Keyed by
    the booking id so a duplicate webhook is idempotent (same campaign pk)."""
    bid = notes.get("ticket_id") or ""
    user_sub = notes.get("user_sub") or ""
    if not bid or not user_sub:
        return _json_response(200, {"handled": False, "reason": "missing booking ref"})
    booking = table.get_item(Key={"pk": f"ADBOOKING#{user_sub}#{bid}"}).get("Item") or {}
    if not booking:
        return _json_response(200, {"handled": False, "reason": "booking not found"})
    if booking.get("status") == "paid":
        return _json_response(200, {"handled": True, "already": True})

    scopekey = _camp_scopekey(booking.get("scope", "national"), booking.get("target_state", ""), booking.get("target_district", ""))
    if scopekey is None:
        scopekey = "NATIONAL"
    camp_pk = f"ADCAMP#{booking.get('placement', 'dashboard').upper()}#{scopekey}#{bid}"
    table.put_item(Item={
        "pk": camp_pk,
        "campaign_id": bid,
        "placement": booking.get("placement", "dashboard"),
        "scope": booking.get("scope", "national"),
        "target_state": booking.get("target_state", ""),
        "target_district": booking.get("target_district", ""),
        "image_url": booking.get("image_url", ""),
        "link_url": booking.get("link_url", ""),
        "alt_text": booking.get("alt_text", "Sponsored"),
        "title": booking.get("title", ""),
        "subtitle": booking.get("subtitle", ""),
        "media_type": booking.get("media_type", "image"),
        "start_at": booking.get("start_at", ""),
        "end_at": booking.get("end_at", ""),
        "priority": 0,
        "impression_cap": 0,
        "status": "pending_review",   # admin approves before it serves
        "impressions": _decimal(0),
        "clicks": _decimal(0),
        "source": "self_serve",
        "advertiser_sub": user_sub,
        "created_at": _now(),
        "updated_at": _now(),
        "created_by": user_sub,
    })
    table.update_item(
        Key={"pk": f"ADBOOKING#{user_sub}#{bid}"},
        UpdateExpression="SET #s = :p, paid_at = :t, payment_id = :pid, campaign_pk = :c",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":p": "paid", ":t": _now(), ":pid": str(payment_id), ":c": camp_pk},
    )
    return _json_response(200, {"success": True, "type": "ad_booking", "campaign_pk": camp_pk})


def handle_ad_booking_mine(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    try:
        raw = _scan_by_pk_prefix(f"ADBOOKING#{user['sub']}#")
    except Exception:
        raw = []
    rows = []
    for b in raw:
        # Pull live performance + review state from the linked campaign, if paid.
        camp_status, imp, clk = "", 0, 0
        cpk = b.get("campaign_pk", "")
        if cpk:
            camp = table.get_item(Key={"pk": cpk}).get("Item") or {}
            camp_status = camp.get("status", "")
            imp = int(_json_num(camp.get("impressions", 0)))
            clk = int(_json_num(camp.get("clicks", 0)))
        rows.append({
            "booking_id": b.get("booking_id", ""),
            "placement": b.get("placement", ""),
            "scope": b.get("scope", ""),
            "target_state": b.get("target_state", ""),
            "target_district": b.get("target_district", ""),
            "image_url": b.get("image_url", ""),
            "days": int(_json_num(b.get("days", 0))),
            "amount": int(_json_num(b.get("amount_inr", 0))),
            "status": b.get("status", ""),
            "campaign_status": camp_status,
            "impressions": imp,
            "clicks": clk,
            "ctr": round((clk / imp * 100), 2) if imp else 0.0,
            "start_at": b.get("start_at", ""),
            "end_at": b.get("end_at", ""),
            "created_at": b.get("created_at", ""),
        })
    rows.sort(key=lambda r: r.get("created_at", ""), reverse=True)
    return _json_response(200, {"success": True, "bookings": rows})


def handle_campaign_approve(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    ad_id = (_event_body(event).get("ad_id") or "").strip()
    if not ad_id.startswith("ADCAMP#"):
        return _json_response(400, {"error": "Invalid campaign id"})
    try:
        table.update_item(
            Key={"pk": ad_id},
            UpdateExpression="SET #s = :a, updated_at = :u",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":a": "active", ":u": _now()},
            ConditionExpression=Attr("pk").exists(),
        )
    except Exception:
        pass
    return _json_response(200, {"success": True, "status": "active"})


def _ad_capacity() -> int:
    """How many ads may run at once for one slot (placement+area+overlapping dates).
    1 = exclusive (default). Admin-configurable via the rate card."""
    try:
        item = table.get_item(Key={"pk": "AD#RATECARD"}).get("Item") or {}
        cap = int(_json_num(item.get("slot_capacity", 1)))
        return max(1, cap)
    except Exception:
        return 1


def handle_ad_rates_get(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    rates, mults = _ad_rate_card()
    return _json_response(200, {"success": True, "placement_rate": rates, "scope_mult": mults, "slot_capacity": _ad_capacity()})


def handle_ad_rates_set(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    pr, sm = {}, {}
    for k, v in (body.get("placement_rate") or {}).items():
        if k in _AD_PLACEMENT_RATE:
            try:
                pr[k] = max(0, int(v))
            except (TypeError, ValueError):
                pass
    for k, v in (body.get("scope_mult") or {}).items():
        if k in _AD_SCOPE_MULT:
            try:
                sm[k] = max(1, int(v))
            except (TypeError, ValueError):
                pass
    try:
        cap = max(1, int(body.get("slot_capacity") or 1))
    except (TypeError, ValueError):
        cap = 1
    table.put_item(Item={"pk": "AD#RATECARD", "placement_rate": pr, "scope_mult": sm, "slot_capacity": cap, "updated_at": _now()})
    return _json_response(200, {"success": True})


def _category_image_key(category_name: str) -> str:
    return f"CATEGORY_IMAGE#{category_name.strip().lower()}"


def handle_category_images_list(event: dict) -> dict:
    """Public, unauthenticated — the portal's category quick-grid fetches
    this to show an admin-uploaded photo instead of the generic FontAwesome
    icon for any category that has one configured."""
    items = _scan_by_pk_prefix("CATEGORY_IMAGE#")
    images = {
        item.get("category_name", ""): item.get("image_url", "")
        for item in items
        if item.get("category_name") and item.get("image_url")
    }
    return _json_response(200, {"images": images})


def handle_category_image_upload(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    category_name = (body.get("category_name") or "").strip()
    if not category_name:
        return _json_response(400, {"error": "Category name is required"})
    if len(category_name) > 40:
        return _json_response(400, {"error": "Category name is too long"})
    b64 = body.get("image_b64", "")
    slug = re.sub(r"[^a-z0-9]+", "-", category_name.lower()).strip("-") or "category"
    key = _upload_b64_to_s3(b64, "category-images", slug)
    if not key:
        return _json_response(400, {"error": "Image file required"})
    url = _public_s3_url(key)
    table.put_item(Item={
        "pk": _category_image_key(category_name),
        "category_name": category_name,
        "image_url": url,
        "created_at": _now(),
        "created_by": "admin",
    })
    return _json_response(200, {"success": True, "category_name": category_name, "image_url": url})


def handle_category_image_remove(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    category_name = (body.get("category_name") or "").strip()
    if not category_name:
        return _json_response(400, {"error": "Category name is required"})
    try:
        table.delete_item(Key={"pk": _category_image_key(category_name)})
    except Exception:
        pass
    return _json_response(200, {"success": True})


# ── Full category manager (admin) ──
# The Category Images card used to only know about categories that had an
# image uploaded. These three endpoints give the admin the same view the
# portal's category grid has (every category that exists on any product OR
# has an image), plus rename and delete-with-product-reassignment.

def _all_product_categories() -> dict:
    """category_name (original casing) -> active product count, across the
    whole catalogue. Lowercase-deduped, first-seen casing wins."""
    counts: dict = {}
    casing: dict = {}
    for item in _scan_by_pk_prefix("CATALOGUE#CATEGORY#"):
        name = (item.get("category_name") or "Other").strip() or "Other"
        key = name.lower()
        if key not in casing:
            casing[key] = name
        counts[key] = counts.get(key, 0) + (1 if item.get("is_active", True) else 0)
    return {casing[k]: v for k, v in counts.items()}


def handle_category_list(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    product_cats = _all_product_categories()
    images: dict = {}
    for item in _scan_by_pk_prefix("CATEGORY_IMAGE#"):
        if item.get("category_name"):
            images[item["category_name"]] = item.get("image_url", "")
    # Union: categories with products + categories that only have an image.
    names = {n.lower(): n for n in product_cats}
    for n in images:
        names.setdefault(n.lower(), n)
    out = []
    for name in sorted(names.values(), key=str.lower):
        img = next((u for k, u in images.items() if k.lower() == name.lower()), "")
        out.append({
            "category_name": name,
            "product_count": product_cats.get(name, 0),
            "image_url": img,
        })
    return _json_response(200, {"categories": out})


def handle_category_rename(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    old_name = (body.get("old_name") or "").strip()
    new_name = (body.get("new_name") or "").strip()
    if not old_name or not new_name:
        return _json_response(400, {"error": "old_name and new_name are required"})
    if len(new_name) > 40:
        return _json_response(400, {"error": "Category name is too long"})
    updated = 0
    for item in _scan_by_pk_prefix("CATALOGUE#CATEGORY#"):
        if (item.get("category_name") or "").strip().lower() == old_name.lower():
            try:
                table.update_item(
                    Key={"pk": item["pk"]},
                    UpdateExpression="SET category_name = :n",
                    ExpressionAttributeValues={":n": new_name},
                )
                updated += 1
            except Exception as e:
                logger.error("[CATEGORY][RENAME] product update failed for %s: %s", item.get("pk"), e)
    # Move the image mapping (if any) to the new name.
    try:
        img = table.get_item(Key={"pk": _category_image_key(old_name)}).get("Item")
        if img:
            table.put_item(Item={
                "pk": _category_image_key(new_name),
                "category_name": new_name,
                "image_url": img.get("image_url", ""),
                "created_at": _now(),
                "created_by": "admin",
            })
            table.delete_item(Key={"pk": _category_image_key(old_name)})
    except Exception as e:
        logger.warning("[CATEGORY][RENAME] image move failed: %s", e)
    return _json_response(200, {"success": True, "updated_products": updated, "new_name": new_name})


def handle_category_delete(event: dict) -> dict:
    """Delete a category: its image mapping is removed and every product
    still under it is automatically moved to the fallback "Other" category
    (per owner's spec) — products are never deleted or hidden by this."""
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    category_name = (body.get("category_name") or "").strip()
    if not category_name:
        return _json_response(400, {"error": "Category name is required"})
    if category_name.lower() == "other":
        return _json_response(400, {"error": '"Other" is the fallback category and cannot be deleted'})
    moved = 0
    for item in _scan_by_pk_prefix("CATALOGUE#CATEGORY#"):
        if (item.get("category_name") or "").strip().lower() == category_name.lower():
            try:
                table.update_item(
                    Key={"pk": item["pk"]},
                    UpdateExpression="SET category_name = :n",
                    ExpressionAttributeValues={":n": "Other"},
                )
                moved += 1
            except Exception as e:
                logger.error("[CATEGORY][DELETE] product move failed for %s: %s", item.get("pk"), e)
    try:
        table.delete_item(Key={"pk": _category_image_key(category_name)})
    except Exception:
        pass
    return _json_response(200, {"success": True, "moved_to_other": moved})


# ══════════════════════════════════════════════════════════════
# COMMUNITY FEED — every signed-in user can post a photo/video with a
# description; everyone signed in sees the shared public feed with
# like / comment / view / share counts. Post owner can edit the
# description or delete the post; likes/comments notify the owner
# (type feed_like / feed_comment → the Feed tab of Notifications).
# Keys:
#   FEEDPOST#<millis>-<uuid8>          (lexicographic pk == chronology)
#   FEEDLIKE#<user_sub>#<post_id>      (one user's likes, prefix-scannable)
#   FEEDCOMMENT#<post_id>#<millis>-<uuid6>
# ══════════════════════════════════════════════════════════════

_FEED_MEDIA_MAX_B64 = 5 * 1024 * 1024 * 4 // 3  # ≈5MB binary as base64


def _feed_author(user: dict) -> dict:
    prof = get_profile(user["sub"])
    return {
        "user_name": prof.get("user_name") or user.get("name") or "Aarvex user",
        "user_photo": prof.get("custom_photo_url") or prof.get("photo_url") or user.get("picture", ""),
    }


def handle_feed_create(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    blocked = _require_can_post(user["sub"])
    if blocked:
        return blocked
    body = _event_body(event)
    if _rate_limited(user["sub"], "feed_post", limit=5, window_seconds=60, fail_closed=True):
        return _rate_limit_response()
    _fv, _fa = _normalize_visibility(body)
    description = str(body.get("description") or "").strip()[:1000]
    mod_err, mod_meta = _moderation_decide(user["sub"], description, "post", "pending")
    if mod_err:
        return mod_err
    # Multi-photo (Batch 7): up to 3 items. Legacy single media_b64 still works
    # and simply becomes the first item.
    media_items = body.get("media_items")
    if not isinstance(media_items, list):
        media_items = []
    single = body.get("media_b64") or ""
    if single and not media_items:
        media_items = [single]
    media_items = [m for m in media_items if m][:3]
    # Product promo (Batch 7): a shop owner can push ≥1 of their products into
    # the feed as a buyable grid (the composer enforces the min-3 for grid look).
    promo_ids = body.get("promo_product_ids") or []
    if not isinstance(promo_ids, list):
        promo_ids = []
    promo_products = []
    if promo_ids:
        _shop = get_shop_by_user(user["sub"]) or {}
        _sid = _shop.get("shop_id", "")
        if _sid:
            wanted = {str(x) for x in promo_ids}
            for it in _scan_by_pk_prefix("CATALOGUE#CATEGORY#"):
                if it.get("shop_id") == _sid:
                    ser = serialize_product(it)
                    if ser and str(ser.get("product_id")) in wanted:
                        promo_products.append(ser)
            promo_products = promo_products[:12]
    if not description and not media_items and not promo_products:
        return _json_response(400, {"error": "Add a photo/video, products, or a description"})
    import time as _time
    post_id = f"{int(_time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
    media_urls = []
    media_types = []
    media_keys = []
    for _idx, _b64 in enumerate(media_items):
        if len(_b64) > _FEED_MEDIA_MAX_B64:
            return _json_response(400, {"error": "Media too large — max 5MB each"})
        key = _upload_b64_to_s3(_b64, f"feed/{user['sub'][:24]}", f"{post_id}-{_idx}")
        if not key:
            return _json_response(400, {"error": "Media upload failed"})
        media_keys.append(key)
        media_urls.append(_public_s3_url(key))
        media_types.append("video" if key.rsplit(".", 1)[-1] in ("mp4", "webm") else "image")
    media_url = media_urls[0] if media_urls else ""
    media_type = media_types[0] if media_types else ""
    author = _feed_author(user)
    _authprof = get_profile(user["sub"])
    # Pro badge: if the author runs a KYC-approved shop, stamp its id on the
    # post so the feed can show a "verified seller" badge + View Shop button.
    author_shop = get_shop_by_user(user["sub"]) or {}
    vis = _fv
    mod_status = "ok"
    if mod_meta.get("hold"):
        vis = "held"
        mod_status = "held"
    elif mod_meta.get("flagged"):
        mod_status = "flagged"
    item = {
        "pk": f"FEEDPOST#{post_id}",
        "post_id": post_id,
        "user_sub": user["sub"],
        "user_name": author["user_name"],
        "user_photo": author["user_photo"],
        "author_shop_id": author_shop.get("shop_id", ""),
        # Author location (Batch 8) — denormalised so the geo-radius feed filter
        # doesn't need a profile lookup per post.
        "author_lat": str(_authprof.get("address_lat", "") or ""),
        "author_lng": str(_authprof.get("address_lng", "") or ""),
        # Audience (Batch 3): public / followers / selected / except — see
        # _normalize_visibility(). Author always sees their own posts.
        "visibility": vis,
        "audience_subs": _fa,
        "description": description,
        "media_url": media_url,
        "media_type": media_type,
        "media_urls": media_urls,
        "media_types": media_types,
        "promo_products": promo_products,
        "post_type": "product_promo" if promo_products else "post",
        "like_count": 0,
        "comment_count": 0,
        "view_count": 0,
        "share_count": 0,
        "moderation_status": mod_status,
        "created_at": _now(),
        "ttl": _ttl(365),
    }
    table.put_item(Item=item)
    try:
        import content_moderation as _cm
        _bind_content_moderation()
        if mod_meta.get("hold") or mod_meta.get("flagged"):
            _cm.create_mod_flag(
                "post", post_id, user["sub"],
                mod_meta.get("reason") or "Flagged",
                mod_meta.get("severity") or "soft",
                description, media_url,
            )
        for mk in media_keys:
            if _cm.flag_media_if_needed(user["sub"], "post", post_id, mk, media_url):
                table.update_item(
                    Key={"pk": item["pk"]},
                    UpdateExpression="SET moderation_status = :m, visibility = if_not_exists(visibility, :h)",
                    ExpressionAttributeValues={":m": "held", ":h": "held"},
                )
                break
    except Exception as e:
        logger.warning("[MOD] post flag side-effects: %s", e)
    return _json_response(200, {"success": True, "post": _feed_public(item, set()), "moderation_status": mod_status})


def _feed_public(item: dict, my_liked) -> dict:
    # my_liked is a dict {post_id: reaction}; membership check still works.
    pid = item.get("post_id", "")
    my_reaction = my_liked.get(pid) if isinstance(my_liked, dict) else None
    return {
        "post_id": pid,
        "user_sub": item.get("user_sub", ""),
        "user_name": item.get("user_name", "Aarvex user"),
        "user_photo": item.get("user_photo", ""),
        "author_shop_id": item.get("author_shop_id", ""),
        "visibility": item.get("visibility", "public"),
        "audience_subs": item.get("audience_subs", []),
        "description": item.get("description", ""),
        "media_url": item.get("media_url", ""),
        "media_type": item.get("media_type", ""),
        "media_urls": item.get("media_urls", []) or ([item.get("media_url")] if item.get("media_url") else []),
        "media_types": item.get("media_types", []) or ([item.get("media_type")] if item.get("media_type") else []),
        "promo_products": item.get("promo_products", []),
        "post_type": item.get("post_type", "post"),
        "like_count": int(_decimal(item.get("like_count", 0))),
        "comment_count": int(_decimal(item.get("comment_count", 0))),
        "view_count": int(_decimal(item.get("view_count", 0))),
        "share_count": int(_decimal(item.get("share_count", 0))),
        "created_at": item.get("created_at", ""),
        "liked_by_me": pid in my_liked,
        "my_reaction": my_reaction,
    }


def _feed_my_likes(user_sub: str) -> dict:
    """Map of post_id -> reaction for this user's reactions (default 'like'
    for legacy records that predate reaction types)."""
    out = {}
    for it in _scan_by_pk_prefix(f"FEEDLIKE#{user_sub}#"):
        out[it.get("post_id", "")] = it.get("reaction", "like")
    return out


def _query_gsi_page(gsi_pk: str, limit: int = 40, start_key: dict | None = None, forward: bool = False) -> tuple[list, dict | None]:
    """Paginated Query on gsi1. Returns (items, last_evaluated_key)."""
    global _gsi_available
    if _gsi_available is False:
        return [], None
    kwargs = {
        "IndexName": _GSI_NAME,
        "KeyConditionExpression": Key("gsi1pk").eq(gsi_pk),
        "ScanIndexForward": forward,
        "Limit": limit,
    }
    if start_key:
        kwargs["ExclusiveStartKey"] = start_key
    try:
        resp = table.query(**kwargs)
        _gsi_available = True
        return resp.get("Items") or [], resp.get("LastEvaluatedKey")
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code in ("ValidationException", "ResourceNotFoundException", "IndexNotFoundException"):
            _gsi_available = False
            logger.warning("[GSI] query page unavailable: %s", code)
            return [], None
        raise


def handle_feed_list(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    params = event.get("queryStringParameters") or {}
    try:
        limit = min(max(int(params.get("limit", 20)), 1), 50)
    except (TypeError, ValueError):
        limit = 20
    try:
        offset = max(int(params.get("offset", 0)), 0)
    except (TypeError, ValueError):
        offset = 0
    mine_only = params.get("mine") == "1"
    # Audience + block filtering (Batch 3): honour each post's public/followers/
    # selected/except audience, and hide anyone I blocked or who blocked me.
    # Computed once per request.
    i_follow = _following_set(user["sub"])
    hidden = _hidden_subs(user["sub"])
    # The Home area is always centred on the viewer's saved Personal
    # Information address.  A device/GPS point must never become the discovery
    # centre, otherwise a user could see a different area by moving around.
    geo = get_profile(user["sub"]).get("feed_geo") or {}
    public_geo = _optional_user_geo(event)
    if public_geo:
        g_lat, g_lng, g_km = public_geo
    else:
        g_lat = g_lng = g_km = 0.0
    radius_active = bool(public_geo) and not mine_only
    posts = []
    prof_cache: dict[str, tuple] = {}
    # Prefer GSI page-walk (newest first) instead of loading every FEEDPOST.
    # Fall back to full prefix scan if GSI missing or cursor/offset legacy path
    # needs a complete sorted set.
    cursor_b64 = (params.get("cursor") or "").strip()
    start_key = None
    if cursor_b64:
        try:
            start_key = json.loads(base64.b64decode(cursor_b64).decode("utf-8"))
        except Exception:
            start_key = None

    raw_batch: list[dict] = []
    next_key = None
    if offset == 0 and not mine_only:
        # Walk newest→older until we have enough visible posts or exhaust.
        lek = start_key
        guard = 0
        while len(posts) < limit and guard < 8:
            guard += 1
            batch, lek = _query_gsi_page("FEEDPOST", limit=max(limit * 3, 40), start_key=lek, forward=False)
            if not batch:
                # GSI empty/unavailable → full scan fallback once
                if guard == 1 and _gsi_available is False:
                    raw_batch = _scan_by_pk_prefix("FEEDPOST#")
                    break
                break
            raw_batch.extend(batch)
            next_key = lek
            # filter into posts incrementally
            for it in batch:
                author_sub = it.get("user_sub", "")
                if it.get("visibility") == "held" and author_sub != user["sub"]:
                    continue
                if it.get("moderation_status") == "held" and author_sub != user["sub"]:
                    continue
                if author_sub in hidden:
                    continue
                if author_sub != user["sub"] and not _post_visible_to(it, user["sub"], i_follow):
                    continue
                selected_exception = (
                    it.get("visibility") == "selected"
                    and user["sub"] in (it.get("audience_subs") or [])
                    and author_sub in i_follow
                    and _is_following(author_sub, user["sub"])
                )
                if radius_active and author_sub != user["sub"] and not selected_exception:
                    if author_sub not in prof_cache:
                        pr = get_profile(author_sub)
                        plat, plng = _profile_coords(pr)
                        if plat is None:
                            try:
                                plat = float(it.get("author_lat") or 0) or None
                                plng = float(it.get("author_lng") or 0) or None
                            except (TypeError, ValueError):
                                plat = plng = None
                        prof_cache[author_sub] = (plat, plng)
                    plat, plng = prof_cache[author_sub]
                    d = _haversine_km(g_lat, g_lng, plat, plng)
                    if d is None or d > g_km:
                        continue
                posts.append(it)
                if len(posts) >= limit:
                    break
            if not lek:
                next_key = None
                break
        page = posts[:limit]
        total = len(page)  # approximate under cursor pagination
        next_cursor = None
        if next_key:
            next_cursor = base64.b64encode(json.dumps(next_key, default=str).encode("utf-8")).decode("ascii")
        my_liked = _feed_my_likes(user["sub"])
        following_authors = i_follow
        return _json_response(200, {
            "posts": [dict(_feed_public(p, my_liked),
                           followed_by_me=(p.get("user_sub", "") in following_authors),
                           is_mine=(p.get("user_sub", "") == user["sub"])) for p in page],
            "total": total,
            "next_offset": None,
            "next_cursor": next_cursor,
            "feed_geo": geo,
            "radius_active": radius_active,
        })

    # Legacy / mine_only path: prefix scan (still GSI-backed when available)
    for it in _scan_by_pk_prefix("FEEDPOST#"):
        author_sub = it.get("user_sub", "")
        if it.get("visibility") == "held" and author_sub != user["sub"]:
            continue
        if it.get("moderation_status") == "held" and author_sub != user["sub"]:
            continue
        if mine_only and author_sub != user["sub"]:
            continue
        if author_sub in hidden:
            continue
        if author_sub != user["sub"] and not _post_visible_to(it, user["sub"], i_follow):
            continue
        selected_exception = (
            it.get("visibility") == "selected"
            and user["sub"] in (it.get("audience_subs") or [])
            and author_sub in i_follow
            and _is_following(author_sub, user["sub"])
        )
        if radius_active and author_sub != user["sub"] and not selected_exception:
            if author_sub not in prof_cache:
                pr = get_profile(author_sub)
                plat, plng = _profile_coords(pr)
                if plat is None:
                    try:
                        plat = float(it.get("author_lat") or 0) or None
                        plng = float(it.get("author_lng") or 0) or None
                    except (TypeError, ValueError):
                        plat = plng = None
                prof_cache[author_sub] = (plat, plng)
            plat, plng = prof_cache[author_sub]
            d = _haversine_km(g_lat, g_lng, plat, plng)
            if d is None or d > g_km:
                continue
        posts.append(it)
    posts.sort(key=lambda p: p.get("pk", ""), reverse=True)  # newest first
    total = len(posts)
    page = posts[offset:offset + limit]
    my_liked = _feed_my_likes(user["sub"])
    following_authors = i_follow
    return _json_response(200, {
        "posts": [dict(_feed_public(p, my_liked),
                       followed_by_me=(p.get("user_sub", "") in following_authors),
                       is_mine=(p.get("user_sub", "") == user["sub"])) for p in page],
        "total": total,
        "next_offset": offset + limit if offset + limit < total else None,
        "next_cursor": None,
        "feed_geo": geo,
        "radius_active": radius_active,
    })


def _get_feed_post(post_id: str) -> dict:
    if not post_id or "#" in post_id:
        return {}
    return table.get_item(Key={"pk": f"FEEDPOST#{post_id}"}).get("Item") or {}


def handle_feed_edit(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    post = _get_feed_post(str(body.get("post_id") or ""))
    if not post:
        return _json_response(404, {"error": "Post not found"})
    if post.get("user_sub") != user["sub"]:
        return _json_response(403, {"error": "You can only edit your own posts"})
    description = str(body.get("description") or "").strip()[:1000]
    mod_err, mod_meta = _moderation_decide(user["sub"], description, "post", str(body.get("post_id") or ""))
    if mod_err:
        return mod_err
    table.update_item(
        Key={"pk": post["pk"]},
        UpdateExpression="SET description = :d, edited_at = :t",
        ExpressionAttributeValues={":d": description, ":t": _now()},
    )
    if mod_meta.get("hold") or mod_meta.get("flagged"):
        try:
            import content_moderation as _cm
            _bind_content_moderation()
            _cm.create_mod_flag("post", post.get("post_id", ""), user["sub"], mod_meta.get("reason") or "edit flagged", mod_meta.get("severity") or "soft", description)
        except Exception:
            pass
    return _json_response(200, {"success": True})


def handle_feed_delete(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    post = _get_feed_post(str(body.get("post_id") or ""))
    if not post:
        return _json_response(404, {"error": "Post not found"})
    if post.get("user_sub") != user["sub"]:
        return _json_response(403, {"error": "You can only delete your own posts"})
    table.delete_item(Key={"pk": post["pk"]})
    # Comments/likes are left to expire via their TTLs — the post itself is
    # gone so nothing references them anymore.
    return _json_response(200, {"success": True})


def handle_feed_like(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    post_id = str(body.get("post_id") or "")
    post = _get_feed_post(post_id)
    if not post:
        return _json_response(404, {"error": "Post not found"})
    # Facebook-style reactions (Batch I): default "like", switching between
    # reactions keeps the count, re-tapping the same one removes it. The post's
    # like_count is the TOTAL reaction count across all types.
    reaction = str(body.get("reaction") or "like").strip().lower()
    if reaction not in ("like", "love", "haha", "wow", "sad", "care"):
        reaction = "like"
    like_pk = f"FEEDLIKE#{user['sub']}#{post_id}"
    existing = table.get_item(Key={"pk": like_pk}).get("Item")
    author = _feed_author(user)
    if existing:
        if existing.get("reaction", "like") == reaction:
            table.delete_item(Key={"pk": like_pk})   # toggle off
            delta = -1
            my_reaction = None
        else:
            table.update_item(
                Key={"pk": like_pk},
                UpdateExpression="SET reaction = :r, updated_at = :u",
                ExpressionAttributeValues={":r": reaction, ":u": _now()},
            )
            delta = 0                                  # switch — count unchanged
            my_reaction = reaction
    else:
        table.put_item(Item={
            "pk": like_pk, "user_sub": user["sub"], "post_id": post_id,
            "reaction": reaction, "user_name": author["user_name"],
            "user_photo": author["user_photo"], "created_at": _now(), "ttl": _ttl(365),
        })
        delta = 1
        my_reaction = reaction
    try:
        resp = table.update_item(
            Key={"pk": post["pk"]},
            UpdateExpression="SET like_count = if_not_exists(like_count, :z) + :d",
            ExpressionAttributeValues={":z": 0, ":d": delta},
            ReturnValues="UPDATED_NEW",
        )
        like_count = max(0, int(_decimal(resp["Attributes"].get("like_count", 0))))
    except ClientError:
        like_count = max(0, int(_decimal(post.get("like_count", 0))) + delta)
    if delta > 0 and post.get("user_sub") and post["user_sub"] != user["sub"]:
        create_notification(
            post["user_sub"], "feed_like", "New reaction on your post",
            f"{author['user_name']} reacted to your post" + (f': "{post.get("description", "")[:60]}"' if post.get("description") else "."),
            post_id=post_id,
        )
    return _json_response(200, {"success": True, "liked": my_reaction is not None, "reaction": my_reaction, "like_count": like_count})


# ══════════════════════════════════════════════════════════════
# STORIES (Batch J) — WhatsApp-style, auto-expire after 24h.
#   STORY#<millis>-<uuid8>            one story (ttl = 1 day)
#   STORYVIEW#<user_sub>#<story_id>   seen marker (drives the unseen ring)
#   STORYLIKE#<user_sub>#<story_id>   like marker
# ══════════════════════════════════════════════════════════════
_STORY_TTL_SECONDS = 24 * 3600


def _story_is_live(item: dict) -> bool:
    """A story is live for 24h after creation (independent of DynamoDB's TTL
    sweep, which is only eventually-consistent and can lag by hours)."""
    import time as _time
    try:
        created_ms = int(str(item.get("story_id", "0")).split("-")[0])
    except (ValueError, IndexError):
        return False
    return (_time.time() * 1000 - created_ms) < _STORY_TTL_SECONDS * 1000


def handle_story_create(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    blocked = _require_can_post(user["sub"])
    if blocked:
        return blocked
    body = _event_body(event)
    _sv, _sa = _normalize_visibility(body)
    media_b64 = body.get("media_b64") or ""
    caption = str(body.get("caption") or "").strip()[:200]
    if _rate_limited(user["sub"], "story_create", limit=10, window_seconds=300, fail_closed=True):
        return _rate_limit_response()
    mod_err, mod_meta = _moderation_decide(user["sub"], caption, "story", "pending")
    if mod_err:
        return mod_err
    if not media_b64:
        return _json_response(400, {"error": "A photo or video is required for a story"})
    if len(media_b64) > _FEED_MEDIA_MAX_B64:
        return _json_response(400, {"error": "Media too large — max 5MB"})
    import time as _time
    story_id = f"{int(_time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
    key = _upload_b64_to_s3(media_b64, f"stories/{user['sub'][:24]}", story_id)
    if not key:
        return _json_response(400, {"error": "Media upload failed"})
    author = _feed_author(user)
    item = {
        "pk": f"STORY#{story_id}",
        "story_id": story_id,
        "user_sub": user["sub"],
        "user_name": author["user_name"],
        "user_photo": author["user_photo"],
        "media_url": _public_s3_url(key),
        "media_type": "video" if key.rsplit(".", 1)[-1] in ("mp4", "webm") else "image",
        "caption": caption,
        "music": str(body.get("music") or "")[:60],
        "visibility": _sv,
        "audience_subs": _sa,
        # Snapshot the owner's fixed Personal Information pin. Existing
        # stories still fall back to the current profile during listing.
        "author_lat": str(_profile_coords(get_profile(user["sub"]))[0] or ""),
        "author_lng": str(_profile_coords(get_profile(user["sub"]))[1] or ""),
        "like_count": 0,
        "view_count": 0,
        "created_at": _now(),
        "ttl": _ttl(1),
    }
    table.put_item(Item=item)
    try:
        import content_moderation as _cm
        _bind_content_moderation()
        if mod_meta.get("hold") or mod_meta.get("flagged"):
            _cm.create_mod_flag("story", story_id, user["sub"], mod_meta.get("reason") or "flagged", mod_meta.get("severity") or "soft", caption, item.get("media_url", ""))
        _cm.flag_media_if_needed(user["sub"], "story", story_id, key, item.get("media_url", ""))
    except Exception as e:
        logger.warning("[MOD] story flag: %s", e)
    return _json_response(200, {"success": True, "story_id": story_id})


def handle_story_list(event: dict) -> dict:
    """Active stories grouped by author, newest group first. `has_unseen`
    drives the coloured ring in the tray; the caller's own group is flagged
    so the UI can pin it as "Your story"."""
    user, err = _require_auth(event)
    if err:
        return err
    seen = {it.get("story_id", "") for it in _scan_by_pk_prefix(f"STORYVIEW#{user['sub']}#")}
    liked = {it.get("story_id", "") for it in _scan_by_pk_prefix(f"STORYLIKE#{user['sub']}#")}
    i_follow = _following_set(user["sub"])
    hidden = _hidden_subs(user["sub"])
    public_geo = _optional_user_geo(event)
    profile_cache: dict[str, tuple] = {}
    groups = {}
    for it in _scan_by_pk_prefix("STORY#"):
        if not _story_is_live(it):
            continue
        sub = it.get("user_sub", "")
        if sub in hidden:
            continue
        if sub != user["sub"] and not _post_visible_to(it, user["sub"], i_follow):
            continue
        selected_exception = (
            it.get("visibility") == "selected"
            and user["sub"] in (it.get("audience_subs") or [])
            and sub in i_follow
            and _is_following(sub, user["sub"])
        )
        if public_geo and sub != user["sub"] and not selected_exception:
            if sub not in profile_cache:
                plat, plng = _profile_coords(get_profile(sub))
                if plat is None:
                    try:
                        plat = float(it.get("author_lat") or 0) or None
                        plng = float(it.get("author_lng") or 0) or None
                    except (TypeError, ValueError):
                        plat = plng = None
                profile_cache[sub] = (plat, plng)
            d = _haversine_km(public_geo[0], public_geo[1], *profile_cache[sub])
            if d is None or d > public_geo[2]:
                continue
        g = groups.setdefault(sub, {
            "user_sub": sub,
            "user_name": it.get("user_name", "Aarvex user"),
            "user_photo": it.get("user_photo", ""),
            "is_mine": sub == user["sub"],
            "stories": [],
        })
        g["stories"].append({
            "story_id": it.get("story_id", ""),
            "media_url": it.get("media_url", ""),
            "media_type": it.get("media_type", "image"),
            "caption": it.get("caption", ""),
            "music": it.get("music", ""),
            "like_count": int(_decimal(it.get("like_count", 0))),
            "view_count": int(_decimal(it.get("view_count", 0))),
            "created_at": it.get("created_at", ""),
            "seen": it.get("story_id", "") in seen,
            "liked_by_me": it.get("story_id", "") in liked,
        })
    out = []
    for g in groups.values():
        g["stories"].sort(key=lambda s: s.get("story_id", ""))
        g["has_unseen"] = any(not s["seen"] for s in g["stories"])
        g["latest"] = g["stories"][-1]["story_id"] if g["stories"] else ""
        out.append(g)
    # Mine first, then groups with unseen stories, then most recent.
    out.sort(key=lambda g: (not g["is_mine"], not g["has_unseen"], g.get("latest", "")), reverse=False)
    return _json_response(200, {"groups": out})


def handle_story_view(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    story_id = str(body.get("story_id") or "")
    if not story_id:
        return _json_response(400, {"error": "story_id required"})
    view_pk = f"STORYVIEW#{user['sub']}#{story_id}"
    if table.get_item(Key={"pk": view_pk}).get("Item"):
        return _json_response(200, {"success": True, "already": True})
    table.put_item(Item={
        "pk": view_pk, "user_sub": user["sub"], "story_id": story_id,
        "created_at": _now(), "ttl": _ttl(2),
    })
    try:
        table.update_item(
            Key={"pk": f"STORY#{story_id}"},
            UpdateExpression="SET view_count = if_not_exists(view_count, :z) + :o",
            ExpressionAttributeValues={":z": 0, ":o": 1},
        )
    except ClientError:
        pass
    return _json_response(200, {"success": True})


def handle_story_like(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    story_id = str(body.get("story_id") or "")
    story = table.get_item(Key={"pk": f"STORY#{story_id}"}).get("Item")
    if not story:
        return _json_response(404, {"error": "Story not found or expired"})
    like_pk = f"STORYLIKE#{user['sub']}#{story_id}"
    existing = table.get_item(Key={"pk": like_pk}).get("Item")
    delta = -1 if existing else 1
    if existing:
        table.delete_item(Key={"pk": like_pk})
    else:
        table.put_item(Item={
            "pk": like_pk, "user_sub": user["sub"], "story_id": story_id,
            "created_at": _now(), "ttl": _ttl(2),
        })
    try:
        resp = table.update_item(
            Key={"pk": f"STORY#{story_id}"},
            UpdateExpression="SET like_count = if_not_exists(like_count, :z) + :d",
            ExpressionAttributeValues={":z": 0, ":d": delta},
            ReturnValues="UPDATED_NEW",
        )
        like_count = max(0, int(_decimal(resp["Attributes"].get("like_count", 0))))
    except ClientError:
        like_count = max(0, int(_decimal(story.get("like_count", 0))) + delta)
    if delta > 0 and story.get("user_sub") and story["user_sub"] != user["sub"]:
        author = _feed_author(user)
        create_notification(
            story["user_sub"], "feed_story", "Story liked",
            f"{author['user_name']} liked your story.",
        )
    return _json_response(200, {"success": True, "liked": delta > 0, "like_count": like_count})


def handle_story_reply(event: dict) -> dict:
    """Reply to a story — delivered as a notification to the story's author
    (same place feed likes/comments land)."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    story_id = str(body.get("story_id") or "")
    text = str(body.get("text") or "").strip()[:300]
    if not text:
        return _json_response(400, {"error": "Reply text required"})
    story = table.get_item(Key={"pk": f"STORY#{story_id}"}).get("Item")
    if not story:
        return _json_response(404, {"error": "Story not found or expired"})
    if story.get("user_sub") == user["sub"]:
        return _json_response(400, {"error": "You cannot reply to your own story"})
    author = _feed_author(user)
    create_notification(
        story["user_sub"], "feed_story", "New story reply",
        f"{author['user_name']}: \"{text[:80]}\"",
    )
    return _json_response(200, {"success": True})


def handle_story_delete(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    story_id = str(body.get("story_id") or "")
    story = table.get_item(Key={"pk": f"STORY#{story_id}"}).get("Item")
    if not story:
        return _json_response(404, {"error": "Story not found"})
    if story.get("user_sub") != user["sub"]:
        return _json_response(403, {"error": "You can only delete your own story"})
    table.delete_item(Key={"pk": f"STORY#{story_id}"})
    return _json_response(200, {"success": True})


def _is_following(follower_sub: str, followee_sub: str) -> bool:
    if not follower_sub or not followee_sub or follower_sub == followee_sub:
        return False
    return bool(table.get_item(Key={"pk": f"FOLLOW#{follower_sub}#{followee_sub}"}).get("Item"))


def _following_set(follower_sub: str) -> set:
    return {it.get("followee_sub", "") for it in _scan_by_pk_prefix(f"FOLLOW#{follower_sub}#")}


# ══════════════ BLOCK / PRIVACY / AUDIENCE / MODERATION (Batch 2+3) ══════════════

def _profile_photo(prof: dict) -> str:
    return prof.get("custom_photo_url") or prof.get("photo_url") or prof.get("picture", "")


def _i_blocked(me_sub: str, other_sub: str) -> bool:
    """True if `me` has an active block on `other`."""
    if not me_sub or not other_sub or me_sub == other_sub:
        return False
    return bool(table.get_item(Key={"pk": f"BLOCK#{me_sub}#{other_sub}"}).get("Item"))


def _hidden_subs(me_sub: str) -> set:
    """Every sub whose content `me` must not see and who must not see `me`'s —
    i.e. people I blocked OR who blocked me (block is mutual invisibility).
    One scan of BLOCK#, split by direction."""
    out = set()
    for it in _scan_by_pk_prefix("BLOCK#"):
        if it.get("blocker_sub") == me_sub:
            out.add(it.get("blocked_sub", ""))
        elif it.get("blocked_sub") == me_sub:
            out.add(it.get("blocker_sub", ""))
    out.discard("")
    return out


_FEED_VIS = {"public", "followers", "selected", "except"}


def _normalize_visibility(body: dict) -> tuple:
    """Audience model shared by posts + stories:
      public   → everyone
      followers→ only people who follow the author
      selected → only the subs in audience_subs
      except   → everyone EXCEPT the subs in audience_subs (WhatsApp "hide from")
    An empty selected/except list is meaningless, so it falls back to public."""
    vis = str(body.get("visibility") or "public").lower()
    if vis not in _FEED_VIS:
        vis = "public"
    aud = body.get("audience_subs") or []
    if not isinstance(aud, list):
        aud = []
    aud = [str(s) for s in aud if s][:500]
    if vis in ("selected", "except") and not aud:
        vis = "public"
    return vis, aud


def _post_visible_to(item: dict, viewer_sub: str, viewer_follows: set) -> bool:
    """Does `viewer` get to see this post/story? Author always sees their own."""
    author_sub = item.get("user_sub", "")
    if author_sub == viewer_sub:
        return True
    vis = item.get("visibility", "public")
    aud = item.get("audience_subs") or []
    if vis == "public":
        return True
    if vis == "followers":
        return author_sub in viewer_follows
    if vis == "selected":
        return viewer_sub in aud
    if vis == "except":
        return viewer_sub not in aud
    return True


def _account_status(user_sub: str) -> str:
    return get_profile(user_sub).get("account_status", "active")


def _require_can_post(user_sub: str):
    """Gate for write actions. Restricted users may browse but not post/sell;
    blacklisted/blocked can do neither. Returns an error response or None."""
    st = _account_status(user_sub)
    if st == "restricted":
        return _json_response(403, {"error": "Your account is restricted — you can browse but not post right now."})
    if st in ("blacklisted", "blocked"):
        return _json_response(403, {"error": "Your account has been blocked. Contact support."})
    return None


def _bind_content_moderation() -> None:
    try:
        import content_moderation as _cm
        from platform_utils import get_platform_settings as _gps
        _cm._bind({
            "table": table,
            "now": _now,
            "create_notification": create_notification,
            "upsert_profile": upsert_profile,
            "get_profile": get_profile,
            "get_platform_settings": _gps,
            "scan_by_pk_prefix": _scan_by_pk_prefix,
            "s3_bucket": S3_BUCKET,
        })
    except Exception as e:
        logger.warning("[MOD] bind failed: %s", e)


def _moderation_decide(user_sub: str, text: str, content_type: str, content_id: str = "") -> tuple:
    """Returns (http_error_response_or_None, decision_dict)."""
    try:
        import content_moderation as _cm
        _bind_content_moderation()
        decision = _cm.enforce_text_policy(user_sub, text, content_type, content_id) or {}
        if decision.get("reject"):
            return _json_response(400, {
                "error": decision.get("error") or "Content blocked by community guidelines.",
                "moderation": True,
                "category": decision.get("category", ""),
            }), decision
        return None, decision
    except Exception as e:
        logger.warning("[MOD] gate error (allowing): %s", e)
        return None, {}


def handle_user_block(event: dict) -> dict:
    """Block / unblock another user. Block is mutual invisibility: neither sees
    the other's posts/stories/profile, and it severs any follow both ways."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    target = str(body.get("user_sub") or "").strip()
    if not target or target == user["sub"]:
        return _json_response(400, {"error": "invalid user"})
    pk = f"BLOCK#{user['sub']}#{target}"
    existing = table.get_item(Key={"pk": pk}).get("Item")
    want = body.get("block")
    blocking = (not existing) if want is None else bool(want)
    if blocking and not existing:
        prof = get_profile(target)
        table.put_item(Item={
            "pk": pk, "blocker_sub": user["sub"], "blocked_sub": target,
            "blocked_name": prof.get("user_name", "Aarvex user"),
            "blocked_photo": _profile_photo(prof),
            "created_at": _now(), "ttl": _ttl(3650),
        })
        table.delete_item(Key={"pk": f"FOLLOW#{user['sub']}#{target}"})
        table.delete_item(Key={"pk": f"FOLLOW#{target}#{user['sub']}"})
    elif not blocking and existing:
        table.delete_item(Key={"pk": pk})
    return _json_response(200, {"success": True, "blocked": blocking})


def handle_block_list(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    out = [{
        "user_sub": it.get("blocked_sub", ""),
        "user_name": it.get("blocked_name", "Aarvex user"),
        "user_photo": it.get("blocked_photo", ""),
    } for it in _scan_by_pk_prefix(f"BLOCK#{user['sub']}#")]
    return _json_response(200, {"blocked": out})


def handle_user_profile(event: dict) -> dict:
    """Public view of ANY user's profile: bio, cover, follower/following counts,
    their visible posts, plus the personal fields they chose to make public.
    Mutual block hides everything but the name."""
    user, err = _require_auth(event)
    if err:
        return err
    params = event.get("queryStringParameters") or {}
    target = str(params.get("user_sub") or "").strip()
    if not target:
        return _json_response(400, {"error": "user_sub required"})
    prof = get_profile(target)
    if not prof:
        return _json_response(404, {"error": "user not found"})
    is_me = target == user["sub"]
    blocked_by_me = _i_blocked(user["sub"], target)
    blocking_me = _i_blocked(target, user["sub"])
    pubf = prof.get("public_fields") or {}

    def pf(field, value):
        return value if (is_me or pubf.get(field)) else ""

    follower_count = sum(1 for it in _scan_by_pk_prefix("FOLLOW#") if it.get("followee_sub") == target)
    following_count = len(_following_set(target))
    shop = get_shop_by_user(target) or {}
    kyc = get_kyc(target)
    # KYC stores the role as `kyc_role` = shop_owner | delivery_partner | both.
    # (An earlier version read a non-existent `role`/`delivery_enabled` field, so
    # delivery partners never got their record card.)
    _is_delivery = kyc.get("status") == "approved" and kyc.get("kyc_role") in ("delivery_partner", "both")
    role = "shop" if shop.get("shop_id") else ("delivery" if _is_delivery else "buyer")
    resp = {
        "user_sub": target, "is_me": is_me,
        "user_name": prof.get("user_name", "Aarvex user"),
        "username": prof.get("username", ""),
        "user_photo": _profile_photo(prof),
        "cover_url": prof.get("cover_url", ""),
        "bio": prof.get("bio", ""),
        "follower_count": follower_count,
        "following_count": following_count,
        "is_following": _is_following(user["sub"], target),
        "follows_me": _is_following(target, user["sub"]),
        "blocked_by_me": blocked_by_me,
        "blocking_me": blocking_me,
        "role": role,
        "shop_id": shop.get("shop_id", ""),
        "joined_at": prof.get("joined_at", prof.get("created_at", "")),
        "city": pf("city", prof.get("city", "")),
        "phone": pf("phone", prof.get("mobile") or prof.get("phone", "")),
        "email": pf("email", prof.get("user_email", "")),
        "dob": pf("dob", prof.get("dob", "")),
        "address": pf("address", prof.get("address", "")),
    }
    if is_me:
        resp["public_fields"] = pubf
    if blocked_by_me or blocking_me:
        resp["posts"], resp["post_count"] = [], 0
        return _json_response(200, resp)
    i_follow = _following_set(user["sub"])
    posts = [it for it in _scan_by_pk_prefix("FEEDPOST#")
             if it.get("user_sub") == target and (is_me or _post_visible_to(it, user["sub"], i_follow))]
    posts.sort(key=lambda p: p.get("pk", ""), reverse=True)
    my_liked = _feed_my_likes(user["sub"])
    resp["post_count"] = len(posts)
    resp["posts"] = [_feed_public(p, my_liked) for p in posts[:30]]
    # Show the delivery record for anyone delivery-approved — including "both"
    # users whose display role is "shop".
    if _is_delivery:
        resp["delivery_stats"] = _delivery_partner_stats(target)
    resp["importer_verified"] = bool(prof.get("importer_verified"))
    resp["importer_stats"] = _importer_stats(target)
    return _json_response(200, resp)


def handle_privacy_update(event: dict) -> dict:
    """Save which personal fields the user wants shown on their public profile,
    plus their bio. `public_fields` is a dict of {field: bool}."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    upd = {}
    if "public_fields" in body and isinstance(body["public_fields"], dict):
        allowed = {"city", "phone", "email", "dob", "address"}
        upd["public_fields"] = {k: bool(v) for k, v in body["public_fields"].items() if k in allowed}
    if "bio" in body:
        upd["bio"] = str(body.get("bio") or "").strip()[:280]
    if upd:
        upsert_profile(user["sub"], upd)
    prof = get_profile(user["sub"])
    return _json_response(200, {"success": True,
                                "public_fields": prof.get("public_fields", {}),
                                "bio": prof.get("bio", "")})


def handle_user_search(event: dict) -> dict:
    """Search users by name (Batch 1) — powers the Home search bar's people
    results. Skips blocked users."""
    user, err = _require_auth(event)
    if err:
        return err
    params = event.get("queryStringParameters") or {}
    q = str(params.get("q") or "").strip().lower()
    if len(q) < 2:
        return _json_response(200, {"users": []})
    hidden = _hidden_subs(user["sub"])
    out = []
    for p in _scan_by_pk_prefix("PROFILE#USER#"):
        sub = p.get("user_sub", "") or p.get("pk", "").replace("PROFILE#USER#", "")
        if not sub or sub in hidden:
            continue
        if (q in (p.get("user_name") or "").lower() or q in (p.get("name") or "").lower()
                or q in (p.get("username") or "").lower()):
            out.append({"user_sub": sub, "user_name": p.get("user_name", "Aarvex user"),
                        "user_photo": _profile_photo(p),
                        "username": p.get("username", "")})
            if len(out) >= 20:
                break
    return _json_response(200, {"users": out})


def handle_user_report(event: dict) -> dict:
    """A user reports another user (optionally a specific post) for review. Feeds
    the admin 'flagged users' queue."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    target = str(body.get("user_sub") or "").strip()
    if not target or target == user["sub"]:
        return _json_response(400, {"error": "invalid user"})
    table.put_item(Item={
        "pk": f"REPORT#{target}#{user['sub']}",
        "reported_sub": target, "reporter_sub": user["sub"],
        "reason": str(body.get("reason") or "").strip()[:500],
        "ref": str(body.get("post_id") or "").strip(),
        "status": "open", "created_at": _now(), "ttl": _ttl(365),
    })
    post_id = str(body.get("post_id") or "").strip()
    if post_id:
        try:
            import content_moderation as _cm
            _bind_content_moderation()
            _cm.create_mod_flag(
                "post", post_id, target,
                f"User report: {str(body.get('reason') or '').strip()[:200]}",
                "soft",
                "",
            )
        except Exception as e:
            logger.warning("[REPORT] MODFLAG create failed: %s", e)
    return _json_response(200, {"success": True})


def admin_user_moderate(event: dict) -> dict:
    """Admin: set a user's moderation status (active / restricted / blacklisted /
    blocked) with a reason. Restricted = browse-only; blacklisted/blocked = out."""
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    user_sub = str(body.get("user_sub") or "")
    status = str(body.get("status") or "active").lower()
    reason = str(body.get("reason") or "").strip()[:500]
    if not user_sub or status not in {"active", "restricted", "blacklisted", "blocked"}:
        return _json_response(400, {"error": "invalid status / user"})
    upsert_profile(user_sub, {
        "account_status": status,
        "moderation_reason": "" if status == "active" else reason,
        "moderated_at": _now(),
    })
    if status != "active":
        shop = get_shop_by_user(user_sub)
        if shop:
            table.update_item(
                Key={"pk": f"SHOP#{shop['shop_id']}"},
                UpdateExpression="SET #s = :s",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={":s": "blocked" if status in ("blacklisted", "blocked") else "active"},
            )
    create_notification(user_sub, "admin_message", "Account Status",
                        f"Your account has been set to {status} by admin." + (f" Reason: {reason}" if reason else ""))
    return _json_response(200, {"success": True, "status": status})


def admin_flagged_users(event: dict) -> dict:
    """Admin queue: users with open reports and/or an active moderation status,
    with report counts + reasons so scammers can be restricted/blacklisted."""
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    reports = {}
    for it in _scan_by_pk_prefix("REPORT#"):
        sub = it.get("reported_sub", "")
        if not sub:
            continue
        r = reports.setdefault(sub, {"count": 0, "reasons": []})
        r["count"] += 1
        if it.get("reason"):
            r["reasons"].append(it.get("reason"))
    profs = {p.get("user_sub", p["pk"].replace("PROFILE#USER#", "")): p
             for p in _scan_by_pk_prefix("PROFILE#USER#")}
    out = []
    seen = set()
    for sub, r in reports.items():
        p = profs.get(sub, {})
        seen.add(sub)
        out.append({
            "user_sub": sub, "name": p.get("user_name", ""), "email": p.get("user_email", ""),
            "account_status": p.get("account_status", "active"),
            "moderation_reason": p.get("moderation_reason", ""),
            "report_count": r["count"], "reasons": r["reasons"][:10],
        })
    for sub, p in profs.items():
        if sub not in seen and p.get("account_status", "active") in ("restricted", "blacklisted"):
            out.append({
                "user_sub": sub, "name": p.get("user_name", ""), "email": p.get("user_email", ""),
                "account_status": p.get("account_status", ""),
                "moderation_reason": p.get("moderation_reason", ""),
                "report_count": 0, "reasons": [],
            })
    out.sort(key=lambda u: (u["report_count"], u["account_status"] != "active"), reverse=True)
    return _json_response(200, {"flagged": out, "total": len(out)})


# ══════════════ MESSENGER (Batch 4) ══════════════
# 1-to-1 chat with text + location / gallery-image / document attachments.
# Data model:
#   MSG#{conv}#{msg_id}       one message (conv = the two subs, sorted + "__")
#   CONVMETA#{owner}#{conv}   per-participant inbox row (last msg + unread count)
# Real-time voice/video is intentionally NOT here — that needs separate WebRTC
# signalling/TURN infra; the UI offers a phone/WhatsApp call button instead.

_CHAT_MEDIA_MAX_B64 = 8 * 1024 * 1024  # ~6 MB decoded


def _conv_id(a: str, b: str) -> str:
    return "__".join(sorted([a, b]))


def _chat_public(m: dict, viewer_sub: str = "") -> dict:
    # Chat reactions are stored as {reactor_sub: emoji} — the VALUE is the emoji
    # string, not a count. (Post reactions elsewhere are counts; this was
    # wrongly copied from there and coerced every emoji to int → 0, so reactions
    # rendered as "0".) Keep the emoji strings intact.
    reactions = m.get("reactions") or {}
    if isinstance(reactions, dict):
        reactions = {k: str(v) for k, v in reactions.items() if v}
    out = {
        "msg_id": m.get("msg_id", ""),
        "from_sub": m.get("from_sub", ""),
        "to_sub": m.get("to_sub", ""),
        "text": m.get("text", ""),
        "attach_type": m.get("attach_type", ""),
        "attach_url": m.get("attach_url", ""),
        "attach_meta": m.get("attach_meta", {}) or {},
        "created_at": m.get("created_at", ""),
        "ts": int(_decimal(m.get("ts", 0))),
        "reply_to": m.get("reply_to") or None,
        "reactions": reactions,
        "edited_at": int(_decimal(m.get("edited_at", 0))),
        "deleted_for_all": bool(m.get("deleted_for_all")),
        "forwarded": bool(m.get("forwarded")),
        "pinned_in_chat": bool(m.get("pinned_in_chat")),
        "pinned_until": int(_decimal(m.get("pinned_until", 0))),
        "e2e": bool(m.get("e2e")),
    }
    if m.get("deleted_for_all"):
        out["text"] = ""
        out["attach_type"] = ""
        out["attach_url"] = ""
    if viewer_sub:
        hide_pk = f"CHATHIDE#{viewer_sub}#{m.get('msg_id', '')}"
        if table.get_item(Key={"pk": hide_pk}).get("Item"):
            out["hidden_for_me"] = True
        star_pk = f"CHATSTAR#{viewer_sub}#{m.get('msg_id', '')}"
        out["starred"] = bool(table.get_item(Key={"pk": star_pk}).get("Item"))
    return out


def _chat_hidden_for(user_sub: str, msg_id: str) -> bool:
    return bool(table.get_item(Key={"pk": f"CHATHIDE#{user_sub}#{msg_id}"}).get("Item"))


def _chat_conv_meta(owner: str, conv: str) -> dict:
    return table.get_item(Key={"pk": f"CONVMETA#{owner}#{conv}"}).get("Item") or {}


def _chat_conv_public(it: dict) -> dict:
    return {
        "user_sub": it.get("other_sub", ""),
        "user_name": it.get("other_name", "Aarvex user"),
        "user_photo": it.get("other_photo", ""),
        "last_text": it.get("last_text", ""),
        "last_ts": int(_decimal(it.get("last_ts", 0))),
        "unread": int(_decimal(it.get("unread", 0))),
        "pinned": bool(it.get("pinned")),
        "archived": bool(it.get("archived")),
        "muted": bool(it.get("muted")),
        "favourite": bool(it.get("favourite")),
        "draft": str(it.get("draft") or "")[:2000],
        "marked_unread": bool(it.get("marked_unread")),
        "is_group": bool(it.get("is_group")),
        "is_request": bool(it.get("is_request")),
        "group_id": it.get("group_id", ""),
    }


def _is_group_ref(s: str) -> bool:
    return str(s or "").startswith("g:")


def _group_gid(s: str) -> str:
    return str(s)[2:]


def _group_conv(gid: str) -> str:
    return f"group_{gid}"


def _user_in_group(gid: str, user_sub: str) -> bool:
    return bool(table.get_item(Key={"pk": f"GROUPMEM#{gid}#{user_sub}"}).get("Item"))


def _is_connected(a: str, b: str) -> bool:
    if not a or not b or a == b:
        return a == b
    if _is_following(a, b) and _is_following(b, a):
        return True
    for pk in (f"CONNECT#{a}#{b}", f"CONNECT#{b}#{a}"):
        it = table.get_item(Key={"pk": pk}).get("Item") or {}
        if it.get("status") == "accepted":
            return True
    return False


def _can_message(sender: str, recipient: str) -> bool:
    """Allow DM unless blocked; non-connected chats become message requests."""
    if sender == recipient:
        return False
    if _is_group_ref(recipient):
        return _user_in_group(_group_gid(recipient), sender)
    if _i_blocked(sender, recipient) or _i_blocked(recipient, sender):
        return False
    return True


def _convmeta_flags(owner: str, conv: str, **flags) -> None:
    if not flags:
        return
    expr = "SET " + ", ".join(f"{k}=:{k}" for k in flags)
    table.update_item(Key={"pk": f"CONVMETA#{owner}#{conv}"},
                      UpdateExpression=expr,
                      ExpressionAttributeValues={f":{k}": v for k, v in flags.items()})


def _upsert_convmeta(owner: str, conv: str, other_sub: str, other_name: str,
                     other_photo: str, preview: str, ts: int, mode: str) -> None:
    """Update a participant's inbox row. mode 'unread' bumps the unread counter
    (recipient); 'read' zeroes it (sender). gsi keys are stamped explicitly
    because update_item bypasses the put_item GSI proxy."""
    expr = ("SET other_sub=:o, other_name=:n, other_photo=:p, last_text=:t, "
            "last_ts=:ts, updated_at=:u, conv=:c, gsi1pk=:gp, gsi1sk=:gs, #ttl=:ttl")
    vals = {":o": other_sub, ":n": other_name, ":p": other_photo, ":t": preview,
            ":ts": ts, ":u": _now(), ":c": conv, ":gp": "CONVMETA",
            ":gs": f"{owner}#{conv}", ":ttl": _ttl(365)}
    if mode == "unread":
        expr += " ADD unread :one"
        vals[":one"] = 1
    else:
        expr += ", unread=:z"
        vals[":z"] = 0
    table.update_item(Key={"pk": f"CONVMETA#{owner}#{conv}"}, UpdateExpression=expr,
                      ExpressionAttributeNames={"#ttl": "ttl"}, ExpressionAttributeValues=vals)


def _reset_unread(owner: str, conv: str) -> None:
    try:
        table.update_item(Key={"pk": f"CONVMETA#{owner}#{conv}"},
                          UpdateExpression="SET unread=:z", ExpressionAttributeValues={":z": 0})
    except Exception:
        pass


def handle_chat_send(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    blocked = _require_can_post(user["sub"])
    if blocked:
        return blocked
    body = _event_body(event)
    to_sub = str(body.get("to_sub") or "").strip()
    if not to_sub or to_sub == user["sub"]:
        return _json_response(400, {"error": "invalid recipient"})
    if _is_group_ref(to_sub):
        return _handle_group_chat_send(user, body, to_sub)
    if _i_blocked(user["sub"], to_sub) or _i_blocked(to_sub, user["sub"]):
        return _json_response(403, {"error": "You cannot message this user."})
    if not _can_message(user["sub"], to_sub):
        return _json_response(403, {"error": "You cannot message this user."})
    if _rate_limited(user["sub"], "chat_send", limit=40, window_seconds=60, fail_closed=True):
        return _rate_limit_response()
    text = str(body.get("text") or "").strip()[:2000]
    if not body.get("e2e"):
        mod_err, _mm = _moderation_decide(user["sub"], text, "chat")
        if mod_err:
            return mod_err
    attach_type = str(body.get("attach_type") or "").lower()
    attach_url = ""
    attach_meta = {}
    conv = _conv_id(user["sub"], to_sub)
    if attach_type == "location":
        try:
            # Stored as strings — DynamoDB's resource client rejects Python
            # float; the map URL on the client works fine with strings.
            attach_meta = {"lat": str(float(body.get("lat"))), "lng": str(float(body.get("lng"))),
                           "label": str(body.get("label") or "")[:120]}
        except (TypeError, ValueError):
            return _json_response(400, {"error": "invalid location"})
    elif attach_type in ("image", "document", "audio"):
        b64 = body.get("attach_b64") or ""
        if not b64:
            return _json_response(400, {"error": "attachment required"})
        if len(b64) > _CHAT_MEDIA_MAX_B64:
            return _json_response(400, {"error": "Attachment too large — max 6MB"})
        key = _upload_b64_to_s3(b64, f"chat/{conv[:40]}", uuid.uuid4().hex[:12])
        if not key:
            return _json_response(400, {"error": "Attachment upload failed"})
        attach_url = _public_s3_url(key)
        attach_meta = {"filename": str(body.get("filename") or "")[:160]}
        if attach_type == "audio":
            attach_meta["duration_ms"] = int(_decimal(body.get("duration_ms") or 0))
    else:
        attach_type = ""
    reply_to = body.get("reply_to")
    if reply_to and isinstance(reply_to, dict):
        reply_to = {
            "msg_id": str(reply_to.get("msg_id") or "")[:80],
            "text": str(reply_to.get("text") or "")[:240],
            "from_name": str(reply_to.get("from_name") or "")[:80],
        }
    else:
        reply_to = None
    forwarded = bool(body.get("forwarded"))
    e2e = bool(body.get("e2e"))
    if not text and not attach_type:
        return _json_response(400, {"error": "Type a message or add an attachment"})
    import time as _time
    ts = int(_time.time() * 1000)
    msg_id = f"{ts}-{uuid.uuid4().hex[:6]}"
    item = {
        "pk": f"MSG#{conv}#{msg_id}", "conv": conv, "msg_id": msg_id,
        "from_sub": user["sub"], "to_sub": to_sub, "text": text,
        "attach_type": attach_type, "attach_url": attach_url, "attach_meta": attach_meta,
        "created_at": _now(), "ts": ts, "ttl": _ttl(365),
        "reply_to": reply_to, "forwarded": forwarded, "e2e": e2e,
    }
    table.put_item(Item=item)
    me = _feed_author(user)
    other_prof = get_profile(to_sub)
    if text:
        if e2e:
            preview = "🔒 Encrypted message"
        else:
            # Notification / inbox preview shows only the FIRST line; if the message
            # has more lines (or is truncated) we append an ellipsis so the rest is
            # represented by "…" instead of spilling into the alert.
            first_line = text.split("\n", 1)[0]
            preview = first_line[:80]
            if len(first_line) > 80 or "\n" in text:
                preview = preview.rstrip() + "…"
    elif attach_type == "location":
        preview = "📍 Location"
    elif attach_type == "document":
        preview = "📎 " + (attach_meta.get("filename") or "Document")
    elif attach_type == "audio":
        preview = "🎤 Voice message"
    else:
        preview = "📷 Photo"
    _upsert_convmeta(user["sub"], conv, to_sub, other_prof.get("user_name", "Aarvex user"),
                     _profile_photo(other_prof), preview, ts, mode="read")
    _upsert_convmeta(to_sub, conv, user["sub"], me["user_name"], me["user_photo"],
                     preview, ts, mode="unread")
    connected = _is_connected(user["sub"], to_sub)
    if not connected:
        _convmeta_flags(to_sub, conv, is_request=True)
    _convmeta_flags(user["sub"], conv, is_request=False)
    create_notification(to_sub, "chat", "New message" if connected else "Message request",
                        f"{me['user_name']}: {preview}",
                        link_type="chat", link_id=user["sub"],
                        from_sub=user["sub"], from_name=me["user_name"], from_photo=me["user_photo"])
    return _json_response(200, {"success": True, "message": _chat_public(item, user["sub"])})


def handle_chat_thread(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    params = event.get("queryStringParameters") or {}
    other = str(params.get("user_sub") or "").strip()
    if not other:
        return _json_response(400, {"error": "user_sub required"})
    if _is_group_ref(other):
        return _handle_group_chat_thread(user, other)
    if _i_blocked(user["sub"], other) or _i_blocked(other, user["sub"]):
        return _json_response(403, {"error": "Conversation unavailable."})
    conv = _conv_id(user["sub"], other)
    msgs = _scan_by_pk_prefix(f"MSG#{conv}#")
    msgs.sort(key=lambda m: int(_decimal(m.get("ts", 0))))
    try:
        limit = min(max(int(params.get("limit", 60)), 1), 100)
    except (TypeError, ValueError):
        limit = 60
    _reset_unread(user["sub"], conv)
    # Read/delivery watermarks (drives the sender's ticks). Opening the thread
    # means I've DELIVERED and READ everything up to the latest message. This
    # only fires here (real chat open) — reading a chat *notification* never
    # calls /chat/thread, so it can raise delivered (via /chat/list) but never
    # read, exactly per spec: notification-read = double tick, not green.
    latest_ts = int(_decimal(msgs[-1].get("ts", 0))) if msgs else 0
    if latest_ts:
        try:
            table.update_item(Key={"pk": f"CONVMETA#{user['sub']}#{conv}"},
                              UpdateExpression="SET delivered_ts=:d, read_ts=:r",
                              ExpressionAttributeValues={":d": latest_ts, ":r": latest_ts})
        except Exception:
            pass
    # The peer's watermarks tell me how far THEY have delivered/read MY messages.
    peer_meta = table.get_item(Key={"pk": f"CONVMETA#{other}#{conv}"}).get("Item") or {}
    peer_delivered_ts = int(_decimal(peer_meta.get("delivered_ts", 0)))
    peer_read_ts = int(_decimal(peer_meta.get("read_ts", 0)))
    other_prof = get_profile(other)
    pubf = other_prof.get("public_fields") or {}
    phone = (other_prof.get("mobile") or other_prof.get("phone", "")) if pubf.get("phone") else ""
    return _json_response(200, {
        "user_sub": other,
        "user_name": other_prof.get("user_name", "Aarvex user"),
        "user_photo": _profile_photo(other_prof),
        "phone": phone,
        "my_sub": user["sub"],
        "peer_delivered_ts": peer_delivered_ts,
        "peer_read_ts": peer_read_ts,
        "messages": [_chat_public(m, user["sub"]) for m in msgs[-limit:]
                     if not _chat_hidden_for(user["sub"], m.get("msg_id", ""))],
        "peer_username": other_prof.get("username", ""),
        "about": other_prof.get("bio", ""),
    })


def handle_chat_list(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    hidden = _hidden_subs(user["sub"])
    convs = []
    total_unread = 0
    for it in _scan_by_pk_prefix(f"CONVMETA#{user['sub']}#"):
        other = it.get("other_sub", "")
        if not other or other in hidden:
            continue
        u = int(_decimal(it.get("unread", 0)))
        total_unread += u
        last_ts = int(_decimal(it.get("last_ts", 0)))
        # Fetching the inbox means these messages have reached my device — mark
        # them delivered (double tick for the sender) without marking them read.
        # Only advances forward, so it never overwrites a later thread-open read.
        if last_ts > int(_decimal(it.get("delivered_ts", 0))):
            try:
                table.update_item(Key={"pk": f"CONVMETA#{user['sub']}#{it.get('conv', '')}"},
                                  UpdateExpression="SET delivered_ts=:d",
                                  ExpressionAttributeValues={":d": last_ts})
            except Exception:
                pass
        row = _chat_conv_public(it)
        row["unread"] = u
        row["last_ts"] = last_ts
        convs.append(row)
    # Pinned conversations first, then newest-first within each group. Both keys
    # descend together under reverse=True: pinned(True=1) sorts above unpinned,
    # and larger last_ts (newer) sorts above older. (The old `not pinned` key
    # fought reverse=True and pushed pinned chats to the BOTTOM.)
    convs.sort(key=lambda c: (bool(c.get("pinned")), c["last_ts"]), reverse=True)
    return _json_response(200, {"conversations": convs, "total_unread": total_unread})


def handle_chat_conv_update(event: dict) -> dict:
    """Pin, archive, mute, favourite, draft, mark unread on a conversation."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    other = str(body.get("user_sub") or "").strip()
    if not other:
        return _json_response(400, {"error": "user_sub required"})
    conv = _group_conv(_group_gid(other)) if _is_group_ref(other) else _conv_id(user["sub"], other)
    pk = f"CONVMETA#{user['sub']}#{conv}"
    if not table.get_item(Key={"pk": pk}).get("Item"):
        if _is_group_ref(other):
            g = table.get_item(Key={"pk": f"GROUP#{_group_gid(other)}"}).get("Item") or {}
            _upsert_convmeta(user["sub"], conv, other, g.get("name", "Group"), g.get("icon", ""), "", 0, mode="read")
            _convmeta_flags(user["sub"], conv, is_group=True, group_id=_group_gid(other))
        else:
            other_prof = get_profile(other)
            _upsert_convmeta(user["sub"], conv, other, other_prof.get("user_name", "Aarvex user"),
                             _profile_photo(other_prof), "", 0, mode="read")
    sets = []
    vals = {}
    for field, key in (
        ("pinned", "pinned"), ("archived", "archived"), ("muted", "muted"),
        ("favourite", "favourite"), ("marked_unread", "marked_unread"),
    ):
        if key in body:
            sets.append(f"{field}=:{field}")
            vals[f":{field}"] = bool(body[key])
    if "draft" in body:
        sets.append("draft=:draft")
        vals[":draft"] = str(body.get("draft") or "")[:2000]
    if "clear_chat" in body and body.get("clear_chat"):
        for m in _scan_by_pk_prefix(f"MSG#{conv}#"):
            mid = m.get("msg_id", "")
            if mid:
                table.put_item(Item={
                    "pk": f"CHATHIDE#{user['sub']}#{mid}", "ttl": _ttl(30),
                    "created_at": _now(),
                })
        sets.append("last_text=:lt")
        vals[":lt"] = ""
    if not sets:
        return _json_response(400, {"error": "nothing to update"})
    table.update_item(Key={"pk": pk}, UpdateExpression="SET " + ", ".join(sets),
                      ExpressionAttributeValues=vals)
    return _json_response(200, {"success": True})


def handle_chat_message(event: dict) -> dict:
    """React, star, edit, delete, pin message."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    action = str(body.get("action") or "").lower()
    other = str(body.get("user_sub") or "").strip()
    msg_id = str(body.get("msg_id") or "").strip()
    if not other or not msg_id:
        return _json_response(400, {"error": "user_sub and msg_id required"})
    conv = _group_conv(_group_gid(other)) if _is_group_ref(other) else _conv_id(user["sub"], other)
    pk = f"MSG#{conv}#{msg_id}"
    item = table.get_item(Key={"pk": pk}).get("Item")
    if not item:
        return _json_response(404, {"error": "Message not found"})
    import time as _time
    now_ms = int(_time.time() * 1000)
    if action == "react":
        emoji = str(body.get("emoji") or "")[:8]
        reactions = dict(item.get("reactions") or {})
        if emoji:
            reactions[user["sub"]] = emoji
        elif user["sub"] in reactions:
            del reactions[user["sub"]]
        table.update_item(Key={"pk": pk}, UpdateExpression="SET reactions=:r",
                          ExpressionAttributeValues={":r": reactions})
        return _json_response(200, {"success": True, "reactions": reactions})
    if action == "star":
        star_pk = f"CHATSTAR#{user['sub']}#{msg_id}"
        if body.get("star"):
            table.put_item(Item={"pk": star_pk, "conv": conv, "msg_id": msg_id, "ttl": _ttl(730),
                                 "created_at": _now()})
        else:
            try:
                table.delete_item(Key={"pk": star_pk})
            except Exception:
                pass
        return _json_response(200, {"success": True, "starred": bool(body.get("star"))})
    if action == "delete":
        scope = str(body.get("scope") or "me").lower()
        if scope == "all" and item.get("from_sub") == user["sub"]:
            age_s = (now_ms - int(_decimal(item.get("ts", 0)))) / 1000.0
            # 2-day window (WhatsApp-like). The old 1-hour cap made "delete for
            # everyone" silently fail on slightly older messages.
            if age_s > 172800:
                return _json_response(400, {"error": "Delete for everyone is only available for 2 days after sending."})
            table.update_item(Key={"pk": pk},
                              UpdateExpression="SET deleted_for_all=:d, text=:z, attach_type=:z, attach_url=:z",
                              ExpressionAttributeValues={":d": True, ":z": ""})
        else:
            table.put_item(Item={"pk": f"CHATHIDE#{user['sub']}#{msg_id}", "ttl": _ttl(365),
                                 "created_at": _now()})
        return _json_response(200, {"success": True})
    if action == "edit":
        if item.get("from_sub") != user["sub"]:
            return _json_response(403, {"error": "You can only edit your own messages."})
        age_s = (now_ms - int(_decimal(item.get("ts", 0)))) / 1000.0
        if age_s > 900:
            return _json_response(400, {"error": "Edit window expired (15 minutes)."})
        new_text = str(body.get("text") or "").strip()[:2000]
        if not new_text:
            return _json_response(400, {"error": "text required"})
        table.update_item(Key={"pk": pk}, UpdateExpression="SET text=:t, edited_at=:e",
                          ExpressionAttributeValues={":t": new_text, ":e": now_ms})
        return _json_response(200, {"success": True})
    if action == "pin":
        until_h = int(_decimal(body.get("hours") or 24))
        until_ms = now_ms + until_h * 3600 * 1000 if body.get("pin") else 0
        table.update_item(Key={"pk": pk},
                          UpdateExpression="SET pinned_in_chat=:p, pinned_until=:u",
                          ExpressionAttributeValues={":p": bool(body.get("pin")), ":u": until_ms})
        return _json_response(200, {"success": True})
    return _json_response(400, {"error": "unknown action"})


def handle_chat_starred(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    out = []
    for it in _scan_by_pk_prefix(f"CHATSTAR#{user['sub']}#"):
        conv = it.get("conv", "")
        mid = it.get("msg_id", "")
        if not conv or not mid:
            continue
        msg = table.get_item(Key={"pk": f"MSG#{conv}#{mid}"}).get("Item")
        if msg and not _chat_hidden_for(user["sub"], mid):
            out.append(_chat_public(msg, user["sub"]))
    out.sort(key=lambda m: m.get("ts", 0), reverse=True)
    return _json_response(200, {"messages": out[:100]})


def handle_chat_forward(event: dict) -> dict:
    """Forward one existing 1:1 message to up to five permitted recipients.

    The client only sends message identifiers, never message content or a raw
    attachment.  This keeps the server authoritative and prevents forwarding
    a message from a conversation the caller does not belong to.
    """
    user, err = _require_auth(event)
    if err:
        return err
    blocked = _require_can_post(user["sub"])
    if blocked:
        return blocked
    body = _event_body(event)
    source_sub = str(body.get("user_sub") or "").strip()
    msg_id = str(body.get("msg_id") or "").strip()
    recipients = body.get("to_subs") or []
    if not source_sub or not msg_id or not isinstance(recipients, list):
        return _json_response(400, {"error": "user_sub, msg_id and to_subs are required"})
    if _is_group_ref(source_sub):
        return _json_response(400, {"error": "Forwarding from group chats is not available yet."})
    recipients = list(dict.fromkeys(str(v).strip() for v in recipients if str(v).strip()))[:5]
    recipients = [v for v in recipients if v != user["sub"]]
    if not recipients:
        return _json_response(400, {"error": "Choose at least one recipient"})
    if _rate_limited(user["sub"], "chat_forward", limit=20, window_seconds=60, fail_closed=True):
        return _rate_limit_response()

    source_conv = _conv_id(user["sub"], source_sub)
    original = table.get_item(Key={"pk": f"MSG#{source_conv}#{msg_id}"}).get("Item")
    if not original or original.get("deleted_for_all"):
        return _json_response(404, {"error": "Message is no longer available to forward."})
    if original.get("e2e"):
        return _json_response(400, {"error": "Encrypted messages cannot be forwarded."})
    if not original.get("text") and not original.get("attach_type"):
        return _json_response(400, {"error": "Message is empty and cannot be forwarded."})

    import time as _time
    me = _feed_author(user)
    sent, skipped = 0, []
    for to_sub in recipients:
        if to_sub == source_sub or _i_blocked(user["sub"], to_sub) or _i_blocked(to_sub, user["sub"]):
            skipped.append(to_sub)
            continue
        if not _can_message(user["sub"], to_sub):
            skipped.append(to_sub)
            continue
        conv = _conv_id(user["sub"], to_sub)
        ts = int(_time.time() * 1000)
        new_id = f"{ts}-{uuid.uuid4().hex[:6]}"
        item = {
            "pk": f"MSG#{conv}#{new_id}", "conv": conv, "msg_id": new_id,
            "from_sub": user["sub"], "to_sub": to_sub,
            "text": str(original.get("text") or "")[:2000],
            "attach_type": str(original.get("attach_type") or ""),
            "attach_url": str(original.get("attach_url") or ""),
            "attach_meta": dict(original.get("attach_meta") or {}),
            "created_at": _now(), "ts": ts, "ttl": _ttl(365),
            "reply_to": None, "forwarded": True, "e2e": False,
        }
        table.put_item(Item=item)
        if item["text"]:
            preview = item["text"].split("\n", 1)[0][:80]
        elif item["attach_type"] == "location":
            preview = "📍 Location"
        elif item["attach_type"] == "document":
            preview = "📎 " + (item["attach_meta"].get("filename") or "Document")
        elif item["attach_type"] == "audio":
            preview = "🎤 Voice message"
        else:
            preview = "📷 Photo"
        other_prof = get_profile(to_sub)
        _upsert_convmeta(user["sub"], conv, to_sub, other_prof.get("user_name", "Aarvex user"),
                         _profile_photo(other_prof), preview, ts, mode="read")
        _upsert_convmeta(to_sub, conv, user["sub"], me["user_name"], me["user_photo"], preview, ts, mode="unread")
        create_notification(to_sub, "chat", "Forwarded message", f"{me['user_name']}: {preview}",
                            link_type="chat", link_id=user["sub"], from_sub=user["sub"],
                            from_name=me["user_name"], from_photo=me["user_photo"])
        sent += 1
    return _json_response(200, {"success": True, "count": sent, "skipped": skipped})


def handle_chat_broadcast(event: dict) -> dict:
    """Send the same message to many recipients (individual chats, not a group)."""
    user, err = _require_auth(event)
    if err:
        return err
    blocked = _require_can_post(user["sub"])
    if blocked:
        return blocked
    body = _event_body(event)
    recipients = body.get("recipients") or []
    if not isinstance(recipients, list) or not recipients:
        return _json_response(400, {"error": "recipients required"})
    recipients = [str(r).strip() for r in recipients if str(r).strip()][:200]
    text = str(body.get("text") or "").strip()[:2000]
    if not text:
        return _json_response(400, {"error": "text required"})
    import time as _time
    month_key = _time.strftime("%Y-%m")
    quota_pk = f"BROADCASTQUOTA#{user['sub']}#{month_key}"
    quota = table.get_item(Key={"pk": quota_pk}).get("Item") or {}
    used = int(_decimal(quota.get("count", 0)))
    limit = 35
    if used + len(recipients) > limit:
        return _json_response(400, {
            "error": f"Broadcast limit exceeded ({used}/{limit} this month).",
            "used": used, "limit": limit,
        })
    sent = 0
    errors = []
    for to_sub in recipients:
        if to_sub == user["sub"] or not _can_message(user["sub"], to_sub):
            errors.append(to_sub)
            continue
        fake = dict(event)
        fake_body = {"to_sub": to_sub, "text": text}
        fake["body"] = json.dumps(fake_body)
        if hasattr(fake, "get"):
            pass
        # inline send (reuse logic)
        conv = _conv_id(user["sub"], to_sub)
        ts = int(_time.time() * 1000)
        msg_id = f"{ts}-{uuid.uuid4().hex[:6]}"
        me = _feed_author(user)
        other_prof = get_profile(to_sub)
        item = {
            "pk": f"MSG#{conv}#{msg_id}", "conv": conv, "msg_id": msg_id,
            "from_sub": user["sub"], "to_sub": to_sub, "text": text,
            "attach_type": "", "attach_url": "", "attach_meta": {},
            "created_at": _now(), "ts": ts, "ttl": _ttl(365), "forwarded": False,
        }
        table.put_item(Item=item)
        preview = text.split("\n", 1)[0][:80]
        _upsert_convmeta(user["sub"], conv, to_sub, other_prof.get("user_name", "Aarvex user"),
                         _profile_photo(other_prof), preview, ts, mode="read")
        _upsert_convmeta(to_sub, conv, user["sub"], me["user_name"], me["user_photo"],
                         preview, ts, mode="unread")
        sent += 1
    table.put_item(Item={
        "pk": quota_pk, "count": used + sent, "month": month_key,
        "updated_at": _now(), "ttl": _ttl(90),
    })
    return _json_response(200, {"success": True, "sent": sent, "errors": errors,
                                "used": used + sent, "limit": limit})


def handle_username_set(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    raw = str(body.get("username") or "").strip().lower()
    if not raw:
        return _json_response(400, {"error": "username required"})
    import re
    if not re.match(r"^[a-z0-9_]{3,30}$", raw):
        return _json_response(400, {"error": "Username: 3–30 chars, letters, numbers, underscore only."})
    prof = get_profile(user["sub"]) or {}
    last_change = int(_decimal(prof.get("username_changed_at", 0)))
    import time as _time
    if prof.get("username") and prof.get("username") != raw:
        if last_change and (_time.time() - last_change) < 30 * 86400:
            return _json_response(400, {"error": "Username can be changed once every 30 days."})
    for p in _scan_by_pk_prefix("PROFILE#USER#"):
        if p.get("username", "").lower() == raw and p.get("user_sub", "") != user["sub"]:
            return _json_response(409, {"error": "Username already taken."})
    upsert_profile(user["sub"], {
        "username": raw,
        "username_changed_at": int(_time.time()),
    })
    table.put_item(Item={"pk": f"USERNAME#{raw}", "user_sub": user["sub"], "ttl": _ttl(3650)})
    return _json_response(200, {"success": True, "username": raw})


def handle_user_by_username(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    params = event.get("queryStringParameters") or {}
    un = str(params.get("u") or params.get("username") or "").strip().lower()
    if not un:
        return _json_response(400, {"error": "username required"})
    item = table.get_item(Key={"pk": f"USERNAME#{un}"}).get("Item")
    if not item:
        for p in _scan_by_pk_prefix("PROFILE#USER#"):
            if (p.get("username") or "").lower() == un:
                item = {"user_sub": p.get("user_sub", "")}
                break
    if not item or not item.get("user_sub"):
        return _json_response(404, {"error": "User not found"})
    target = item["user_sub"]
    prof = get_profile(target) or {}
    return _json_response(200, {
        "user_sub": target,
        "user_name": prof.get("user_name", "Aarvex user"),
        "user_photo": _profile_photo(prof),
        "username": prof.get("username", un),
    })


def handle_connect_request(event: dict) -> dict:
    """Send / accept / reject / list connection requests (username discovery)."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    action = str(body.get("action") or "send").lower()
    if action == "list":
        incoming, outgoing = [], []
        for it in _scan_by_pk_prefix("CONNECT#"):
            if it.get("to_sub") == user["sub"] and it.get("status") == "pending":
                prof = get_profile(it.get("from_sub", "")) or {}
                incoming.append({
                    "user_sub": it.get("from_sub", ""),
                    "user_name": prof.get("user_name", "User"),
                    "user_photo": _profile_photo(prof),
                    "username": prof.get("username", ""),
                    "created_at": it.get("created_at", ""),
                })
            elif it.get("from_sub") == user["sub"] and it.get("status") == "pending":
                prof = get_profile(it.get("to_sub", "")) or {}
                outgoing.append({
                    "user_sub": it.get("to_sub", ""),
                    "user_name": prof.get("user_name", "User"),
                    "user_photo": _profile_photo(prof),
                })
        return _json_response(200, {"incoming": incoming, "outgoing": outgoing})
    target = str(body.get("user_sub") or "").strip()
    if not target or target == user["sub"]:
        return _json_response(400, {"error": "invalid user"})
    pk = f"CONNECT#{user['sub']}#{target}"
    if action == "send":
        if _is_connected(user["sub"], target):
            return _json_response(200, {"success": True, "status": "connected"})
        table.put_item(Item={
            "pk": pk, "from_sub": user["sub"], "to_sub": target,
            "status": "pending", "created_at": _now(), "ttl": _ttl(365),
        })
        me = _feed_author(user)
        create_notification(target, "connect", "Connection request",
                            f"{me['user_name']} wants to connect with you.",
                            link_type="profile", link_id=user["sub"],
                            from_sub=user["sub"], from_name=me["user_name"], from_photo=me["user_photo"])
        return _json_response(200, {"success": True, "status": "pending"})
    rev_pk = f"CONNECT#{target}#{user['sub']}"
    if action == "accept":
        table.put_item(Item={
            "pk": rev_pk, "from_sub": target, "to_sub": user["sub"],
            "status": "accepted", "created_at": _now(), "ttl": _ttl(365),
        })
        try:
            table.delete_item(Key={"pk": pk})
        except Exception:
            pass
        try:
            table.delete_item(Key={"pk": f"CONNECT#{target}#{user['sub']}"})
        except Exception:
            pass
        if not _is_following(user["sub"], target):
            table.put_item(Item={
                "pk": f"FOLLOW#{user['sub']}#{target}",
                "follower_sub": user["sub"], "followee_sub": target,
                "created_at": _now(), "ttl": _ttl(3650),
            })
        if not _is_following(target, user["sub"]):
            table.put_item(Item={
                "pk": f"FOLLOW#{target}#{user['sub']}",
                "follower_sub": target, "followee_sub": user["sub"],
                "created_at": _now(), "ttl": _ttl(3650),
            })
        conv = _conv_id(user["sub"], target)
        _convmeta_flags(user["sub"], conv, is_request=False)
        _convmeta_flags(target, conv, is_request=False)
        return _json_response(200, {"success": True, "status": "accepted"})
    if action == "reject":
        try:
            table.delete_item(Key={"pk": pk})
            table.delete_item(Key={"pk": rev_pk})
        except Exception:
            pass
        return _json_response(200, {"success": True, "status": "rejected"})
    return _json_response(400, {"error": "unknown action"})


def _handle_group_chat_send(user: dict, body: dict, group_ref: str) -> dict:
    gid = _group_gid(group_ref)
    if not _user_in_group(gid, user["sub"]):
        return _json_response(403, {"error": "Not a group member"})
    if _rate_limited(user["sub"], "chat_send", limit=40, window_seconds=60, fail_closed=True):
        return _rate_limit_response()
    text = str(body.get("text") or "").strip()[:2000]
    if not body.get("e2e"):
        mod_err, _mm = _moderation_decide(user["sub"], text, "chat")
        if mod_err:
            return mod_err
    attach_type = str(body.get("attach_type") or "").lower()
    attach_url, attach_meta = "", {}
    conv = _group_conv(gid)
    if attach_type in ("image", "document", "audio"):
        b64 = body.get("attach_b64") or ""
        if not b64:
            return _json_response(400, {"error": "attachment required"})
        key = _upload_b64_to_s3(b64, f"chat/{conv[:40]}", uuid.uuid4().hex[:12])
        if not key:
            return _json_response(400, {"error": "Attachment upload failed"})
        attach_url = _public_s3_url(key)
        attach_meta = {"filename": str(body.get("filename") or "")[:160]}
    elif attach_type == "location":
        attach_meta = {"lat": str(float(body.get("lat"))), "lng": str(float(body.get("lng"))),
                       "label": str(body.get("label") or "")[:120]}
    else:
        attach_type = attach_type if attach_type in ("location",) else ""
    if not text and not attach_type:
        return _json_response(400, {"error": "Type a message or add an attachment"})
    import time as _time
    ts = int(_time.time() * 1000)
    msg_id = f"{ts}-{uuid.uuid4().hex[:6]}"
    item = {
        "pk": f"MSG#{conv}#{msg_id}", "conv": conv, "msg_id": msg_id,
        "from_sub": user["sub"], "to_sub": group_ref, "text": text,
        "attach_type": attach_type, "attach_url": attach_url, "attach_meta": attach_meta,
        "created_at": _now(), "ts": ts, "ttl": _ttl(365), "is_group": True,
    }
    table.put_item(Item=item)
    g = table.get_item(Key={"pk": f"GROUP#{gid}"}).get("Item") or {}
    gname = g.get("name", "Group")
    preview = (text[:80] if text else "📷 Media") if text or attach_type else "Message"
    me = _feed_author(user)
    preview = f"{me['user_name']}: {preview}"
    for it in _scan_by_pk_prefix(f"GROUPMEM#{gid}#"):
        mem = it.get("user_sub", "")
        if not mem:
            continue
        mode = "unread" if mem != user["sub"] else "read"
        _upsert_convmeta(mem, conv, group_ref, gname, g.get("icon", ""), preview, ts, mode=mode)
        _convmeta_flags(mem, conv, is_group=True, group_id=gid)
    return _json_response(200, {"success": True, "message": _chat_public(item, user["sub"])})


def _handle_group_chat_thread(user: dict, group_ref: str) -> dict:
    gid = _group_gid(group_ref)
    if not _user_in_group(gid, user["sub"]):
        return _json_response(403, {"error": "Not a group member"})
    conv = _group_conv(gid)
    msgs = _scan_by_pk_prefix(f"MSG#{conv}#")
    msgs.sort(key=lambda m: int(_decimal(m.get("ts", 0))))
    g = table.get_item(Key={"pk": f"GROUP#{gid}"}).get("Item") or {}
    _reset_unread(user["sub"], conv)
    members = []
    for it in _scan_by_pk_prefix(f"GROUPMEM#{gid}#"):
        ms = it.get("user_sub", "")
        if ms:
            p = get_profile(ms) or {}
            members.append({"user_sub": ms, "user_name": p.get("user_name", ""), "user_photo": _profile_photo(p)})
    return _json_response(200, {
        "user_sub": group_ref,
        "user_name": g.get("name", "Group"),
        "user_photo": g.get("icon", ""),
        "my_sub": user["sub"],
        "is_group": True,
        "group_id": gid,
        "members": members,
        "messages": [_chat_public(m, user["sub"]) for m in msgs[-100:]
                     if not _chat_hidden_for(user["sub"], m.get("msg_id", ""))],
        "peer_delivered_ts": 0,
        "peer_read_ts": 0,
    })


def handle_group_create(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    name = str(body.get("name") or "New group").strip()[:80]
    members = body.get("members") or []
    if not isinstance(members, list):
        members = []
    members = [str(m).strip() for m in members if str(m).strip() and str(m).strip() != user["sub"]][:49]
    gid = uuid.uuid4().hex[:12]
    import time as _time
    table.put_item(Item={
        "pk": f"GROUP#{gid}", "group_id": gid, "name": name,
        "icon": "", "created_by": user["sub"], "created_at": _now(), "ttl": _ttl(730),
    })
    all_mem = [user["sub"]] + members
    for ms in all_mem:
        table.put_item(Item={
            "pk": f"GROUPMEM#{gid}#{ms}", "group_id": gid, "user_sub": ms,
            "role": "admin" if ms == user["sub"] else "member",
            "created_at": _now(), "ttl": _ttl(730),
        })
        conv = _group_conv(gid)
        _upsert_convmeta(ms, conv, f"g:{gid}", name, "", "Group created", int(_time.time() * 1000), mode="read")
        _convmeta_flags(ms, conv, is_group=True, group_id=gid)
    return _json_response(200, {"success": True, "group_id": gid, "group_ref": f"g:{gid}", "name": name})


# ══════════════ WEBRTC CALL SIGNALING ══════════════

def handle_call_start(event: dict) -> dict:
    """Start a voice/video call — returns call_id for WebRTC signaling."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    to_sub = str(body.get("to_sub") or "").strip()
    kind = str(body.get("kind") or "voice").lower()
    if kind not in ("voice", "video"):
        kind = "voice"
    group_ref = str(body.get("group_ref") or "").strip()
    if group_ref and _is_group_ref(group_ref):
        gid = _group_gid(group_ref)
        if not _user_in_group(gid, user["sub"]):
            return _json_response(403, {"error": "Not a group member"})
        members = [it.get("user_sub") for it in _scan_by_pk_prefix(f"GROUPMEM#{gid}#") if it.get("user_sub")]
        to_sub = members[0] if members else ""
    if not to_sub or to_sub == user["sub"]:
        return _json_response(400, {"error": "invalid recipient"})
    if _i_blocked(user["sub"], to_sub) or _i_blocked(to_sub, user["sub"]):
        return _json_response(403, {"error": "Cannot call this user"})
    import time as _time
    call_id = uuid.uuid4().hex[:16]
    me = _feed_author(user)
    table.put_item(Item={
        "pk": f"CALL#{call_id}", "call_id": call_id,
        "caller_sub": user["sub"], "callee_sub": to_sub,
        "caller_name": me["user_name"], "caller_photo": me["user_photo"],
        "kind": kind, "status": "ringing", "group_ref": group_ref,
        "participants": [user["sub"], to_sub],
        "created_at": _now(), "ts": int(_time.time() * 1000), "ttl": _ttl(2),
    })
    create_notification(to_sub, "call", f"Incoming {kind} call", f"{me['user_name']} is calling…",
                        link_type="call", link_id=call_id,
                        from_sub=user["sub"], from_name=me["user_name"], from_photo=me["user_photo"])
    return _json_response(200, {"success": True, "call_id": call_id, "kind": kind})


def handle_call_incoming(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    out = []
    for it in _scan_by_pk_prefix("CALL#"):
        if it.get("callee_sub") == user["sub"] and it.get("status") == "ringing":
            out.append({
                "call_id": it.get("call_id", ""),
                "caller_sub": it.get("caller_sub", ""),
                "caller_name": it.get("caller_name", ""),
                "caller_photo": it.get("caller_photo", ""),
                "kind": it.get("kind", "voice"),
                "ts": int(_decimal(it.get("ts", 0))),
            })
    out.sort(key=lambda x: x["ts"], reverse=True)
    return _json_response(200, {"calls": out[:5]})


def handle_call_signal(event: dict) -> dict:
    """Exchange WebRTC SDP / ICE — server only relays, cannot decode media."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    call_id = str(body.get("call_id") or "").strip()
    kind = str(body.get("kind") or "").lower()
    payload = body.get("payload")
    if not call_id or not kind:
        return _json_response(400, {"error": "call_id and kind required"})
    call = table.get_item(Key={"pk": f"CALL#{call_id}"}).get("Item")
    if not call:
        return _json_response(404, {"error": "Call not found"})
    parts = call.get("participants") or [call.get("caller_sub"), call.get("callee_sub")]
    if user["sub"] not in parts:
        return _json_response(403, {"error": "Not in this call"})
    import time as _time
    ts = int(_time.time() * 1000)
    sig_id = f"{ts}-{uuid.uuid4().hex[:6]}"
    table.put_item(Item={
        "pk": f"CALLSIG#{call_id}#{sig_id}", "call_id": call_id,
        "from_sub": user["sub"], "kind": kind, "payload": payload,
        "ts": ts, "ttl": _ttl(1),
    })
    if kind == "answer":
        table.update_item(Key={"pk": f"CALL#{call_id}"},
                          UpdateExpression="SET #st=:a", ExpressionAttributeNames={"#st": "status"},
                          ExpressionAttributeValues={":a": "active"})
    if kind == "end":
        table.update_item(Key={"pk": f"CALL#{call_id}"},
                          UpdateExpression="SET #st=:e", ExpressionAttributeNames={"#st": "status"},
                          ExpressionAttributeValues={":e": "ended"})
    return _json_response(200, {"success": True, "sig_id": sig_id})


def handle_call_signals(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    params = event.get("queryStringParameters") or {}
    call_id = str(params.get("call_id") or "").strip()
    since = int(_decimal(params.get("since") or 0))
    if not call_id:
        return _json_response(400, {"error": "call_id required"})
    call = table.get_item(Key={"pk": f"CALL#{call_id}"}).get("Item")
    if not call:
        return _json_response(404, {"error": "Call not found"})
    parts = call.get("participants") or [call.get("caller_sub"), call.get("callee_sub")]
    if user["sub"] not in parts:
        return _json_response(403, {"error": "Not in this call"})
    sigs = []
    for it in _scan_by_pk_prefix(f"CALLSIG#{call_id}#"):
        ts = int(_decimal(it.get("ts", 0)))
        if ts > since and it.get("from_sub") != user["sub"]:
            sigs.append({
                "sig_id": it.get("pk", "").split("#")[-1],
                "from_sub": it.get("from_sub", ""),
                "kind": it.get("kind", ""),
                "payload": it.get("payload"),
                "ts": ts,
            })
    sigs.sort(key=lambda s: s["ts"])
    return _json_response(200, {
        "signals": sigs,
        "status": call.get("status", ""),
        "kind": call.get("kind", "voice"),
    })


def handle_call_end(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    call_id = str(body.get("call_id") or "").strip()
    if not call_id:
        return _json_response(400, {"error": "call_id required"})
    try:
        table.update_item(Key={"pk": f"CALL#{call_id}"},
                          UpdateExpression="SET #st=:e", ExpressionAttributeNames={"#st": "status"},
                          ExpressionAttributeValues={":e": "ended"})
    except Exception:
        pass
    return _json_response(200, {"success": True})


# ══════════════ E2E ENCRYPTION (client-side keys, server relays ciphertext) ══════════════

def handle_e2e_register(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    pub = body.get("public_key")
    if not pub or not isinstance(pub, dict):
        return _json_response(400, {"error": "public_key (JWK) required"})
    table.put_item(Item={
        "pk": f"E2EKEY#{user['sub']}", "user_sub": user["sub"],
        "public_key": pub, "updated_at": _now(), "ttl": _ttl(3650),
    })
    upsert_profile(user["sub"], {"e2e_enabled": True})
    return _json_response(200, {"success": True})


def handle_e2e_key(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    params = event.get("queryStringParameters") or {}
    target = str(params.get("user_sub") or "").strip()
    if not target:
        return _json_response(400, {"error": "user_sub required"})
    item = table.get_item(Key={"pk": f"E2EKEY#{target}"}).get("Item")
    if not item:
        return _json_response(404, {"error": "Peer has not enabled encryption yet"})
    return _json_response(200, {
        "user_sub": target,
        "public_key": item.get("public_key"),
        "updated_at": item.get("updated_at", ""),
    })


def handle_chat_read(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    other = str(body.get("user_sub") or "").strip()
    if not other:
        return _json_response(400, {"error": "user_sub required"})
    if _is_group_ref(other):
        conv = _group_conv(_group_gid(other))
    else:
        conv = _conv_id(user["sub"], other)
    _reset_unread(user["sub"], conv)
    return _json_response(200, {"success": True})


# ══════════════ DELIVERY-PARTNER RECORD (Batch 6) ══════════════

def _delivery_partner_stats(user_sub: str) -> dict:
    kyc = get_kyc(user_sub)
    done = int(_decimal(kyc.get("delivery_completed_count", 0)))
    on_time = int(_decimal(kyc.get("delivery_on_time_count", 0)))
    reviews = []
    for it in _scan_by_pk_prefix(f"DELIVERYRATING#{user_sub}#"):
        if it.get("comment") or it.get("rating"):
            reviews.append({
                "rating": int(_decimal(it.get("rating", 0))),
                "comment": it.get("comment", ""),
                "created_at": it.get("created_at", ""),
            })
    reviews.sort(key=lambda r: r.get("created_at", ""), reverse=True)
    return {
        "deliveries_done": done,
        "on_time": on_time,
        "on_time_pct": round(on_time / done * 100) if done else 0,
        "avg_rating": round(float(_decimal(kyc.get("delivery_avg_rating", 0))), 1),
        "total_ratings": int(_decimal(kyc.get("delivery_rating_count", 0))),
        "reviews": reviews[:20],
    }


def handle_order_detail(event: dict) -> dict:
    """Full transparency for ONE order — every party's name/phone/address, the
    timeline, the charge breakdown, the payment mode + payout status, and the
    invoice link. Only the importer, shop owner, delivery partner (or admin)
    may open it. Powers the History → order-detail sheet."""
    user, err = _require_auth(event)
    if err:
        return err
    params = event.get("queryStringParameters") or {}
    arn = str(params.get("arn") or "").strip()
    if not arn:
        return _json_response(400, {"error": "arn required"})
    rec = table.get_item(Key={"pk": f"DELIVERY#ARN#{arn}"}).get("Item") or {}
    order = table.get_item(Key={"pk": f"ORDER#{arn}"}).get("Item") or {}
    if not rec and not order:
        return _json_response(404, {"error": "Order not found"})
    importer_sub = rec.get("importer_sub") or order.get("user_sub") or order.get("importer_sub", "")
    seller_sub = rec.get("seller_sub") or order.get("seller_sub", "")
    partner_sub = rec.get("claimed_by", "")
    if user["sub"] not in (importer_sub, seller_sub, partner_sub) and not _admin_authorized(event):
        return _json_response(403, {"error": "This order is not yours"})

    def party(sub, role, fb_name="", fb_phone=""):
        p = get_profile(sub) if sub else {}
        return {
            "role": role, "sub": sub or "",
            "name": (p.get("user_name") if p else "") or fb_name or "—",
            "phone": (p.get("mobile") or p.get("phone") if p else "") or fb_phone or "",
            "city": (p.get("city") if p else "") or "",
            "address": (p.get("address") if p else "") or "",
        }

    shop = get_shop_by_user(seller_sub) if seller_sub else {}
    shop_party = party(seller_sub, "Shop", rec.get("shop_name", ""), "")
    if shop:
        shop_party["shop_id"] = shop.get("shop_id", "")
        shop_party["shop_name"] = shop.get("shop_name", "")
        shop_party["address"] = shop.get("address_full") or shop_party["address"]
        shop_party["city"] = shop.get("address_city") or shop_party["city"]

    # Timeline + time-taken
    time_taken = ""
    try:
        from datetime import datetime
        ca = rec.get("claimed_at") or rec.get("created_at")
        cp = rec.get("completed_at")
        if ca and cp:
            c1 = datetime.fromisoformat(str(ca).replace("Z", "+00:00"))
            c2 = datetime.fromisoformat(str(cp).replace("Z", "+00:00"))
            m = max(0, int((c2 - c1).total_seconds() / 60))
            time_taken = (f"{m // 60}h {m % 60}m") if m >= 60 else f"{m}m"
    except Exception:
        pass

    # Prefer delivery-record charges; fall back to ORDER# fields; then derive
    # missing delivery / platform / GST the same way invoices do (cod_invoice
    # ._derive_charges) so Order details never shows blank ₹0 when the invoice
    # already has the correct breakdown.
    charge_src = {
        "lot_price": rec.get("lot_price") or order.get("lot_price") or order.get("total_amount") or 0,
        "delivery_charge": rec.get("delivery_charge") or order.get("delivery_charge") or 0,
        "platform_fee": rec.get("platform_fee") or order.get("platform_fee") or 0,
        "gst_amount": rec.get("gst_amount") or order.get("gst_amount") or 0,
        "distance_km": rec.get("distance_km") or order.get("distance_km") or 0,
        "cod_amount": rec.get("cod_amount") or order.get("cod_amount") or order.get("total_amount") or 0,
        "total_amount": order.get("total_amount") or 0,
    }
    try:
        from cod_invoice import _derive_charges
        lot, delivery_charge, platform_fee, gst = _derive_charges(charge_src)
    except Exception:
        lot = float(_decimal(charge_src["lot_price"]))
        delivery_charge = float(_decimal(charge_src["delivery_charge"]))
        platform_fee = float(_decimal(charge_src["platform_fee"]))
        gst = float(_decimal(charge_src["gst_amount"]))
    total = (
        float(_decimal(rec.get("cod_amount", 0)))
        or float(_decimal(order.get("total_amount", 0)))
        or round(lot + delivery_charge + platform_fee + gst, 2)
    )
    is_cod = bool(rec.get("is_cod"))
    status = rec.get("status") or order.get("current_status", "PENDING")
    delivered = str(status).upper() == "COMPLETED"

    # Payout transparency: on delivery, online orders auto-settle the shop +
    # delivery partner; COD means the partner collected cash in hand and must
    # remit the shop's share + the platform fee.
    payment = {
        "mode": "Cash on Delivery" if is_cod else "Online (prepaid)",
        "is_cod": is_cod,
        "importer_paid": (not is_cod) or delivered,
        "shop_settled": delivered and not is_cod,
        "delivery_settled": delivered and not is_cod,
        "cash_in_hand": is_cod and delivered,
        "cash_amount": total if is_cod else 0,
        "shop_receivable": round(lot, 2),
        "delivery_receivable": round(delivery_charge, 2),
        "platform_due_from_partner": round(platform_fee, 2) if is_cod else 0,
    }

    return _json_response(200, {
        "arn": arn,
        "product_name": rec.get("product_name") or order.get("product_name", ""),
        "product_image": _product_image_for_pk(rec.get("product_pk", "")),
        "qty_kg": _json_num_safe(rec.get("lot_size_kg", order.get("quantity_kg", 0))),
        "order_type": order.get("order_type") or ("sample" if lot and lot <= 500 else "bulk"),
        "status": status,
        "delivered": delivered,
        "created_at": rec.get("created_at") or order.get("created_at", ""),
        "claimed_at": rec.get("claimed_at", ""),
        "completed_at": rec.get("completed_at", ""),
        "time_taken": time_taken,
        "cancelled_reason": rec.get("cancel_reason") or order.get("cancel_reason", ""),
        "importer": party(importer_sub, "Importer", rec.get("buyer_name", ""), rec.get("buyer_mobile", "")),
        "shop": shop_party,
        "delivery_partner": party(partner_sub, "Delivery partner"),
        "charges": {"lot": round(lot, 2), "delivery": round(delivery_charge, 2),
                    "platform": round(platform_fee, 2), "gst": round(gst, 2), "total": total},
        "payment": payment,
        "invoice_url": rec.get("invoice_url", ""),
    })


def _json_num_safe(v):
    try:
        return float(_decimal(v))
    except Exception:
        return 0


def _product_image_for_pk(ppk):
    if not ppk:
        return ""
    try:
        it = table.get_item(Key={"pk": ppk}).get("Item") or {}
        imgs = it.get("images") or []
        return it.get("image_url") or it.get("image") or it.get("photo_url") or (imgs[0] if imgs else "") or ""
    except Exception:
        return ""


def _importer_stats(user_sub: str) -> dict:
    """A buyer's trust record — verified flag, orders placed, member-since — so
    shops/delivery partners can vet them the way buyers vet a delivery boy."""
    prof = get_profile(user_sub)
    placed = int(_decimal(prof.get("importer_order_count", 0)))
    return {
        "verified": bool(prof.get("importer_verified")),
        "orders_placed": placed,
        "member_since": prof.get("joined_at") or prof.get("created_at", ""),
    }


def handle_importer_verify(event: dict) -> dict:
    """Lightweight importer verification (parallel to delivery/shop KYC): confirm
    the buyer's Personal Information is complete + genuine, then stamp a verified
    badge that shops and delivery partners can see."""
    user, err = _require_auth(event)
    if err:
        return err
    prof = get_profile(user["sub"])
    ok = (prof.get("user_name") and (prof.get("mobile") or prof.get("phone"))
          and prof.get("address") and prof.get("city") and prof.get("pincode"))
    if not ok:
        return _json_response(400, {
            "error": "Complete your Personal Information first (name, mobile, address, city, pincode).",
            "needs_profile": True,
        })
    upsert_profile(user["sub"], {"importer_verified": True, "importer_verified_at": _now()})
    return _json_response(200, {"success": True, "verified": True})


def handle_delivery_record(event: dict) -> dict:
    """Public delivery-partner record — completions, on-time %, rating, reviews.
    Powers the profile 'delivery record' card and the shareable feed post."""
    user, err = _require_auth(event)
    if err:
        return err
    params = event.get("queryStringParameters") or {}
    target = str(params.get("user_sub") or user["sub"])
    prof = get_profile(target)
    stats = _delivery_partner_stats(target)
    stats["user_sub"] = target
    stats["user_name"] = prof.get("user_name", "Delivery partner")
    stats["user_photo"] = _profile_photo(prof)
    return _json_response(200, stats)


# ══════════════ SHOP'S OWN DELIVERY TEAM (Batch 6) ══════════════

def _shop_team_member(sub: str) -> dict:
    p = get_profile(sub)
    k = get_kyc(sub)
    return {
        "user_sub": sub,
        "user_name": p.get("user_name", "Delivery partner"),
        "user_photo": _profile_photo(p),
        "kyc_ok": k.get("status") == "approved" and k.get("kyc_role") in ("delivery_partner", "both"),
    }


def handle_shop_team(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    shop = get_shop_by_user(user["sub"])
    if not shop:
        return _json_response(404, {"error": "You don't have a shop"})
    subs = list(shop.get("own_delivery_subs", []) or [])
    return _json_response(200, {"members": [_shop_team_member(s) for s in subs]})


def handle_shop_team_add(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    shop = get_shop_by_user(user["sub"])
    if not shop:
        return _json_response(404, {"error": "You don't have a shop"})
    body = _event_body(event)
    target = str(body.get("user_sub") or "").strip()
    email = str(body.get("email") or "").strip().lower()
    if not target and email:
        for p in _scan_by_pk_prefix("PROFILE#USER#"):
            if (p.get("user_email") or "").lower() == email:
                target = p.get("user_sub", "")
                break
    if not target:
        return _json_response(400, {"error": "Enter the delivery partner's registered email"})
    k = get_kyc(target)
    if not (k.get("status") == "approved" and k.get("kyc_role") in ("delivery_partner", "both")):
        return _json_response(400, {"error": "That user is not an approved delivery partner"})
    subs = list(shop.get("own_delivery_subs", []) or [])
    if target not in subs:
        subs.append(target)
    subs = subs[:20]
    table.update_item(Key={"pk": f"SHOP#{shop['shop_id']}"},
                      UpdateExpression="SET own_delivery_subs = :s",
                      ExpressionAttributeValues={":s": subs})
    return _json_response(200, {"success": True, "members": [_shop_team_member(s) for s in subs]})


def handle_shop_team_remove(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    shop = get_shop_by_user(user["sub"])
    if not shop:
        return _json_response(404, {"error": "You don't have a shop"})
    body = _event_body(event)
    target = str(body.get("user_sub") or "").strip()
    subs = [s for s in (shop.get("own_delivery_subs", []) or []) if s != target]
    table.update_item(Key={"pk": f"SHOP#{shop['shop_id']}"},
                      UpdateExpression="SET own_delivery_subs = :s",
                      ExpressionAttributeValues={":s": subs})
    return _json_response(200, {"success": True, "members": [_shop_team_member(s) for s in subs]})


# ══════════════ GEO-RADIUS FEED FILTER (Batch 8) ══════════════

def _profile_coords(p: dict) -> tuple[float | None, float | None]:
    """Lat/lng from Personal Information (profile address fields)."""
    if not p:
        return None, None
    try:
        lat, lng = float(p.get("address_lat") or 0), float(p.get("address_lng") or 0)
        if lat and lng:
            return lat, lng
    except (TypeError, ValueError):
        pass
    return None, None


def _resolve_profile_coords(p: dict) -> tuple[float | None, float | None]:
    """Profile lat/lng, or pincode centroid as fallback (best-effort)."""
    lat, lng = _profile_coords(p)
    if lat is not None:
        return lat, lng
    pin = str(p.get("pincode") or "").strip()
    if pin and PLATFORM_UTILS_OK:
        try:
            from platform_utils import geocode_pincode

            g = geocode_pincode(pin)
            if g:
                return g[0], g[1]
        except Exception:
            pass
    return None, None


def _haversine_km(a_lat, a_lng, b_lat, b_lng):
    """Great-circle distance in km, or None if any coordinate is missing/zero."""
    import math
    try:
        a_lat, a_lng, b_lat, b_lng = float(a_lat), float(a_lng), float(b_lat), float(b_lng)
    except (TypeError, ValueError):
        return None
    if not (a_lat and a_lng and b_lat and b_lng):
        return None
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = math.radians(b_lat - a_lat), math.radians(b_lng - a_lng)
    x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(x))


# ══════════════ PHASE D — radius applied EVERYWHERE ══════════════
# Catalogue + shop listings are public (no forced auth), but an authenticated
# viewer's saved Home radius is applied to public discovery. The centre and
# every candidate location come from the saved Personal Information map pin.

def _optional_user_geo(event: dict):
    """Fixed personal-address centre plus saved Home radius, or None.

    `feed_geo` stores the user's radius preference only. Its historical lat/lng
    fields are deliberately ignored: a GPS/current-delivery position cannot
    change which public people, products or shops appear in Home/Trade.
    """
    try:
        u = _auth_user(event)
        if not u:
            return None
        profile = get_profile(u["sub"])
        geo = profile.get("feed_geo") or {}
        lat, lng = _profile_coords(profile)
        km = float(geo.get("radius_km") or 0)
        if lat and lng and km > 0:
            return (lat, lng, km)
    except Exception:
        pass
    return None


def _owner_profile_geo(user_sub: str, cache: dict):
    """Permanent Personal Information coordinates for a user, cached."""
    if not user_sub:
        return None, None
    key = "u:" + user_sub
    if key not in cache:
        cache[key] = _profile_coords(get_profile(user_sub))
    return cache[key]


def _shop_owner_geo(shop: dict, cache: dict):
    """A shop is located at its owner's Personal Information address."""
    owner = shop.get("user_sub") or shop.get("owner_sub") or ""
    coords = _owner_profile_geo(owner, cache)
    # Backward-compatible fallback for old shop rows; new rows mirror this
    # exact profile address during creation/profile updates.
    if coords[0] is None:
        return shop.get("address_lat"), shop.get("address_lng")
    return coords


def _product_geo(p: dict, shop_cache: dict):
    """A product is discovered using its seller's fixed personal address."""
    seller = p.get("seller_user_sub") or p.get("seller_sub") or p.get("shop_owner_sub") or ""
    if seller:
        return _owner_profile_geo(seller, shop_cache)
    sid = p.get("shop_id")
    if sid:
        key = "shop:" + sid
        if key not in shop_cache:
            shop_cache[key] = _shop_owner_geo(get_shop(sid) or {}, shop_cache)
        return shop_cache[key]
    return None, None


def _geo_filter_products(products: list, geo, shop_cache=None):
    if not geo:
        return products
    g_lat, g_lng, g_km = geo
    cache = shop_cache if shop_cache is not None else {}
    out = []
    for p in products:
        plat, plng = _product_geo(p, cache)
        d = _haversine_km(g_lat, g_lng, plat, plng)
        if d is not None and d <= g_km:
            out.append(p)
    return out


def _geo_filter_shops(shops: list, geo, cache=None):
    """Strictly filter public shops by the owner's permanent profile pin."""
    if not geo:
        return shops
    g_lat, g_lng, g_km = geo
    out = []
    owner_cache = cache if cache is not None else {}
    for s in shops:
        slat, slng = _shop_owner_geo(s, owner_cache)
        d = _haversine_km(g_lat, g_lng, slat, slng)
        if d is not None and d <= g_km:
            out.append(s)
    return out


def handle_geo_set(event: dict) -> dict:
    """Save the user's home-feed area filter (centre + radius). Stored on the
    profile as strings (DynamoDB rejects floats) and applied in handle_feed_list."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    if body.get("clear"):
        upsert_profile(user["sub"], {"feed_geo": {}})
        return _json_response(200, {"success": True, "feed_geo": {}})
    try:
        km = float(body.get("radius_km") or 0)
    except (TypeError, ValueError):
        return _json_response(400, {"error": "invalid radius"})
    if km <= 0:
        return _json_response(400, {"error": "radius_km must be positive"})
    # The Home area may never use a transient device location. It is always
    # centred on the permanent map pin saved in Personal Information.
    prof = get_profile(user["sub"])
    lat, lng = _profile_coords(prof)
    if not (lat and lng):
        return _json_response(400, {
            "error": "Add your delivery address in Profile (with map pin or pincode) or allow GPS.",
        })
    geo = {"lat": str(lat), "lng": str(lng), "radius_km": str(km),
           "label": str(prof.get("address") or body.get("label") or "")[:120]}
    upsert_profile(user["sub"], {"feed_geo": geo})
    return _json_response(200, {"success": True, "feed_geo": geo})


def handle_geo_users(event: dict) -> dict:
    """Users who saved a personal address — for the Home 'All areas' map.
    Optional centre + radius_km (defaults to the viewer's feed_geo)."""
    user, err = _require_auth(event)
    if err:
        return err
    params = event.get("queryStringParameters") or {}
    prof = get_profile(user["sub"])
    geo = prof.get("feed_geo") or {}
    try:
        radius_km = float(
            params.get("radius_km") if params.get("radius_km") is not None else geo.get("radius_km") or 0
        )
    except (TypeError, ValueError):
        radius_km = 0.0
    center_lat = center_lng = 0.0
    if params.get("lat") is not None and params.get("lng") is not None:
        try:
            center_lat, center_lng = float(params["lat"]), float(params["lng"])
        except (TypeError, ValueError):
            center_lat = center_lng = 0.0
    if not (center_lat and center_lng):
        # Map circle is tied to Personal Information, not historic feed_geo
        # coordinates or the phone's current GPS position.
        clat, clng = _profile_coords(prof)
        if clat is not None:
            center_lat, center_lng = clat, clng

    hidden = _hidden_subs(user["sub"])
    users_out = []
    for p in _scan_by_pk_prefix("PROFILE#USER#"):
        sub = p.get("user_sub", "") or p.get("pk", "").replace("PROFILE#USER#", "")
        if not sub or sub in hidden:
            continue
        if p.get("account_status") in ("blocked", "blacklisted"):
            continue
        lat, lng = _resolve_profile_coords(p)
        if lat is None:
            continue
        if radius_km > 0 and center_lat and center_lng:
            d = _haversine_km(center_lat, center_lng, lat, lng)
            if d is not None and d > radius_km:
                continue
        users_out.append({
            "user_sub": sub,
            "user_name": p.get("user_name") or p.get("name") or "Aarvex user",
            "user_photo": _profile_photo(p),
            "lat": lat,
            "lng": lng,
            "city": p.get("city") or "",
            # Each pin owns its own saved Home radius. The map must never
            # redraw every person's circle using the viewer's radius.
            "radius_km": _json_num((p.get("feed_geo") or {}).get("radius_km", 0)),
        })
        if len(users_out) >= 250:
            break
    return _json_response(200, {
        "center": {"lat": center_lat, "lng": center_lng} if center_lat and center_lng else None,
        "radius_km": radius_km,
        "users": users_out,
        "total": len(users_out),
        "feed_geo": geo,
    })


def handle_feed_follow(event: dict) -> dict:
    """Follow / unfollow another user (Batch I). Telegram-style: one-way, no
    approval needed. Drives follower counts and 'followers-only' post privacy."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    target = str(body.get("user_sub") or "").strip()
    if not target:
        return _json_response(400, {"error": "user_sub required"})
    if target == user["sub"]:
        return _json_response(400, {"error": "You cannot follow yourself"})
    pk = f"FOLLOW#{user['sub']}#{target}"
    existing = table.get_item(Key={"pk": pk}).get("Item")
    want = body.get("follow")
    following = (not existing) if want is None else bool(want)
    if following and not existing:
        author = _feed_author(user)
        table.put_item(Item={
            "pk": pk, "follower_sub": user["sub"], "followee_sub": target,
            "follower_name": author["user_name"], "follower_photo": author["user_photo"],
            "created_at": _now(), "ttl": _ttl(365),
        })
        create_notification(target, "feed_follow", "New follower", f"{author['user_name']} started following you.",
                            link_type="profile", link_id=user["sub"],
                            from_sub=user["sub"], from_name=author["user_name"], from_photo=author["user_photo"])
    elif not following and existing:
        table.delete_item(Key={"pk": pk})
    return _json_response(200, {"success": True, "following": following})


def handle_feed_follow_stats(event: dict) -> dict:
    """Follower / following counts for a user (defaults to the caller), plus
    whether the caller follows them and the follower list."""
    user, err = _require_auth(event)
    if err:
        return err
    params = event.get("queryStringParameters") or {}
    target = str(params.get("user_sub") or user["sub"])
    followers = []
    for it in _scan_by_pk_prefix("FOLLOW#"):
        if it.get("followee_sub") == target:
            followers.append({
                "user_sub": it.get("follower_sub", ""),
                "user_name": it.get("follower_name", "Aarvex user"),
                "user_photo": it.get("follower_photo", ""),
            })
    # The people `target` follows. FOLLOW records only denormalise the
    # follower's name/photo, so resolve each followee's current profile for a
    # display name + avatar (used by the Messages "Following" list).
    following = []
    for it in _scan_by_pk_prefix(f"FOLLOW#{target}#"):
        fsub = it.get("followee_sub", "")
        if not fsub:
            continue
        prof = get_profile(fsub)
        following.append({
            "user_sub": fsub,
            "user_name": prof.get("user_name") or "Aarvex user",
            "user_photo": prof.get("custom_photo_url") or prof.get("photo_url") or prof.get("picture", ""),
        })
    return _json_response(200, {
        "user_sub": target,
        "follower_count": len(followers),
        "following_count": len(following),
        "is_following": _is_following(user["sub"], target),
        "followers": followers[:100],
        "following": following[:200],
    })


def handle_feed_likers(event: dict) -> dict:
    """Who reacted to a post (Batch I) — powers the tap-the-count list. Reads
    the FEEDLIKE records for this post; name/photo were denormalised onto them
    at reaction time (legacy records fall back to a generic name)."""
    user, err = _require_auth(event)
    if err:
        return err
    params = event.get("queryStringParameters") or {}
    post_id = str(params.get("post_id") or "")
    if not post_id:
        return _json_response(400, {"error": "post_id required"})
    likers = []
    for it in _scan_by_pk_prefix("FEEDLIKE#"):
        if it.get("post_id") != post_id:
            continue
        likers.append({
            "user_name": it.get("user_name", "Aarvex user"),
            "user_photo": it.get("user_photo", ""),
            "reaction": it.get("reaction", "like"),
            "created_at": it.get("created_at", ""),
        })
    likers.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return _json_response(200, {"likers": likers})


def handle_feed_comment(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    post_id = str(body.get("post_id") or "")
    text = str(body.get("text") or "").strip()[:300]
    if not text:
        return _json_response(400, {"error": "Comment text required"})
    if _rate_limited(user["sub"], "feed_comment", limit=20, window_seconds=60, fail_closed=True):
        return _rate_limit_response()
    mod_err, mod_meta = _moderation_decide(user["sub"], text, "comment", post_id)
    if mod_err:
        return mod_err
    post = _get_feed_post(post_id)
    if not post:
        return _json_response(404, {"error": "Post not found"})
    import time as _time
    author = _feed_author(user)
    comment_id = f"{int(_time.time() * 1000)}-{uuid.uuid4().hex[:6]}"
    # parent_id set => this is a threaded reply to another comment (Batch I).
    parent_id = str(body.get("parent_id") or "").strip()[:60]
    table.put_item(Item={
        "pk": f"FEEDCOMMENT#{post_id}#{comment_id}",
        "post_id": post_id,
        "comment_id": comment_id,
        "parent_id": parent_id,
        "user_sub": user["sub"],
        "user_name": author["user_name"],
        "user_photo": author["user_photo"],
        "text": text,
        "like_count": 0,
        "created_at": _now(),
        "ttl": _ttl(365),
    })
    if mod_meta.get("flagged") or mod_meta.get("hold"):
        try:
            import content_moderation as _cm
            _bind_content_moderation()
            _cm.create_mod_flag("comment", comment_id, user["sub"], mod_meta.get("reason") or "flagged", mod_meta.get("severity") or "soft", text)
        except Exception:
            pass
    try:
        table.update_item(
            Key={"pk": post["pk"]},
            UpdateExpression="SET comment_count = if_not_exists(comment_count, :z) + :o",
            ExpressionAttributeValues={":z": 0, ":o": 1},
        )
    except ClientError:
        pass
    if post.get("user_sub") and post["user_sub"] != user["sub"]:
        create_notification(
            post["user_sub"], "feed_comment", "New comment on your post",
            f"{author['user_name']}: \"{text[:80]}\"",
            post_id=post_id,
        )
    return _json_response(200, {"success": True, "comment_id": comment_id})


def handle_feed_comments(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    params = event.get("queryStringParameters") or {}
    post_id = str(params.get("post_id") or "")
    if not post_id:
        return _json_response(400, {"error": "post_id required"})
    comments = list(_scan_by_pk_prefix(f"FEEDCOMMENT#{post_id}#"))
    comments.sort(key=lambda c: c.get("pk", ""))
    my_comment_likes = {
        it.get("comment_id", "") for it in _scan_by_pk_prefix(f"FEEDCLIKE#{user['sub']}#")
    }
    return _json_response(200, {"comments": [{
        "comment_id": c.get("comment_id", ""),
        "parent_id": c.get("parent_id", ""),
        "user_sub": c.get("user_sub", ""),
        "user_name": c.get("user_name", "Aarvex user"),
        "user_photo": c.get("user_photo", ""),
        "text": c.get("text", ""),
        "like_count": int(_decimal(c.get("like_count", 0))),
        "liked_by_me": c.get("comment_id", "") in my_comment_likes,
        "created_at": c.get("created_at", ""),
    } for c in comments]})


def handle_feed_comment_like(event: dict) -> dict:
    """Like / unlike a single comment (Batch I)."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    post_id = str(body.get("post_id") or "")
    comment_id = str(body.get("comment_id") or "")
    if not post_id or not comment_id:
        return _json_response(400, {"error": "post_id and comment_id required"})
    comment_pk = f"FEEDCOMMENT#{post_id}#{comment_id}"
    if not table.get_item(Key={"pk": comment_pk}).get("Item"):
        return _json_response(404, {"error": "Comment not found"})
    like_pk = f"FEEDCLIKE#{user['sub']}#{comment_id}"
    existing = table.get_item(Key={"pk": like_pk}).get("Item")
    delta = -1 if existing else 1
    if existing:
        table.delete_item(Key={"pk": like_pk})
    else:
        table.put_item(Item={
            "pk": like_pk, "user_sub": user["sub"], "comment_id": comment_id,
            "post_id": post_id, "created_at": _now(), "ttl": _ttl(365),
        })
    try:
        resp = table.update_item(
            Key={"pk": comment_pk},
            UpdateExpression="SET like_count = if_not_exists(like_count, :z) + :d",
            ExpressionAttributeValues={":z": 0, ":d": delta},
            ReturnValues="UPDATED_NEW",
        )
        like_count = max(0, int(_decimal(resp["Attributes"].get("like_count", 0))))
    except ClientError:
        like_count = 0
    return _json_response(200, {"success": True, "liked": delta > 0, "like_count": like_count})


def handle_feed_view(event: dict) -> dict:
    """Batched, best-effort view counting — the frontend sends the ids of
    posts that actually scrolled into view (IntersectionObserver)."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    post_ids = body.get("post_ids") or []
    if not isinstance(post_ids, list):
        return _json_response(400, {"error": "post_ids must be a list"})
    counted = 0
    for pid in post_ids[:25]:
        pid = str(pid)
        if "#" in pid:
            continue
        try:
            table.update_item(
                Key={"pk": f"FEEDPOST#{pid}"},
                UpdateExpression="SET view_count = if_not_exists(view_count, :z) + :o",
                ConditionExpression="attribute_exists(pk)",
                ExpressionAttributeValues={":z": 0, ":o": 1},
            )
            counted += 1
        except Exception:
            pass
    return _json_response(200, {"success": True, "counted": counted})


def handle_feed_share(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    post = _get_feed_post(str(body.get("post_id") or ""))
    if not post:
        return _json_response(404, {"error": "Post not found"})
    try:
        table.update_item(
            Key={"pk": post["pk"]},
            UpdateExpression="SET share_count = if_not_exists(share_count, :z) + :o",
            ExpressionAttributeValues={":z": 0, ":o": 1},
        )
    except ClientError:
        pass
    return _json_response(200, {"success": True})


def handle_profile_cover(event: dict) -> dict:
    """Set / replace the profile COVER photo (shown behind the avatar on
    My Profile, like a social profile header)."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    b64 = body.get("image_b64") or ""
    if not b64:
        upsert_profile(user["sub"], {"cover_photo_url": ""})
        return _json_response(200, {"success": True, "cover_photo_url": ""})
    if len(b64) > _FEED_MEDIA_MAX_B64:
        return _json_response(400, {"error": "Image too large — max 5MB"})
    key = _upload_b64_to_s3(b64, f"covers/{user['sub'][:24]}", "cover")
    if not key:
        return _json_response(400, {"error": "Upload failed"})
    url = _public_s3_url(key)
    upsert_profile(user["sub"], {"cover_photo_url": url})
    return _json_response(200, {"success": True, "cover_photo_url": url})


def handle_shop_favourites(event: dict) -> dict:
    """Shops this user has liked/favourited — powers the Favourites tab's
    new "Shops" sub-tab. Reuses the SHOPLIKE records handle_shop_like
    already writes."""
    user, err = _require_auth(event)
    if err:
        return err
    shops = []
    for it in _scan_by_pk_prefix(f"SHOPLIKE#{user['sub']}#"):
        shop_id = it.get("shop_id", "")
        if not shop_id:
            continue
        shop = get_shop(shop_id)
        if not shop or shop.get("status") not in ("active", None, ""):
            # Still list paused shops (they may come back) — only drop
            # records whose shop no longer exists at all.
            if not shop:
                continue
        shops.append({
            "shop_id": shop_id,
            "shop_name": shop.get("shop_name") or shop_id,
            "shop_category": shop.get("shop_category", ""),
            "shop_logo_url": shop.get("shop_logo_url", ""),
            "address_city": shop.get("address_city", ""),
            "address_state": shop.get("address_state", ""),
            "avg_rating": _json_num(shop.get("avg_rating", 0)),
            "like_count": int(_decimal(shop.get("like_count", 0))),
            "liked_at": it.get("liked_at", ""),
        })
    shops.sort(key=lambda s: s.get("liked_at", ""), reverse=True)
    return _json_response(200, {"shops": shops})


def handle_favourites_get(event: dict) -> dict:
    user, error = _require_auth(event)
    if error:
        return error
    item = table.get_item(Key={"pk": f"FAVOURITE#USER#{user['sub']}"}).get("Item") or {}
    return _json_response(200, {"liked_keys": sorted(item.get("liked_keys") or [])})


def handle_favourites_products(event: dict) -> dict:
    """Full product objects for the user's liked products (Phase 0). Previously
    the favourites grid filtered the entire in-browser catalogue by liked key,
    which only works while the whole catalogue is loaded — impossible once the
    catalogue is paginated. This returns just the liked products' data."""
    user, error = _require_auth(event)
    if error:
        return error
    fav = table.get_item(Key={"pk": f"FAVOURITE#USER#{user['sub']}"}).get("Item") or {}
    liked = set(fav.get("liked_keys") or [])
    if not liked:
        return _json_response(200, {"products": []})
    out = []
    for p in _all_active_products(include_paused=True):
        key = (p.get("shop_id") or "") + "::" + (p.get("product_id") or "")
        if key in liked:
            out.append(p)
    return _json_response(200, {"products": out})


def handle_favourites_toggle(event: dict) -> dict:
    user, error = _require_auth(event)
    if error:
        return error
    body = _event_body(event)
    key = str(body.get("key") or "").strip()
    liked = body.get("liked")
    if not key or "::" not in key or not isinstance(liked, bool):
        return _json_response(400, {"error": "A valid favourite key and liked state are required"})
    favourite_pk = f"FAVOURITE#USER#{user['sub']}"
    try:
        action = "ADD" if liked else "DELETE"
        # This update_item is an upsert — it can create the row — so the index
        # attributes have to be written here too (put_item's proxy never runs).
        g_pk, g_sk = _gsi_keys(favourite_pk)
        table.update_item(
            Key={"pk": favourite_pk},
            UpdateExpression=f"SET updated_at = :now, gsi1pk = :gp, gsi1sk = :gs {action} liked_keys :keyset",
            ExpressionAttributeValues={":keyset": {key}, ":now": _now(), ":gp": g_pk, ":gs": g_sk},
        )
    except ClientError:
        logger.exception("[FAVOURITES] Toggle failed")
        return _json_response(500, {"error": "Could not update favourites"})
    return _json_response(200, {"success": True, "key": key, "liked": liked})


def admin_list_users(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    qs = event.get("queryStringParameters") or {}
    try:
        limit = min(max(int(qs.get("limit", 100)), 1), 300)
    except (TypeError, ValueError):
        limit = 100
    cursor_b64 = (qs.get("cursor") or "").strip()
    start_key = None
    if cursor_b64:
        try:
            start_key = json.loads(base64.b64decode(cursor_b64).decode("utf-8"))
        except Exception:
            start_key = None

    profiles, lek = _query_gsi_page("PROFILE", limit=limit, start_key=start_key, forward=False)
    if not profiles and _gsi_available is False:
        profiles = _scan_by_pk_prefix("PROFILE#USER#")
        profiles.sort(key=lambda p: p.get("joined_at", p.get("created_at", "")), reverse=True)
        profiles = profiles[:limit]
        lek = None

    kyc_map = {k.get("user_sub"): k for k in _scan_by_pk_prefix("KYC#USER#")}
    shops = {s.get("user_sub"): s for s in _scan_by_pk_prefix("SHOP#")}
    try:
        import content_moderation as _cm
        _bind_content_moderation()
        get_strikes = _cm.get_strikes
    except Exception:
        get_strikes = lambda _s: {"count": 0}

    users = []
    for p in profiles:
        sub = p.get("user_sub", p["pk"].replace("PROFILE#USER#", ""))
        kyc = kyc_map.get(sub, {})
        shop = shops.get(sub, {})
        strikes = get_strikes(sub)
        users.append({
            "user_sub": sub,
            "name": p.get("user_name", ""),
            "email": p.get("user_email", ""),
            "joined_at": p.get("joined_at", p.get("created_at", "")),
            "account_status": p.get("account_status", "active"),
            "moderation_reason": p.get("moderation_reason", ""),
            "strike_count": strikes.get("count", 0),
            "kyc_status": kyc.get("status", "none"),
            "shop_id": shop.get("shop_id", kyc.get("shop_id", "")),
            "shop_status": shop.get("status", ""),
        })
    next_cursor = None
    if lek:
        next_cursor = base64.b64encode(json.dumps(lek, default=str).encode("utf-8")).decode("ascii")
    return _json_response(200, {"users": users, "total": len(users), "next_cursor": next_cursor})


def admin_user_block(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    user_sub = body.get("user_sub", "")
    blocked = body.get("blocked", True)
    status = "blocked" if blocked else "active"
    upsert_profile(user_sub, {"account_status": status})
    shop = get_shop_by_user(user_sub)
    if shop and blocked:
        table.update_item(
            Key={"pk": f"SHOP#{shop['shop_id']}"},
            UpdateExpression="SET #s = :s",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": "blocked"},
        )
    create_notification(user_sub, "admin_message", "Account Status", f"Your account has been {status} by admin.")
    return _json_response(200, {"success": True})


def admin_user_delete(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    user_sub = str(body.get("user_sub") or "").strip()
    if not user_sub:
        return _json_response(400, {"error": "user_sub required"})
    confirm = body.get("confirm")
    if not confirm:
        return _json_response(400, {"error": "Confirmation required — send confirm=true"})
    reason = str(body.get("reason") or "admin_permanent_delete")[:300]
    result = _purge_user(user_sub, by_admin=True, reason=reason)
    return _json_response(200, {"success": True, **result})


def admin_user_warn(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    user_sub = str(body.get("user_sub") or "").strip()
    message = str(body.get("message") or body.get("reason") or "").strip()
    if not user_sub or not message:
        return _json_response(400, {"error": "user_sub and message required"})
    try:
        import content_moderation as _cm
        _bind_content_moderation()
        result = _cm.admin_warn_user(user_sub, message)
        _cm.write_admin_audit("warn_user", message, target=user_sub)
    except Exception as e:
        logger.exception("[ADMIN] warn failed")
        return _json_response(500, {"error": str(e)})
    return _json_response(200, {"success": True, **result})


def admin_user_notify(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    user_sub = body.get("user_sub", "")
    title = body.get("title") or body.get("subject") or "Message from Aarvex Global Admin"
    message = body.get("message") or body.get("body") or ""
    create_notification(user_sub, "admin_message", title, message)
    return _json_response(200, {"success": True})


def admin_kyc_list(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    status_filter = (event.get("queryStringParameters") or {}).get("status", "pending")
    items = _scan_by_pk_prefix("KYC#USER#")
    if status_filter != "all":
        items = [i for i in items if i.get("status") == status_filter]
    out = []
    for k in items:
        out.append({
            "user_sub": k.get("user_sub", ""),
            "user_name": k.get("user_name", ""),
            "user_email": k.get("user_email", ""),
            "aadhaar_last4": k.get("aadhaar_last4", ""),
            "pan_number": k.get("pan_number", ""),
            "pan_name": k.get("pan_name", ""),
            "aadhaar_name": k.get("aadhaar_name", ""),
            "bank_account_holder": k.get("bank_account_holder", ""),
            "bank_name": k.get("bank_name", ""),
            "bank_ifsc": k.get("bank_ifsc", ""),
            "bank_account_masked": k.get("bank_account_masked", ""),
            "kyc_checks": k.get("kyc_checks", {}),
            "auto_flags": k.get("auto_flags", []),
            "kyc_role": k.get("kyc_role", "shop_owner"),
            "status": k.get("status", ""),
            "submitted_at": k.get("submitted_at", ""),
            "aadhaar_front_url": _presigned_get(k.get("aadhaar_front_s3_key", "")),
            "aadhaar_back_url": _presigned_get(k.get("aadhaar_back_s3_key", "")),
            "signature_url": _presigned_get(k.get("signature_s3_key", "")),
        })
    out.sort(key=lambda x: x.get("submitted_at", ""), reverse=True)
    return _json_response(200, {"kyc_list": out})


_VALID_KYC_ROLES = ("shop_owner", "delivery_partner", "both")


def _normalize_kyc_role(raw) -> str | None:
    """Returns a valid kyc_role string, or None if not supplied/invalid.
    Kept permissive on None/missing so approve/reject can omit it entirely
    and leave the existing kyc_role untouched (back-compatible default)."""
    if raw is None:
        return None
    role = str(raw).strip().lower()
    return role if role in _VALID_KYC_ROLES else None


def admin_kyc_review(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    user_sub = body.get("user_sub", "")
    action = body.get("action", "")
    reason = body.get("rejection_reason", "")
    # Optional role correction, usable alongside approve/reject, or alone
    # via action="update_role". See _normalize_kyc_role for validation.
    new_role = _normalize_kyc_role(body.get("kyc_role"))
    kyc = get_kyc(user_sub)
    if not kyc:
        return _json_response(404, {"error": "KYC not found"})
    if action == "approve":
        names = {"#s": "status"}
        values = {":s": "approved", ":u": _now(), ":r": ""}
        expr = "SET #s = :s, reviewed_at = :u, rejection_reason = :r"
        if new_role:
            names["#kr"] = "kyc_role"
            values[":kr"] = new_role
            expr += ", #kr = :kr"
        table.update_item(
            Key={"pk": f"KYC#USER#{user_sub}"},
            UpdateExpression=expr,
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )
        create_notification(user_sub, "kyc_update", "KYC Approved", "Your KYC has been approved! Create your shop now.")
    elif action == "reject":
        names = {"#s": "status"}
        values = {":s": "rejected", ":u": _now(), ":r": reason}
        expr = "SET #s = :s, reviewed_at = :u, rejection_reason = :r"
        if new_role:
            names["#kr"] = "kyc_role"
            values[":kr"] = new_role
            expr += ", #kr = :kr"
        table.update_item(
            Key={"pk": f"KYC#USER#{user_sub}"},
            UpdateExpression=expr,
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )
        create_notification(user_sub, "kyc_update", "KYC Rejected", f"KYC rejected: {reason or 'Please resubmit.'}")
    elif action == "update_role":
        # Standalone role correction — for the exact bug this fixes: an
        # already-approved KYC whose kyc_role was wrong (e.g. defaulted to
        # "shop_owner" at submit time) and had no way to be corrected since
        # approve/reject never touched kyc_role before this fix. Does NOT
        # touch status or send a KYC-status notification, since the KYC
        # decision itself isn't changing — only the role on file is.
        if not new_role:
            return _json_response(400, {"error": "kyc_role must be one of: shop_owner, delivery_partner, both"})
        table.update_item(
            Key={"pk": f"KYC#USER#{user_sub}"},
            UpdateExpression="SET kyc_role = :kr, reviewed_at = :u",
            ExpressionAttributeValues={":kr": new_role, ":u": _now()},
        )
        create_notification(
            user_sub, "kyc_update", "Account Role Updated",
            "Your account role has been updated by admin. Refresh the app to see any new tabs (e.g. Delivery)."
        )
    else:
        return _json_response(400, {"error": "action must be approve, reject, or update_role"})
    return _json_response(200, {"success": True})


def admin_shops_list(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    shops = []
    for s in _scan_by_pk_prefix("SHOP#"):
        shops.append({
            "shop_id": s.get("shop_id", ""),
            "user_name": s.get("user_name", ""),
            "user_email": s.get("user_email", ""),
            "shop_category": s.get("shop_category", ""),
            "product_count": int(_decimal(s.get("product_count", 0))),
            "avg_rating": _json_num(s.get("avg_rating", 0)),
            "status": s.get("status", ""),
            "created_at": s.get("created_at", ""),
            "user_sub": s.get("user_sub", ""),
        })
    return _json_response(200, {"shops": shops})


def admin_shop_block(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    shop_id = body.get("shop_id", "")
    blocked = body.get("blocked", True)
    shop = get_shop(shop_id)
    if not shop:
        return _json_response(404, {"error": "Shop not found"})
    status = "blocked" if blocked else "active"
    table.update_item(
        Key={"pk": f"SHOP#{shop_id}"},
        UpdateExpression="SET #s = :s",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": status},
    )
    owner = shop.get("user_sub", "")
    if owner:
        create_notification(owner, "shop_status", "Shop Status", f"Your shop has been {status} by admin.")
    return _json_response(200, {"success": True})


def admin_shop_delete(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    shop_id = body.get("shop_id", "")
    shop = get_shop(shop_id)
    if not shop:
        return _json_response(404, {"error": "Shop not found"})
    for item in _scan_by_pk_prefix("CATALOGUE#CATEGORY#"):
        if item.get("shop_id") == shop_id:
            table.delete_item(Key={"pk": item["pk"]})
    table.delete_item(Key={"pk": f"SHOP#{shop_id}"})
    owner = shop.get("user_sub", "")
    if owner:
        create_notification(owner, "shop_status", "Shop Deleted", "Your shop and products have been removed by admin.")
    return _json_response(200, {"success": True})


def admin_marketplace_stats() -> dict:
    profiles = _scan_by_pk_prefix("PROFILE#USER#")
    kyc_pending = len([k for k in _scan_by_pk_prefix("KYC#USER#") if k.get("status") == "pending"])
    shops = _scan_by_pk_prefix("SHOP#")
    active_shops = len([s for s in shops if s.get("status") == "active"])
    seller_products = len([
        p for p in _scan_by_pk_prefix("CATALOGUE#CATEGORY#")
        if p.get("is_seller_product") and p.get("is_active", True)
    ])
    notifs = _scan_by_pk_prefix("NOTIFICATION#USER#")
    unread = sum(1 for n in notifs if not n.get("is_read"))
    return {
        "total_portal_users": len(profiles),
        "kyc_pending": kyc_pending,
        "total_active_shops": active_shops,
        "total_seller_products": seller_products,
        "unread_notifications": unread,
    }


def _normalize_http_path(path: str) -> str:
    if not path:
        return "/"
    path = path.split("?")[0]
    for stage in ("/prod", "/dev", "/staging", "/$default"):
        if path.startswith(stage + "/"):
            path = path[len(stage):]
            break
    if not path.startswith("/"):
        path = "/" + path
    return path if path == "/" else path.rstrip("/")


def _normalize_shop_id(raw: str) -> str:
    s = (raw or "").strip().upper()
    if not s:
        return ""
    if s.startswith("SHOP-"):
        return s
    digits = re.sub(r"\D", "", s)
    if digits:
        return f"SHOP-AX-{digits.zfill(5)[-5:]}"
    return s


def _approved_shopkeepers() -> list[dict]:
    shops = []
    for item in _scan_by_pk_prefix("SHOP#"):
        pk = item.get("pk", "")
        if "COUNTER" in pk:
            continue
        shop_id = item.get("shop_id") or pk.replace("SHOP#", "")
        if not shop_id:
            continue
        user_sub = item.get("user_sub", "")
        if not user_sub:
            continue
        kyc = get_kyc(user_sub)
        if kyc.get("status") != "approved":
            continue
        if item.get("status", "active") in ("blocked", "deleted"):
            continue
        shops.append(item)
    return shops


def _shop_public_stats(shop_id: str) -> dict:
    products = sum(
        1 for item in _scan_by_pk_prefix("CATALOGUE#CATEGORY#")
        if item.get("shop_id") == shop_id and item.get("is_active", True)
    )
    deals = sum(
        1 for item in _scan_by_pk_prefix("DEAL#SHOP#")
        if item.get("shop_id") == shop_id
    )
    return {"products_listed": products, "orders_completed": deals}


def _shop_public_reviews(shop_id: str) -> list[dict]:
    reviews = []
    for item in _scan_by_pk_prefix("REVIEW#"):
        if item.get("shop_id") != shop_id:
            continue
        if "rating" not in item:
            continue
        reviews.append({
            "reviewer_name": item.get("reviewer_name", "Customer"),
            "rating": int(item.get("rating", 0)),
            "comment": item.get("comment", ""),
            "created_at": item.get("created_at", ""),
            "product_id": item.get("product_id", ""),
        })
    reviews.sort(key=lambda r: r.get("created_at", ""), reverse=True)
    return reviews[:30]


def _bulk_shop_stats_and_reviews(shop_ids: set) -> tuple[dict, dict]:
    """Stats + reviews for MANY shops using one scan per collection, instead
    of _shop_public_stats/_shop_public_reviews' 3 scans per shop."""
    stats_map: dict[str, dict] = {sid: {"products_listed": 0, "orders_completed": 0} for sid in shop_ids}
    reviews_map: dict[str, list] = {sid: [] for sid in shop_ids}
    if not shop_ids:
        return stats_map, reviews_map
    for item in _scan_by_pk_prefix("CATALOGUE#CATEGORY#"):
        sid = item.get("shop_id", "")
        if sid in stats_map and item.get("is_active", True):
            stats_map[sid]["products_listed"] += 1
    for item in _scan_by_pk_prefix("DEAL#SHOP#"):
        sid = item.get("shop_id", "")
        if sid in stats_map:
            stats_map[sid]["orders_completed"] += 1
    for item in _scan_by_pk_prefix("REVIEW#"):
        sid = item.get("shop_id", "")
        if sid not in reviews_map or "rating" not in item:
            continue
        reviews_map[sid].append({
            "reviewer_name": item.get("reviewer_name", "Customer"),
            "rating": int(item.get("rating", 0)),
            "comment": item.get("comment", ""),
            "created_at": item.get("created_at", ""),
            "product_id": item.get("product_id", ""),
        })
    for sid in reviews_map:
        reviews_map[sid].sort(key=lambda r: r.get("created_at", ""), reverse=True)
        reviews_map[sid] = reviews_map[sid][:30]
    return stats_map, reviews_map


def _serialize_shop_public(shop: dict, stats: dict | None = None, reviews: list | None = None) -> dict:
    """`stats` / `reviews` can be passed in when the caller already has them
    (or has precomputed them in bulk). Each is otherwise a FULL TABLE SCAN, so
    never let this run un-primed inside a loop — see handle_shop_public."""
    shop_id = shop.get("shop_id") or shop.get("pk", "").replace("SHOP#", "")
    stats = stats if stats is not None else _shop_public_stats(shop_id)
    reviews = reviews if reviews is not None else _shop_public_reviews(shop_id)
    avg = round(sum(r["rating"] for r in reviews) / len(reviews), 1) if reviews else 0.0
    return {
        "shop_id": shop_id,
        "shop_name": shop.get("shop_name") or shop_id,
        # Owner's chat id — lets buyers open an in-app messenger thread with the
        # shopkeeper ("Chat with shop"). Sending still requires the buyer to be
        # signed in (messenger + /chat/send enforce auth), and this is no more
        # exposing than contact_number below, which is the owner's real phone.
        "owner_sub": shop.get("user_sub", ""),
        "shop_description": shop.get("shop_description", ""),
        "shop_category": shop.get("shop_category", ""),
        # Shop display picture + cover — surfaced everywhere a shop appears
        # (profile modal, directory, top-shops strip, feed pro badge).
        "shop_logo_url": shop.get("shop_logo_url", ""),
        "shop_cover_url": shop.get("shop_cover_url", ""),
        "address_city": shop.get("address_city", ""),
        "address_state": shop.get("address_state", ""),
        "address_pincode": shop.get("address_pincode", ""),
        "gst_number": shop.get("gst_number", ""),
        # Publicly-shareable contact info only -- business phone + city/state.
        # Never merge personal email or other sensitive KYC fields here.
        "contact_number": get_profile(shop.get("user_sub", "")).get("mobile") or get_profile(shop.get("user_sub", "")).get("phone", ""),
        "address_line": ", ".join(filter(None, [shop.get("address_city", ""), shop.get("address_state", "")])),
        "status": shop.get("status", "active"),
        # A shop historically had TWO unrelated like counters: `like_count`
        # (written by the heart / favourite button, and what the shop
        # directory, Top Shops and Favourites all read) and `likes` (written
        # by the profile's thumbs-up reaction). The profile stat read `likes`,
        # so hearting a shop never moved the number shown on its own page.
        # `likes` is now the canonical heart count; the thumbs reaction keeps
        # its own clearly-named pair.
        "likes": int(_decimal(shop.get("like_count", 0) or shop.get("likes", 0))),
        "reaction_likes": int(_decimal(shop.get("likes", 0))),
        "dislikes": int(_decimal(shop.get("dislikes", 0))),
        "avg_rating": avg,
        "total_reviews": len(reviews),
        "products_listed": stats.get("products_listed", 0),
        "orders_completed": stats.get("orders_completed", 0),
        "member_since": shop.get("created_at", ""),
    }


def notify_shopkeepers_of_listing(exporter_data: dict, ticket_id: str, ref_id: str) -> int:
    crop = exporter_data.get("product_name") or exporter_data.get("crop") or "Produce"
    qty = exporter_data.get("quantity_available_kg", "")
    city = exporter_data.get("location_city", "")
    state = exporter_data.get("location_state", "")
    price = exporter_data.get("expected_price", "")
    price_line = f"Expected price: ₹{price}/kg\n" if price not in (None, "", 0) else ""
    body = (
        f"Crop: {crop}\nQuantity: {qty} kg\n{price_line}"
        f"Location: {city}, {state}\nReference: {ref_id}\n"
        f"5% platform fee applies on finalized deals."
    )
    count = 0
    for shop in _approved_shopkeepers():
        user_sub = shop.get("user_sub", "")
        if not user_sub:
            continue
        create_notification(
            user_sub, "new_lead", f"New produce listing — {crop}", body,
            ticket_id=ticket_id, reference_id=ref_id, listing_crop=crop,
            # Structured fields (Phase 2, Section 0 #4): "body" above is kept
            # as-is for older clients/other channels, but the in-app
            # notification-item template (CatalogueUI.notificationItemHtml)
            # reads these fields directly instead of parsing/dumping raw text.
            listing_quantity_kg=qty,
            listing_expected_price=price if price not in (None, "", 0) else None,
            listing_city=city,
            listing_state=state,
            platform_fee_pct=5,
        )
        count += 1
    logger.info("[SELL] Notified %s shopkeepers for %s", count, ref_id)
    return count


def handle_shop_public(event: dict) -> dict:
    params = event.get("queryStringParameters") or {}
    shop_id = _normalize_shop_id(params.get("shop_id") or "")
    q = (params.get("q") or params.get("search") or "").strip()

    if q and not shop_id:
        q_upper = _normalize_shop_id(q) if re.search(r"\d", q) else ""
        matched = []
        for item in _approved_shopkeepers():
            sid = item.get("shop_id") or item.get("pk", "").replace("SHOP#", "")
            desc = (item.get("shop_description") or "").lower()
            match = (q_upper and sid.upper() == q_upper) or q.lower() in sid.lower() or q.lower() in desc
            if match:
                matched.append((sid, item))
        matched = matched[:20]
        # PERF: build the stats/reviews maps with ONE scan each instead of
        # letting _serialize_shop_public run 3 full table scans per shop.
        wanted = {sid for sid, _ in matched}
        stats_map, reviews_map = _bulk_shop_stats_and_reviews(wanted)
        shops = [
            _serialize_shop_public(item, stats_map.get(sid), reviews_map.get(sid, []))
            for sid, item in matched
        ]
        return _json_response(200, {"shops": shops})

    if not shop_id:
        return _json_response(400, {"error": "shop_id or search (q) required"})

    shop = get_shop(shop_id)
    if not shop:
        # Soft fallback: try without aggressive normalize (legacy ids)
        raw = (params.get("shop_id") or "").strip()
        if raw and raw != shop_id:
            shop = get_shop(raw)
            if shop:
                shop_id = shop.get("shop_id") or raw
    if not shop:
        return _json_response(404, {"error": "Shop not found", "shop": None})

    # One catalogue scan for products (+ count). Avoid a second full-table
    # pass inside _shop_public_stats which was timing out API Gateway and
    # surfacing as TypeError: Failed to fetch in the browser.
    products = []
    for item in _scan_by_pk_prefix("CATALOGUE#CATEGORY#"):
        if item.get("shop_id") != shop_id:
            continue
        ser = serialize_product(item)
        if ser:
            products.append(ser)

    reviews = _shop_public_reviews(shop_id)
    # Lightweight stats — reuse the products we already loaded; deals scan only.
    deals = 0
    try:
        deals = sum(
            1 for item in _scan_by_pk_prefix("DEAL#SHOP#")
            if item.get("shop_id") == shop_id
        )
    except Exception as e:
        logger.warning("[SHOP_PUBLIC] deals scan failed: %s", e)
    stats = {"products_listed": len(products), "orders_completed": deals}

    return _json_response(200, {
        "shop": dict(_serialize_shop_public(shop, stats, reviews),
                     products_sold=int(_decimal(shop.get("products_sold", 0))),
                     product_count=len(products)),
        "products": products,
        "reviews": reviews,
    })


def handle_shop_react(event: dict) -> dict:
    body = _event_body(event)
    shop_id = _normalize_shop_id(body.get("shop_id") or "")
    reaction = (body.get("reaction") or "").strip().lower()
    user_sub = (body.get("user_sub") or "").strip()
    if not shop_id or reaction not in ("like", "dislike"):
        return _json_response(400, {"error": "Invalid reaction"})
    shop = get_shop(shop_id)
    if not shop:
        return _json_response(404, {"error": "Shop not found"})
    react_key = f"SHOP_REACT#{shop_id}#{user_sub or 'anon_' + str(uuid.uuid4())[:8]}"
    prev = table.get_item(Key={"pk": react_key}).get("Item") or {}
    likes = int(_decimal(shop.get("likes", 0)))
    dislikes = int(_decimal(shop.get("dislikes", 0)))
    if prev.get("reaction") == "like":
        likes = max(0, likes - 1)
    elif prev.get("reaction") == "dislike":
        dislikes = max(0, dislikes - 1)
    if reaction == "like":
        likes += 1
    else:
        dislikes += 1
    table.put_item(Item={"pk": react_key, "reaction": reaction, "user_sub": user_sub, "updated_at": _now(), "ttl": _ttl(365)})
    table.update_item(
        Key={"pk": f"SHOP#{shop_id}"},
        UpdateExpression="SET likes = :l, dislikes = :d",
        ExpressionAttributeValues={":l": likes, ":d": dislikes},
    )
    return _json_response(200, {"success": True, "likes": likes, "dislikes": dislikes})


def handle_shop_like(event: dict) -> dict:
    """Like a shop (auth required, idempotent per user). Increments like_count atomically."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    shop_id = _normalize_shop_id(body.get("shop_id") or "")
    if not shop_id:
        return _json_response(400, {"error": "shop_id required"})
    
    shop = get_shop(shop_id)
    if not shop:
        return _json_response(404, {"error": "Shop not found"})
    
    # Deduplication key: SHOPLIKE#{user_sub}#{shop_id}
    like_key = f"SHOPLIKE#{user['sub']}#{shop_id}"
    existing = table.get_item(Key={"pk": like_key}).get("Item")

    # Toggle-off support: heart button on shop cards passes liked=false to
    # un-favourite. Removes the SHOPLIKE record (so it drops out of the
    # Favourites → Shops tab) and decrements the public like_count, floored
    # at 0. Idempotent — un-liking an already-un-liked shop is a no-op.
    want_liked = body.get("liked")
    if want_liked is False:
        if not existing:
            like_count = int(_decimal(shop.get("like_count", 0)))
            return _json_response(200, {"success": True, "like_count": like_count, "liked": False})
        table.delete_item(Key={"pk": like_key})
        try:
            resp = table.update_item(
                Key={"pk": f"SHOP#{shop_id}"},
                UpdateExpression="SET like_count = if_not_exists(like_count, :zero) - :one",
                ConditionExpression="attribute_exists(like_count) AND like_count > :zero",
                ExpressionAttributeValues={":zero": 0, ":one": 1},
                ReturnValues="UPDATED_NEW",
            )
            like_count = int(resp["Attributes"].get("like_count", 0))
        except ClientError:
            like_count = max(0, int(_decimal(shop.get("like_count", 0))) - 1)
            table.update_item(
                Key={"pk": f"SHOP#{shop_id}"},
                UpdateExpression="SET like_count = :l",
                ExpressionAttributeValues={":l": like_count},
            )
        return _json_response(200, {"success": True, "like_count": like_count, "liked": False})

    if existing:
        # Already liked - return current count without incrementing
        like_count = int(_decimal(shop.get("like_count", 0)))
        return _json_response(200, {"success": True, "like_count": like_count, "already_liked": True, "liked": True})

    # Atomically increment like_count
    try:
        resp = table.update_item(
            Key={"pk": f"SHOP#{shop_id}"},
            UpdateExpression="SET like_count = if_not_exists(like_count, :zero) + :one",
            ExpressionAttributeValues={":zero": 0, ":one": 1},
            ReturnValues="UPDATED_NEW",
        )
        like_count = int(resp["Attributes"].get("like_count", 1))
    except ClientError:
        # Fallback if atomic update fails
        like_count = int(_decimal(shop.get("like_count", 0))) + 1
        table.update_item(
            Key={"pk": f"SHOP#{shop_id}"},
            UpdateExpression="SET like_count = :l",
            ExpressionAttributeValues={":l": like_count},
        )
    
    # Record that this user liked this shop (idempotency)
    table.put_item(Item={
        "pk": like_key,
        "user_sub": user["sub"],
        "shop_id": shop_id,
        "liked_at": _now(),
        "ttl": _ttl(365),
    })
    
    return _json_response(200, {"success": True, "like_count": like_count, "already_liked": False, "liked": True})


def handle_shops_top(event: dict) -> dict:
    """Return the viewer's city leaderboard, never constrained by Home radius."""
    import math
    viewer = _auth_user(event)
    viewer_city = ""
    if viewer:
        viewer_city = str(get_profile(viewer["sub"]).get("city") or "").strip().casefold()
    
    # PERF: count products per shop ONCE up front. This used to run a full
    # table scan *inside* the per-shop loop (O(shops x items)) — with 1k shops
    # that was 1k full scans for a single request, and this endpoint is hit on
    # every Trade tab / home feed load.
    product_counts: dict[str, int] = {}
    for prod in _scan_by_pk_prefix("CATALOGUE#CATEGORY#"):
        if not prod.get("is_active", True):
            continue
        sid = prod.get("shop_id", "")
        if sid:
            product_counts[sid] = product_counts.get(sid, 0) + 1

    shops = []
    for item in _scan_by_pk_prefix("SHOP#"):
        if item.get("status") != "active" or not item.get("kyc_verified"):
            continue

        # Star Performer / Top Shops are a city-level merchandising section.
        # They use the shop owner's Personal Information city and deliberately
        # ignore the user's All areas radius.
        owner_city = str(get_profile(item.get("user_sub", "")).get("city") or item.get("address_city") or "").strip().casefold()
        if viewer_city and owner_city != viewer_city:
            continue

        shop_id = item.get("shop_id", "")

        # Only include shops with at least 1 published product
        product_count = product_counts.get(shop_id, 0)
        if product_count < 1:
            continue

        avg_rating = float(_decimal(item.get("avg_rating", 0)))
        total_reviews = int(_decimal(item.get("total_reviews", 0)))
        like_count = int(_decimal(item.get("like_count", 0)))
        
        # Composite score: avg_rating * log(1 + total_reviews) + like_count factor
        # This balances rating quality with review volume and likes
        review_factor = math.log(1 + total_reviews) if total_reviews > 0 else 0
        score = (avg_rating * review_factor) + (like_count * 0.1)
        
        shops.append({
            "shop_id": shop_id,
            "shop_name": item.get("shop_name") or shop_id,
            "shop_logo_url": item.get("shop_logo_url", ""),
            "shop_cover_url": item.get("shop_cover_url", ""),
            "avg_rating": round(avg_rating, 1),
            "total_reviews": total_reviews,
            "like_count": like_count,
            "score": score,
            "product_count": product_count,
        })
    
    # Sort by score descending
    shops.sort(key=lambda s: s["score"], reverse=True)
    
    # Return top 10
    top_shops = shops[:10]
    for shop in top_shops:
        shop.pop("score", None)  # Don't expose internal score to frontend
    
    return _json_response(200, {"shops": top_shops})


def handle_shop_list(event: dict) -> dict:
    """List all active shops for the public Shop Directory tab (Trade > Shop).
    Unlike handle_shops_top (fixed top-10 leaderboard), this returns every
    active shop, paginated, so buyers can browse the full directory and search
    it client-side. Suspended/blocked/deleted shops are filtered out in the
    query itself so they disappear immediately, not just via a frontend filter.
    """
    params = event.get("queryStringParameters") or {}
    try:
        limit = min(max(int(params.get("limit", 50)), 1), 100)
    except (TypeError, ValueError):
        limit = 50
    try:
        offset = max(int(params.get("offset", 0)), 0)
    except (TypeError, ValueError):
        offset = 0

    geo = _optional_user_geo(event)
    # One catalogue pass → product counts per shop (avoid N full scans).
    product_counts: dict[str, int] = {}
    for prod in _scan_by_pk_prefix("CATALOGUE#CATEGORY#"):
        if not prod.get("is_active", True):
            continue
        sid = prod.get("shop_id") or ""
        if sid:
            product_counts[sid] = product_counts.get(sid, 0) + 1

    active_records = []
    for item in _scan_by_pk_prefix("SHOP#"):
        pk = item.get("pk", "")
        if "COUNTER" in pk:
            continue
        if item.get("status") != "active" or not item.get("kyc_verified"):
            continue
        shop_id = item.get("shop_id") or pk.replace("SHOP#", "")
        if not shop_id:
            continue
        product_count = product_counts.get(shop_id, 0)
        active_records.append((item, product_count, shop_id))

    # Shop Directory is public local discovery, so apply the saved permanent
    # address radius here too. Favourite shops use their separate endpoint and
    # therefore remain visible outside this radius.
    # Ensure every row has shop_id before geo filter (some legacy rows only have pk).
    shop_rows = []
    for item, product_count, sid in active_records:
        if item.get("shop_id"):
            shop_rows.append(item)
        else:
            row = dict(item)
            row["shop_id"] = sid
            shop_rows.append(row)
    allowed_ids = {s.get("shop_id") for s in _geo_filter_shops(shop_rows, geo)}
    shops = []
    for item, product_count, sid in active_records:
        if sid not in allowed_ids:
            continue
        shops.append({
            "shop_id": sid,
            "shop_name": item.get("shop_name") or sid,
            "shop_description": item.get("shop_description", ""),
            "shop_category": item.get("shop_category", ""),
            "address_city": item.get("address_city", ""),
            "address_state": item.get("address_state", ""),
            "shop_logo_url": item.get("shop_logo_url", ""),
            "avg_rating": _json_num(item.get("avg_rating", 0)),
            "total_reviews": int(_decimal(item.get("total_reviews", 0))),
            "like_count": int(_decimal(item.get("like_count", 0))),
            "product_count": product_count,
            "created_at": item.get("created_at", ""),
        })

    # Stable order (newest shop first) so pagination offsets do not shuffle
    # results between pages as new shops are created concurrently.
    shops.sort(key=lambda s: s.get("created_at", ""), reverse=True)

    total = len(shops)
    page = shops[offset:offset + limit]
    next_offset = offset + limit if offset + limit < total else None
    return _json_response(200, {
        "shops": page,
        "total": total,
        "limit": limit,
        "offset": offset,
        "next_offset": next_offset,
    })


def handle_shop_feedback(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    shop_id = _normalize_shop_id(body.get("shop_id") or "")
    message = (body.get("message") or "").strip()
    if not shop_id or not message:
        return _json_response(400, {"error": "shop_id and message required"})
    shop = get_shop(shop_id)
    if not shop:
        return _json_response(404, {"error": "Shop not found"})
    owner_sub = shop.get("user_sub", "")
    fid = str(uuid.uuid4())
    table.put_item(Item={
        "pk": f"SHOP_FEEDBACK#{shop_id}#{fid}",
        "shop_id": shop_id, "owner_sub": owner_sub,
        "from_sub": user["sub"], "from_name": user.get("name", ""),
        "message": message[:500], "is_read": False,
        "created_at": _now(), "ttl": _ttl(365),
    })
    if owner_sub:
        create_notification(owner_sub, "admin_message", "New private feedback", message[:120])
    return _json_response(200, {"success": True})


def handle_shop_feedback_list(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    shop = get_shop_by_user(user["sub"])
    shop_id = shop.get("shop_id") or shop.get("pk", "").replace("SHOP#", "")
    if not shop_id:
        return _json_response(200, {"feedback": []})
    items = [i for i in _scan_by_pk_prefix(f"SHOP_FEEDBACK#{shop_id}#")]
    items.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return _json_response(200, {"feedback": [{
        "feedback_id": i.get("pk", "").split("#")[-1],
        "from_name": i.get("from_name", "Customer"),
        "message": i.get("message", ""),
        "created_at": i.get("created_at", ""),
        "is_read": i.get("is_read", False),
    } for i in items[:50]]})


def _resolve_deal_address(user_sub: str, body: dict) -> dict:
    """Resolve the buyer's chosen per-order delivery address for a listing deal.

    Prefers a saved address-book entry (address_id — the same book the order
    form uses), so the delivery destination is the importer's ORDER address
    rather than their personal-profile address. Falls back to any raw
    delivery_* fields a client may send directly. Coordinates come straight
    from the picked map location; pincode is kept for a geocode fallback."""
    address_id = (body.get("address_id") or "").strip()
    if address_id and user_sub:
        item = table.get_item(Key={"pk": f"ADDRESS#{user_sub}#{address_id}"}).get("Item") or {}
        if item:
            return {
                "address": item.get("address", ""),
                "city": item.get("city", ""),
                "state": item.get("state", ""),
                "pincode": str(item.get("pincode", "") or ""),
                "lat": float(_decimal(item.get("lat", 0)) or 0),
                "lng": float(_decimal(item.get("lng", 0)) or 0),
            }
    try:
        _lat = float(body.get("delivery_lat") or 0)
        _lng = float(body.get("delivery_lng") or 0)
    except (TypeError, ValueError):
        _lat = _lng = 0.0
    return {
        "address": (body.get("delivery_address") or "").strip(),
        "city": (body.get("delivery_city") or "").strip(),
        "state": (body.get("delivery_state") or "").strip(),
        "pincode": (body.get("delivery_pincode") or "").strip(),
        "lat": _lat, "lng": _lng,
    }


def handle_listing_deal_preview(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    ticket_id = (body.get("ticket_id") or body.get("reference_id") or "").strip()
    if not ticket_id:
        return _json_response(400, {"error": "Listing reference required"})
    ticket = table.get_item(Key={"pk": f"TICKET#EXPORTER#{ticket_id}"}).get("Item") or {}
    if not ticket:
        for item in _scan_by_pk_prefix("TICKET#EXPORTER#"):
            if item.get("ticket_id") == ticket_id:
                ticket = item
                break
    if not ticket:
        return _json_response(404, {"error": "Listing not found"})
    qty = _decimal(body.get("quantity_kg") or ticket.get("quantity_available_kg", 1))
    lot_price = _decimal(ticket.get("expected_price", 0)) * qty
    if _decimal(ticket.get("lot_price", 0)) > 0:
        lot_price = _decimal(ticket.get("lot_price"))
    # Distance (hence delivery charge) is measured to the chosen order address.
    _addr = _resolve_deal_address(user["sub"], body)
    breakdown = calc_payment_breakdown(
        lot_price,
        seller_pincode=ticket.get("location_pincode", ticket.get("pincode", "")),
        buyer_pincode=_addr.get("pincode") or body.get("delivery_pincode", ""),
    )
    return _json_response(200, {"breakdown": breakdown, "ticket_id": ticket_id})


def handle_listing_deal(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    if get_kyc(user["sub"]).get("status") != "approved":
        return _json_response(403, {"error": "KYC approval required"})
    shop = get_shop_by_user(user["sub"])
    shop_id = shop.get("shop_id", "")
    if not shop_id:
        return _json_response(403, {"error": "Active shop required"})
    body = _event_body(event)
    ticket_id = (body.get("ticket_id") or body.get("reference_id") or "").strip()
    payment_mode = (body.get("payment_mode") or "online").strip().lower()
    if payment_mode in ("cash", "cash_on_delivery"):
        payment_mode = "cod"
    qty = _decimal(body.get("quantity_kg"), Decimal("0"))
    if not ticket_id:
        return _json_response(400, {"error": "Listing reference required"})

    ticket = table.get_item(Key={"pk": f"TICKET#EXPORTER#{ticket_id}"}).get("Item") or {}
    if not ticket:
        for item in _scan_by_pk_prefix("TICKET#EXPORTER#"):
            tid = item.get("ticket_id", "")
            if tid == ticket_id or tid[:8].upper() == ticket_id.upper():
                ticket = item
                ticket_id = tid
                break
    if not ticket:
        return _json_response(404, {"error": "Listing not found"})

    deal_qty = qty or _decimal(ticket.get("quantity_available_kg", 1))
    lot_price = _decimal(ticket.get("expected_price", 0)) * deal_qty
    if _decimal(ticket.get("lot_price", 0)) > 0:
        lot_price = _decimal(ticket.get("lot_price"))

    # ── Delivery destination = the buyer's CHOSEN order address (address book /
    # map picker), not their personal-profile address. Resolve it up front and
    # settle the coordinates BEFORE any payment link / record is created, so a
    # delivery is never born with a missing destination (which later surfaces to
    # the delivery partner as "incomplete location data and cannot be claimed").
    deal_addr = _resolve_deal_address(user["sub"], body)
    _dest_lat = deal_addr.get("lat") or 0.0
    _dest_lng = deal_addr.get("lng") or 0.0
    _dest_pincode = deal_addr.get("pincode") or shop.get("address_pincode", "")
    if (not _dest_lat or not _dest_lng) and _dest_pincode:
        try:
            from platform_utils import geocode_pincode
            _geo = geocode_pincode(_dest_pincode)
            if _geo:
                _dest_lat, _dest_lng = float(_geo[0]), float(_geo[1])
        except Exception as _ge:
            logger.warning("[DEAL] dest geocode failed: %s", _ge)
    if not _dest_lat or not _dest_lng:
        return _json_response(400, {
            "error": "Please choose a delivery address (pick it on the map) before finalizing — "
                     "the delivery partner needs an exact drop location.",
            "code": "delivery_address_required",
        })

    breakdown = calc_payment_breakdown(
        lot_price,
        seller_pincode=ticket.get("location_pincode", ticket.get("pincode", "")),
        buyer_pincode=_dest_pincode,
    )
    arn, tracking_key = generate_arn()
    deal_id = str(uuid.uuid4())
    payment_link_url = ""
    if payment_mode == "online":
        try:
            from advanced_features import create_cashfree_payment_link
            pseudo_ticket = {
                "arn": arn,
                "ticket_id": deal_id,
                "product_name": ticket.get("product_name", ""),
                "quantity_kg": deal_qty,
                "payment_amount": breakdown["total"],
                "payment_currency": "INR",
                "customer_name": user.get("name", ""),
                "email": user.get("email", ""),
                "mobile": get_profile(user["sub"]).get("phone", ""),
            }
            link = create_cashfree_payment_link(pseudo_ticket) or {}
            payment_link_url = link.get("short_url", "")
        except Exception as e:
            logger.error("[DEAL] Cashfree link: %s", e)

    table.put_item(Item={
        "pk": f"DEAL#SHOP#{deal_id}", "deal_id": deal_id, "arn": arn,
        "tracking_key": tracking_key,
        "exporter_ticket_id": ticket_id, "shop_id": shop_id,
        "shopkeeper_sub": user["sub"], "crop": ticket.get("product_name", ""),
        "quantity_kg": _json_num(deal_qty),
        "lot_price": breakdown["lot_price"],
        "delivery_charge": breakdown["delivery_charge"],
        "platform_fee": breakdown["platform_fee"],
        "platform_fee_pct": breakdown["platform_fee_pct"],
        "subtotal": breakdown["subtotal"],
        "gst_amount": breakdown["gst_amount"],
        "gst_rate_pct": breakdown["gst_rate_pct"],
        "total_amount": breakdown["total"],
        "payment_mode": payment_mode,
        "payment_link_url": payment_link_url,
        "status": "deal_finalized",
        "created_at": _now(), "ttl": _ttl(730),
    })
    table.put_item(Item={
        "pk": f"ORDER#{arn}", "sk": "STATUS", "arn": arn,
        "ticket_id": deal_id, "product_name": ticket.get("product_name", ""),
        "current_status": "Deal Finalized — Awaiting Payment" if payment_mode == "online" else "Deal Finalized",
        "status_history": [{"status": "Deal Finalized", "timestamp": _now(), "updated_by": user["sub"]}],
        "last_updated": _now(), "importer_sub": user["sub"],
    })
    if _delivery_mod:
        # Destination = the buyer's chosen order address, already resolved and
        # coordinate-checked above (_dest_lat / _dest_lng / _dest_pincode).
        #
        # Pickup = the SELLER's location. On a produce deal the seller is the
        # EXPORTER who created this listing — an unregistered lead with no saved
        # profile coords, only the location fields captured on the ticket. So
        # pickup comes from the exporter's own location, NEVER from the buyer's
        # shop (get_shop_by_user(user) — that's the delivery/destination side).
        # Best-effort: a missing seller pincode must not block the buyer's sale,
        # so we don't hard-reject here the way a missing drop address does.
        try:
            _pickup_lat = _decimal(float(ticket.get("seller_lat") or 0))
            _pickup_lng = _decimal(float(ticket.get("seller_lng") or 0))
        except (TypeError, ValueError):
            _pickup_lat = _decimal(0)
            _pickup_lng = _decimal(0)
        if not _pickup_lat or not _pickup_lng:
            try:
                from platform_utils import geocode_pincode
                _ppin = ticket.get("location_pincode", "") or ticket.get("pincode", "")
                _pgeo = geocode_pincode(_ppin) if _ppin else None
                if _pgeo:
                    _pickup_lat, _pickup_lng = _decimal(_pgeo[0]), _decimal(_pgeo[1])
            except Exception as _ge:
                logger.warning("[DEAL] pickup geocode failed: %s", _ge)
        _delivery_mod.create_delivery_record(
            arn=arn,
            product_name=ticket.get("product_name", ""),
            importer_sub=user["sub"],
            pickup_city=ticket.get("location_city", ""),
            # Full address text for the strips. Importer = their picked order
            # address; seller (produce exporter) has only city/state as a lead,
            # so we compose the best available pickup label.
            dest_address=deal_addr.get("address", ""),
            pickup_address=ticket.get("location_address", "") or
                ", ".join([p for p in [ticket.get("location_city", ""), ticket.get("location_state", "")] if p]),
            delivery_city=deal_addr.get("city") or shop.get("address_city", ""),
            delivery_pincode=_dest_pincode,
            lot_size_kg=float(deal_qty),
            distance_km=breakdown["distance_km"],
            delivery_charge=breakdown["delivery_charge"],
            pickup_lat=float(_pickup_lat or 0),
            pickup_lng=float(_pickup_lng or 0),
            dest_lat=float(_dest_lat or 0),
            dest_lng=float(_dest_lng or 0),
            buyer_name=user.get("name", ""),
            buyer_email=user.get("email", ""),
            buyer_mobile=get_profile(user["sub"]).get("mobile") or get_profile(user["sub"]).get("phone", ""),
        )
    seller_mobile = ticket.get("whatsapp_number") or ticket.get("mobile", "")
    msg = (
        f"Deal Finalized — Aarvex Global\n\nCrop: {ticket.get('product_name', '')}\n"
        f"Lot: {deal_qty} kg · ₹{breakdown['lot_price']}\n"
        f"Delivery: ₹{breakdown['delivery_charge']}\n"
        f"Platform fee ({breakdown['platform_fee_pct']}%): ₹{breakdown['platform_fee']}\n"
        f"GST ({breakdown['gst_rate_pct']}%): ₹{breakdown['gst_amount']}\n"
        f"Total: ₹{breakdown['total']}\nPayment: {payment_mode.upper()}\nOrder ID: {arn}"
    )
    try:
        from advanced_features import send_whatsapp_text
        if seller_mobile:
            send_whatsapp_text(str(seller_mobile), msg)
    except Exception as e:
        logger.error("[DEAL] WhatsApp: %s", e)
    create_notification(user["sub"], "shop_status", "Deal finalized", f"Order {arn} — Total ₹{breakdown['total']} (incl. GST ₹{breakdown['gst_amount']})")
    return _json_response(200, {
        "success": True, "arn": arn, "breakdown": breakdown,
        "payment_link_url": payment_link_url,
        "total_amount": breakdown["total"],
        "gst_amount": breakdown["gst_amount"],
        "platform_fee": breakdown["platform_fee"],
    })


def handle_shop_subscribe(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    kyc = get_kyc(user["sub"])
    if kyc.get("status") != "approved":
        return _json_response(403, {"error": "KYC must be approved first"})
    if is_subscription_active(user["sub"]):
        return _json_response(200, {"success": True, "already_active": True, "message": "Subscription already active"})
    settings = get_platform_settings()
    amount = float(settings["shop_subscription_inr"])
    try:
        from advanced_features import create_cashfree_payment_link, create_cashfree_order
        sub_id = str(uuid.uuid4())
        sub_ticket = {
            "arn": f"SUB-{sub_id[:8]}",
            "ticket_id": sub_id,
            "user_sub": user["sub"],
            "product_name": "Agro Shop Plan — Monthly",
            "quantity_kg": 1,
            "payment_amount": amount,
            "payment_currency": "INR",
            "customer_name": user.get("name", ""),
            "email": user.get("email", ""),
            "mobile": get_profile(user["sub"]).get("phone", ""),
        }
        link = create_cashfree_payment_link(sub_ticket) or {}
        # In-app checkout: an order gives a payment_session_id the frontend JS
        # SDK uses to open the payment modal right inside the app. order_tags
        # carry ticket_id=sub_id, so the webhook activates THIS subscription.
        order_session = create_cashfree_order(sub_ticket) or {}
        table.put_item(Item={
            "pk": f"SUBSCRIPTION#USER#{user['sub']}",
            "user_sub": user["sub"],
            "subscription_id": sub_id,
            "status": "pending",
            # DynamoDB rejects Python floats — store as Decimal. (This float
            # was the root cause of the /shop/subscribe 500: put_item raised
            # before any payment link/session reached the frontend.)
            "amount_inr": _decimal(amount),
            "payment_link_id": link.get("id", ""),
            "razorpay_link_id": link.get("id", ""),  # legacy key
            "cf_order_id": order_session.get("order_id", ""),
            "created_at": _now(),
        })
        return _json_response(200, {
            "success": True,
            "payment_link_url": link.get("short_url", ""),
            "payment_session_id": order_session.get("payment_session_id", ""),
            "cf_order_id": order_session.get("order_id", ""),
            "payment_mode": order_session.get("mode", ""),
            "amount": amount,
        })
    except Exception as e:
        logger.error("[SUB] %s", e)
        return _json_response(500, {"error": "Could not create subscription payment link"})


def admin_delivery_list(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(401, {"error": "Unauthorized"})
    rows = []
    if _delivery_mod:
        for item in _delivery_mod._scan_prefix("DELIVERY#ARN#"):
            rows.append({
                "arn": item.get("arn"),
                "status": item.get("status"),
                "product_name": item.get("product_name"),
                "pickup_city": item.get("pickup_city"),
                "delivery_city": item.get("delivery_city"),
                "claimed_by": item.get("claimed_by", ""),
            })
    return _json_response(200, {"deliveries": rows[:100]})


def admin_settings_get(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(401, {"error": "Unauthorized"})
    s = get_platform_settings()
    out = {}
    for k, v in s.items():
        if isinstance(v, Decimal):
            out[k] = float(v)
        else:
            out[k] = v
    return _json_response(200, {"settings": out})


def admin_settings_update(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(401, {"error": "Unauthorized"})
    body = _event_body(event)
    allowed = (
        "delivery_rate_per_km", "min_delivery_charge", "platform_fee_pct", "gst_rate_pct",
        "shop_subscription_inr", "otp_expiry_minutes",
        "auto_moderation_enabled", "auto_moderation_mode", "moderation_alert_admin",
        "moderation_keyword_pack",
    )
    updates = {k: body[k] for k in allowed if k in body}
    if updates:
        from platform_utils import save_platform_settings
        save_platform_settings(updates)
        try:
            import content_moderation as _cm
            _bind_content_moderation()
            _cm.write_admin_audit("settings_update", json.dumps(updates, default=str)[:400])
        except Exception:
            pass
    return _json_response(200, {"success": True})


def admin_moderation_queue(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    qs = event.get("queryStringParameters") or {}
    status = qs.get("status") or "open"
    try:
        import content_moderation as _cm
        _bind_content_moderation()
        flags = _cm.list_mod_flags(status=status, limit=100)
        alerts = _cm.list_admin_alerts(status="open", limit=30)
    except Exception as e:
        return _json_response(500, {"error": str(e)})
    return _json_response(200, {"flags": flags, "alerts": alerts, "open_alerts": len(alerts)})


def admin_moderation_resolve(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    flag_pk = str(body.get("pk") or body.get("flag_pk") or "")
    action = str(body.get("action") or "ack").lower()
    note = str(body.get("note") or "")[:300]
    if not flag_pk.startswith("MODFLAG#"):
        # allow content_type + content_id
        ct = str(body.get("content_type") or "")
        cid = str(body.get("content_id") or "")
        if ct and cid:
            flag_pk = f"MODFLAG#{ct}#{cid}"
    try:
        import content_moderation as _cm
        _bind_content_moderation()
        ok = _cm.resolve_mod_flag(flag_pk, action, note)
        if action == "remove":
            # Hide/delete content when possible
            parts = flag_pk.replace("MODFLAG#", "").split("#", 1)
            if len(parts) == 2 and parts[0] == "post":
                try:
                    table.update_item(
                        Key={"pk": f"FEEDPOST#{parts[1]}"},
                        UpdateExpression="SET visibility = :h, moderation_status = :r",
                        ExpressionAttributeValues={":h": "held", ":r": "removed"},
                    )
                except Exception:
                    pass
        _cm.write_admin_audit("mod_resolve", f"{action} {flag_pk}", target=flag_pk)
    except Exception as e:
        return _json_response(500, {"error": str(e)})
    return _json_response(200, {"success": bool(ok)})


def admin_alert_ack(event: dict) -> dict:
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    pk = str(body.get("pk") or "")
    try:
        import content_moderation as _cm
        _bind_content_moderation()
        ok = _cm.ack_admin_alert(pk)
    except Exception as e:
        return _json_response(500, {"error": str(e)})
    return _json_response(200, {"success": bool(ok)})


def admin_maintenance_cleanup(event: dict) -> dict:
    """Dry-run or delete orphan S3 prefixes / old telemetry."""
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    action = str(body.get("action") or "telemetry_purge").lower()
    dry_run = bool(body.get("dry_run", True))
    days = int(body.get("days") or 30)
    report = {"action": action, "dry_run": dry_run, "deleted": 0, "samples": []}

    if action == "telemetry_purge":
        cutoff = time.time() - days * 86400
        for it in _scan_by_pk_prefix("TELEMETRY#"):
            ts = it.get("created_at") or it.get("ts") or ""
            try:
                # ISO or epoch
                if isinstance(ts, (int, float, Decimal)):
                    age_ok = float(ts) < cutoff
                else:
                    from datetime import datetime as _dt
                    s = str(ts).replace("Z", "+00:00")
                    age_ok = _dt.fromisoformat(s).timestamp() < cutoff
            except Exception:
                age_ok = True  # unknown age → eligible for cleanup when admin asks
            if not age_ok:
                continue
            pk = it.get("pk", "")
            if dry_run:
                if len(report["samples"]) < 20:
                    report["samples"].append(pk)
                report["deleted"] += 1
            else:
                try:
                    table.delete_item(Key={"pk": pk})
                    report["deleted"] += 1
                except Exception:
                    pass
    elif action == "orphan_s3_dry" or action == "orphan_s3":
        # Lightweight: list feed/ and stories/ prefixes; report keys without matching FEEDPOST/STORY
        dry_run = action == "orphan_s3_dry" or dry_run
        known = set()
        for it in _scan_by_pk_prefix("FEEDPOST#"):
            for u in (it.get("media_urls") or []) + ([it.get("media_url")] if it.get("media_url") else []):
                if u:
                    known.add(str(u))
        samples = []
        deleted = 0
        try:
            token = None
            while True:
                kwargs = {"Bucket": S3_BUCKET, "Prefix": "feed/", "MaxKeys": 100}
                if token:
                    kwargs["ContinuationToken"] = token
                resp = s3.list_objects_v2(**kwargs)
                for o in resp.get("Contents") or []:
                    key = o["Key"]
                    url = _public_s3_url(key)
                    if url not in known and key not in known:
                        samples.append(key)
                        if not dry_run:
                            try:
                                s3.delete_object(Bucket=S3_BUCKET, Key=key)
                                deleted += 1
                            except Exception:
                                pass
                        else:
                            deleted += 1
                        if dry_run and len(samples) >= 50:
                            break
                if dry_run and len(samples) >= 50:
                    break
                if not resp.get("IsTruncated"):
                    break
                token = resp.get("NextContinuationToken")
        except Exception as e:
            report["error"] = str(e)
        report["samples"] = samples[:50]
        report["deleted"] = deleted
    else:
        return _json_response(400, {"error": "Unknown action"})
    try:
        import content_moderation as _cm
        _bind_content_moderation()
        _cm.write_admin_audit("maintenance", json.dumps(report, default=str)[:400])
    except Exception:
        pass
    return _json_response(200, {"success": True, "report": report})


def _address_pk(user_sub: str) -> str:
    return f"USER#{user_sub}"


def handle_address_list(event: dict) -> dict:
    """List saved delivery addresses for the logged-in buyer (address book)."""
    user, err = _require_auth(event)
    if err:
        return err
    try:
        # Indexed prefix read (gsi1) instead of a full-table scan; the helper
        # self-detects a missing index and falls back to a raw scan, so the
        # result set is identical. Matches how ADDRESS# rows are read in the
        # account aggregation (_scan_by_pk_prefix(f"ADDRESS#{sub}#")).
        raw = _scan_by_pk_prefix(f"ADDRESS#{user['sub']}#")
    except Exception as e:
        logger.error("[ADDRESS] list failed: %s", e)
        raw = []
    addresses = sorted(
        [
            {
                "address_id": it.get("address_id", ""),
                "label": it.get("label", "Address"),
                "address": it.get("address", ""),
                "city": it.get("city", ""),
                "state": it.get("state", ""),
                "district": it.get("district", ""),
                "pincode": it.get("pincode", ""),
                "lat": _json_num(it.get("lat", 0)),
                "lng": _json_num(it.get("lng", 0)),
                "is_default": bool(it.get("is_default")),
                "created_at": it.get("created_at", ""),
            }
            for it in raw
        ],
        key=lambda a: a.get("created_at", ""),
        reverse=True,
    )
    return _json_response(200, {"success": True, "addresses": addresses})


def handle_address_save(event: dict) -> dict:
    """Save a new address (or update one, if address_id passed) — built from
    the Leaflet + Geocoder location picker on the frontend."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    address = (body.get("address") or "").strip()
    city = (body.get("city") or "").strip()
    state_name = (body.get("state") or "").strip()
    if not address or not city or not state_name:
        return _json_response(400, {"error": "address, city and state are required"})
    try:
        lat = float(body.get("lat") or 0)
        lng = float(body.get("lng") or 0)
    except (TypeError, ValueError):
        lat = lng = 0.0
    address_id = (body.get("address_id") or "").strip() or f"ADDR-{uuid.uuid4().hex[:12]}"
    pk = f"ADDRESS#{user['sub']}#{address_id}"
    existing_created = table.get_item(Key={"pk": pk}).get("Item", {}).get("created_at")
    item = {
        "pk": pk,
        "user_sub": user["sub"],
        "address_id": address_id,
        "label": (body.get("label") or "Address")[:40],
        "address": address[:300],
        "city": city[:80],
        "state": state_name[:80],
        "district": (body.get("district") or "").strip()[:80],
        "pincode": (body.get("pincode") or "").strip()[:10],
        "lat": _decimal(lat),
        "lng": _decimal(lng),
        "is_default": bool(body.get("is_default")),
        "created_at": existing_created or _now(),
        "updated_at": _now(),
    }
    table.put_item(Item=item)
    return _json_response(200, {"success": True, "address_id": address_id})


def handle_address_delete(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    address_id = (body.get("address_id") or "").strip()
    if not address_id:
        return _json_response(400, {"error": "address_id required"})
    pk = f"ADDRESS#{user['sub']}#{address_id}"
    try:
        table.delete_item(Key={"pk": pk})
    except Exception as e:
        logger.error("[ADDRESS] delete failed: %s", e)
        return _json_response(500, {"error": "Could not delete address"})
    return _json_response(200, {"success": True})


def handle_portal_route(event: dict) -> dict | None:
    """Route marketplace/portal HTTP endpoints."""
    method = event.get("requestContext", {}).get("http", {}).get("method") or event.get("httpMethod", "GET")
    path = _normalize_http_path(event.get("rawPath") or event.get("path") or "")
    logger.info(f"[PORTAL_ROUTE] {method} {path}")

    if method == "OPTIONS":
        return _json_response(200, {})

    routes = {
        ("POST", "/auth/session"): handle_auth_session,
        ("GET", "/config/maps"): handle_config_maps,
        ("POST", "/app-update"): handle_app_update,
        ("GET", "/app-update"): handle_app_update,
        ("POST", "/kyc/submit"): handle_kyc_submit,
        ("GET", "/kyc/status"): handle_kyc_status,
        ("POST", "/shop/create"): handle_shop_create,
        ("POST", "/shop/update"): handle_shop_update,
        ("POST", "/shop/delete"): handle_shop_delete,
        ("POST", "/account/delete"): handle_account_delete,
        ("GET", "/catalogue/sections"): handle_catalogue_sections,
        ("GET", "/catalogue/search"): handle_catalogue_search,
        ("POST", "/product/view"): handle_product_view,
        ("GET", "/shop/analytics"): handle_shop_analytics,
        ("GET", "/referral/code"): handle_referral_code,
        ("POST", "/referral/apply"): handle_referral_apply,
        ("GET", "/referral/list"): handle_referral_list,
        ("GET", "/favourites/products"): handle_favourites_products,
        ("GET", "/account/summary"): handle_account_summary,
        ("GET", "/order/invoice"): handle_order_invoice,
        ("POST", "/rfq/create"): handle_rfq_create,
        ("POST", "/rfq/message"): handle_rfq_message,
        ("GET", "/rfq/list"): handle_rfq_list,
        ("GET", "/rfq/get"): handle_rfq_get,
        ("POST", "/dispute/create"): handle_dispute_create,
        ("GET", "/dispute/get"): handle_dispute_get,
        ("GET", "/dispute/list"): handle_dispute_list,
        ("POST", "/alert/create"): handle_alert_create,
        ("GET", "/alert/list"): handle_alert_list,
        ("POST", "/alert/delete"): handle_alert_delete,
        ("POST", "/shop/subscribe"): handle_shop_subscribe,
        ("GET", "/shop/info"): handle_shop_info,
        ("GET", "/shop/public"): handle_shop_public,
        ("POST", "/shop/react"): handle_shop_react,
        ("POST", "/shop/like"): handle_shop_like,
        ("POST", "/shop/feedback"): handle_shop_feedback,
        ("GET", "/shop/feedback"): handle_shop_feedback_list,
        ("GET", "/shops/top"): handle_shops_top,
        ("GET", "/shop/list"): handle_shop_list,
        ("POST", "/listing/deal/preview"): handle_listing_deal_preview,
        ("POST", "/listing/deal"): handle_listing_deal,
        ("POST", "/shop/toggle"): handle_shop_toggle,
        ("GET", "/shop/products"): handle_shop_products_list,
        ("POST", "/shop/product/add"): handle_shop_product_add,
        ("POST", "/shop/product/edit"): handle_shop_product_edit,
        ("POST", "/shop/product/delete"): handle_shop_product_delete,
        ("POST", "/shop/product/pause"): handle_shop_product_pause,
        ("POST", "/review/submit"): handle_review_submit,
        ("GET", "/reviews"): handle_reviews_list,
        ("GET", "/notifications"): handle_notifications_list,
        ("POST", "/notifications/read"): handle_notifications_read,
        ("POST", "/notifications/delete"): handle_notifications_delete,
        ("GET", "/banner/active"): handle_ad_active,
        ("POST", "/banner/upload"): handle_ad_upload,
        ("POST", "/banner/remove"): handle_ad_remove,
        ("GET", "/campaign/list"): handle_campaign_list,
        ("POST", "/campaign/save"): handle_campaign_save,
        ("POST", "/campaign/delete"): handle_campaign_delete,
        ("POST", "/campaign/toggle"): handle_campaign_toggle,
        ("POST", "/campaign/approve"): handle_campaign_approve,
        ("POST", "/ad/event"): handle_ad_event,
        ("GET", "/ad/booking/quote"): handle_ad_booking_quote,
        ("POST", "/ad/booking/create"): handle_ad_booking_create,
        ("GET", "/ad/booking/mine"): handle_ad_booking_mine,
        ("GET", "/campaign/rates"): handle_ad_rates_get,
        ("POST", "/campaign/rates"): handle_ad_rates_set,
        ("GET", "/category/images"): handle_category_images_list,
        ("POST", "/category/image/upload"): handle_category_image_upload,
        ("POST", "/category/image/remove"): handle_category_image_remove,
        ("GET", "/category/list"): handle_category_list,
        ("POST", "/category/rename"): handle_category_rename,
        ("POST", "/category/delete"): handle_category_delete,
        ("POST", "/feed/post"): handle_feed_create,
        ("GET", "/feed"): handle_feed_list,
        ("POST", "/feed/edit"): handle_feed_edit,
        ("POST", "/feed/delete"): handle_feed_delete,
        ("POST", "/feed/like"): handle_feed_like,
        ("GET", "/feed/likers"): handle_feed_likers,
        ("POST", "/story/create"): handle_story_create,
        ("GET", "/story/list"): handle_story_list,
        ("POST", "/story/view"): handle_story_view,
        ("POST", "/story/like"): handle_story_like,
        ("POST", "/story/reply"): handle_story_reply,
        ("POST", "/story/delete"): handle_story_delete,
        ("POST", "/feed/follow"): handle_feed_follow,
        ("GET", "/feed/follow/stats"): handle_feed_follow_stats,
        ("GET", "/user/profile"): handle_user_profile,
        ("GET", "/user/search"): handle_user_search,
        ("POST", "/user/block"): handle_user_block,
        ("GET", "/user/blocklist"): handle_block_list,
        ("POST", "/user/report"): handle_user_report,
        ("POST", "/privacy/update"): handle_privacy_update,
        ("POST", "/chat/send"): handle_chat_send,
        ("GET", "/chat/thread"): handle_chat_thread,
        ("GET", "/chat/list"): handle_chat_list,
        ("POST", "/chat/read"): handle_chat_read,
        ("POST", "/chat/conv"): handle_chat_conv_update,
        ("POST", "/chat/message"): handle_chat_message,
        ("GET", "/chat/starred"): handle_chat_starred,
        ("POST", "/chat/forward"): handle_chat_forward,
        ("POST", "/chat/broadcast"): handle_chat_broadcast,
        ("POST", "/user/username"): handle_username_set,
        ("GET", "/user/by-username"): handle_user_by_username,
        ("POST", "/connect/request"): handle_connect_request,
        ("POST", "/chat/group/create"): handle_group_create,
        ("POST", "/call/start"): handle_call_start,
        ("GET", "/call/incoming"): handle_call_incoming,
        ("POST", "/call/signal"): handle_call_signal,
        ("GET", "/call/signals"): handle_call_signals,
        ("POST", "/call/end"): handle_call_end,
        ("POST", "/chat/e2e/register"): handle_e2e_register,
        ("GET", "/chat/e2e/key"): handle_e2e_key,
        ("GET", "/delivery/record"): handle_delivery_record,
        ("POST", "/importer/verify"): handle_importer_verify,
        ("GET", "/order/detail"): handle_order_detail,
        ("GET", "/shop/team"): handle_shop_team,
        ("POST", "/shop/team/add"): handle_shop_team_add,
        ("POST", "/shop/team/remove"): handle_shop_team_remove,
        ("POST", "/geo/set"): handle_geo_set,
        ("GET", "/geo/users"): handle_geo_users,
        ("POST", "/feed/comment"): handle_feed_comment,
        ("POST", "/feed/comment/like"): handle_feed_comment_like,
        ("GET", "/feed/comments"): handle_feed_comments,
        ("POST", "/feed/view"): handle_feed_view,
        ("POST", "/feed/share"): handle_feed_share,
        ("POST", "/profile/cover"): handle_profile_cover,
        ("GET", "/shop/favourites"): handle_shop_favourites,
        ("GET", "/favourites"): handle_favourites_get,
        ("POST", "/favourites/toggle"): handle_favourites_toggle,
        ("GET", "/track"): handle_track_order,
        ("POST", "/order/cancel"): handle_order_cancel,
        ("GET", "/profile"): handle_profile_get,
        ("POST", "/profile/update"): handle_profile_update,
        ("GET", "/admin/api/disputes"): admin_dispute_list,
        ("POST", "/admin/api/dispute/resolve"): admin_dispute_resolve,
        ("GET", "/admin/api/users"): admin_list_users,
        ("POST", "/admin/api/user/block"): admin_user_block,
        ("POST", "/admin/api/user/moderate"): admin_user_moderate,
        ("GET", "/admin/api/flagged"): admin_flagged_users,
        ("POST", "/admin/api/user/delete"): admin_user_delete,
        ("POST", "/admin/api/user/notify"): admin_user_notify,
        ("POST", "/admin/api/user/warn"): admin_user_warn,
        ("GET", "/admin/api/moderation"): admin_moderation_queue,
        ("POST", "/admin/api/moderation/resolve"): admin_moderation_resolve,
        ("POST", "/admin/api/alerts/ack"): admin_alert_ack,
        ("POST", "/admin/api/maintenance"): admin_maintenance_cleanup,
        ("GET", "/admin/api/kyc/list"): admin_kyc_list,
        ("POST", "/admin/api/kyc/review"): admin_kyc_review,
        ("GET", "/admin/api/shops"): admin_shops_list,
        ("POST", "/admin/api/shop/block"): admin_shop_block,
        ("POST", "/admin/api/shop/delete"): admin_shop_delete,
        ("GET", "/admin/api/deliveries"): admin_delivery_list,
        ("GET", "/admin/api/settings"): admin_settings_get,
        ("POST", "/admin/api/settings"): admin_settings_update,
        ("GET", "/address/list"): handle_address_list,
        ("POST", "/address/save"): handle_address_save,
        ("POST", "/address/delete"): handle_address_delete,
        ("POST", "/push/register"): register_push_token,
    }
    if _delivery_mod:
        routes.update({
            ("GET", "/delivery/orders"): _delivery_mod.handle_delivery_orders,
            ("POST", "/delivery/claim"): _delivery_mod.handle_delivery_claim,
            ("POST", "/delivery/release"): _delivery_mod.handle_delivery_release,
            ("POST", "/delivery/approve"): _delivery_mod.handle_delivery_approve,
            ("POST", "/delivery/reject-claim"): _delivery_mod.handle_delivery_reject_claim,
            ("POST", "/delivery/start"): _delivery_mod.handle_delivery_start,
            ("POST", "/delivery/location"): _delivery_mod.handle_delivery_location,
            ("POST", "/delivery/complete"): _delivery_mod.handle_delivery_complete,
            ("POST", "/delivery/picked-up"): _delivery_mod.handle_delivery_picked_up,
            ("POST", "/delivery/send-otp"): _delivery_mod.handle_delivery_send_otp,
            ("GET", "/delivery/earnings"): _delivery_mod.handle_delivery_earnings,
            ("POST", "/delivery/rate"): _delivery_mod.handle_delivery_rate,
            ("GET", "/delivery/rating"): _delivery_mod.handle_delivery_rating,
            ("GET", "/delivery/active"): _delivery_mod.handle_delivery_active,
            ("GET", "/delivery/my-claims"): _delivery_mod.handle_delivery_my_claims,
            ("POST", "/delivery/cancel"): _delivery_mod.handle_delivery_cancel,
            ("POST", "/delivery/reject"): _delivery_mod.handle_delivery_reject,
            ("POST", "/delivery/review/submit"): _delivery_mod.handle_delivery_review_submit,
        })

    # Portal telemetry (client → cloud)
    try:
        import ax_telemetry as _ax_tel
        _ax_tel._bind({
            "table": table,
            "json_response": _json_response,
            "event_body": _event_body,
            "admin_authorized": _admin_authorized,
            "rate_limited": _rate_limited,
            "scan_by_pk_prefix": _scan_by_pk_prefix,
        })
        routes[("POST", "/telemetry/report")] = _ax_tel.handle_telemetry_report
        routes[("GET", "/admin/api/telemetry")] = _ax_tel.handle_admin_telemetry_list
        routes[("POST", "/admin/api/telemetry/ack")] = _ax_tel.handle_admin_telemetry_ack
        routes[("POST", "/admin/api/telemetry/purge")] = _ax_tel.handle_admin_telemetry_purge
        routes[("GET", "/admin/api/setup-map")] = _ax_tel.handle_admin_setup_map
        routes[("GET", "/admin/api/app-pulse")] = _ax_tel.handle_admin_app_pulse
    except Exception as _e:
        logger.warning("[TELEMETRY] bind failed: %s", _e)

    try:
        import design_auditor as _da
        _da._bind({
            "table": table,
            "json_response": _json_response,
            "event_body": _event_body,
            "admin_authorized": _admin_authorized,
            "now": _now,
            "scan_by_pk_prefix": _scan_by_pk_prefix,
            "s3": s3,
            "s3_bucket": S3_BUCKET,
            "cloudfront_base": CLOUDFRONT_BASE,
        })
        routes[("POST", "/admin/api/design-audit/run")] = _da.handle_design_audit_run
        routes[("GET", "/admin/api/design-audit/status")] = _da.handle_design_audit_status
        routes[("GET", "/admin/api/design-audit/report")] = _da.handle_design_audit_report
        routes[("POST", "/admin/api/design-audit/finding")] = _da.handle_design_audit_finding_update
        routes[("POST", "/admin/api/design-audit/apply-safe")] = _da.handle_design_audit_apply_safe
        routes[("GET", "/admin/api/design-audit/scorecard")] = _da.handle_design_audit_scorecard
        routes[("POST", "/admin/api/design-audit/fix-finding")] = _da.handle_design_audit_fix_finding
        routes[("GET", "/admin/api/design-audit/tokens")] = _da.handle_design_audit_tokens
    except Exception as _e:
        logger.warning("[DESIGN_AUDIT] bind failed: %s", _e)

    routes[("POST", "/admin/api/command-center/apply-patch")] = admin_cc_apply_patch
    routes[("GET", "/admin/api/command-center/patch-history")] = admin_cc_patch_history
    routes[("POST", "/admin/api/command-center/patch-rollback")] = admin_cc_patch_rollback
    routes[("POST", "/admin/api/command-center/explain")] = admin_cc_explain_error

    handler = routes.get((method, path))
    if handler:
        try:
            result = handler(event)
        except Exception:
            logger.error(
                "[PORTAL_ROUTE][UNHANDLED] %s %s crashed:\n%s",
                method, path, traceback.format_exc(),
            )
            return _json_response(500, {"error": "Something went wrong on our end. Please try again in a moment."})
        status = result.get("statusCode", "?") if isinstance(result, dict) else "?"
        logger.info(f"[PORTAL_ROUTE] {method} {path} → {status}")
        return result
    logger.warning(f"[PORTAL_ROUTE] No handler for {method} {path}")
    if path.startswith("/admin/api/"):
        return None
    return None


if _delivery_mod:
    import sys as _sys
    _delivery_mod._bind_delivery_helpers(_sys.modules[__name__])
    _delivery_mod._bind_contact_helper(get_delivery_partner_contact)
    _delivery_mod._bind_partner_pool_helpers(list_approved_delivery_partners, suspend_delivery_partner)
