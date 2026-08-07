"""
Aarvex content policy — keyword hard-block, strikes, admin alerts, mod flags,
optional Rekognition soft-flag for media.

Bound from marketplace.py via _bind().
"""

from __future__ import annotations

import logging
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger()

_H: dict[str, Any] = {}

# Curated denylist (HI+EN). Keep short + high-precision; soft scams go to review.
_HARD_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("sexual", re.compile(
        r"\b(porn|pornhub|xxx|onlyfans|nude|nudes|sex\s*chat|escort|prostitut|"
        r"child\s*porn|csam|loli|underage\s*sex|rape\s*porn)\b|"
        r"(सेक्स\s*वीडियो|अश्लील|पोर्न)",
        re.I,
    )),
    ("violence", re.compile(
        r"\b(hire\s*a?\s*killer|hitman|assassinate|behead|make\s*a?\s*bomb|"
        r"how\s*to\s*make\s*bomb|terror\s*attack)\b|"
        r"(बम\s*बना|हिटमैन)",
        re.I,
    )),
    ("drugs", re.compile(
        r"\b(buy\s*cocaine|sell\s*heroin|mdma\s*for\s*sale|fentanyl\s*ship|"
        r"weed\s*delivery\s*india\s*cod)\b",
        re.I,
    )),
    ("scam", re.compile(
        r"\b(send\s*otp\s*to\s*me|share\s*your\s*otp|lottery\s*winner\s*pay\s*fee|"
        r"crypto\s*giveaway\s*seed\s*phrase|double\s*your\s*money\s*guaranteed)\b|"
        r"(ओटीपी\s*भेजो|ओटीपी\s*शेयर)",
        re.I,
    )),
]

_SOFT_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("soft_sexual", re.compile(r"\b(sexy\s*pics?|hot\s*girls?\s*chat|dating\s*tonight)\b", re.I)),
    ("soft_scam", re.compile(r"\b(guaranteed\s*profit|risk\s*free\s*investment)\b", re.I)),
]

STRIKE_RESTRICT_AT = 3
STRIKE_BLOCK_AT = 5


def _bind(helpers: dict) -> None:
    _H.update(helpers or {})


def _table():
    return _H.get("table")


def _now() -> str:
    fn = _H.get("now")
    if fn:
        return fn()
    return datetime.now(timezone.utc).isoformat()


def _ttl(days: int) -> int:
    return int(time.time()) + days * 86400


def _notify(user_sub: str, ntype: str, title: str, body: str, **extra) -> None:
    fn = _H.get("create_notification")
    if fn:
        try:
            fn(user_sub, ntype, title, body, **extra)
        except Exception as e:
            logger.warning("[MOD] notify failed: %s", e)


def _upsert_profile(user_sub: str, data: dict) -> None:
    fn = _H.get("upsert_profile")
    if fn:
        fn(user_sub, data)


def _get_profile(user_sub: str) -> dict:
    fn = _H.get("get_profile")
    return fn(user_sub) if fn else {}


def _settings() -> dict:
    fn = _H.get("get_platform_settings")
    try:
        return fn() if fn else {}
    except Exception:
        return {}


def auto_moderation_enabled() -> bool:
    s = _settings()
    v = s.get("auto_moderation_enabled", False)
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "yes", "on")
    return bool(v)


def auto_moderation_mode() -> str:
    s = _settings()
    m = str(s.get("auto_moderation_mode") or "block").lower()
    return m if m in ("block", "flag") else "block"


def moderation_alert_admin() -> bool:
    s = _settings()
    v = s.get("moderation_alert_admin", True)
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "yes", "on")
    return bool(v)


def normalize_text(text: str) -> str:
    t = (text or "").lower()
    t = t.replace("0", "o").replace("1", "i").replace("3", "e").replace("@", "a").replace("$", "s")
    t = re.sub(r"[^\w\s\u0900-\u097f]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def content_policy_check(text: str) -> dict:
    """Return {ok, severity, category, reason}."""
    raw = (text or "").strip()
    if not raw:
        return {"ok": True, "severity": "none", "category": "", "reason": ""}
    norm = normalize_text(raw)
    for cat, pat in _HARD_PATTERNS:
        if pat.search(raw) or pat.search(norm):
            return {
                "ok": False,
                "severity": "hard",
                "category": cat,
                "reason": f"Blocked by community guidelines ({cat})",
            }
    # Admin-editable keyword pack from platform settings
    try:
        pack = str(_settings().get("moderation_keyword_pack") or "")
        extras = [p.strip() for p in re.split(r"[\n,]+", pack) if p.strip() and len(p.strip()) >= 3]
        for kw in extras[:80]:
            if kw.lower() in norm or kw.lower() in raw.lower():
                return {
                    "ok": False,
                    "severity": "hard",
                    "category": "custom",
                    "reason": f"Blocked by admin keyword list ({kw[:40]})",
                }
    except Exception:
        pass
    for cat, pat in _SOFT_PATTERNS:
        if pat.search(raw) or pat.search(norm):
            return {
                "ok": False,
                "severity": "soft",
                "category": cat,
                "reason": f"Flagged for review ({cat})",
            }
    return {"ok": True, "severity": "none", "category": "", "reason": ""}


def create_admin_alert(kind: str, title: str, detail: str, **extra) -> str:
    table = _table()
    if table is None:
        return ""
    aid = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"
    item = {
        "pk": f"ADMINALERT#{aid}",
        "alert_id": aid,
        "kind": kind[:40],
        "title": title[:160],
        "detail": detail[:800],
        "status": "open",
        "created_at": _now(),
        "ttl": _ttl(90),
        **{k: str(v)[:200] for k, v in extra.items() if v is not None},
    }
    try:
        table.put_item(Item=item)
    except Exception as e:
        logger.warning("[MOD] admin alert failed: %s", e)
        return ""
    return aid


def create_mod_flag(
    content_type: str,
    content_id: str,
    user_sub: str,
    reason: str,
    severity: str = "soft",
    snippet: str = "",
    media_url: str = "",
) -> str:
    table = _table()
    if table is None:
        return ""
    fid = f"{content_type}#{content_id}"
    item = {
        "pk": f"MODFLAG#{fid}",
        "content_type": content_type,
        "content_id": content_id,
        "user_sub": user_sub,
        "reason": reason[:500],
        "severity": severity,
        "snippet": (snippet or "")[:400],
        "media_url": (media_url or "")[:500],
        "status": "open",
        "created_at": _now(),
        "ttl": _ttl(180),
    }
    try:
        table.put_item(Item=item)
    except Exception as e:
        logger.warning("[MOD] modflag failed: %s", e)
        return ""
    if moderation_alert_admin():
        create_admin_alert(
            "moderation",
            f"{severity.upper()} {content_type}",
            reason,
            user_sub=user_sub,
            content_type=content_type,
            content_id=content_id,
        )
    return fid


def get_strikes(user_sub: str) -> dict:
    table = _table()
    if not table or not user_sub:
        return {"count": 0, "reasons": []}
    it = table.get_item(Key={"pk": f"USERSTRIKE#{user_sub}"}).get("Item") or {}
    reasons = it.get("reasons") or []
    if not isinstance(reasons, list):
        reasons = []
    return {"count": int(it.get("count") or 0), "reasons": reasons[-10:], "updated_at": it.get("updated_at", "")}


def add_strike(user_sub: str, reason: str, *, notify: bool = True) -> dict:
    """Increment strike; auto-restrict at 3, auto-block at 5."""
    table = _table()
    if not table or not user_sub:
        return {"count": 0}
    pk = f"USERSTRIKE#{user_sub}"
    existing = table.get_item(Key={"pk": pk}).get("Item") or {}
    count = int(existing.get("count") or 0) + 1
    reasons = list(existing.get("reasons") or [])
    reasons.append({"at": _now(), "reason": reason[:300]})
    reasons = reasons[-20:]
    item = {
        "pk": pk,
        "user_sub": user_sub,
        "count": count,
        "reasons": reasons,
        "updated_at": _now(),
        "ttl": _ttl(730),
    }
    table.put_item(Item=item)

    status = None
    if count >= STRIKE_BLOCK_AT:
        status = "blocked"
    elif count >= STRIKE_RESTRICT_AT:
        status = "restricted"

    if status:
        _upsert_profile(user_sub, {
            "account_status": status,
            "moderation_reason": reason[:500],
            "moderated_at": _now(),
        })
        if moderation_alert_admin():
            create_admin_alert(
                "strike_escalate",
                f"User auto-{status} ({count} strikes)",
                reason,
                user_sub=user_sub,
            )
        if notify:
            _notify(
                user_sub, "admin_message", "Account Status",
                f"Your account is now {status} after repeated guideline violations.",
            )
    elif notify:
        _notify(
            user_sub, "admin_message", "Community Guidelines Warning",
            f"Warning recorded ({count}/{STRIKE_RESTRICT_AT} before restrict). {reason[:200]}",
        )
    return {"count": count, "account_status": status or _get_profile(user_sub).get("account_status", "active")}


def admin_warn_user(user_sub: str, message: str) -> dict:
    reason = (message or "Warning from Aarvex admin").strip()[:500]
    result = add_strike(user_sub, reason, notify=True)
    if moderation_alert_admin():
        create_admin_alert("admin_warn", "Admin warned user", reason, user_sub=user_sub)
    return result


def enforce_text_policy(user_sub: str, text: str, content_type: str, content_id: str = "") -> dict | None:
    """
    If auto-moderation OFF → None (allow).
    Hard + mode=block → reject dict (strike + flag).
    Soft or mode=flag → return hold/flagged meta (caller creates MODFLAG with real id).
    """
    if not auto_moderation_enabled():
        return None
    check = content_policy_check(text)
    if check["ok"]:
        return None
    mode = auto_moderation_mode()
    sev = check["severity"]
    if sev == "hard" and mode == "block":
        add_strike(user_sub, check["reason"], notify=True)
        create_mod_flag(content_type, content_id or "rejected", user_sub, check["reason"], "hard", text)
        return {
            "reject": True,
            "error": "Post blocked: community guidelines. A warning has been recorded.",
            "category": check["category"],
        }
    if sev == "hard" and mode == "flag":
        return {"reject": False, "hold": True, "reason": check["reason"], "severity": "hard", "category": check["category"]}
    if sev == "soft":
        return {"reject": False, "hold": False, "flagged": True, "reason": check["reason"], "severity": "soft", "category": check["category"]}
    return None


def rekognition_moderate_s3(bucket: str, key: str) -> dict:
    """Optional AWS Rekognition. Returns {flagged, labels, error}."""
    if not bucket or not key:
        return {"flagged": False, "labels": [], "error": "no_key"}
    try:
        import boto3
        client = boto3.client("rekognition")
        resp = client.detect_moderation_labels(
            Image={"S3Object": {"Bucket": bucket, "Name": key}},
            MinConfidence=55.0,
        )
        labels = resp.get("ModerationLabels") or []
        bad = []
        for lb in labels:
            name = (lb.get("Name") or "").lower()
            parent = (lb.get("ParentName") or "").lower()
            if any(x in name or x in parent for x in (
                "explicit", "nudity", "sexual", "graphic", "violence", "visually disturbing",
                "drugs", "hate",
            )):
                bad.append({"name": lb.get("Name"), "confidence": lb.get("Confidence")})
        return {"flagged": bool(bad), "labels": bad, "error": ""}
    except Exception as e:
        logger.warning("[MOD] rekognition skipped: %s", e)
        return {"flagged": False, "labels": [], "error": str(e)[:200]}


def flag_media_if_needed(user_sub: str, content_type: str, content_id: str, s3_key: str, media_url: str = "") -> bool:
    """When auto-mod ON and media uploaded — Rekognition soft-flag. Returns True if flagged."""
    if not auto_moderation_enabled() or not s3_key:
        return False
    bucket = _H.get("s3_bucket") or ""
    result = rekognition_moderate_s3(bucket, s3_key)
    if result.get("flagged"):
        labels = ", ".join(x.get("name", "") for x in result.get("labels") or [])[:200]
        create_mod_flag(
            content_type, content_id, user_sub,
            f"Media flagged by auto-detect: {labels}",
            "soft", "", media_url,
        )
        return True
    # If Rekognition unavailable, still queue media-heavy posts for review when mode=flag
    if result.get("error") and auto_moderation_mode() == "flag":
        create_mod_flag(
            content_type, content_id, user_sub,
            "Media pending review (auto-detect queue)",
            "soft", "", media_url,
        )
        return True
    return False


def list_mod_flags(status: str = "open", limit: int = 100) -> list[dict]:
    scan = _H.get("scan_by_pk_prefix")
    if not scan:
        return []
    items = scan("MODFLAG#") or []
    if status != "all":
        items = [i for i in items if i.get("status", "open") == status]
    items.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return items[:limit]


def list_admin_alerts(status: str = "open", limit: int = 50) -> list[dict]:
    scan = _H.get("scan_by_pk_prefix")
    if not scan:
        return []
    items = scan("ADMINALERT#") or []
    if status != "all":
        items = [i for i in items if i.get("status", "open") == status]
    items.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return items[:limit]


def resolve_mod_flag(flag_pk: str, action: str, admin_note: str = "") -> bool:
    table = _table()
    if not table or not flag_pk.startswith("MODFLAG#"):
        return False
    status = {"allow": "allowed", "remove": "removed", "ack": "acked"}.get(action, action)
    try:
        table.update_item(
            Key={"pk": flag_pk},
            UpdateExpression="SET #s = :s, resolved_at = :t, admin_note = :n",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": status, ":t": _now(), ":n": (admin_note or "")[:300]},
        )
        return True
    except Exception as e:
        logger.warning("[MOD] resolve failed: %s", e)
        return False


def ack_admin_alert(alert_pk: str) -> bool:
    table = _table()
    if not table or not alert_pk.startswith("ADMINALERT#"):
        return False
    try:
        table.update_item(
            Key={"pk": alert_pk},
            UpdateExpression="SET #s = :s, acked_at = :t",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": "acked", ":t": _now()},
        )
        return True
    except Exception:
        return False


def write_admin_audit(action: str, detail: str, target: str = "") -> None:
    table = _table()
    if not table:
        return
    aid = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"
    try:
        table.put_item(Item={
            "pk": f"ADMINAUDIT#{aid}",
            "action": action[:80],
            "detail": detail[:500],
            "target": target[:120],
            "created_at": _now(),
            "ttl": _ttl(365),
        })
    except Exception as e:
        logger.warning("[MOD] audit failed: %s", e)
