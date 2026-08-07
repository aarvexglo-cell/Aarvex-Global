"""
Aarvex admin session + TOTP lockout helpers.
Used by marketplace.py and advanced_features.py.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets
import time
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger()

ADMIN_TOTP_SECRET = os.environ.get("ADMIN_TOTP_SECRET", "")
_SESSION_TTL_SEC = 8 * 3600
_LOCKOUT_FAILS = 5
_LOCKOUT_SEC = 15 * 60


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _table():
    import boto3
    name = os.environ.get("DYNAMODB_TABLE_NAME") or os.environ.get("DYNAMODB_TABLE", "aarvex-social-bot-state")
    return boto3.resource("dynamodb").Table(name)


def legacy_hour_token() -> str:
    seed = f"{ADMIN_TOTP_SECRET}:{datetime.utcnow().strftime('%Y%m%d%H')}"
    return hmac.new(seed.encode(), b"aarvex-admin", hashlib.sha256).hexdigest()


def is_locked_out() -> tuple[bool, int]:
    """Returns (locked, seconds_remaining)."""
    try:
        it = _table().get_item(Key={"pk": "ADMINLOCK#totp"}).get("Item") or {}
        until = int(it.get("locked_until") or 0)
        now = int(time.time())
        if until > now:
            return True, until - now
        return False, 0
    except Exception as e:
        logger.warning("[ADMINSESS] lockout check failed: %s", e)
        return False, 0


def record_totp_failure() -> dict:
    t = _table()
    now = int(time.time())
    try:
        it = t.get_item(Key={"pk": "ADMINLOCK#totp"}).get("Item") or {}
        fails = int(it.get("fails") or 0) + 1
        locked_until = 0
        if fails >= _LOCKOUT_FAILS:
            locked_until = now + _LOCKOUT_SEC
            fails = 0
        t.put_item(Item={
            "pk": "ADMINLOCK#totp",
            "fails": fails,
            "locked_until": locked_until,
            "updated_at": _now_iso(),
            "ttl": now + 86400,
        })
        return {"fails": fails, "locked_until": locked_until}
    except Exception as e:
        logger.warning("[ADMINSESS] record fail: %s", e)
        return {"fails": 0, "locked_until": 0}


def clear_totp_failures() -> None:
    try:
        _table().delete_item(Key={"pk": "ADMINLOCK#totp"})
    except Exception:
        pass


def create_admin_session() -> str:
    """Create ADMINSESS# row; return opaque session token."""
    token = secrets.token_hex(32)
    now = int(time.time())
    _table().put_item(Item={
        "pk": f"ADMINSESS#{token}",
        "session_id": token,
        "created_at": _now_iso(),
        "expires_at": now + _SESSION_TTL_SEC,
        "ttl": now + _SESSION_TTL_SEC,
    })
    clear_totp_failures()
    return token


def revoke_admin_session(token: str) -> bool:
    if not token:
        return False
    try:
        _table().delete_item(Key={"pk": f"ADMINSESS#{token}"})
        return True
    except Exception:
        return False


def session_valid(token: str) -> bool:
    if not token or not ADMIN_TOTP_SECRET:
        return False
    # Preferred: server-side session row
    try:
        it = _table().get_item(Key={"pk": f"ADMINSESS#{token}"}).get("Item")
        if it:
            exp = int(it.get("expires_at") or 0)
            if exp >= int(time.time()):
                return True
            revoke_admin_session(token)
            return False
    except Exception as e:
        logger.warning("[ADMINSESS] lookup failed: %s", e)
    # Legacy hour HMAC (transition) — still accept for same hour
    try:
        return bool(hmac.compare_digest(token, legacy_hour_token()))
    except Exception:
        return False


def extract_admin_token(event: dict) -> str:
    headers = event.get("headers") or {}
    return (
        headers.get("X-Admin-Session")
        or headers.get("x-admin-session")
        or (headers.get("Authorization") or headers.get("authorization") or "").replace("Bearer ", "").replace("bearer ", "")
    ).strip()
