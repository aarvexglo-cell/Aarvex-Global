"""
Delivery partner network — claim, GPS, in-app OTP completion.
OTP delivered via portal notifications (free) — no SMS.
"""

from __future__ import annotations

import logging
import math
import re
from datetime import datetime, timezone
from decimal import Decimal

from platform_utils import (
    arn_valid,
    create_payout_entries,
    commit_product_stock,
    estimate_eta_minutes,
    extract_tracking_key,
    finalize_product_reservation,
    generate_otp,
    get_platform_settings,
    hash_otp,
    normalize_arn,
    reserve_product_stock,
    reverse_product_reservation,
    to_ist_str,
    verify_otp,
)

logger = logging.getLogger()

_json_response = None
_event_body = None
_require_auth = None
_now = None
_ttl = None
_json_num = None
_decimal = None
create_notification = None
get_kyc = None
get_profile = None
get_shop_by_user = None
table = None
_get_delivery_partner_contact = None
_list_approved_delivery_partners = None
_suspend_delivery_partner = None


def _bind_partner_pool_helpers(list_fn, suspend_fn):
    global _list_approved_delivery_partners, _suspend_delivery_partner
    _list_approved_delivery_partners = list_fn
    _suspend_delivery_partner = suspend_fn


def _bind_delivery_helpers(marketplace_mod):
    global _json_response, _event_body, _require_auth, _now, _ttl, _json_num
    global _decimal, create_notification, get_kyc, get_profile, get_shop_by_user, table
    _json_response = marketplace_mod._json_response
    _event_body = marketplace_mod._event_body
    _require_auth = marketplace_mod._require_auth
    _now = marketplace_mod._now
    _ttl = marketplace_mod._ttl
    _json_num = marketplace_mod._json_num
    _decimal = marketplace_mod._decimal
    create_notification = marketplace_mod.create_notification
    get_kyc = marketplace_mod.get_kyc
    get_profile = marketplace_mod.get_profile
    get_shop_by_user = getattr(marketplace_mod, "get_shop_by_user", None)
    table = marketplace_mod.table


def _bind_contact_helper(fn):
    global _get_delivery_partner_contact
    _get_delivery_partner_contact = fn


def _delivery_profile(user_sub: str) -> dict:
    kyc = get_kyc(user_sub)
    return {
        "role": kyc.get("kyc_role", "shop_owner"),
        "is_delivery_partner": kyc.get("kyc_role") in ("delivery_partner", "both") and not kyc.get("delivery_suspended"),
        "kyc_status": kyc.get("status", "none"),
        "delivery_suspended": bool(kyc.get("delivery_suspended", False)),
    }


def _get_delivery_record(arn: str) -> dict:
    return table.get_item(Key={"pk": f"DELIVERY#ARN#{normalize_arn(arn)}"}).get("Item") or {}


def _scan_prefix(prefix: str) -> list:
    from boto3.dynamodb.conditions import Attr
    items, kwargs = [], {"FilterExpression": Attr("pk").begins_with(prefix)}
    while True:
        resp = table.scan(**kwargs)
        items.extend(resp.get("Items", []))
        if "LastEvaluatedKey" not in resp:
            break
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    return items


# Statuses that count as "still open" for a delivery partner's claim — i.e.
# they've committed to it and it hasn't reached a terminal state yet.
_OPEN_CLAIM_STATUSES = ("DELIVERY_ASSIGNED", "IN_TRANSIT", "NEAR_DESTINATION")


def _get_active_claims_for(user_sub: str) -> list:
    """All of this delivery partner's currently-open claims. Business rule
    (previously unenforced — this is the fix): a partner should only ever
    have ONE open claim at a time, but this returns a list rather than
    just a bool/single-item so it also surfaces any pre-existing bad data
    (multiple open claims from before this restriction shipped) for the
    partner to clean up via the "My pending claims" panel."""
    out = []
    for item in _scan_prefix("DELIVERY#ARN#"):
        if item.get("claimed_by") == user_sub and item.get("status") in _OPEN_CLAIM_STATUSES:
            out.append(item)
    return out


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _delivery_triangle_km(partner_lat, partner_lng, pickup_lat, pickup_lng, dest_lat, dest_lng):
    """Return the three sides of the delivery triangle in km.

    The radius rule is intentionally about the *three points*, not only the
    shop→importer trip: partner→shop, shop→importer and partner→importer must
    each be within the partner's chosen working radius.
    """
    try:
        values = [float(v) for v in (partner_lat, partner_lng, pickup_lat, pickup_lng, dest_lat, dest_lng)]
    except (TypeError, ValueError):
        return None
    if not all(values):
        return None
    p_lat, p_lng, s_lat, s_lng, i_lat, i_lng = values
    return {
        "partner_to_shop": round(_haversine_m(p_lat, p_lng, s_lat, s_lng) / 1000.0, 1),
        "shop_to_importer": round(_haversine_m(s_lat, s_lng, i_lat, i_lng) / 1000.0, 1),
        "partner_to_importer": round(_haversine_m(p_lat, p_lng, i_lat, i_lng) / 1000.0, 1),
    }


def _send_delivery_otp_notification(importer_sub: str, arn: str, otp: str) -> None:
    create_notification(
        importer_sub,
        "delivery_otp",
        "Delivery OTP — share with driver",
        f"Your delivery for {arn} is nearby.\n\nOTP: {otp}\n\n"
        f"Share this code verbally with the delivery partner to confirm receipt.\n"
        f"Valid for {get_platform_settings()['otp_expiry_minutes']} minutes.",
        arn=arn,
    )


def handle_delivery_release(event: dict) -> dict:
    """A shop's preferred partner (or the shop owner) opens a reserved order to
    the general delivery pool early — e.g. if their own boy can't take it."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    arn = normalize_arn(body.get("arn", ""))
    rec = _get_delivery_record(arn)
    if not rec:
        return _json_response(404, {"error": "Delivery record not found"})
    pref = rec.get("preferred_subs") or []
    if user["sub"] not in pref and user["sub"] != rec.get("seller_sub", ""):
        return _json_response(403, {"error": "Only the shop's own team can release this order"})
    if rec.get("claimed_by"):
        return _json_response(409, {"error": "Order already claimed"})
    table.update_item(
        Key={"pk": f"DELIVERY#ARN#{arn}"},
        UpdateExpression="SET preferred_until_ts = :z",
        ExpressionAttributeValues={":z": 0},
    )
    return _json_response(200, {"success": True})


def _approval_authorized(rec: dict, user_sub: str) -> bool:
    return user_sub in (rec.get("seller_sub", ""), rec.get("importer_sub", ""))


def handle_delivery_approve(event: dict) -> dict:
    """Shop owner OR importer approves an outside delivery partner's pending
    claim → the order becomes assigned and stock is reserved (D3)."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    arn = normalize_arn(body.get("arn", ""))
    rec = _get_delivery_record(arn)
    if not rec:
        return _json_response(404, {"error": "Delivery record not found"})
    if not _approval_authorized(rec, user["sub"]):
        return _json_response(403, {"error": "Only the shop or importer can approve this partner"})
    if rec.get("status") != "PENDING_APPROVAL" or not rec.get("claim_pending"):
        return _json_response(409, {"error": "No pending approval on this order"})
    partner = rec.get("claimed_by", "")
    table.update_item(
        Key={"pk": f"DELIVERY#ARN#{arn}"},
        UpdateExpression="SET #s = :st REMOVE claim_pending",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":st": "DELIVERY_ASSIGNED"},
    )
    # Reserve stock now that the partner is confirmed.
    # Complete-only stock model: commit already happened at delivery-create;
    # claim/approve must NOT change public available_stock_kg.
    try:
        purchased_qty = rec.get("committed_kg") or rec.get("reserved_kg") or rec.get("lot_size_kg", 0)
        table.update_item(
            Key={"pk": f"DELIVERY#ARN#{arn}"},
            UpdateExpression="SET reserved_kg = if_not_exists(reserved_kg, :q), committed_kg = if_not_exists(committed_kg, :q)",
            ExpressionAttributeValues={":q": Decimal(str(purchased_qty))},
        )
    except Exception as e:
        logger.warning("[DELIVERY][APPROVE] commit marker failed: %s", e)
    if partner and create_notification:
        try:
            create_notification(partner, "shop_status", "Delivery approved",
                                f"Your claim for order {arn} was approved — start the journey.",
                                arn=arn, track_arn=arn)
        except Exception:
            pass
    return _json_response(200, {"success": True, "status": "DELIVERY_ASSIGNED"})


def handle_delivery_reject_claim(event: dict) -> dict:
    """Shop owner OR importer rejects a pending claim → the order returns to the
    general pool for another partner (D3)."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    arn = normalize_arn(body.get("arn", ""))
    rec = _get_delivery_record(arn)
    if not rec:
        return _json_response(404, {"error": "Delivery record not found"})
    if not _approval_authorized(rec, user["sub"]):
        return _json_response(403, {"error": "Only the shop or importer can reject this partner"})
    if rec.get("status") != "PENDING_APPROVAL":
        return _json_response(409, {"error": "No pending approval on this order"})
    partner = rec.get("claimed_by", "")
    table.update_item(
        Key={"pk": f"DELIVERY#ARN#{arn}"},
        UpdateExpression="SET #s = :st REMOVE claimed_by, claimed_at, claim_pending",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":st": "PENDING_DELIVERY"},
    )
    if partner and create_notification:
        try:
            create_notification(partner, "shop_status", "Claim not approved",
                                f"Your claim for order {arn} wasn't approved — it's back in the pool.", arn=arn)
        except Exception:
            pass
    return _json_response(200, {"success": True})


def handle_delivery_orders(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    prof = _delivery_profile(user["sub"])
    if prof["kyc_status"] != "approved" or not prof["is_delivery_partner"]:
        return _json_response(403, {"error": "Approved delivery partner KYC required"})

    # ── Radius-based nearby filter — fully optional. If the partner's
    #    browser didn't send lat/lng (no GPS permission, or they haven't
    #    tapped "Use my location" yet), every order is returned exactly
    #    like before — nothing is ever silently hidden without a reason. ──
    params = event.get("queryStringParameters") or {}
    try:
        partner_lat = float(params.get("lat") or 0)
        partner_lng = float(params.get("lng") or 0)
    except (TypeError, ValueError):
        partner_lat = partner_lng = 0.0
    try:
        radius_km = float(params.get("radius_km") or 0)
    except (TypeError, ValueError):
        radius_km = 0.0
    radius_active = bool(partner_lat and partner_lng and radius_km > 0)

    import time as _time
    now_ts = int(_time.time())
    settings = get_platform_settings()
    rate_per_km = float(settings.get("delivery_rate_per_km", 10) or 10)
    min_charge = float(settings.get("min_delivery_charge", 50) or 50)
    has_gps = bool(partner_lat and partner_lng)
    _img_cache = {}

    def _product_image(ppk):
        """Product photo for the order card (B4). Cached per request."""
        if not ppk:
            return ""
        if ppk in _img_cache:
            return _img_cache[ppk]
        url = ""
        try:
            it = table.get_item(Key={"pk": ppk}).get("Item") or {}
            imgs = it.get("images") or []
            url = (it.get("image_url") or it.get("image") or it.get("photo_url")
                   or (imgs[0] if imgs else "") or "")
        except Exception:
            url = ""
        _img_cache[ppk] = url
        return url

    orders = []
    outside_radius_count = 0
    for item in _scan_prefix("DELIVERY#ARN#"):
        if item.get("status") in ("PENDING_DELIVERY", "DELIVERY_ASSIGNED") and not item.get("claimed_by"):
            # Shop's own-team priority: hide from non-preferred partners until the
            # window lapses (then it opens to everyone).
            pref = item.get("preferred_subs") or []
            if pref and user["sub"] not in pref and now_ts < int(_decimal(item.get("preferred_until_ts", 0))):
                continue
            pickup_lat = float(item.get("pickup_lat") or 0)
            pickup_lng = float(item.get("pickup_lng") or 0)
            dest_lat = float(item.get("dest_lat") or 0)
            dest_lng = float(item.get("dest_lng") or 0)
            # ── B2: three DISTINCT distances (they used to collapse into one) ──
            #   pickup_distance_km  = delivery boy → shop
            #   shop_to_importer_km = shop → importer (the actual trip)
            #   dest_distance_km    = delivery boy → importer
            # Computed whenever we have the partner's GPS — no longer gated on
            # the radius filter being on (that's why both read the same before).
            triangle = _delivery_triangle_km(partner_lat, partner_lng, pickup_lat, pickup_lng, dest_lat, dest_lng) if has_gps else None
            pickup_distance_km = triangle["partner_to_shop"] if triangle else None
            dest_distance_km = triangle["partner_to_importer"] if triangle else None
            shop_to_importer_km = _json_num(item.get("distance_km", 0))
            if triangle:
                # Coordinates are the source of truth; legacy stored values
                # can be stale or have been produced with the wrong address.
                shop_to_importer_km = triangle["shop_to_importer"]
            # ── B1: ALL THREE points must sit inside the partner's radius —
            # delivery boy → shop, delivery boy → importer, and shop → importer.
            # A leg is only ever used to reject when we actually know both of
            # its coordinates, so orders with missing GPS stay visible.
            # The radius filter only removes orders we can actually MEASURE as
            # too far. Orders with incomplete coordinates (triangle is None)
            # bypass the radius rule — they stay visible and claimable rather
            # than silently disappearing. Orders WITH coords are strictly held
            # to the triangle: every one of the three sides must be in range.
            if radius_active and triangle and any(d > radius_km for d in triangle.values()):
                outside_radius_count += 1
                continue
            # ── B3: earning — use the stored delivery_charge, but if it was
            # never priced (legacy/₹0 records) derive it from the real trip
            # distance so the card never advertises a bogus ₹0. ──
            earning = float(_decimal(item.get("delivery_charge", 0)) or 0)
            if earning <= 0:
                earning = round(max(min_charge, rate_per_km * float(shop_to_importer_km or 0)), 2)
            orders.append({
                "arn": item.get("arn", ""),
                "product_name": item.get("product_name", ""),
                "product_image": _product_image(item.get("product_pk", "")),
                "pickup_city": item.get("pickup_city", ""),
                "delivery_city": item.get("delivery_city", ""),
                "lot_size_kg": item.get("lot_size_kg", ""),
                "distance_km": shop_to_importer_km,
                "shop_to_importer_km": shop_to_importer_km,
                "pickup_distance_km": pickup_distance_km,
                "dest_distance_km": dest_distance_km,
                "estimated_earning": earning,
                "status": item.get("status", ""),
                "is_cod": bool(item.get("is_cod", False)),
                "cod_amount": _json_num(item.get("cod_amount", 0)),
            })
    if radius_active:
        orders.sort(key=lambda o: o["pickup_distance_km"] if o["pickup_distance_km"] is not None else 0)
    return _json_response(200, {
        "orders": orders,
        "radius_active": radius_active,
        "radius_km": radius_km if radius_active else None,
        "outside_radius_count": outside_radius_count,
    })


def handle_delivery_claim(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    prof = _delivery_profile(user["sub"])
    if prof["kyc_status"] != "approved" or not prof["is_delivery_partner"]:
        return _json_response(403, {"error": "Approved delivery partner KYC required"})

    # ── One-open-claim-at-a-time (fix) ──
    # Previously nothing stopped a partner from claiming order #2 while
    # order #1 was still DELIVERY_ASSIGNED/IN_TRANSIT and never completed
    # or cancelled — the live-tracking bug report that led here. A partner
    # must close (complete or cancel) every existing claim before a new
    # one is allowed.
    open_claims = _get_active_claims_for(user["sub"])
    if open_claims:
        return _json_response(409, {
            "error": "You have an unfinished delivery. Complete it or cancel it before claiming a new order.",
            "pending_claims": [
                {"arn": c.get("arn", ""), "product_name": c.get("product_name", ""), "status": c.get("status", "")}
                for c in open_claims
            ],
        })

    body = _event_body(event)
    arn = normalize_arn(body.get("arn", ""))
    if not arn_valid(arn):
        return _json_response(400, {"error": "Invalid ARN"})
    rec = _get_delivery_record(arn)
    if not rec:
        return _json_response(404, {"error": "Delivery record not found"})
    if rec.get("claimed_by"):
        return _json_response(409, {"error": "Order already claimed"})
    # Re-validate the location filter at the moment of claiming.  A list can
    # be stale, and API callers must not be able to bypass the delivery
    # partner's selected radius by posting an ARN directly.
    try:
        saved_radius_km = float(get_profile(user["sub"]).get("delivery_radius_km") or 0)
        requested_radius_km = float(body.get("radius_km") or 0)
        # The saved value prevents bypass; max() also covers the small window
        # immediately after the user presses Apply while their profile write is
        # still in flight.
        radius_km = max(saved_radius_km, requested_radius_km)
        partner_lat = float(body.get("partner_lat") or 0)
        partner_lng = float(body.get("partner_lng") or 0)
    except (TypeError, ValueError):
        return _json_response(400, {"error": "Invalid radius or current location"})
    if radius_km > 0:
        triangle = _delivery_triangle_km(
            partner_lat, partner_lng, rec.get("pickup_lat"), rec.get("pickup_lng"),
            rec.get("dest_lat"), rec.get("dest_lng"),
        )
        # The radius rule only applies to orders that actually HAVE location
        # data. An order with missing coordinates can't be measured against a
        # radius, so we let it through instead of blocking the partner with a
        # confusing "incomplete location data" rejection. Orders that DO carry
        # coordinates are still strictly held to the triangle rule below.
        if triangle and any(km > radius_km for km in triangle.values()):
            return _json_response(409, {
                "error": "This order is outside your delivery radius.",
                "triangle_km": triangle,
                "radius_km": radius_km,
            })
    # Shop's own-team priority: block non-preferred partners during the window.
    pref = rec.get("preferred_subs") or []
    if pref and user["sub"] not in pref:
        import time as _time
        if int(_time.time()) < int(_decimal(rec.get("preferred_until_ts", 0))):
            return _json_response(423, {"error": "This order is reserved for the shop's own delivery team for a few more minutes."})
    # ── D3: assignment approval ──
    # A shop that runs its OWN delivery team gets to vet outside partners: when
    # someone NOT on the team claims, the order enters PENDING_APPROVAL and the
    # shop owner + importer decide (they see the partner's record). Shops with
    # no team keep the fast first-come flow — nothing changes for them.
    needs_approval = bool(pref) and user["sub"] not in pref
    tracking_key = extract_tracking_key(arn)
    try:
        from boto3.dynamodb.conditions import Attr as _Attr
        # Atomic claim: only succeeds if nobody has claimed it yet. This
        # closes the race window where two delivery partners tap "Claim"
        # at the same moment and both would otherwise succeed.
        table.update_item(
            Key={"pk": f"DELIVERY#ARN#{arn}"},
            UpdateExpression="SET claimed_by = :u, claimed_at = :t, #s = :st, tracking_key = :tk, claim_pending = :cp",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":u": user["sub"],
                ":t": _now(),
                ":st": "PENDING_APPROVAL" if needs_approval else "DELIVERY_ASSIGNED",
                ":tk": tracking_key,
                ":cp": needs_approval,
            },
            ConditionExpression=_Attr("claimed_by").not_exists(),
        )
    except Exception as e:
        if "ConditionalCheckFailed" in str(e):
            return _json_response(409, {"error": "Order already claimed by another partner"})
        raise

    # Pending approval: notify the shop owner + importer (with the partner's
    # record to review) and stop here — stock is NOT reserved until approved.
    if needs_approval:
        me = _delivery_profile(user["sub"])
        who = me.get("name") or "A delivery partner"
        for _sub, _role in ((rec.get("seller_sub", ""), "shop"), (rec.get("importer_sub", ""), "importer")):
            if _sub and create_notification:
                try:
                    create_notification(
                        _sub, "delivery_approval",
                        "Approve delivery partner?",
                        f"{who} wants to deliver order {arn}. Review their record and approve or reject.",
                        arn=arn, link_type="delivery_approval", link_id=arn,
                        approve_partner_sub=user["sub"],
                    )
                except Exception as _e:
                    logger.warning("[DELIVERY][APPROVAL] notify failed: %s", _e)
        return _json_response(200, {
            "success": True, "pending_approval": True, "arn": arn,
            "message": "Claim sent to the shop / importer for approval.",
        })

    # ── Complete-only stock model: public available_stock_kg is NOT touched
    # at claim time. Commit already happened when the delivery record was
    # created. Keep reserved_kg/committed_kg markers for cancel/complete.
    product_pk = rec.get("product_pk", "")
    purchased_qty = rec.get("committed_kg") or rec.get("reserved_kg") or rec.get("lot_size_kg", 0)
    try:
        table.update_item(
            Key={"pk": f"DELIVERY#ARN#{arn}"},
            UpdateExpression="SET reserved_kg = if_not_exists(reserved_kg, :q), committed_kg = if_not_exists(committed_kg, :q)",
            ExpressionAttributeValues={":q": Decimal(str(purchased_qty))},
        )
    except Exception as e:
        logger.error("[DELIVERY][CLAIM] could not store committed_kg for %s: %s", arn, e)
    # Legacy no-op (reserve_product_stock is intentionally a no-op now).
    if product_pk:
        reserve_product_stock(product_pk, purchased_qty, arn)

    create_notification(user["sub"], "shop_status", "Order claimed", f"You claimed delivery for {arn}. Tracking key: {tracking_key}")
    # ── Importer alert with the delivery partner's NAME + PHONE so the
    #    buyer can call them directly from the notification (the frontend
    #    renders a tel: Call button off `call_phone`). WhatsApp too —
    #    best-effort, never blocks the claim. ──
    importer_sub = rec.get("importer_sub", "")
    partner_name, partner_phone = "your delivery partner", ""
    try:
        partner_contact = _get_delivery_partner_contact(user["sub"]) if _get_delivery_partner_contact else {}
        partner_name = partner_contact.get("name") or partner_name
        partner_phone = partner_contact.get("phone", "")
    except Exception as e:
        logger.warning("[DELIVERY][CLAIM] partner contact lookup failed: %s", e)
    if importer_sub:
        contact_line = f" Delivery partner: {partner_name}" + (f" ({partner_phone})." if partner_phone else ".")
        create_notification(
            importer_sub, "shop_status", "Delivery partner assigned",
            f"A delivery partner has claimed your order {arn} and is on the way.{contact_line} "
            "You can track it live from the Track tab.",
            arn=arn,
            call_phone=partner_phone,
            call_name=partner_name,
        )
    buyer_mobile = rec.get("buyer_mobile", "")
    if buyer_mobile:
        try:
            from advanced_features import send_whatsapp_text
            send_whatsapp_text(
                buyer_mobile,
                f"✅ *Delivery partner assigned!*\n\nOrder ID: {arn}\n"
                f"Delivery partner: {partner_name}" + (f"\nContact: {partner_phone}" if partner_phone else "") +
                "\n\nYou'll get another message the moment the journey starts.",
            )
        except Exception as e:
            logger.warning("[DELIVERY][CLAIM] WhatsApp to buyer failed: %s", e)
    return _json_response(200, {
        "success": True,
        "tracking_key": tracking_key,
        "arn": arn,
        "buyer_name": rec.get("buyer_name", ""),
        "buyer_mobile": rec.get("buyer_mobile", ""),
    })


def handle_delivery_start(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    arn = normalize_arn(body.get("arn", ""))
    key = (body.get("tracking_key") or body.get("tracking_code") or "").strip()
    rec = _get_delivery_record(arn)
    if not rec or rec.get("claimed_by") != user["sub"]:
        return _json_response(403, {"error": "You have not claimed this order"})
    if key != rec.get("tracking_key", extract_tracking_key(arn)):
        return _json_response(400, {"error": "Invalid tracking key"})
    settings = get_platform_settings()
    otp = generate_otp()
    try:
        otp_hash = hash_otp(arn, otp)
    except RuntimeError as e:
        logger.error("[DELIVERY][START] denied — %s", e)
        return _json_response(500, {"error": "OTP system is not configured. Please contact support."})
    table.update_item(
        Key={"pk": f"DELIVERY#ARN#{arn}"},
        UpdateExpression="SET #s = :st, journey_started_at = :t, otp_hash = :oh, otp_plain_pending = :op, "
        "otp_expires_at = :ex, otp_attempts = :z, tracking_key_used = :tu",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={
            ":st": "IN_TRANSIT",
            ":t": _now(),
            ":oh": otp_hash,
            ":op": otp,
            ":ex": int(datetime.now(timezone.utc).timestamp()) + settings["otp_expiry_minutes"] * 60,
            ":z": 0,
            ":tu": True,
        },
    )
    try:
        table.update_item(
            Key={"pk": f"ORDER#{arn}"},
            UpdateExpression="SET current_status = :s, last_updated = :u",
            ExpressionAttributeValues={":s": "In Transit", ":u": _now()},
        )
    except Exception:
        pass

    # ── Journey-start alert to the buyer: order has left, with the
    #    delivery partner's name + phone so the buyer can call them
    #    directly (Zomato/Swiggy-style). WhatsApp + in-app, best-effort —
    #    never let a notification failure block the journey from starting. ──
    try:
        partner_contact = _get_delivery_partner_contact(user["sub"]) if _get_delivery_partner_contact else {}
        partner_name = partner_contact.get("name", "your delivery partner")
        partner_phone = partner_contact.get("phone", "")
        importer_sub = rec.get("importer_sub", "")
        contact_line = f"\nDelivery partner: {partner_name}" + (f" ({partner_phone})" if partner_phone else "")
        if importer_sub:
            # `track_arn` makes the frontend render a "Track live" button
            # that jumps straight to the Track tab with this ARN filled in;
            # `call_phone` renders a direct tel: Call button.
            create_notification(
                importer_sub, "shop_status", "Your order is on the way",
                f"Order {arn} has left for delivery.{contact_line} "
                "Live tracking is now ready.",
                arn=arn,
                track_arn=arn,
                call_phone=partner_phone,
                call_name=partner_name,
            )
        buyer_mobile = rec.get("buyer_mobile", "")
        if buyer_mobile:
            try:
                from advanced_features import send_whatsapp_text
                send_whatsapp_text(
                    buyer_mobile,
                    f"🚚 *Your order is on the way!*\n\nOrder ID: {arn}\nStarted: {to_ist_str()}\n"
                    f"Delivery partner: {partner_name}" + (f"\nContact: {partner_phone}" if partner_phone else "") +
                    "\n\nYou'll get another message when the delivery partner is nearby.",
                )
            except Exception as e:
                logger.warning("[DELIVERY][START] WhatsApp to buyer failed: %s", e)
    except Exception as e:
        logger.warning("[DELIVERY][START] buyer alert failed: %s", e)

    return _json_response(200, {"success": True, "status": "IN_TRANSIT"})


def handle_delivery_location(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    arn = normalize_arn(body.get("arn", ""))
    lat = float(body.get("lat") or body.get("latitude") or 0)
    lng = float(body.get("lng") or body.get("longitude") or 0)
    if not lat or not lng:
        return _json_response(400, {"error": "lat/lng required"})
    rec = _get_delivery_record(arn)
    if not rec or rec.get("claimed_by") != user["sub"]:
        return _json_response(403, {"error": "Not your delivery"})
    # Keep accepting GPS through NEAR_DESTINATION/ARRIVED too — otherwise the
    # driver's live dot froze the moment they got close (status flips to
    # NEAR_DESTINATION), so the importer's map stopped updating right when it
    # mattered most. OTP re-send below stays guarded by `not otp_sent`.
    if rec.get("status") not in ("IN_TRANSIT", "NEAR_DESTINATION", "ARRIVED"):
        return _json_response(400, {"error": "Delivery not in transit"})
    ts = _now()
    table.put_item(Item={
        "pk": f"TRACKING#ARN#{arn}",
        "sk": ts,
        "arn": arn,
        "lat": Decimal(str(lat)),
        "lng": Decimal(str(lng)),
        "recorded_at": ts,
        "ttl": _ttl(7),
    })
    table.update_item(
        Key={"pk": f"DELIVERY#ARN#{arn}"},
        UpdateExpression="SET last_lat = :la, last_lng = :ln, last_location_at = :t",
        ExpressionAttributeValues={":la": Decimal(str(lat)), ":ln": Decimal(str(lng)), ":t": ts},
    )
    dest_lat = float(rec.get("dest_lat") or 0)
    dest_lng = float(rec.get("dest_lng") or 0)
    settings = get_platform_settings()
    dist_m = None
    if not dest_lat and not dest_lng:
        # No destination coordinates on file (address wasn't geocoded) —
        # fall back to triggering OTP immediately so delivery isn't blocked.
        proximity_ok = not rec.get("otp_sent")
    else:
        dist_m = _haversine_m(lat, lng, dest_lat, dest_lng)
        proximity_ok = dist_m <= settings["gps_proximity_meters"] and not rec.get("otp_sent")

    # ── "Getting close" alert (~1km) — separate from the tighter OTP
    #    radius above, so the buyer gets a heads-up earlier, Zomato-style,
    #    without it affecting OTP delivery logic at all. Fires once per
    #    delivery via the close_alert_sent flag. ──
    if dist_m is not None and dist_m <= 1000 and not rec.get("close_alert_sent"):
        importer_sub = rec.get("importer_sub", "")
        if importer_sub:
            try:
                create_notification(
                    importer_sub,
                    "delivery_nearby",
                    "Delivery partner is nearby",
                    "Your delivery partner is about 1 km away and should arrive shortly.",
                    arn=arn,
                )
            except Exception as e:
                logger.warning("[DELIVERY][NEARBY] notification failed: %s", e)
        buyer_mobile = rec.get("buyer_mobile", "")
        if buyer_mobile:
            try:
                from advanced_features import send_whatsapp_text
                send_whatsapp_text(
                    buyer_mobile,
                    f"📍 Your delivery partner is about 1 km away for order {arn} — should arrive shortly.",
                )
            except Exception as e:
                logger.warning("[DELIVERY][NEARBY] WhatsApp failed: %s", e)
        table.update_item(
            Key={"pk": f"DELIVERY#ARN#{arn}"},
            UpdateExpression="SET close_alert_sent = :t",
            ExpressionAttributeValues={":t": True},
        )

    if proximity_ok:
        # Reuse the OTP minted at journey start if it's still around, else mint
        # a fresh one. We ALWAYS recompute + store the hash for the exact OTP
        # we're about to send, so the value the importer receives can never
        # drift from what we later verify against.
        otp = rec.get("otp_plain_pending") or generate_otp()
        try:
            otp_hash = hash_otp(arn, otp)
        except RuntimeError as e:
            logger.error("[DELIVERY][LOCATION] OTP generation denied — %s", e)
            return _json_response(500, {"error": "OTP system is not configured. Please contact support."})
        importer_sub = rec.get("importer_sub", "")
        notification_sent = False
        if importer_sub:
            try:
                _send_delivery_otp_notification(importer_sub, arn, otp)
                notification_sent = True
            except Exception as e:
                logger.error("[DELIVERY] OTP notification failed: %s", e)
        if notification_sent:
            # Anchor the OTP's validity window to the moment the importer
            # actually RECEIVES it — not to journey start. Anchoring at start
            # meant any delivery longer than otp_expiry_minutes handed the
            # importer an already-expired OTP, so the driver could never
            # complete the order. Reset attempts here too, since this is the
            # first time this OTP is live in the importer's hands.
            expires_at = int(datetime.now(timezone.utc).timestamp()) + settings["otp_expiry_minutes"] * 60
            table.update_item(
                Key={"pk": f"DELIVERY#ARN#{arn}"},
                UpdateExpression="SET otp_sent = :t, #s = :st, near_destination_at = :n, "
                "otp_hash = :oh, otp_plain_pending = :op, otp_expires_at = :ex, otp_attempts = :z",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={
                    ":t": True, ":st": "NEAR_DESTINATION", ":n": ts,
                    ":oh": otp_hash, ":op": otp, ":ex": expires_at, ":z": 0,
                },
            )
        else:
            logger.warning("[DELIVERY] OTP notification not sent — importer_sub missing or error")
    return _json_response(200, {"success": True})


def handle_delivery_picked_up(event: dict) -> dict:
    """Delivery partner confirms they've collected the goods from the shop.
    Records `picked_up_at` (drives the 'Picked up from shop' timeline step on
    the importer's Track view) and notifies the importer. Idempotent."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    arn = normalize_arn(body.get("arn", ""))
    rec = _get_delivery_record(arn)
    if not rec or rec.get("claimed_by") != user["sub"]:
        return _json_response(403, {"error": "Not your delivery"})
    if rec.get("picked_up_at"):
        return _json_response(200, {"success": True, "already": True, "picked_up_at": rec.get("picked_up_at")})
    ts = _now()
    table.update_item(
        Key={"pk": f"DELIVERY#ARN#{arn}"},
        UpdateExpression="SET picked_up_at = :t",
        ExpressionAttributeValues={":t": ts},
    )
    try:
        importer_sub = rec.get("importer_sub", "")
        if importer_sub:
            create_notification(
                importer_sub, "shop_status", "Order picked up",
                f"Your order {arn} has been picked up from the shop.",
                arn=arn, track_arn=arn,
            )
    except Exception as e:
        logger.warning("[DELIVERY][PICKED_UP] notify failed: %s", e)
    return _json_response(200, {"success": True, "picked_up_at": ts})


def handle_delivery_send_otp(event: dict) -> dict:
    """Driver-triggered OTP send to the importer.

    The automatic OTP dispatch only fires once the driver's GPS reaches the
    destination (`gps_proximity_meters`). On patchy GPS — or when the partner
    is at the door but the location ping hasn't landed — the importer never
    received an OTP, so the driver had nothing to type and the order could
    never be completed. This lets the partner push the OTP to the importer on
    demand: it mints/reuses the pending OTP, notifies the importer, and anchors
    the validity window to *now* so it is guaranteed live in the importer's
    hands. Reuses the exact same mint → hash → send → anchor logic as the
    proximity path so the value can never drift from what /complete verifies."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    arn = normalize_arn(body.get("arn", ""))
    rec = _get_delivery_record(arn)
    if not rec or rec.get("claimed_by") != user["sub"]:
        return _json_response(403, {"error": "Not your delivery"})
    if rec.get("status") == "COMPLETED":
        return _json_response(400, {"error": "This delivery is already completed."})
    importer_sub = rec.get("importer_sub", "")
    if not importer_sub:
        return _json_response(400, {"error": "No importer contact on this order — cannot send the OTP."})
    settings = get_platform_settings()
    otp = rec.get("otp_plain_pending") or generate_otp()
    try:
        otp_hash = hash_otp(arn, otp)
    except RuntimeError as e:
        logger.error("[DELIVERY][SEND_OTP] OTP generation denied — %s", e)
        return _json_response(500, {"error": "OTP system is not configured. Please contact support."})
    try:
        _send_delivery_otp_notification(importer_sub, arn, otp)
    except Exception as e:
        logger.error("[DELIVERY][SEND_OTP] notification failed: %s", e)
        return _json_response(502, {"error": "Could not send the OTP to the importer. Please try again."})
    expires_at = int(datetime.now(timezone.utc).timestamp()) + settings["otp_expiry_minutes"] * 60
    table.update_item(
        Key={"pk": f"DELIVERY#ARN#{arn}"},
        UpdateExpression="SET otp_sent = :t, otp_hash = :oh, otp_plain_pending = :op, "
        "otp_expires_at = :ex, otp_attempts = :z",
        ExpressionAttributeValues={
            ":t": True, ":oh": otp_hash, ":op": otp, ":ex": expires_at, ":z": 0,
        },
    )
    return _json_response(200, {
        "success": True,
        "expires_in_minutes": settings["otp_expiry_minutes"],
    })


def handle_delivery_complete(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    arn = normalize_arn(body.get("arn", ""))
    otp = (body.get("otp") or "").strip()
    rec = _get_delivery_record(arn)
    if not rec or rec.get("claimed_by") != user["sub"]:
        return _json_response(403, {"error": "Not your delivery"})
    settings = get_platform_settings()
    if int(rec.get("otp_expires_at") or 0) < int(datetime.now(timezone.utc).timestamp()):
        return _json_response(400, {"error": "OTP expired. Contact admin."})
    attempts = int(rec.get("otp_attempts") or 0)
    if attempts >= settings["max_otp_attempts"]:
        table.update_item(
            Key={"pk": f"DELIVERY#ARN#{arn}"},
            UpdateExpression="SET #s = :st, frozen_for_review = :t",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":st": "ADMIN_REVIEW", ":t": True},
        )
        return _json_response(403, {"error": "Too many failed attempts. Order sent to admin review."})
    if not verify_otp(arn, otp, rec.get("otp_hash", "")):
        table.update_item(
            Key={"pk": f"DELIVERY#ARN#{arn}"},
            UpdateExpression="SET otp_attempts = :a",
            ExpressionAttributeValues={":a": attempts + 1},
        )
        return _json_response(400, {"error": f"Invalid OTP. {settings['max_otp_attempts'] - attempts - 1} attempts left."})
    table.update_item(
        Key={"pk": f"DELIVERY#ARN#{arn}"},
        UpdateExpression="SET #s = :st, completed_at = :t REMOVE otp_plain_pending",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":st": "COMPLETED", ":t": _now()},
    )
    # Optional proof-of-delivery photo (base64 from the partner's camera) —
    # uploaded to S3 and stored on the record so the importer can see it on
    # their Track view. Best-effort: never block completion on an upload error.
    _pod_b64 = body.get("pod_photo") or ""
    if _pod_b64:
        try:
            from marketplace import _upload_b64_to_s3
            _pod_url = _upload_b64_to_s3(_pod_b64, "delivery-pod", arn)
            if _pod_url:
                table.update_item(
                    Key={"pk": f"DELIVERY#ARN#{arn}"},
                    UpdateExpression="SET pod_photo_url = :u",
                    ExpressionAttributeValues={":u": _pod_url},
                )
        except Exception as e:
            logger.warning("[DELIVERY][POD] upload failed: %s", e)
    # ── Delivery-partner record (Batch 6): count completions + on-time. On-time
    #    = handed over within 48h of claiming (generous, no strict SLA yet). ──
    partner_sub = rec.get("claimed_by", "")
    on_time = True
    try:
        # NOTE: do NOT re-import datetime/timezone here. A local import anywhere
        # in this function makes `datetime` a function-local name for the ENTIRE
        # function, so the otp_expires_at check near the top (which runs first)
        # blew up with UnboundLocalError — meaning /delivery/complete ALWAYS
        # 500'd and no OTP could ever complete an order. They're already
        # imported at module scope.
        claimed = rec.get("claimed_at", "")
        if claimed:
            c = datetime.fromisoformat(str(claimed).replace("Z", "+00:00"))
            if c.tzinfo is None:
                c = c.replace(tzinfo=timezone.utc)
            on_time = (datetime.now(timezone.utc) - c).total_seconds() / 3600.0 <= 48
    except Exception:
        on_time = True
    if partner_sub:
        try:
            table.update_item(
                Key={"pk": f"KYC#USER#{partner_sub}"},
                UpdateExpression="ADD delivery_completed_count :one" + (", delivery_on_time_count :one" if on_time else ""),
                ExpressionAttributeValues={":one": 1},
            )
        except Exception as e:
            logger.warning("[DELIVERY] partner record counter failed: %s", e)
        try:
            table.update_item(
                Key={"pk": f"DELIVERY#ARN#{arn}"},
                UpdateExpression="SET on_time = :ot",
                ExpressionAttributeValues={":ot": on_time},
            )
        except Exception:
            pass
    # Shop "products sold" counter (Batch 6) — one per completed seller order.
    seller_sub = rec.get("seller_sub", "")
    if seller_sub and get_shop_by_user:
        try:
            _shop = get_shop_by_user(seller_sub)
            if _shop and _shop.get("shop_id"):
                table.update_item(
                    Key={"pk": f"SHOP#{_shop['shop_id']}"},
                    UpdateExpression="ADD products_sold :one",
                    ExpressionAttributeValues={":one": 1},
                )
        except Exception as e:
            logger.warning("[DELIVERY] shop products_sold update failed: %s", e)
    try:
        table.update_item(
            Key={"pk": f"ORDER#{arn}"},
            UpdateExpression="SET current_status = :s, last_updated = :u",
            ExpressionAttributeValues={":s": "Delivered", ":u": _now()},
        )
    except Exception:
        pass
    importer_sub = rec.get("importer_sub", "")
    if importer_sub:
        create_notification(
            importer_sub,
            "shop_status",
            "Order delivered successfully",
            f"Order {arn} has been delivered. Thank you for choosing Aarvex Global!",
            arn=arn,
        )

    # ── WhatsApp closing messages: buyer gets a delivered confirmation,
    #    delivery partner gets a short earning-added confirmation.
    #    Best-effort — must never block the already-completed delivery. ──
    try:
        buyer_mobile = rec.get("buyer_mobile", "")
        if buyer_mobile:
            from advanced_features import send_whatsapp_text
            send_whatsapp_text(
                buyer_mobile,
                f"✅ *Delivered!*\n\nOrder {arn} has been delivered successfully at {to_ist_str()}.\n"
                f"Thank you for choosing Aarvex Global! 🙏",
            )
    except Exception as e:
        logger.warning("[DELIVERY][COMPLETE] WhatsApp to buyer failed: %s", e)
    try:
        partner_contact = _get_delivery_partner_contact(user["sub"]) if _get_delivery_partner_contact else {}
        partner_phone = partner_contact.get("phone", "")
        if partner_phone:
            from advanced_features import send_whatsapp_text
            send_whatsapp_text(
                partner_phone,
                f"✅ Delivery for {arn} marked complete at {to_ist_str()}.\n"
                f"Earning of ₹{rec.get('delivery_charge', 0)} has been added to your account.",
            )
    except Exception as e:
        logger.warning("[DELIVERY][COMPLETE] WhatsApp to partner failed: %s", e)

    # ── Good-behaviour signal: a successful completion resets this
    #    partner's consecutive-rejection counter (see handle_delivery_reject). ──
    try:
        table.update_item(
            Key={"pk": f"KYC#USER#{user['sub']}"},
            UpdateExpression="SET delivery_reject_count = :z",
            ExpressionAttributeValues={":z": 0},
        )
    except Exception:
        pass

    # ── Finalize stock on COMPLETE only: decrement public available_stock_kg
    # by the committed qty and soft-archive if empty.
    try:
        qty = rec.get("committed_kg") or rec.get("reserved_kg") or rec.get("lot_size_kg") or 0
        finalize_product_reservation(rec.get("product_pk", ""), arn, purchased_kg=qty)
    except Exception as e:
        logger.error("[DELIVERY][COMPLETE] stock finalize failed for %s: %s", arn, e)

    # ── Payout ledger: now that delivery is confirmed (OTP verified,
    #    cash collected if COD), record what's owed to seller + this
    #    delivery partner. Idempotent — safe even if called twice. ──
    try:
        create_payout_entries(
            arn=arn,
            seller_sub=rec.get("seller_sub", ""),
            delivery_partner_sub=rec.get("claimed_by", ""),
            lot_price=rec.get("lot_price", 0),
            delivery_charge=rec.get("delivery_charge", 0),
            platform_fee=rec.get("platform_fee", 0),
            gst_amount=rec.get("gst_amount", 0),
            is_seller_product=bool(rec.get("is_seller_product", False)),
            payment_method="cod" if rec.get("is_cod") else "online",
        )
    except Exception as e:
        logger.error("[DELIVERY][PAYOUT] Could not create payout entries for %s: %s", arn, e)

    # ── FINAL invoice at handover (not gateway-driven). Generated now — the
    #    moment the goods are actually delivered (OTP verified) — for EVERY
    #    order, COD or online. This deliberately does NOT wait on the Razorpay
    #    webhook: the buyer's definitive invoice is tied to the physical
    #    handover, from our own system, and works even if the payment webhook
    #    is delayed or never fires. generate_cod_invoice() now handles both
    #    payment methods and falls back to a printable HTML invoice when the
    #    reportlab PDF library isn't installed. ──
    invoice_url = ""
    try:
        from cod_invoice import generate_cod_invoice
        invoice_url = generate_cod_invoice(rec) or ""
        # Persist so the buyer can re-download from their order card anytime
        # (B2B buyers need the GST invoice at filing time).
        if invoice_url:
            for pk in (f"DELIVERY#ARN#{arn}", f"ORDER#{arn}"):
                try:
                    table.update_item(
                        Key={"pk": pk},
                        UpdateExpression="SET invoice_url = :u, invoice_generated_at = :t",
                        ExpressionAttributeValues={":u": invoice_url, ":t": _now()},
                    )
                except Exception:
                    pass  # ORDER# row may not exist for every flow
    except Exception as e:
        logger.error("[DELIVERY][INVOICE] generation failed for %s: %s", arn, e)

    return _json_response(200, {"success": True, "status": "COMPLETED", "invoice_url": invoice_url})


def handle_delivery_rate(event: dict) -> dict:
    """Buyer rates the delivery partner after a completed delivery (Phase 1).

    Shops and products were rateable but delivery partners were not, so there
    was no quality signal on the people actually handling the goods. One
    rating per ARN, only by that order's buyer, only once delivered. The
    running average is kept on the partner's KYC record so it can be shown
    without re-scanning every rating.
    """
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    arn = str(body.get("arn") or "").strip()
    comment = str(body.get("comment") or "").strip()[:300]
    try:
        rating = int(body.get("rating", 0))
    except (TypeError, ValueError):
        rating = 0
    if not arn or rating < 1 or rating > 5:
        return _json_response(400, {"error": "arn and a rating from 1 to 5 are required"})

    rec = table.get_item(Key={"pk": f"DELIVERY#ARN#{arn}"}).get("Item") or {}
    if not rec:
        return _json_response(404, {"error": "Delivery not found"})
    if rec.get("importer_sub") != user["sub"]:
        return _json_response(403, {"error": "Only the buyer of this order can rate the delivery"})
    if rec.get("status") != "COMPLETED":
        return _json_response(400, {"error": "You can rate the delivery once it is completed"})
    partner_sub = rec.get("claimed_by", "")
    if not partner_sub:
        return _json_response(400, {"error": "No delivery partner on this order"})

    rating_pk = f"DELIVERYRATING#{partner_sub}#{arn}"
    previous = table.get_item(Key={"pk": rating_pk}).get("Item") or {}
    table.put_item(Item={
        "pk": rating_pk,
        "partner_sub": partner_sub,
        "arn": arn,
        "rater_sub": user["sub"],
        "rating": rating,
        "comment": comment,
        "created_at": _now(),
        "ttl": _ttl(730),
    })

    # Maintain the running average incrementally rather than rescanning.
    kyc_key = {"pk": f"KYC#USER#{partner_sub}"}
    kyc = table.get_item(Key=kyc_key).get("Item") or {}
    total = int(_decimal(kyc.get("delivery_rating_count", 0)))
    summed = float(_decimal(kyc.get("delivery_rating_sum", 0)))
    if previous:
        summed -= float(_decimal(previous.get("rating", 0)))   # re-rating replaces
    else:
        total += 1
    summed += rating
    avg = round(summed / total, 2) if total else 0.0
    try:
        table.update_item(
            Key=kyc_key,
            UpdateExpression=(
                "SET delivery_rating_count = :c, delivery_rating_sum = :s, delivery_avg_rating = :a"
            ),
            ExpressionAttributeValues={":c": total, ":s": _decimal(summed), ":a": _decimal(avg)},
        )
    except Exception as e:
        logger.error("[DELIVERY][RATE] Could not update partner average for %s: %s", partner_sub, e)

    if not previous:
        create_notification(
            partner_sub, "delivery_rating", "You received a delivery rating",
            f"A buyer rated your delivery {rating}/5 for order {arn}.",
        )
    return _json_response(200, {"success": True, "rating": rating, "avg_rating": avg, "total_ratings": total})


def handle_delivery_rating(event: dict) -> dict:
    """Rating summary for a delivery partner (defaults to the caller)."""
    user, err = _require_auth(event)
    if err:
        return err
    params = event.get("queryStringParameters") or {}
    partner_sub = str(params.get("partner_sub") or user["sub"])
    kyc = table.get_item(Key={"pk": f"KYC#USER#{partner_sub}"}).get("Item") or {}
    recent = []
    for it in _scan_prefix(f"DELIVERYRATING#{partner_sub}#"):
        recent.append({
            "arn": it.get("arn", ""),
            "rating": int(_decimal(it.get("rating", 0))),
            "comment": it.get("comment", ""),
            "created_at": it.get("created_at", ""),
        })
    recent.sort(key=lambda r: r.get("created_at", ""), reverse=True)
    return _json_response(200, {
        "partner_sub": partner_sub,
        "avg_rating": _json_num(kyc.get("delivery_avg_rating", 0)),
        "total_ratings": int(_decimal(kyc.get("delivery_rating_count", 0))),
        "recent": recent[:20],
    })


def handle_delivery_earnings(event: dict) -> dict:
    user, err = _require_auth(event)
    if err:
        return err
    completed, pending, total = 0, 0, Decimal("0")
    for item in _scan_prefix("DELIVERY#ARN#"):
        if item.get("claimed_by") != user["sub"]:
            continue
        earn = _decimal(item.get("delivery_charge", 0))
        if item.get("status") == "COMPLETED":
            completed += 1
            total += earn
        elif item.get("status") in ("IN_TRANSIT", "NEAR_DESTINATION", "DELIVERY_ASSIGNED"):
            pending += 1
    return _json_response(200, {
        "completed_deliveries": completed,
        "pending_deliveries": pending,
        "total_earned_inr": float(total),
    })


def handle_delivery_active(event: dict) -> dict:
    """Restore-on-refresh: returns this partner's currently in-progress
    delivery (if any), so the frontend can rebuild the active-delivery UI
    (map, GPS push, OTP-complete panel) without requiring a re-claim.
    Stays populated until the order reaches COMPLETED, no matter how many
    times the page is refreshed."""
    user, err = _require_auth(event)
    if err:
        return err
    for item in _scan_prefix("DELIVERY#ARN#"):
        if item.get("claimed_by") != user["sub"]:
            continue
        if item.get("status") in ("DELIVERY_ASSIGNED", "IN_TRANSIT", "NEAR_DESTINATION"):
            return _json_response(200, {
                "active": True,
                "arn": item.get("arn", ""),
                "tracking_key": item.get("tracking_key", ""),
                "status": item.get("status", ""),
                "product_name": item.get("product_name", ""),
                "buyer_name": item.get("buyer_name", ""),
                "buyer_mobile": item.get("buyer_mobile", ""),
                "pickup_city": item.get("pickup_city", ""),
                "delivery_city": item.get("delivery_city", ""),
                # Partner's payout — restores the ₹ chip after a page refresh
                # even before the first live /track poll lands.
                "estimated_earning": round(float(item.get("delivery_charge", 0) or 0), 2),
            })
    return _json_response(200, {"active": False})


def handle_delivery_my_claims(event: dict) -> dict:
    """Powers the delivery-partner's "My pending claims" button: lists
    every claim this partner currently has open (normally 0 or 1, now that
    handle_delivery_claim enforces one-at-a-time — but this stays a list
    so any pre-existing multi-claim data is visible and closeable too,
    instead of silently hiding all but one)."""
    user, err = _require_auth(event)
    if err:
        return err
    claims = _get_active_claims_for(user["sub"])
    return _json_response(200, {
        "claims": [
            {
                "arn": c.get("arn", ""),
                "product_name": c.get("product_name", ""),
                "buyer_name": c.get("buyer_name", ""),
                "status": c.get("status", ""),
                "claimed_at": c.get("claimed_at", ""),
                "pickup_city": c.get("pickup_city", ""),
                "delivery_city": c.get("delivery_city", ""),
            }
            for c in claims
        ],
    })


def handle_delivery_cancel(event: dict) -> dict:
    """The missing counterpart to handle_order_cancel (marketplace.py) —
    that one lets the BUYER cancel before delivery starts; this lets the
    DELIVERY PARTNER close a claim they can't fulfil, at any point before
    completion. Same downstream effect either way: the claim-time stock
    reservation is reversed so the product goes back to the seller's live
    public catalogue at its original value, and the order is marked
    CANCELLED (not silently dropped) so the buyer isn't left thinking a
    delivery is still coming.

    This is also what unblocks the partner from claiming a new order —
    handle_delivery_claim refuses while any claim of theirs is still open.
    """
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    arn = normalize_arn(body.get("arn", ""))
    if not arn_valid(arn):
        return _json_response(400, {"error": "Invalid ARN"})
    reason = str(body.get("reason", "") or "").strip()[:300]

    rec = _get_delivery_record(arn)
    if not rec:
        return _json_response(404, {"error": "Delivery record not found"})
    # ── Any of the three parties on this order may cancel it: the delivery
    #    partner (their claim), the importer (their order), or the shop
    #    keeper (their product). Anyone else is rejected. Only a delivery-
    #    partner cancel counts as a reliability strike below. ──
    is_partner = rec.get("claimed_by") == user["sub"]
    is_importer = rec.get("importer_sub") == user["sub"]
    is_seller = bool(rec.get("seller_sub")) and rec.get("seller_sub") == user["sub"]
    if not (is_partner or is_importer or is_seller):
        return _json_response(403, {"error": "You are not a party to this order"})
    canceller_role = "delivery_partner" if is_partner else ("importer" if is_importer else "shop_keeper")

    status = rec.get("status", "")
    if status not in _OPEN_CLAIM_STATUSES:
        return _json_response(409, {"error": "This claim is already " + (status or "closed") + " — nothing to cancel"})

    # ── Release stock commit on cancel (available unchanged until complete).
    product_pk = rec.get("product_pk", "")
    reserved_kg = rec.get("committed_kg") or rec.get("reserved_kg") or rec.get("lot_size_kg", 0)
    try:
        reverse_product_reservation(product_pk, reserved_kg, arn)
    except Exception as e:
        logger.error("[DELIVERY][CANCEL_CLAIM] stock release failed for %s: %s", arn, e, exc_info=True)

    try:
        table.update_item(
            Key={"pk": f"DELIVERY#ARN#{arn}"},
            UpdateExpression="SET #s = :s, cancelled_at = :t, cancelled_by = :who, cancel_reason = :r",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":s": "CANCELLED", ":t": _now(), ":who": canceller_role, ":r": reason,
            },
        )
    except Exception as e:
        logger.error("[DELIVERY][CANCEL_CLAIM] delivery record update failed for %s: %s", arn, e)
    try:
        table.update_item(
            Key={"pk": f"ORDER#{arn}"},
            UpdateExpression="SET current_status = :s, last_updated = :u",
            ExpressionAttributeValues={":s": "Cancelled", ":u": _now()},
        )
    except Exception as e:
        logger.warning("[DELIVERY][CANCEL_CLAIM] order record update failed for %s: %s", arn, e)

    role_label = {"delivery_partner": "the delivery partner", "importer": "the buyer", "shop_keeper": "the shop keeper"}[canceller_role]
    product_label = rec.get("product_name", "your product")
    importer_sub = rec.get("importer_sub", "")
    if importer_sub and not is_importer:
        create_notification(
            importer_sub, "shop_status", f"Order cancelled by {role_label}",
            f"Your order {arn} for {product_label} was cancelled by {role_label} before it reached you. "
            "The item is back in the seller's catalogue if you'd like to reorder — you have not been charged for this delivery.",
        )
    seller_sub = rec.get("seller_sub", "")
    if seller_sub and not is_seller:
        create_notification(
            seller_sub, "shop_status", "Order cancelled — product relisted",
            f"Order {arn} for {product_label} was cancelled by {role_label}. Your product is back in your live catalogue.",
        )
    partner_sub = rec.get("claimed_by", "")
    if partner_sub and not is_partner:
        create_notification(
            partner_sub, "shop_status", "Delivery cancelled",
            f"Order {arn} for {product_label} was cancelled by {role_label}. You can stop the journey — this does not count against you.",
        )

    # ── Fraud/reliability tracking — ONLY when the delivery partner
    # themself cancels a claim they committed to. An importer/shop-keeper
    # cancel is their own decision and never strikes the partner. ──
    cancel_count = 0
    suspended = False
    if is_partner:
        kyc = get_kyc(user["sub"])
        cancel_count = int(kyc.get("delivery_claim_cancel_count", 0) or 0) + 1
        try:
            table.update_item(
                Key={"pk": f"KYC#USER#{user['sub']}"},
                UpdateExpression="SET delivery_claim_cancel_count = :c",
                ExpressionAttributeValues={":c": cancel_count},
            )
            settings = get_platform_settings()
            threshold = settings.get("delivery_claim_cancel_suspend_threshold", 4)
            if cancel_count >= threshold and _suspend_delivery_partner:
                _suspend_delivery_partner(user["sub"], f"Cancelled {cancel_count} claimed deliveries after commitment")
                suspended = True
        except Exception as e:
            logger.error("[DELIVERY][CANCEL_CLAIM] cancel-count tracking failed for %s: %s", user["sub"], e)

    return _json_response(200, {"success": True, "arn": arn, "cancelled_by": canceller_role, "strike_count": cancel_count, "suspended": suspended})


def handle_delivery_reject(event: dict) -> dict:
    """A delivery partner explicitly declines an available order. Tracks a
    consecutive-rejection counter per partner; after
    `delivery_reject_suspend_threshold` in a row (default 12), the
    partner's delivery access is auto-suspended as a fraud-prevention
    measure — this does not affect their shop account if they have one."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    arn = normalize_arn(body.get("arn", ""))
    kyc = get_kyc(user["sub"])
    count = int(kyc.get("delivery_reject_count", 0) or 0) + 1
    table.update_item(
        Key={"pk": f"KYC#USER#{user['sub']}"},
        UpdateExpression="SET delivery_reject_count = :c",
        ExpressionAttributeValues={":c": count},
    )
    settings = get_platform_settings()
    threshold = settings.get("delivery_reject_suspend_threshold", 12)
    suspended = False
    if count >= threshold and _suspend_delivery_partner:
        _suspend_delivery_partner(user["sub"], f"Rejected {count} consecutive delivery orders")
        suspended = True
    return _json_response(200, {"success": True, "reject_count": count, "suspended": suspended})


def handle_delivery_review_submit(event: dict) -> dict:
    """Buyer rates the delivery partner after a completed delivery
    (separate from product reviews). Aggregates onto the partner's KYC
    record so an average rating can be shown / used for future priority
    allocation."""
    user, err = _require_auth(event)
    if err:
        return err
    body = _event_body(event)
    arn = normalize_arn(body.get("arn", ""))
    rating = int(body.get("rating", 0) or 0)
    comment = (body.get("comment") or "").strip()[:500]
    if rating < 1 or rating > 5:
        return _json_response(400, {"error": "Rating must be 1-5"})
    rec = _get_delivery_record(arn)
    if not rec or rec.get("importer_sub") != user["sub"]:
        return _json_response(403, {"error": "You can only review your own completed orders"})
    if rec.get("status") != "COMPLETED":
        return _json_response(400, {"error": "Order not yet delivered"})
    partner_sub = rec.get("claimed_by", "")
    if not partner_sub:
        return _json_response(400, {"error": "No delivery partner on this order"})
    review_pk = f"DELIVERY_REVIEW#{arn}"
    existing = table.get_item(Key={"pk": review_pk}).get("Item")
    if existing:
        return _json_response(409, {"error": "You already reviewed this delivery"})
    table.put_item(Item={
        "pk": review_pk,
        "arn": arn,
        "delivery_partner_sub": partner_sub,
        "buyer_sub": user["sub"],
        "rating": rating,
        "comment": comment,
        "created_at": _now(),
        "ttl": _ttl(730),
    })
    try:
        table.update_item(
            Key={"pk": f"KYC#USER#{partner_sub}"},
            UpdateExpression="ADD delivery_rating_sum :r, delivery_rating_count :n",
            ExpressionAttributeValues={":r": rating, ":n": 1},
        )
    except Exception as e:
        logger.warning("[DELIVERY][REVIEW] rating aggregate failed: %s", e)
    return _json_response(200, {"success": True})


def _preferred_subs_for_seller(seller_sub: str) -> list:
    """Batch 6 — a shop's OWN delivery team gets first dibs on its orders.
    Preferred = the delivery partners the shop added (own_delivery_subs) plus
    the seller themselves if they're an approved delivery partner."""
    if not seller_sub:
        return []
    subs = []
    try:
        shop = get_shop_by_user(seller_sub) if get_shop_by_user else {}
        subs = list((shop or {}).get("own_delivery_subs", []) or [])
    except Exception:
        subs = []
    try:
        k = get_kyc(seller_sub) if get_kyc else {}
        if k.get("status") == "approved" and k.get("kyc_role") in ("delivery_partner", "both") and seller_sub not in subs:
            subs.append(seller_sub)
    except Exception:
        pass
    return [s for s in subs if s]


def create_delivery_record(**kwargs) -> None:
    import time as _time
    arn = normalize_arn(kwargs.get("arn", ""))
    tracking_key = extract_tracking_key(arn)
    _preferred = _preferred_subs_for_seller(kwargs.get("seller_sub", ""))
    _pk = kwargs.get("product_pk", "")
    _qty = _decimal(kwargs.get("lot_size_kg", 0))
    # Commit BEFORE writing the delivery row so we never leave an ARN
    # booked without a matching committed_kg on the product.
    if _pk and _qty > 0:
        commit_result = commit_product_stock(_pk, _qty, arn)
        if not commit_result.get("success"):
            logger.error(
                "[DELIVERY][CREATE] stock commit failed for %s (pk=%s qty=%s): %s",
                arn, _pk, _qty, commit_result.get("error"),
            )
            raise RuntimeError(commit_result.get("error") or "insufficient_stock")
    table.put_item(Item={
        "pk": f"DELIVERY#ARN#{arn}",
        "arn": arn,
        "tracking_key": tracking_key,
        # Shop's own-delivery-team priority window (30 min). Empty list = no
        # priority, so the general first-come pool works exactly as before.
        "preferred_subs": _preferred,
        "preferred_until_ts": (int(_time.time()) + 30 * 60) if _preferred else 0,
        "product_name": kwargs.get("product_name", ""),
        "product_pk": kwargs.get("product_pk", ""),
        "importer_sub": kwargs.get("importer_sub", ""),
        "pickup_city": kwargs.get("pickup_city", ""),
        # Full street-level address TEXT for each end of the trip, shown on the
        # Delivery / Track / Shop strips. dest_address = the importer's ORDER
        # address (their location-picker choice, never their profile address);
        # pickup_address = the shopkeeper/seller's permanent address.
        "dest_address": kwargs.get("dest_address", ""),
        "pickup_address": kwargs.get("pickup_address", ""),
        "delivery_city": kwargs.get("delivery_city", ""),
        "delivery_pincode": kwargs.get("delivery_pincode", ""),
        "lot_size_kg": _qty,
        "committed_kg": _qty,
        "reserved_kg": _qty,
        "distance_km": _decimal(kwargs.get("distance_km", 0)),
        "delivery_charge": _decimal(kwargs.get("delivery_charge", 0)),
        "pickup_lat": _decimal(kwargs.get("pickup_lat", 0)),
        "pickup_lng": _decimal(kwargs.get("pickup_lng", 0)),
        "dest_lat": _decimal(kwargs.get("dest_lat", 0)),
        "dest_lng": _decimal(kwargs.get("dest_lng", 0)),
        "is_cod": bool(kwargs.get("is_cod", False)),
        "cod_amount": _decimal(kwargs.get("cod_amount", 0)),
        # ── payout / invoice fields (needed at delivery-complete time,
        #    stored here so we don't need a cross-module ticket lookup) ──
        "seller_sub": kwargs.get("seller_sub", ""),
        "is_seller_product": bool(kwargs.get("is_seller_product", False)),
        "lot_price": _decimal(kwargs.get("lot_price", 0)),
        "platform_fee": _decimal(kwargs.get("platform_fee", 0)),
        "gst_amount": _decimal(kwargs.get("gst_amount", 0)),
        "buyer_name": kwargs.get("buyer_name", ""),
        "buyer_email": kwargs.get("buyer_email", ""),
        "buyer_mobile": kwargs.get("buyer_mobile", ""),
        "buyer_gst_number": kwargs.get("buyer_gst_number", ""),
        "product_id": kwargs.get("product_id", ""),
        "status": "PENDING_DELIVERY",
        "created_at": _now(),
        "ttl": _ttl(730),
    })
    # D4: count orders placed by this importer (for their trust record).
    _imp = kwargs.get("importer_sub", "")
    if _imp:
        try:
            table.update_item(
                Key={"pk": f"PROFILE#USER#{_imp}"},
                UpdateExpression="ADD importer_order_count :one",
                ExpressionAttributeValues={":one": 1},
            )
        except Exception:
            pass
    _broadcast_new_delivery_order(arn, kwargs)


def _broadcast_new_delivery_order(arn: str, kwargs: dict) -> None:
    """Notify every approved, non-suspended delivery partner that a new
    order is available to claim — in-app + WhatsApp, first-accept-wins.
    Best-effort: a broadcast failure must never block order placement."""
    if not _list_approved_delivery_partners:
        logger.warning("[DELIVERY][BROADCAST] partner pool helper not bound — skipping")
        return
    try:
        partners = _list_approved_delivery_partners()
    except Exception as e:
        logger.error("[DELIVERY][BROADCAST] could not list partners: %s", e)
        return
    if not partners:
        return
    pickup = kwargs.get("pickup_city", "")
    dest = kwargs.get("delivery_city", "")
    distance = kwargs.get("distance_km", 0)
    earning = kwargs.get("delivery_charge", 0)
    product = kwargs.get("product_name", "")
    body = (
        f"📦 New delivery available!\n\n{product}\n{pickup} → {dest} (~{distance} km)\n"
        f"Estimated earning: ₹{earning}\n\nOpen the Aarvex app → Delivery tab to claim it. First to claim gets it."
    )
    for p in partners:
        try:
            if create_notification:
                create_notification(
                    p["user_sub"], "shop_status", "New delivery order available", body, arn=arn,
                    # Structured fields (Phase 2, Section 0 #4): "body" above (with
                    # its 📦 emoji) is kept for WhatsApp — send_whatsapp_text() below
                    # still uses it as plain chat text, which is normal there. The
                    # in-app notification card must NOT show that raw dump next to
                    # an icon-based UI, so it reads these fields instead.
                    delivery_product_name=product,
                    delivery_pickup_city=pickup,
                    delivery_dest_city=dest,
                    delivery_distance_km=distance,
                    delivery_earning=earning,
                )
        except Exception as e:
            logger.warning("[DELIVERY][BROADCAST] in-app notify failed for %s: %s", p.get("user_sub"), e)
        try:
            if p.get("phone"):
                from advanced_features import send_whatsapp_text
                send_whatsapp_text(p["phone"], body)
        except Exception as e:
            logger.warning("[DELIVERY][BROADCAST] WhatsApp failed for %s: %s", p.get("user_sub"), e)


def handle_track_enriched(event: dict) -> dict:
    params = event.get("queryStringParameters") or {}
    arn = normalize_arn(params.get("arn") or "")
    if not arn_valid(arn):
        return _json_response(400, {"error": "Invalid Order ID. Example: ARN-2026-847291"})
    order = table.get_item(Key={"pk": f"ORDER#{arn}"}).get("Item") or {}
    delivery = _get_delivery_record(arn)
    if not order and not delivery:
        return _json_response(404, {"error": "Order not found"})
    tracking_points = []
    try:
        resp = table.query(
            KeyConditionExpression="pk = :pk",
            ExpressionAttributeValues={":pk": f"TRACKING#ARN#{arn}"},
            ScanIndexForward=False,
            Limit=20,
        )
        tracking_points = [
            {"lat": float(i.get("lat", 0)), "lng": float(i.get("lng", 0)), "at": i.get("recorded_at", "")}
            for i in resp.get("Items", [])
        ]
    except Exception:
        pass
    status = delivery.get("status") or order.get("current_status", "PENDING_DELIVERY")
    # Timeline now carries the real timestamp for each stage it happened at
    # (frontend renders a vertical stepper with times). Payment Confirmed has
    # no dedicated timestamp, so it reuses the placed time (prepaid) / stays
    # blank until other data exists.
    _placed_at = delivery.get("created_at") or order.get("created_at", "")
    _picked_at = delivery.get("picked_up_at", "")
    timeline = [
        {"step": "Order Placed", "done": True, "at": _placed_at},
        {"step": "Payment Confirmed", "done": status not in ("PENDING_DELIVERY",), "at": _placed_at},
        {"step": "Delivery Assigned", "done": status in ("DELIVERY_ASSIGNED", "IN_TRANSIT", "NEAR_DESTINATION", "COMPLETED"), "at": delivery.get("claimed_at", "")},
        {"step": "Picked up from shop", "done": bool(_picked_at) or status in ("IN_TRANSIT", "NEAR_DESTINATION", "COMPLETED"), "at": _picked_at},
        {"step": "In Transit", "done": status in ("IN_TRANSIT", "NEAR_DESTINATION", "COMPLETED"), "at": delivery.get("journey_started_at", "")},
        {"step": "Delivered", "done": status == "COMPLETED", "at": delivery.get("completed_at", "")},
    ]

    # Amount / payment summary for the importer's Track view. COD → amount is
    # due on delivery; prepaid → already paid. Falls back to the line-item sum
    # when cod_amount wasn't stored.
    _f = lambda k: float(delivery.get(k, 0) or 0)
    is_cod = bool(delivery.get("is_cod", False))
    cod_amount = _f("cod_amount")
    line_total = round(_f("lot_price") + _f("gst_amount") + _f("delivery_charge") + _f("platform_fee"), 2)
    order_total = round(cod_amount if (is_cod and cod_amount) else line_total, 2)
    payment = {
        "is_cod": is_cod,
        "status": "COD" if is_cod else "PAID",
        "amount": order_total,
        "amount_due": round(cod_amount, 2) if is_cod else 0,
        "breakdown": {
            "item": _f("lot_price"),
            "gst": _f("gst_amount"),
            "delivery": _f("delivery_charge"),
            "platform": _f("platform_fee"),
        },
    }

    driver_lat = float(delivery.get("last_lat") or 0)
    driver_lng = float(delivery.get("last_lng") or 0)
    dest_lat = float(delivery.get("dest_lat") or 0)
    dest_lng = float(delivery.get("dest_lng") or 0)

    distance_remaining_km = None
    eta_minutes = None
    if driver_lat and driver_lng and dest_lat and dest_lng:
        distance_remaining_km = round(_haversine_m(driver_lat, driver_lng, dest_lat, dest_lng) / 1000.0, 2)
        eta_minutes = estimate_eta_minutes(distance_remaining_km)

    updated_seconds_ago = None
    last_loc_at = delivery.get("last_location_at", "")
    if last_loc_at:
        try:
            dt = datetime.fromisoformat(last_loc_at.replace("Z", "+00:00"))
            updated_seconds_ago = max(0, int((datetime.now(timezone.utc) - dt).total_seconds()))
        except Exception:
            updated_seconds_ago = None

    delivery_partner = None
    claimed_by = delivery.get("claimed_by", "")
    if claimed_by and _get_delivery_partner_contact:
        try:
            delivery_partner = _get_delivery_partner_contact(claimed_by)
        except Exception as e:
            logger.warning("[TRACK] could not load delivery partner contact: %s", e)

    pickup_lat = float(delivery.get("pickup_lat") or 0)
    pickup_lng = float(delivery.get("pickup_lng") or 0)
    # Backfill shop pickup coordinates for orders created before pickup
    # geocoding existed (they had pickup_lat/lng = 0, which left two legs of the
    # delivery triangle blank). Geocode the seller shop's pincode once and
    # persist it back so this only runs a single time per order.
    if (not pickup_lat or not pickup_lng) and delivery.get("seller_sub") and get_shop_by_user:
        try:
            from platform_utils import geocode_pincode
            _shop = get_shop_by_user(delivery.get("seller_sub", "")) or {}
            _ppin = _shop.get("address_pincode", "")
            _pgeo = geocode_pincode(_ppin) if _ppin else None
            if _pgeo:
                pickup_lat, pickup_lng = float(_pgeo[0]), float(_pgeo[1])
                table.update_item(
                    Key={"pk": f"DELIVERY#ARN#{arn}"},
                    UpdateExpression="SET pickup_lat = :la, pickup_lng = :ln",
                    ExpressionAttributeValues={":la": _decimal(pickup_lat), ":ln": _decimal(pickup_lng)},
                )
        except Exception as _e:
            logger.warning("[TRACK] pickup backfill geocode failed: %s", _e)

    payload = {
        "arn": arn,
        "order": order,
        "product_name": delivery.get("product_name") or order.get("product_name", ""),
        "status": status,
        "timeline": timeline,
        "payment": payment,
        "picked_up_at": delivery.get("picked_up_at", ""),
        "pod_photo_url": delivery.get("pod_photo_url", ""),
        # Shop / pickup point — needed for the delivery-triangle overlay
        # (delivery boy ↔ shop ↔ importer distances) on both maps.
        "pickup": {
            "city": delivery.get("pickup_city", ""),
            "address": delivery.get("pickup_address", ""),
            "lat": pickup_lat or None,
            "lng": pickup_lng or None,
        },
        "driver_location": {
            "lat": driver_lat,
            "lng": driver_lng,
            "updated_at": delivery.get("last_location_at", ""),
            "updated_seconds_ago": updated_seconds_ago,
        } if driver_lat else None,
        "destination": {
            "city": delivery.get("delivery_city", order.get("city", "")),
            "address": delivery.get("dest_address", ""),
            "pincode": delivery.get("delivery_pincode", ""),
            "lat": dest_lat or None,
            "lng": dest_lng or None,
        },
        "buyer_name": delivery.get("buyer_name", ""),
        "delivery_partner": delivery_partner,
        "distance_remaining_km": distance_remaining_km,
        "eta_minutes": eta_minutes,
        # Delivery boy's payout for this order — powers the ₹ chip on the
        # Delivery-tab journey strip (stored at claim time as delivery_charge).
        "earnings": round(float(delivery.get("delivery_charge", 0) or 0), 2),
        "tracking_points": tracking_points,
        "otp_ready": status == "NEAR_DESTINATION",
        "otp_delivery": "in_app_notification",
    }
    user, err = _require_auth(event)
    if not err and user:
        # ── Contact sharing between the three parties (signed-in only):
        #    importer, shop keeper and delivery partner all see each
        #    other's name + phone with call buttons on the track strip.
        #    The delivery_partner block above stays public (existing
        #    behaviour); buyer/seller contacts require sign-in. ──
        payload["buyer_mobile"] = delivery.get("buyer_mobile", "")
        # Importer identity for the Delivery-tab strip (DP avatar + in-app
        # message button need the importer's photo + sub).
        importer_sub = delivery.get("importer_sub", "")
        payload["buyer_sub"] = importer_sub
        if importer_sub and _get_delivery_partner_contact:
            try:
                _imp = _get_delivery_partner_contact(importer_sub) or {}
                payload["buyer_avatar"] = _imp.get("photo", "")
            except Exception as e:
                logger.warning("[TRACK] could not load importer avatar: %s", e)
        seller_sub = delivery.get("seller_sub", "")
        if seller_sub and _get_delivery_partner_contact:
            try:
                seller_contact = _get_delivery_partner_contact(seller_sub) or {}
                payload["seller_contact"] = {
                    "name": seller_contact.get("name") or "Shop keeper",
                    "phone": seller_contact.get("phone", ""),
                    "sub": seller_contact.get("sub", ""),
                    "photo": seller_contact.get("photo", ""),
                }
            except Exception as e:
                logger.warning("[TRACK] could not load seller contact: %s", e)
        for n in _scan_prefix(f"NOTIFICATION#USER#{user['sub']}#"):
            if n.get("type") == "delivery_otp" and n.get("arn") == arn:
                m = re.search(r"OTP:\s*(\d{6})", n.get("body", ""))
                if m:
                    payload["your_otp"] = m.group(1)
                break
    return _json_response(200, payload)
