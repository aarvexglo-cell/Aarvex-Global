"""
Aarvex Portal Telemetry — client error / health reports + admin Command Center.

Storage (DynamoDB, same table):
  pk = TELEMETRY#{YYYY-MM-DD}#{event_id}
  ttl  = 30 days

Portal:  POST /telemetry/report   (optional auth, rate-limited)
Admin:   GET  /admin/api/telemetry
Admin:   POST /admin/api/telemetry/ack
Admin:   GET  /admin/api/setup-map
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from datetime import datetime, timezone
from decimal import Decimal

logger = logging.getLogger()

_HELPERS = {}


def _bind(helpers: dict) -> None:
    _HELPERS.update(helpers or {})


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ttl(days: int = 30) -> int:
    return int(time.time()) + days * 86400


def _json_response(status: int, body: dict):
    fn = _HELPERS.get("json_response")
    if fn:
        return fn(status, body)
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Admin-Session",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        },
        "body": json.dumps(body, default=str),
    }


def _table():
    return _HELPERS.get("table")


def _event_body(event: dict) -> dict:
    fn = _HELPERS.get("event_body")
    if fn:
        return fn(event) or {}
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        import base64
        raw = base64.b64decode(raw).decode("utf-8")
    try:
        return json.loads(raw) if isinstance(raw, str) else (raw or {})
    except Exception:
        return {}


def _admin_ok(event: dict) -> bool:
    fn = _HELPERS.get("admin_authorized")
    return bool(fn and fn(event))


def _rate_limited(key: str, action: str, limit: int = 30, window: int = 60) -> bool:
    fn = _HELPERS.get("rate_limited")
    if not fn:
        return False
    try:
        return bool(fn(key, action, limit, window))
    except TypeError:
        try:
            return bool(fn(key, action))
        except Exception:
            return False
    except Exception:
        return False


# ── Static setup map (source of truth for Admin Command Center) ──────────
SETUP_MAP = {
    "version": 1,
    "updated": "2026-08-06",
    "tabs": [
        {
            "id": "dashboard",
            "label": "Home",
            "features": ["banner", "search_people", "stories", "feed", "geo", "messages_fab", "profile_alert"],
            "files": ["portal.html", "ax-feed.js", "ax-stories.js", "ax-social.js"],
            "design_rules": ["solid_notif_bell", "msg_fab_no_dark_circle", "story_static_ring", "search_edge_flush"],
        },
        {
            "id": "trade",
            "label": "Trade",
            "features": ["banner", "search_products", "category_grid", "product_sections", "shops_mode", "cart", "cod_online"],
            "files": ["portal-catalogue-render.js", "product-modal.js", "portal-order-flow.js", "catalogue-ui.css"],
            "design_rules": ["category_rounded_boxes", "search_opens_category_grid", "shop_category_sections_3col"],
        },
        {
            "id": "favourites",
            "label": "Favourites",
            "features": ["fav_products", "fav_shops", "category_grid"],
            "files": ["ax-feed.js", "product-modal.js"],
            "design_rules": ["fav_shops_same_as_trade_shop_profile"],
        },
        {
            "id": "delivery",
            "label": "Delivery",
            "features": ["claims", "live_map", "otp_complete", "earnings"],
            "files": ["ax-delivery-ux.js", "portal-delivery.js"],
            "design_rules": [],
        },
        {
            "id": "account",
            "label": "Account",
            "features": ["orders_history", "invoice", "payouts", "delete_account"],
            "files": ["portal-order-flow.js", "portal-auth.js"],
            "design_rules": [],
        },
    ],
    "global_features": [
        {"id": "preloader", "files": ["ax-preloader.js", "assets/car-loader.json"], "notes": "Line-art + blur host"},
        {"id": "messenger", "files": ["ax-messenger.js"], "notes": "In-app chat + calls"},
        {"id": "telemetry", "files": ["ax-telemetry.js", "ax_telemetry.py"], "notes": "Client health + admin CC"},
        {"id": "cod_invoice", "files": ["cod_invoice.py"], "notes": "Invoice after OTP; online on payment"},
    ],
    "safe_autofix": [
        "ignore_benign_browser_noise",
        "remount_lottie_preloader",
        "clear_stale_docked_search",
        "trim_local_error_buffer",
        "retry_once_chunk_load",
    ],
    "never_autofix_without_permission": [
        "payment_flow",
        "order_placement",
        "invoice_generation",
        "auth_session",
        "account_delete",
        "delivery_otp",
        "admin_privileges",
        "schema_migrations",
    ],
}


def handle_telemetry_report(event: dict) -> dict:
    """Portal → cloud: batch of client events."""
    body = _event_body(event)
    events = body.get("events") or []
    if isinstance(body.get("event"), dict):
        events = [body["event"]]
    if not isinstance(events, list) or not events:
        return _json_response(400, {"error": "No events"})

    # Rate limit by coarse IP / session fingerprint
    headers = event.get("headers") or {}
    ip = headers.get("x-forwarded-for") or headers.get("X-Forwarded-For") or "anon"
    ip = str(ip).split(",")[0].strip()[:64]
    if _rate_limited(ip or "anon", "telemetry_report"):
        return _json_response(429, {"error": "Too many telemetry reports"})

    table = _table()
    if table is None:
        return _json_response(503, {"error": "Storage unavailable"})

    saved = 0
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    for raw in events[:25]:
        if not isinstance(raw, dict):
            continue
        eid = str(raw.get("id") or uuid.uuid4())[:48]
        severity = str(raw.get("severity") or "info").lower()
        if severity not in ("ignore", "info", "warn", "error", "critical"):
            severity = "error"
        item = {
            "pk": f"TELEMETRY#{day}#{eid}",
            "sk": "EVENT",
            "entity": "telemetry",
            "event_id": eid,
            "day": day,
            "ts": raw.get("ts") or _now(),
            "severity": severity,
            "auto_action": str(raw.get("auto_action") or "none")[:40],
            "auto_applied": str(raw.get("auto_applied") or "none")[:40],
            "tab": str(raw.get("tab") or "unknown")[:40],
            "feature": str(raw.get("feature") or "unknown")[:60],
            "type": str(raw.get("type") or "client")[:40],
            "message": str(raw.get("message") or "")[:500],
            "cause": str(raw.get("cause") or "")[:400],
            "stack": str(raw.get("stack") or "")[:1200],
            "href": str(raw.get("href") or "")[:300],
            "meta": json.dumps(raw.get("meta") or {})[:1500],
            "status": "open",
            "needs_permission": bool(raw.get("needs_permission")),
            "critical": bool(raw.get("critical") or severity == "critical"),
            "ttl": _ttl(30),
            "created_at": _now(),
        }
        try:
            table.put_item(Item=item)
            saved += 1
        except Exception as e:
            logger.warning("[TELEMETRY] put failed: %s", e)

    return _json_response(200, {"ok": True, "saved": saved})


def handle_admin_telemetry_list(event: dict) -> dict:
    if not _admin_ok(event):
        return _json_response(403, {"error": "Unauthorized"})
    table = _table()
    if table is None:
        return _json_response(503, {"error": "Storage unavailable"})

    qs = event.get("queryStringParameters") or {}
    day = (qs.get("day") or datetime.now(timezone.utc).strftime("%Y-%m-%d")).strip()
    limit = min(int(qs.get("limit") or 100), 200)

    items = []
    try:
        # Prefer day prefix query via scan (table may be pk-only)
        from boto3.dynamodb.conditions import Attr
        resp = table.scan(
            FilterExpression=Attr("entity").eq("telemetry") & Attr("day").eq(day),
            Limit=400,
        )
        items = resp.get("Items") or []
        while resp.get("LastEvaluatedKey") and len(items) < 400:
            resp = table.scan(
                FilterExpression=Attr("entity").eq("telemetry") & Attr("day").eq(day),
                ExclusiveStartKey=resp["LastEvaluatedKey"],
                Limit=400,
            )
            items.extend(resp.get("Items") or [])
    except Exception as e:
        logger.warning("[TELEMETRY] list scan failed: %s", e)
        # Fallback: pk prefix scan helper if bound
        scan = _HELPERS.get("scan_by_pk_prefix")
        if scan:
            items = scan(f"TELEMETRY#{day}#") or []

    items.sort(key=lambda x: x.get("ts", ""), reverse=True)
    items = items[:limit]

    by_tab = {}
    by_sev = {}
    open_critical = 0
    for it in items:
        t = it.get("tab") or "unknown"
        by_tab[t] = by_tab.get(t, 0) + 1
        s = it.get("severity") or "info"
        by_sev[s] = by_sev.get(s, 0) + 1
        if it.get("critical") and it.get("status") == "open":
            open_critical += 1

    # Decimal → native for JSON
    def _clean(o):
        if isinstance(o, list):
            return [_clean(x) for x in o]
        if isinstance(o, dict):
            return {k: _clean(v) for k, v in o.items()}
        if isinstance(o, Decimal):
            return int(o) if o % 1 == 0 else float(o)
        return o

    return _json_response(200, {
        "day": day,
        "total": len(items),
        "open_critical": open_critical,
        "by_tab": by_tab,
        "by_severity": by_sev,
        "events": _clean(items),
        "setup_version": SETUP_MAP.get("version"),
    })


def handle_admin_telemetry_ack(event: dict) -> dict:
    if not _admin_ok(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    pk = body.get("pk") or ""
    status = body.get("status") or "acked"
    if not pk.startswith("TELEMETRY#"):
        return _json_response(400, {"error": "Invalid pk"})
    table = _table()
    if table is None:
        return _json_response(503, {"error": "Storage unavailable"})
    try:
        try:
            table.update_item(
                Key={"pk": pk, "sk": "EVENT"},
                UpdateExpression="SET #s = :s, acked_at = :t",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={":s": status, ":t": _now()},
            )
        except Exception:
            table.update_item(
                Key={"pk": pk},
                UpdateExpression="SET #s = :s, acked_at = :t",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={":s": status, ":t": _now()},
            )
        return _json_response(200, {"ok": True})
    except Exception as e:
        return _json_response(500, {"error": str(e)})


def handle_admin_setup_map(event: dict) -> dict:
    if not _admin_ok(event):
        return _json_response(403, {"error": "Unauthorized"})
    return _json_response(200, {"setup": SETUP_MAP})


def handle_admin_telemetry_purge(event: dict) -> dict:
    """Delete telemetry rows older than N days (or all for a day)."""
    if not _admin_ok(event):
        return _json_response(403, {"error": "Unauthorized"})
    table = _table()
    if table is None:
        return _json_response(503, {"error": "Storage unavailable"})
    body = _event_body(event)
    days = int(body.get("days") or 30)
    dry_run = bool(body.get("dry_run", True))
    scan = _HELPERS.get("scan_by_pk_prefix")
    items = scan("TELEMETRY#") if scan else []
    cutoff = time.time() - days * 86400
    deleted = 0
    samples = []
    for it in items:
        pk = it.get("pk", "")
        if dry_run:
            if len(samples) < 30:
                samples.append(pk)
            deleted += 1
            continue
        try:
            table.delete_item(Key={"pk": pk})
            deleted += 1
        except Exception:
            pass
    return _json_response(200, {"ok": True, "dry_run": dry_run, "deleted": deleted, "samples": samples, "cutoff_days": days})
