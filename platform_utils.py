"""
Shared platform utilities — ARN, payment breakdown, OTP, settings.
Used by marketplace.py, delivery.py, and advanced_features.py.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import random
import re
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

import boto3
from botocore.exceptions import ClientError
from datetime import timedelta

logger = logging.getLogger()

IST_OFFSET = timedelta(hours=5, minutes=30)


def to_ist_str(dt: "datetime | str | None" = None, fmt: str = "%d %b %Y, %I:%M %p") -> str:
    """Convert a UTC datetime / ISO string / None(=now) to an IST display
    string. Every WhatsApp-facing message should use this instead of the
    raw UTC ISO string, so buyers/delivery-partners see correct local time."""
    try:
        if dt is None:
            d = datetime.now(timezone.utc)
        elif isinstance(dt, str):
            s = dt.strip()
            if s.endswith("Z"):
                s = s[:-1] + "+00:00"
            d = datetime.fromisoformat(s)
            if d.tzinfo is None:
                d = d.replace(tzinfo=timezone.utc)
        else:
            d = dt
            if d.tzinfo is None:
                d = d.replace(tzinfo=timezone.utc)
        ist = d.astimezone(timezone.utc) + IST_OFFSET
        return ist.strftime(fmt) + " IST"
    except Exception:
        return str(dt) if dt else ""


DYNAMODB_TABLE = os.environ.get("DYNAMODB_TABLE_NAME") or os.environ.get("DYNAMODB_TABLE", "aarvex-social-bot-state")

# ─────────────────────────────────────────────────────────────
# SECURITY: dedicated secrets — no hardcoded fallback strings.
# Each secret MUST be set as a Lambda env var. If missing, the
# feature that depends on it fails CLOSED (raises / denies)
# instead of silently using a guessable default.
# ─────────────────────────────────────────────────────────────
OTP_SECRET = os.environ.get("OTP_SECRET", "")
if not OTP_SECRET:
    logger.critical("[SECURITY] OTP_SECRET env var is not set — delivery OTPs will fail to verify safely.")

_BANK_ENC_KEY_RAW = os.environ.get("BANK_ENCRYPTION_KEY", "")

_db = boto3.resource("dynamodb")
table = _db.Table(DYNAMODB_TABLE)

ARN_RE = re.compile(r"^(AX\d{6}\d{6}|ARN-\d{4}-\d{6})$", re.I)
IFSC_RE = re.compile(r"^[A-Z]{4}0[A-Z0-9]{6}$", re.I)

DEFAULT_SETTINGS = {
    "delivery_rate_per_km": Decimal("10"),
    "min_delivery_charge": Decimal("50"),
    "platform_fee_pct": Decimal("10"),
    "gst_rate_pct": Decimal("5"),
    "shop_subscription_inr": Decimal("200"),
    "otp_expiry_minutes": 30,
    "gps_proximity_meters": 500,
    "max_otp_attempts": 3,
    "delivery_claim_broadcast_minutes": 10,
    "delivery_reject_suspend_threshold": 12,
    "delivery_claim_cancel_suspend_threshold": 4,
    # Content moderation (admin Settings toggles)
    "auto_moderation_enabled": False,
    "auto_moderation_mode": "block",  # block | flag
    "moderation_alert_admin": True,
    "moderation_keyword_pack": "",  # optional extra keywords, newline or comma separated
}

_INT_SETTINGS = {
    "otp_expiry_minutes", "gps_proximity_meters", "max_otp_attempts",
    "delivery_claim_broadcast_minutes", "delivery_reject_suspend_threshold",
    "delivery_claim_cancel_suspend_threshold",
}

_BOOL_SETTINGS = {
    "auto_moderation_enabled",
    "moderation_alert_admin",
}

_STR_SETTINGS = {
    "auto_moderation_mode",
    "moderation_keyword_pack",
}


def _decimal(value, default: Decimal = Decimal("0")) -> Decimal:
    try:
        return Decimal(str(value).strip())
    except (InvalidOperation, AttributeError, TypeError):
        return default


def _as_bool(value, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, (int, float, Decimal)):
        return bool(value)
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def get_platform_settings() -> dict:
    item = table.get_item(Key={"pk": "SETTINGS#PLATFORM"}).get("Item") or {}
    out = {}
    for key, default in DEFAULT_SETTINGS.items():
        raw = item.get(key, default)
        if key in _BOOL_SETTINGS:
            out[key] = _as_bool(raw, bool(default))
        elif key in _STR_SETTINGS:
            out[key] = str(raw if raw is not None else default)
        elif key in _INT_SETTINGS:
            out[key] = int(raw or default)
        else:
            out[key] = _decimal(raw, _decimal(default))
    return out


def save_platform_settings(updates: dict) -> None:
    clean = {}
    for k, v in updates.items():
        if k not in DEFAULT_SETTINGS:
            continue
        if k in _BOOL_SETTINGS:
            clean[k] = _as_bool(v)
        elif k in _STR_SETTINGS:
            sv = str(v or "").lower().strip()
            if k == "auto_moderation_mode" and sv not in ("block", "flag"):
                sv = "block"
            clean[k] = sv
        elif k in _INT_SETTINGS:
            clean[k] = int(v)
        else:
            clean[k] = _decimal(v)
    if not clean:
        return
    names = {f"#k{i}": k for i, k in enumerate(clean)}
    values = {f":v{i}": v for i, v in enumerate(clean.values())}
    expr = "SET " + ", ".join(f"{n} = {v}" for n, v in zip(names, values))
    table.update_item(
        Key={"pk": "SETTINGS#PLATFORM"},
        UpdateExpression=expr + ", updated_at = :u",
        ExpressionAttributeNames=names,
        ExpressionAttributeValues={**values, ":u": datetime.now(timezone.utc).isoformat()},
    )


def generate_arn() -> tuple[str, str]:
    """Return (arn, tracking_key). New format: ARN-YYYY-XXXXXX."""
    year = datetime.utcnow().year
    for _ in range(12):
        num = random.randint(100000, 999999)
        arn = f"ARN-{year}-{num:06d}"
        tracking_key = f"{num:06d}"
        try:
            if not table.get_item(Key={"pk": f"ORDER#{arn}"}).get("Item"):
                return arn, tracking_key
        except Exception:
            return arn, tracking_key
    num = random.randint(100000, 999999)
    return f"ARN-{year}-{num:06d}", f"{num:06d}"


def generate_legacy_arn() -> str:
    """Backward-compatible AX format."""
    now = datetime.utcnow()
    return f"AX{now.year}{now.month:02d}{random.randint(100000, 999999)}"


def normalize_arn(arn: str) -> str:
    return (arn or "").strip().upper()


def arn_valid(arn: str) -> bool:
    return bool(ARN_RE.match(normalize_arn(arn)))


def extract_tracking_key(arn: str) -> str:
    arn = normalize_arn(arn)
    if arn.startswith("ARN-"):
        parts = arn.split("-")
        if len(parts) >= 3:
            return parts[-1][-6:]
    digits = re.sub(r"\D", "", arn)
    return digits[-6:] if len(digits) >= 6 else digits


def estimate_distance_km(seller_pincode: str = "", buyer_pincode: str = "", fallback: Decimal = Decimal("15")) -> Decimal:
    """Pincode-based rough distance; admin can override via stored order distance."""
    s = re.sub(r"\D", "", seller_pincode or "")
    b = re.sub(r"\D", "", buyer_pincode or "")
    if len(s) == 6 and len(b) == 6:
        diff = abs(int(s[:3]) - int(b[:3]))
        return max(Decimal("5"), min(Decimal("500"), Decimal(diff * 8 + 10)))
    return fallback


def calc_payment_breakdown(
    lot_price: Decimal | float | str,
    distance_km: Decimal | float | str | None = None,
    seller_pincode: str = "",
    buyer_pincode: str = "",
    settings: dict | None = None,
) -> dict:
    """
    Importer-facing payment breakdown.
    Shows lot + delivery + platform fee + GST (separate line).
    Platform fee rate is visible; GST is customer-facing only on goods+services subtotal.
    """
    settings = settings or get_platform_settings()
    lot = _decimal(lot_price)
    if distance_km is None:
        distance_km = estimate_distance_km(seller_pincode, buyer_pincode)
    dist = _decimal(distance_km, Decimal("15"))
    rate_km = _decimal(settings["delivery_rate_per_km"])
    min_del = _decimal(settings["min_delivery_charge"])
    delivery = max(min_del, (dist * rate_km).quantize(Decimal("1")))
    fee_pct = _decimal(settings["platform_fee_pct"])
    platform_fee = (lot * fee_pct / Decimal("100")).quantize(Decimal("1"))
    subtotal = lot + delivery + platform_fee
    gst_pct = _decimal(settings["gst_rate_pct"])
    gst_amount = (subtotal * gst_pct / Decimal("100")).quantize(Decimal("0.01"))
    total = subtotal + gst_amount
    return {
        "lot_price": float(lot),
        "delivery_charge": float(delivery),
        "distance_km": float(dist),
        "platform_fee": float(platform_fee),
        "platform_fee_pct": float(fee_pct),
        "subtotal": float(subtotal),
        "gst_amount": float(gst_amount),
        "gst_rate_pct": float(gst_pct),
        "total": float(total),
        "currency": "INR",
    }


# ─────────────────────────────────────────────────────────────
# BANK DETAIL ENCRYPTION (reversible — needed for payouts)
# Previously this was a one-way HMAC hash, which meant nobody —
# not even the admin — could ever recover the real account number
# to actually send a payout. This uses Fernet (AES-128-CBC + HMAC),
# which is reversible ONLY with BANK_ENCRYPTION_KEY.
#
# Generate a key once with:
#   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
# and store it as the BANK_ENCRYPTION_KEY Lambda env var. Never commit it.
# ─────────────────────────────────────────────────────────────

def _fernet():
    if not _BANK_ENC_KEY_RAW:
        raise RuntimeError(
            "BANK_ENCRYPTION_KEY is not configured — refusing to touch bank details in plaintext or with a weak key."
        )
    from cryptography.fernet import Fernet
    return Fernet(_BANK_ENC_KEY_RAW.encode())


def encrypt_bank_field(value: str) -> str:
    """Reversible encryption for a bank field. Returns ciphertext token."""
    return _fernet().encrypt((value or "").encode()).decode()


def decrypt_bank_field(token: str) -> str:
    """Decrypt a bank field. Should ONLY be called from admin-authorized,
    payout-execution code paths — never returned in a normal API response."""
    if not token:
        return ""
    try:
        return _fernet().decrypt(token.encode()).decode()
    except Exception as e:
        logger.error("[BANK][DECRYPT] failed: %s", e)
        return ""


def mask_bank_account(value: str) -> str:
    v = re.sub(r"\D", "", value or "")
    return ("•" * max(0, len(v) - 4)) + v[-4:] if v else ""


# ─────────────────────────────────────────────────────────────
# PAYOUT LEDGER — tracks who is owed what after an order is
# delivered (COD or online). This is the missing "settlement"
# layer: calc_payment_breakdown() only calculates amounts;
# these functions record + track actual money owed/paid.
# ─────────────────────────────────────────────────────────────

def create_payout_entries(
    arn: str,
    *,
    seller_sub: str = "",
    delivery_partner_sub: str = "",
    lot_price: Decimal | float | str = 0,
    delivery_charge: Decimal | float | str = 0,
    platform_fee: Decimal | float | str = 0,
    gst_amount: Decimal | float | str = 0,
    is_seller_product: bool = True,
    payment_method: str = "online",
) -> list[str]:
    """Create one payout-ledger entry per payee (seller + delivery partner).
    Company's own share (platform_fee + gst) is NOT a payout — it's revenue
    retained, so no ledger entry is created for it; it's implicit as
    total_collected - seller_payout - delivery_payout.
    Returns list of created payout_id(s). Idempotent per (arn, payee_type).
    """
    now = datetime.now(timezone.utc).isoformat()
    created = []

    def _put(payee_type: str, payee_sub: str, amount: Decimal) -> str | None:
        if not payee_sub or amount <= 0:
            return None
        payout_id = f"{arn}#{payee_type}"
        pk = f"PAYOUT#{payout_id}"
        # Idempotency: don't double-create if delivery-complete fires twice.
        existing = table.get_item(Key={"pk": pk}).get("Item")
        if existing:
            return payout_id
        table.put_item(Item={
            "pk": pk,
            "payout_id": payout_id,
            "arn": arn,
            "payee_type": payee_type,          # "seller" | "delivery_partner"
            "payee_sub": payee_sub,
            "amount": _decimal(amount),
            "status": "pending",                # pending -> paid
            "payment_method": payment_method,    # "online" | "cod"
            "created_at": now,
            "paid_at": "",
            "paid_ref": "",
            "paid_by_admin": "",
        })
        return payout_id

    if is_seller_product:
        pid = _put("seller", seller_sub, _decimal(lot_price))
        if pid:
            created.append(pid)
    pid = _put("delivery_partner", delivery_partner_sub, _decimal(delivery_charge))
    if pid:
        created.append(pid)
    return created


def list_payouts(status: str | None = None, payee_type: str | None = None) -> list[dict]:
    from boto3.dynamodb.conditions import Attr
    filt = Attr("pk").begins_with("PAYOUT#")
    if status:
        filt = filt & Attr("status").eq(status)
    if payee_type:
        filt = filt & Attr("payee_type").eq(payee_type)
    items, kwargs = [], {"FilterExpression": filt}
    while True:
        resp = table.scan(**kwargs)
        items.extend(resp.get("Items", []))
        if "LastEvaluatedKey" not in resp:
            break
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    items.sort(key=lambda i: i.get("created_at", ""), reverse=True)
    return items


def mark_payout_paid(payout_id: str, admin_id: str, paid_ref: str = "") -> bool:
    pk = f"PAYOUT#{payout_id}"
    item = table.get_item(Key={"pk": pk}).get("Item")
    if not item or item.get("status") == "paid":
        return False
    table.update_item(
        Key={"pk": pk},
        UpdateExpression="SET #s = :s, paid_at = :t, paid_ref = :r, paid_by_admin = :a",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={
            ":s": "paid", ":t": datetime.now(timezone.utc).isoformat(),
            ":r": paid_ref, ":a": admin_id,
        },
    )
    return True


def get_bank_details_for_payout(user_sub: str) -> dict:
    """ADMIN-ONLY. Decrypts bank account number just-in-time for making a
    transfer. Callers MUST check admin auth before calling this — this
    function itself does not check auth, to keep it reusable/testable."""
    kyc = table.get_item(Key={"pk": f"KYC#USER#{user_sub}"}).get("Item") or {}
    return {
        "bank_account_holder": kyc.get("bank_account_holder", ""),
        "bank_name": kyc.get("bank_name", ""),
        "bank_ifsc": kyc.get("bank_ifsc", ""),
        "bank_account_number": decrypt_bank_field(kyc.get("bank_account_enc", "")),
    }


def hash_otp(arn: str, otp: str) -> str:
    return hashlib.sha256(f"{OTP_SECRET}:{arn}:{otp}".encode()).hexdigest()


def verify_otp(arn: str, otp: str, stored_hash: str) -> bool:
    if not stored_hash or not otp:
        return False
    return hmac.compare_digest(hash_otp(arn, otp.strip()), stored_hash)


def generate_otp() -> str:
    return f"{random.randint(100000, 999999)}"


def _dec(v, default: Decimal = Decimal("0")) -> Decimal:
    try:
        return Decimal(str(v))
    except Exception:
        return default


def _ensure_stock_fields(product_pk: str, item: dict) -> dict:
    """Back-fill available / committed / initial for legacy catalogue rows."""
    lot = _dec(item.get("lot_size_kg", 0))
    updates = {}
    if item.get("available_stock_kg") is None:
        updates["available_stock_kg"] = lot
        item["available_stock_kg"] = lot
    if item.get("committed_kg") is None:
        updates["committed_kg"] = Decimal("0")
        item["committed_kg"] = Decimal("0")
    if item.get("initial_stock_kg") is None:
        init = _dec(item.get("available_stock_kg"), lot) or lot
        updates["initial_stock_kg"] = init
        item["initial_stock_kg"] = init
    if updates:
        try:
            names = {f"#k{i}": k for i, k in enumerate(updates)}
            values = {f":v{i}": v for i, v in enumerate(updates.values())}
            expr = "SET " + ", ".join(f"{n} = {v}" for n, v in zip(names, values))
            table.update_item(
                Key={"pk": product_pk},
                UpdateExpression=expr,
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
            )
        except Exception as e:
            logger.warning("[STOCK] backfill failed for %s: %s", product_pk, e)
    return item


def free_stock_kg(item: dict) -> Decimal:
    avail = _dec(item.get("available_stock_kg"), _dec(item.get("lot_size_kg", 0)))
    committed = _dec(item.get("committed_kg", 0))
    free = avail - committed
    return free if free > 0 else Decimal("0")


def _soft_archive_product(product_pk: str, item: dict, arn: str = "") -> None:
    """Hide from public catalogue but KEEP the DynamoDB row for seller refill."""
    try:
        table.update_item(
            Key={"pk": product_pk},
            UpdateExpression=(
                "SET lot_status = :s, is_active = :a, sold_at = :t, sold_arn = :arn, "
                "available_stock_kg = :z, committed_kg = :z"
            ),
            ExpressionAttributeValues={
                ":s": "sold_out",
                ":a": False,
                ":t": datetime.now(timezone.utc).isoformat(),
                ":arn": arn or "",
                ":z": Decimal("0"),
            },
        )
    except Exception as e:
        logger.error("[STOCK] soft-archive failed for %s: %s", product_pk, e)


def _maybe_low_stock_alert(item: dict, remaining: Decimal) -> None:
    """Notify seller once when remaining stock drops to <= 20% of initial."""
    try:
        initial = _dec(item.get("initial_stock_kg"), _dec(item.get("lot_size_kg", 0)))
        if initial <= 0 or remaining <= 0:
            return
        ratio = float(remaining / initial)
        if ratio > 0.20:
            # Clear prior flag when restocked above 25%
            if ratio > 0.25 and item.get("low_stock_alerted"):
                try:
                    table.update_item(
                        Key={"pk": item["pk"]},
                        UpdateExpression="REMOVE low_stock_alerted, low_stock_alerted_at",
                    )
                except Exception:
                    pass
            return
        if item.get("low_stock_alerted"):
            return
        seller = item.get("seller_user_sub", "")
        if not seller:
            return
        try:
            table.update_item(
                Key={"pk": item["pk"]},
                UpdateExpression="SET low_stock_alerted = :t, low_stock_alerted_at = :ts",
                ConditionExpression="attribute_not_exists(low_stock_alerted)",
                ExpressionAttributeValues={
                    ":t": True,
                    ":ts": datetime.now(timezone.utc).isoformat(),
                },
            )
        except ClientError:
            return  # already alerted (race)
        try:
            from marketplace import create_notification
            pname = item.get("product_name") or "your product"
            create_notification(
                seller,
                "low_stock",
                "Low stock warning",
                (
                    f"Only about 20% of {pname} is left ({float(remaining):g} kg of {float(initial):g} kg). "
                    "Please refill soon. If stock reaches zero, this listing will be archived and "
                    "buyers will not see it until you refill."
                ),
                edit_product_id=item.get("product_id", ""),
                edit_category_id=item.get("category_id", ""),
                cta_label="Refill & edit product",
            )
        except Exception as e:
            logger.warning("[STOCK] low-stock notify failed: %s", e)
    except Exception as e:
        logger.warning("[STOCK] low-stock check failed: %s", e)


def commit_product_stock(product_pk: str, purchased_kg, arn: str = "") -> dict:
    """Book qty against free stock WITHOUT changing public available_stock_kg.

    Called when a delivery record is created (COD place / online payment).
    Public Trade/Fav/Shop keep showing available until COMPLETE.
    """
    if not product_pk:
        return {"success": False, "free_kg": 0, "error": "no product_pk"}
    try:
        qty = Decimal(str(purchased_kg))
    except Exception:
        return {"success": False, "free_kg": 0, "error": "bad quantity"}
    if qty <= 0:
        return {"success": False, "free_kg": 0, "error": "quantity must be positive"}

    for _attempt in range(4):
        try:
            item = table.get_item(Key={"pk": product_pk}).get("Item")
            if not item:
                return {"success": False, "free_kg": 0, "error": "product not found"}
            item = _ensure_stock_fields(product_pk, item)
            avail = _dec(item.get("available_stock_kg"))
            committed = _dec(item.get("committed_kg", 0))
            free = avail - committed
            if qty > free:
                return {
                    "success": False,
                    "free_kg": float(free if free > 0 else 0),
                    "error": "insufficient_stock",
                }
            new_committed = committed + qty
            table.update_item(
                Key={"pk": product_pk},
                UpdateExpression="SET committed_kg = :nc",
                ConditionExpression="committed_kg = :prev",
                ExpressionAttributeValues={":nc": new_committed, ":prev": committed},
            )
            return {
                "success": True,
                "free_kg": float(avail - new_committed),
                "committed_kg": float(new_committed),
                "available_kg": float(avail),
                "error": None,
            }
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                continue
            logger.error("[STOCK][COMMIT] failed for %s: %s", product_pk, e)
            return {"success": False, "free_kg": 0, "error": str(e)}
        except Exception as e:
            logger.error("[STOCK][COMMIT] unexpected for %s: %s", product_pk, e, exc_info=True)
            return {"success": False, "free_kg": 0, "error": str(e)}
    return {"success": False, "free_kg": 0, "error": "insufficient_stock"}


def release_product_commit(product_pk: str, purchased_kg, arn: str = "") -> bool:
    """Cancel path: release committed_kg only. Public available unchanged.

    Also cleans up legacy claim-time reservations (lot_status=reserved) by
    restoring available_stock_kg if that old path had already deducted it.
    """
    if not product_pk:
        return False
    try:
        qty = _dec(purchased_kg) if purchased_kg else Decimal("0")
    except Exception:
        qty = Decimal("0")
    try:
        item = table.get_item(Key={"pk": product_pk}).get("Item")
        if not item:
            return False
        item = _ensure_stock_fields(product_pk, item)

        # Legacy claim-time reserve: available was already reduced — put it back.
        legacy = item.get("lot_status") == "reserved" and (
            not arn or item.get("reserved_arn") == arn
        )
        if legacy:
            if qty > 0:
                table.update_item(
                    Key={"pk": product_pk},
                    UpdateExpression=(
                        "SET available_stock_kg = if_not_exists(available_stock_kg, :z) + :q, "
                        "is_active = :a, lot_status = :s "
                        "REMOVE reserved_arn, reserved_at"
                    ),
                    ExpressionAttributeValues={
                        ":q": qty, ":z": Decimal("0"), ":a": True, ":s": "available",
                    },
                )
            else:
                table.update_item(
                    Key={"pk": product_pk},
                    UpdateExpression="SET is_active = :a, lot_status = :s REMOVE reserved_arn, reserved_at",
                    ExpressionAttributeValues={":a": True, ":s": "available"},
                )
            return True

        committed = _dec(item.get("committed_kg", 0))
        if qty > 0 and committed > 0:
            new_c = committed - qty
            if new_c < 0:
                new_c = Decimal("0")
            table.update_item(
                Key={"pk": product_pk},
                UpdateExpression="SET committed_kg = :nc",
                ExpressionAttributeValues={":nc": new_c},
            )
        return True
    except Exception as e:
        logger.error("[STOCK][RELEASE] unexpected for %s (arn=%s): %s", product_pk, arn, e, exc_info=True)
        return False


def complete_product_sale(product_pk: str, purchased_kg, arn: str = "") -> dict:
    """COMPLETE (OTP) only: decrement public available + release commit.

    Soft-archives at 0 (keeps row for seller refill). Never hard-deletes.
    """
    if not product_pk:
        return {"success": False, "remaining_kg": 0, "sold_out": False, "error": "no product_pk"}
    try:
        qty = Decimal(str(purchased_kg))
    except Exception:
        return {"success": False, "remaining_kg": 0, "sold_out": False, "error": "bad quantity"}
    if qty <= 0:
        return {"success": False, "remaining_kg": 0, "sold_out": False, "error": "quantity must be positive"}

    try:
        item = table.get_item(Key={"pk": product_pk}).get("Item")
        if not item:
            return {"success": False, "remaining_kg": 0, "sold_out": False, "error": "product not found"}
        item = _ensure_stock_fields(product_pk, item)

        # Legacy: claim already reduced available — don't double-decrement.
        legacy = item.get("lot_status") == "reserved" and item.get("reserved_arn") == arn
        if legacy:
            remaining = _dec(item.get("available_stock_kg"))
            sold_out = remaining <= 0
            if sold_out:
                _soft_archive_product(product_pk, item, arn)
            else:
                try:
                    table.update_item(
                        Key={"pk": product_pk},
                        UpdateExpression="SET lot_status = :s REMOVE reserved_arn, reserved_at",
                        ExpressionAttributeValues={":s": "available"},
                    )
                except Exception:
                    pass
                _maybe_low_stock_alert(item, remaining)
            return {
                "success": True,
                "remaining_kg": float(remaining if remaining > 0 else 0),
                "sold_out": sold_out,
                "error": None,
            }

        committed = _dec(item.get("committed_kg", 0))
        new_committed = committed - qty
        if new_committed < 0:
            new_committed = Decimal("0")

        resp = table.update_item(
            Key={"pk": product_pk},
            UpdateExpression=(
                "SET available_stock_kg = available_stock_kg - :q, committed_kg = :nc"
            ),
            ConditionExpression="available_stock_kg >= :q",
            ExpressionAttributeValues={":q": qty, ":nc": new_committed},
            ReturnValues="ALL_NEW",
        )
        attrs = resp.get("Attributes") or {}
        remaining = _dec(attrs.get("available_stock_kg"))
        sold_out = remaining <= 0
        if sold_out:
            _soft_archive_product(product_pk, item, arn)
        else:
            item2 = dict(item)
            item2.update(attrs)
            _maybe_low_stock_alert(item2, remaining)
        return {
            "success": True,
            "remaining_kg": float(remaining if remaining > 0 else 0),
            "sold_out": sold_out,
            "error": None,
        }
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            logger.warning("[STOCK][COMPLETE] insufficient for %s wanted %s", product_pk, purchased_kg)
            return {"success": False, "remaining_kg": 0, "sold_out": False, "error": "insufficient_stock"}
        logger.error("[STOCK][COMPLETE] failed for %s: %s", product_pk, e)
        return {"success": False, "remaining_kg": 0, "sold_out": False, "error": str(e)}
    except Exception as e:
        logger.error("[STOCK][COMPLETE] unexpected for %s: %s", product_pk, e, exc_info=True)
        return {"success": False, "remaining_kg": 0, "sold_out": False, "error": str(e)}


def decrement_product_stock(product_pk: str, purchased_kg, arn: str = "") -> dict:
    """Alias → complete_product_sale (stock minus only on order complete)."""
    return complete_product_sale(product_pk, purchased_kg, arn=arn)


def reserve_product_stock(product_pk: str, purchased_kg, arn: str = "") -> dict:
    """DEPRECATED no-op for claim path. Stock is committed at delivery-create
    and decremented only on COMPLETE. Kept so old imports don't crash."""
    logger.info("[STOCK][RESERVE] no-op (complete-only model) pk=%s arn=%s", product_pk, arn)
    item = table.get_item(Key={"pk": product_pk}).get("Item") if product_pk else None
    avail = float(_dec((item or {}).get("available_stock_kg"), 0))
    return {"success": True, "remaining_kg": avail, "fully_reserved": False, "error": None}


def finalize_product_reservation(product_pk: str, arn: str = "", purchased_kg=None) -> bool:
    """COMPLETE hook — decrements available by purchased_kg (from delivery rec)."""
    if not product_pk:
        logger.warning("[STOCK][FINALIZE] no product_pk for arn=%s", arn)
        return False
    qty = purchased_kg
    if qty is None:
        try:
            rec = table.get_item(Key={"pk": f"DELIVERY#ARN#{arn}"}).get("Item") or {} if arn else {}
            qty = rec.get("committed_kg") or rec.get("reserved_kg") or rec.get("lot_size_kg") or 0
        except Exception:
            qty = 0
    result = complete_product_sale(product_pk, qty, arn=arn)
    return bool(result.get("success"))


def reverse_product_reservation(product_pk: str, reserved_kg, arn: str = "") -> bool:
    """CANCEL hook — release commit (and legacy claim reserves)."""
    return release_product_commit(product_pk, reserved_kg, arn=arn)


def mark_lot_sold(product_pk: str, arn: str = "") -> bool:
    """Mark catalogue lot sold — only call from verified Razorpay webhook."""
    if not product_pk:
        return False
    try:
        item = table.get_item(Key={"pk": product_pk}).get("Item")
        if not item:
            return False
        table.update_item(
            Key={"pk": product_pk},
            UpdateExpression="SET lot_status = :s, is_active = :a, sold_at = :t, sold_arn = :arn",
            ExpressionAttributeValues={
                ":s": "sold",
                ":a": False,
                ":t": datetime.now(timezone.utc).isoformat(),
                ":arn": arn,
            },
        )
        return True
    except Exception as e:
        logger.error("[LOT] mark sold failed: %s", e)
        return False


# ─────────────────────────────────────────────────────────────
# GEOCODING + LIVE-TRACKING HELPERS (buyer address → lat/lng,
# distance-remaining, ETA). Used by the delivery-tracking map
# so buyer + delivery partner can see each other like a
# Zomato/Swiggy style live map.
# ─────────────────────────────────────────────────────────────

AVG_DELIVERY_SPEED_KMPH = Decimal("22")  # conservative mixed city/highway avg


def geocode_pincode(pincode: str) -> tuple[float, float] | None:
    """Best-effort pincode → (lat, lng) via OpenStreetMap Nominatim.
    Returns None on any failure — callers must treat this as optional."""
    pincode = re.sub(r"\D", "", pincode or "")
    if len(pincode) != 6:
        return None
    try:
        url = f"https://nominatim.openstreetmap.org/search?postalcode={pincode}&country=India&format=json&limit=1"
        req = urllib.request.Request(url, headers={"User-Agent": "AarvexGlobal/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            if data:
                return float(data[0]["lat"]), float(data[0]["lon"])
    except Exception as e:
        logger.warning("[GEOCODE] pincode lookup failed for %s: %s", pincode, e)
    return None


def haversine_km(lat1, lon1, lat2, lon2) -> float:
    import math
    if not lat1 or not lon1 or not lat2 or not lon2:
        return 0.0
    r = 6371.0
    p1, p2 = math.radians(float(lat1)), math.radians(float(lat2))
    dp = math.radians(float(lat2) - float(lat1))
    dl = math.radians(float(lon2) - float(lon1))
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def estimate_eta_minutes(distance_km: float) -> int:
    """Rough ETA — used only for a friendly on-screen estimate, never for
    billing/SLA purposes."""
    if not distance_km or distance_km <= 0:
        return 0
    try:
        mins = (Decimal(str(distance_km)) / AVG_DELIVERY_SPEED_KMPH) * Decimal("60")
        return max(1, int(mins.to_integral_value(rounding="ROUND_CEILING")))
    except Exception:
        return max(1, round(distance_km / float(AVG_DELIVERY_SPEED_KMPH) * 60))


def verify_recaptcha(token: str) -> bool:
    """Verify Cloudflare Turnstile token. Uses RECAPTCHA_SECRET_KEY env var."""
    if not token or not str(token).strip():
        return False
    secret = os.environ.get("RECAPTCHA_SECRET_KEY", "")
    if not secret:
        logger.error("[TURNSTILE] RECAPTCHA_SECRET_KEY is not set in this Lambda's environment — "
                     "every submission will fail verification until it's configured.")
        return False
    try:
        data = urllib.parse.urlencode({"secret": secret, "response": token}).encode()
        req = urllib.request.Request(
            "https://challenges.cloudflare.com/turnstile/v0/siteverify",
            data=data,
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            result = json.loads(resp.read().decode())
            ok = bool(result.get("success"))
            if not ok:
                # Cloudflare's own reason codes — e.g. "invalid-input-secret"
                # (wrong secret key), "timeout-or-duplicate" (token already
                # used or expired), "invalid-input-response" (malformed/stale
                # token). This is the single most useful line for diagnosing
                # a captcha failure — without it, all we know is "it failed".
                logger.warning("[TURNSTILE] siteverify rejected token: %s", result.get("error-codes"))
            return ok
    except Exception as e:
        logger.warning("[TURNSTILE] verification failed: %s", e)
        return False