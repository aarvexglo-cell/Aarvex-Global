"""
Advanced Aarvex Global features for the existing Lambda deployment.

This module is intentionally independent from lambda_handler.py. It uses the same
environment variables, DynamoDB table, WhatsApp Cloud API, S3, SES, and Razorpay
credentials, but keeps the advanced workflows out of the main webhook file.
"""

from __future__ import annotations

import base64
import csv
import hashlib
import hmac
import io
import json
import logging
import os
import random
import re
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

import boto3
from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError

logger = logging.getLogger()

try:
    from marketplace import (
        get_public_catalogue_enriched,
        handle_portal_route,
        notify_seller_lead,
        admin_marketplace_stats,
        _auth_user,
    )
    MARKETPLACE_AVAILABLE = True
except Exception as _mp_err:
    MARKETPLACE_AVAILABLE = False
    logger.warning("[MARKETPLACE] import failed: %s", _mp_err)

DYNAMODB_TABLE = os.environ.get("DYNAMODB_TABLE_NAME") or os.environ.get("DYNAMODB_TABLE", "aarvex-social-bot-state")
GRAPH_API_VERSION = os.environ.get("GRAPH_API_VERSION", "v20.0")
WA_PHONE_NUMBER_ID = os.environ.get("WA_PHONE_NUMBER_ID", "")
WA_ACCESS_TOKEN = os.environ.get("WA_ACCESS_TOKEN", "")
ADMIN_WHATSAPP_NUMBER = os.environ.get("ADMIN_WHATSAPP_NUMBER", "")
ADMIN_TOTP_SECRET = os.environ.get("ADMIN_TOTP_SECRET", "")

RAZORPAY_KEY_ID = os.environ.get("RAZORPAY_KEY_ID", "")
RAZORPAY_KEY_SECRET = os.environ.get("RAZORPAY_KEY_SECRET", "")
RAZORPAY_WEBHOOK_SECRET = os.environ.get("RAZORPAY_WEBHOOK_SECRET", "")
# ── Cashfree Payment Gateway (replaces Razorpay as the live gateway) ──
# Set these in the Lambda environment (see deploy notes). App ID + Secret
# come from Cashfree dashboard → Developers → API Keys. CASHFREE_ENV picks
# the sandbox vs production host. The webhook signature is verified with the
# secret key, so CASHFREE_WEBHOOK_SECRET defaults to the secret key.
CASHFREE_APP_ID = os.environ.get("CASHFREE_APP_ID", "")
CASHFREE_SECRET_KEY = os.environ.get("CASHFREE_SECRET_KEY", "")
CASHFREE_ENV = (os.environ.get("CASHFREE_ENV", "test") or "test").strip().lower()
CASHFREE_WEBHOOK_SECRET = os.environ.get("CASHFREE_WEBHOOK_SECRET", "") or CASHFREE_SECRET_KEY
CASHFREE_API_BASE = "https://api.cashfree.com/pg" if CASHFREE_ENV in ("prod", "production", "live") else "https://sandbox.cashfree.com/pg"
SES_FROM_EMAIL = os.environ.get("SES_FROM_EMAIL", "")
S3_BUCKET_FOR_INVOICES = os.environ.get("S3_BUCKET_FOR_INVOICES", "")
S3_BUCKET_FOR_CATALOGUE_MEDIA = os.environ.get("S3_BUCKET_FOR_CATALOGUE_MEDIA", "")
BROADCAST_BUCKET = os.environ.get("BROADCAST_BUCKET") or S3_BUCKET_FOR_CATALOGUE_MEDIA
API_GATEWAY_BASE_URL = os.environ.get("API_GATEWAY_BASE_URL", "")
COMPANY_NAME = os.environ.get("COMPANY_NAME", "Aarvex Global")
COMPANY_GST_NUMBER = os.environ.get("COMPANY_GST_NUMBER") or os.environ.get("COMPANY_GST", "")
COMPANY_ADDRESS = os.environ.get("COMPANY_ADDRESS", "Warora, Chandrapur, Maharashtra, India")
COMPANY_PHONE = os.environ.get("COMPANY_PHONE", "+91-8767205473")
COMPANY_EMAIL = os.environ.get("COMPANY_EMAIL", "aarvexglo@gmail.com")
INR_TO_USD_RATE = Decimal(os.environ.get("INR_TO_USD_RATE", "83.00"))
ADV_SAMPLE_PRICE_INR = Decimal(os.environ.get("ADV_SAMPLE_PRICE_INR", "500"))
ADV_BULK_DEPOSIT_INR = Decimal(os.environ.get("ADV_BULK_DEPOSIT_INR", "5000"))

_db = boto3.resource("dynamodb")
table = _db.Table(DYNAMODB_TABLE)
s3 = boto3.client("s3")
ses = boto3.client("ses", region_name=os.environ.get("SES_REGION", "ap-south-1"))

ARN_RE = re.compile(r"^(AX\d{6}\d{6}|ARN-\d{4}-\d{6})$", re.I)

try:
    from platform_utils import (
        calc_payment_breakdown,
        generate_arn as _generate_arn_v2,
        get_platform_settings,
        mark_lot_sold,
        normalize_arn,
        arn_valid,
        verify_recaptcha,
        list_payouts,
        mark_payout_paid,
        get_bank_details_for_payout,
        mask_bank_account,
        geocode_pincode,
        estimate_eta_minutes,
    )
    PLATFORM_UTILS = True
except ImportError:
    PLATFORM_UTILS = False

    def verify_recaptcha(token: str) -> bool:
        return bool(token and str(token).strip())
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
GST_RE = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$", re.I)
MOBILE_RE = re.compile(r"^\+?\d{10,15}$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ttl(days: int) -> int:
    return int(time.time()) + days * 86400


def _decimal(value: Any, default: Decimal = Decimal("0")) -> Decimal:
    try:
        return Decimal(str(value).strip())
    except (InvalidOperation, AttributeError):
        return default


def _json_num(value: Any) -> int | float:
    """Convert a Decimal/str DynamoDB value into a real JSON number.

    Keeps 0 falsy and non-zero numeric on the JS side (the website does
    `p.min_order_kg || 1` and `p.price_per_kg ? ... : 'Contact for price'`,
    both of which rely on real numbers rather than stringified Decimals).
    """
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
        },
        "body": json.dumps(body, default=str),
    }


def _plain_response(status: int, body: str) -> dict:
    return {"statusCode": status, "headers": {"Content-Type": "text/plain"}, "body": body}


def _send_whatsapp_payload(to_number: str, payload: dict) -> bool:
    if not WA_PHONE_NUMBER_ID or not WA_ACCESS_TOKEN:
        logger.error("[ADVANCED][WA] WhatsApp env vars missing")
        return False
    url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/{WA_PHONE_NUMBER_ID}/messages"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload, default=str).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {WA_ACCESS_TOKEN}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            logger.info("[ADVANCED][WA] Sent: %s", resp.read()[:200])
            return True
    except urllib.error.HTTPError as e:
        logger.error("[ADVANCED][WA] HTTP %s: %s", e.code, e.read().decode("utf-8", "ignore")[:500])
    except Exception as e:
        logger.error("[ADVANCED][WA] Send error: %s", e, exc_info=True)
    return False


def send_whatsapp_text(to_number: str, message: str) -> bool:
    return _send_whatsapp_payload(to_number, {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": to_number,
        "type": "text",
        "text": {"preview_url": True, "body": message[:4096]},
    })


def _send_interactive_list(to_number: str, body: str, button: str, section_title: str, rows: list[dict]) -> bool:
    return _send_whatsapp_payload(to_number, {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": to_number,
        "type": "interactive",
        "interactive": {
            "type": "list",
            "body": {"text": body[:1024]},
            "action": {"button": button[:20], "sections": [{"title": section_title[:24], "rows": rows[:10]}]},
        },
    })


def _send_buttons(to_number: str, body: str, buttons: list[tuple[str, str]]) -> bool:
    return _send_whatsapp_payload(to_number, {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": to_number,
        "type": "interactive",
        "interactive": {
            "type": "button",
            "body": {"text": body[:1024]},
            "action": {"buttons": [
                {"type": "reply", "reply": {"id": bid[:256], "title": title[:20]}}
                for bid, title in buttons[:3]
            ]},
        },
    })


def _send_image(to_number: str, image_url: str, caption: str) -> bool:
    if not image_url:
        return send_whatsapp_text(to_number, caption)
    return _send_whatsapp_payload(to_number, {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": to_number,
        "type": "image",
        "image": {"link": image_url, "caption": caption[:1024]},
    })


def _get_adv_state(phone: str) -> dict:
    try:
        return table.get_item(Key={"pk": f"ADVSTATE#WA#{phone}"}).get("Item") or {}
    except ClientError as e:
        logger.error("[ADVANCED][STATE] get error: %s", e.response.get("Error"))
        return {}


def _save_adv_state(phone: str, flow: str, data: dict | None = None) -> None:
    table.put_item(Item={
        "pk": f"ADVSTATE#WA#{phone}",
        "advanced_flow": flow,
        "data": data or {},
        "updated_at": _now(),
        "ttl": _ttl(30),
    })


def _clear_adv_state(phone: str) -> None:
    try:
        table.delete_item(Key={"pk": f"ADVSTATE#WA#{phone}"})
    except ClientError as e:
        logger.error("[ADVANCED][STATE] clear error: %s", e.response.get("Error"))


def _parse_key_values(text: str) -> dict:
    data = {}
    for line in text.splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            data[key.strip().lower().replace(" ", "_")] = value.strip()
    return data


def _safe_product_id(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", value or "")[:80]


def _scan_by_pk_prefix(prefix: str) -> list[dict]:
    items = []
    kwargs = {"FilterExpression": Attr("pk").begins_with(prefix)}
    while True:
        resp = table.scan(**kwargs)
        items.extend(resp.get("Items", []))
        if "LastEvaluatedKey" not in resp:
            break
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    return items


def _scan_catalogue() -> list[dict]:
    return [item for item in _scan_by_pk_prefix("CATALOGUE#CATEGORY#") if item.get("is_active", True)]


def _categories_from_catalogue() -> dict[str, dict]:
    categories = {}
    for item in _scan_catalogue():
        pk = item.get("pk", "")
        parts = pk.split("#")
        category_id = item.get("category_id") or (parts[2] if len(parts) >= 3 else "default")
        category_name = item.get("category_name") or category_id.replace("_", " ").title()
        categories.setdefault(category_id, {"category_id": category_id, "category_name": category_name, "products": []})
        categories[category_id]["products"].append(item)
    return categories


def _get_category_products(category_id: str) -> list[dict]:
    products = [
        item for item in _scan_catalogue()
        if item.get("pk", "").startswith(f"CATALOGUE#CATEGORY#{category_id}")
        or item.get("category_id") == category_id
    ]
    return [p for p in products if p.get("is_active", True)]


def get_public_catalogue(event: dict) -> dict:
    """
    Public, NO-AUTH catalogue endpoint for the marketing website (index.html).

    The website's loadCatalogue() JS calls GET /catalogue and expects:
        {"products": [{product_id, product_name, category_id, category_name,
                        description, price_per_kg, min_order_kg,
                        available_stock, image_url}, ...]}

    This reads the SAME DynamoDB items the admin dashboard manages via
    /admin/api/catalogue/upsert (CATALOGUE#CATEGORY#{category_id}#{product_id}),
    so a product added/edited/deleted in the admin dashboard shows up here too
    — no separate "website catalogue" to keep in sync.

    Always returns 200 (even on internal error) with an empty list in the
    worst case, since the website already falls back to its own hardcoded
    DEFAULT_PRODUCTS when "products" comes back empty — a transient DynamoDB
    hiccup should never turn into a broken page for a visitor.
    """
    method = event.get("requestContext", {}).get("http", {}).get("method") or event.get("httpMethod", "GET")
    if method == "OPTIONS":
        return _json_response(200, {})
    try:
        if MARKETPLACE_AVAILABLE:
            data = get_public_catalogue_enriched(include_paused=True)
            logger.info("[PUBLIC][CATALOGUE] Returning %d products (marketplace)", data.get("total", 0))
            return _json_response(200, data)
        items = _scan_catalogue()  # already filters is_active=True
        products = [
            {
                "product_id":      item.get("product_id", ""),
                "product_name":    item.get("product_name", ""),
                "category_id":     item.get("category_id", ""),
                "category_name":   item.get("category_name", ""),
                "description":     item.get("description", ""),
                "price_per_kg":    _json_num(item.get("price_per_kg", 0)),
                "min_order_kg":    _json_num(item.get("min_order_kg", 0)),
                "available_stock": item.get("available_stock", "In Stock"),
                "image_url":       item.get("image_url", ""),
            }
            for item in items
        ]
        products.sort(key=lambda p: (p["category_name"], p["product_name"]))
        logger.info("[PUBLIC][CATALOGUE] Returning %d active products", len(products))
        return _json_response(200, {"products": products, "total": len(products)})
    except Exception as e:
        logger.error("[PUBLIC][CATALOGUE] Failed: %s", e, exc_info=True)
        return _json_response(200, {"products": [], "total": 0})


def _get_product(category_id: str, product_id: str) -> dict:
    for product in _get_category_products(category_id):
        sk = product.get("sk") or product.get("SK") or ""
        pid = product.get("product_id") or sk.replace("PRODUCT#", "") or _safe_product_id(product.get("product_name", ""))
        if pid == product_id:
            return product
    return {}


def _send_category_list(phone: str) -> bool:
    categories = _categories_from_catalogue()
    if not categories:
        return send_whatsapp_text(
            phone,
            "🌿 *Aarvex Global — Product Catalogue*\n\n"
            "Catalogue abhi DynamoDB me configured nahi hai. Admin category/product items add karein, "
            "phir yeh list dynamic dikhne lagegi.",
        )
    rows = []
    for category_id, cat in list(categories.items())[:10]:
        rows.append({
            "id": f"adv_cat_{category_id}",
            "title": cat["category_name"][:24],
            "description": f"{len(cat['products'])} products"[:72],
        })
    body = (
        "🌿 *Aarvex Global — Product Catalogue*\n\n"
        "Humari premium quality agricultural product categories neeche hain. Apni category choose karein:"
    )
    return _send_interactive_list(phone, body, "Choose Category", "Categories", rows)


def _send_product_list(phone: str, category_id: str) -> bool:
    products = _get_category_products(category_id)
    if not products:
        send_whatsapp_text(phone, "Is category me active products nahi mile. Kripya dusri category choose karein.")
        return _send_category_list(phone)
    if len(products) == 1:
        return _send_product_detail(phone, category_id, products[0])
    rows = []
    for product in products[:10]:
        product_id = (
            product.get("product_id")
            or product.get("sk", "").replace("PRODUCT#", "")
            or _safe_product_id(product.get("product_name", "product"))
        )
        rows.append({
            "id": f"adv_prod_{category_id}_{product_id}",
            "title": product.get("product_name", "Product")[:24],
            "description": product.get("available_stock", "In Stock")[:72],
        })
    return _send_interactive_list(phone, "📦 Choose products:", "Choose Product", "Products", rows)


def _send_product_detail(phone: str, category_id: str, product: dict) -> bool:
    if not product:
        return send_whatsapp_text(phone, "Product details nahi mile. Kripya catalogue se dobara select karein.")
    product_id = (
        product.get("product_id")
        or product.get("sk", "").replace("PRODUCT#", "")
        or _safe_product_id(product.get("product_name", "product"))
    )
    name = product.get("product_name", "Product")
    rate = _decimal(product.get("price_per_kg"))
    caption = (
        f"📦 *{name}*\n\n"
        f"{product.get('description', 'Premium quality agricultural product from Aarvex Global.')}\n\n"
        f"💰 *Price:* ₹{rate}/kg (bulk pricing alag)\n"
        f"📦 *Min Order:* {product.get('min_order_kg', 1)} kg\n"
        f"✅ *Availability:* {product.get('available_stock', 'In Stock')}\n\n"
        "_International buyers: USD pricing, FOB/CIF pricing and export documentation available_"
    )
    _send_image(phone, product.get("image_url", ""), caption)
    return _send_buttons(phone, "What would you like to do?", [
        (f"adv_order_{category_id}_{product_id}", "Place Order"),
        (f"adv_cat_{category_id}", "Other Product"),
        ("adv_catalogue", "Go Back"),
    ])


def _start_order(phone: str, category_id: str, product_id: str) -> bool:
    product = _get_product(category_id, product_id)
    if not product:
        send_whatsapp_text(phone, "Product details not found. Please select again from the catalogue.")
        return _send_category_list(phone)
    # NOTE: cta_url interactive type is NOT used here — it fails silently on many
    # WABA accounts. Instead we send a plain text message with the clickable URL
    # (WhatsApp auto-renders it as a tappable link) followed by reply buttons.
    product_name = product.get("product_name", "Product")
    form_url = (
        "https://aarvex-admin-dashboard-prod.s3.ap-southeast-1.amazonaws.com"
        f"/order-form.html?product={product_id}"
    )
    # Message 1: order details + clickable URL
    order_msg = (
        f"🛒 *{product_name} — Order Form*\n"
        "━━━━━━━━━━━━━━━━━━━━━\n"
        "Tap the link below and fill out the order form.\n"
        "Name, address, quantity — everything in one place.\n"
        "📱 Done in just 2 minutes!\n\n"
        f"👉 {form_url}\n\n"
        "Once you submit the form, you will receive a confirmation from our team on WhatsApp. 🙏"
    )
    send_whatsapp_text(phone, order_msg)
    # Message 2: quick-action reply buttons
    _send_buttons(phone, "Do you need anything else?", [
        (f"adv_cat_{category_id}", "Other Product"),
        ("adv_catalogue",          "All Categories"),
        ("menu_main",              "Main Menu"),
    ])
    return True


def _handle_order_step_1(phone: str, text: str, state: dict) -> bool:
    data = dict(state.get("data", {}))
    values = _parse_key_values(text)
    order_type = values.get("order_type", "").lower()
    qty = _decimal(values.get("quantity"), Decimal("-1"))
    if order_type not in ("sample", "bulk"):
        return send_whatsapp_text(phone, "ORDER_TYPE sirf Sample ya Bulk hona chahiye. Kripya Step 1 dobara bhejein.")
    if qty <= 0 or qty != int(qty):
        return send_whatsapp_text(phone, "QUANTITY positive number hona chahiye. Example: QUANTITY: 500")
    if order_type == "sample" and qty > 5:
        return send_whatsapp_text(phone, "Sample order maximum 5 kg tak allowed hai. Kripya quantity dobara bhejein.")
    data.update({"order_type": order_type, "quantity_kg": qty})
    _save_adv_state(phone, "order_form_step_2", data)
    return send_whatsapp_text(phone, (
        "📋 *Order Form — Step 2 of 3*\n\n"
        "Apni details bhejein:\n\n"
        "NAME: Aapka poora naam\n"
        "COMPANY: Company ka naam\n"
        "GST: GST Number, agar ho\n"
        "ADDRESS: Poora delivery address\n"
        "CITY: Shehar\n"
        "STATE: Rajya\n"
        "COUNTRY: Desh\n\n"
        "*Example:*\n"
        "NAME: Rajesh Kumar\n"
        "COMPANY: Kumar Traders Pvt Ltd\n"
        "GST: 29ABCDE1234F1Z5\n"
        "ADDRESS: 123 Market Street\n"
        "CITY: Mumbai\n"
        "STATE: Maharashtra\n"
        "COUNTRY: India"
    ))


def _handle_order_step_2(phone: str, text: str, state: dict) -> bool:
    data = dict(state.get("data", {}))
    values = _parse_key_values(text)
    required = ["name", "company", "address", "city", "state", "country"]
    missing = [key.upper() for key in required if not values.get(key)]
    if missing:
        return send_whatsapp_text(phone, "Yeh fields missing hain: " + ", ".join(missing) + ". Kripya Step 2 dobara bhejein.")
    gst = values.get("gst", "")
    if gst and gst.upper() != "NA" and not GST_RE.match(gst):
        return send_whatsapp_text(phone, "GST format valid nahi lag raha. Agar GST nahi hai to GST: NA bhejein.")
    data.update({
        "customer_name": values["name"],
        "company_name": values["company"],
        "gst_number": "" if gst.upper() == "NA" else gst,
        "address": values["address"],
        "city": values["city"],
        "state": values["state"],
        "country": values["country"],
    })
    _save_adv_state(phone, "order_form_step_3", data)
    return send_whatsapp_text(phone, (
        "📋 *Order Form — Step 3 of 3*\n\n"
        "Contact details:\n\n"
        "MOBILE: 10 digit ya international number\n"
        "EMAIL: Email address\n\n"
        "*Example:*\n"
        "MOBILE: 9876543210\n"
        "EMAIL: rajesh@kumartraders.com"
    ))


def _handle_order_step_3(phone: str, text: str, state: dict) -> bool:
    data = dict(state.get("data", {}))
    values = _parse_key_values(text)
    mobile = re.sub(r"[\s-]", "", values.get("mobile", ""))
    email = values.get("email", "")
    if not MOBILE_RE.match(mobile):
        return send_whatsapp_text(phone, "MOBILE valid nahi lag raha. 10-15 digit number bhejein.")
    if not EMAIL_RE.match(email):
        return send_whatsapp_text(phone, "EMAIL valid nahi lag raha. Kripya sahi email bhejein.")
    data.update({"mobile": mobile, "email": email, "whatsapp_number": phone})
    _save_adv_state(phone, "order_form_confirm", data)
    product = data.get("product", {})
    msg = (
        "✅ *Order Summary — Please Confirm*\n\n"
        f"📦 *Product:* {product.get('product_name', 'Product')}\n"
        f"🔢 *Type:* {data.get('order_type')} | *Qty:* {data.get('quantity_kg')} kg\n"
        f"👤 *Name:* {data.get('customer_name')}\n"
        f"🏢 *Company:* {data.get('company_name')}\n"
        f"📍 *City:* {data.get('city')}, {data.get('country')}\n"
        f"📞 *Mobile:* {mobile}\n"
        f"📧 *Email:* {email}\n\n"
        "Kya yeh details sahi hain?"
    )
    return _send_buttons(phone, msg, [("adv_confirm_payment", "Confirm & Pay"), ("adv_restart_order", "Dobara Bharo")])


def _payment_mode(country: str) -> tuple[str, str]:
    if country.strip().lower() in ("india", "bharat", "in"):
        return "national", "INR"
    return "international", "USD"


def _calculate_amount(product: dict, qty: Decimal, order_type: str, currency: str, delivery_pincode: str = "") -> Decimal:
    if order_type == "sample":
        amount_inr = ADV_SAMPLE_PRICE_INR
    else:
        lot_size = _decimal(product.get("lot_size_kg", 0))
        if lot_size > 0:
            lot_price = _decimal(product.get("lot_price", 0))
            if lot_price <= 0:
                lot_price = _decimal(product.get("price_per_kg", 0)) * lot_size
            if PLATFORM_UTILS:
                bd = calc_payment_breakdown(
                    lot_price,
                    seller_pincode=product.get("seller_pincode", product.get("shop_pincode", "")),
                    buyer_pincode=delivery_pincode,
                )
                amount_inr = Decimal(str(bd["total"]))
            else:
                amount_inr = lot_price
        else:
            rate = _decimal(product.get("price_per_kg"))
            amount_inr = rate * qty if rate > 0 else ADV_BULK_DEPOSIT_INR
    if currency == "USD":
        return (amount_inr / INR_TO_USD_RATE).quantize(Decimal("0.01"))
    return amount_inr.quantize(Decimal("0.01"))


def _calculate_breakdown(product: dict, qty: Decimal, order_type: str, delivery_pincode: str = "") -> dict:
    if order_type == "sample":
        return {"lot_price": ADV_SAMPLE_PRICE_INR, "delivery_charge": Decimal("0"), "platform_fee": Decimal("0"),
                "platform_fee_pct": 0, "subtotal": ADV_SAMPLE_PRICE_INR, "gst_amount": Decimal("0"),
                "gst_rate_pct": 0, "total": ADV_SAMPLE_PRICE_INR, "currency": "INR"}
    lot_size = _decimal(product.get("lot_size_kg", 0))
    if lot_size > 0:
        lot_price = _decimal(product.get("lot_price", 0)) or _decimal(product.get("price_per_kg", 0)) * lot_size
    else:
        lot_price = _decimal(product.get("price_per_kg")) * qty if _decimal(product.get("price_per_kg")) > 0 else ADV_BULK_DEPOSIT_INR
    if PLATFORM_UTILS:
        breakdown = calc_payment_breakdown(lot_price, buyer_pincode=delivery_pincode)
        return _decimalize_breakdown(breakdown)
    fee = lot_price * Decimal("0.10")
    total = lot_price + fee
    return {"lot_price": lot_price, "delivery_charge": Decimal("0"), "platform_fee": fee,
            "platform_fee_pct": 10, "subtotal": total, "gst_amount": Decimal("0"), "gst_rate_pct": 0,
            "total": total, "currency": "INR"}


def _decimalize_breakdown(breakdown: dict) -> dict:
    converted = {}
    for key, value in breakdown.items():
        if key == "currency":
            converted[key] = value
        elif isinstance(value, Decimal):
            converted[key] = value
        elif isinstance(value, int):
            converted[key] = Decimal(value)
        elif isinstance(value, float):
            converted[key] = Decimal(str(value))
        elif isinstance(value, str) and value.replace('.', '', 1).isdigit():
            converted[key] = Decimal(value)
        else:
            converted[key] = value
    return converted


def generate_arn() -> str:
    if PLATFORM_UTILS:
        arn, _ = _generate_arn_v2()
        return arn
    for _ in range(8):
        now = datetime.utcnow()
        arn = f"AX{now.year}{now.month:02d}{random.randint(100000, 999999)}"
        try:
            if not table.get_item(Key={"pk": f"ORDER#{arn}"}).get("Item"):
                return arn
        except ClientError:
            return arn
    now = datetime.utcnow()
    return f"AX{now.year}{now.month:02d}{random.randint(100000, 999999)}"


def create_importer_ticket(order_data: dict) -> str:
    ticket_id = str(uuid.uuid4())
    arn = generate_arn()
    product = order_data.get("product", {})
    mode, currency = _payment_mode(order_data.get("country", "India"))
    delivery_pin = order_data.get("pincode", order_data.get("delivery_pincode", ""))
    breakdown = _decimalize_breakdown(_calculate_breakdown(product, _decimal(order_data.get("quantity_kg")), order_data.get("order_type", "bulk"), delivery_pin))
    amount = _calculate_amount(product, _decimal(order_data.get("quantity_kg")), order_data.get("order_type", "bulk"), currency, delivery_pin)
    item = {
        "pk": f"TICKET#IMPORTER#{ticket_id}",
        "sk": "METADATA",
        "ticket_id": ticket_id,
        "created_at": _now(),
        "customer_name": order_data.get("customer_name", ""),
        "company_name": order_data.get("company_name", ""),
        "mobile": order_data.get("mobile", ""),
        "email": order_data.get("email", ""),
        "whatsapp_number": order_data.get("whatsapp_number", ""),
        "address": order_data.get("address", ""),
        "city": order_data.get("city", ""),
        "state": order_data.get("state", ""),
        "country": order_data.get("country", ""),
        "gst_number": order_data.get("gst_number", ""),
        "product_id": order_data.get("product_id", ""),
        "product_name": product.get("product_name", ""),
        "order_type": order_data.get("order_type", "bulk"),
        "quantity_kg": _decimal(order_data.get("quantity_kg")),
        "payment_status": "pending",
        "payment_mode": mode,
        "payment_amount": amount,
        "payment_currency": currency,
        "payment_breakdown": breakdown,
        "lot_price": breakdown.get("lot_price", 0),
        "delivery_charge": breakdown.get("delivery_charge", 0),
        "platform_fee": breakdown.get("platform_fee", 0),
        "gst_amount": breakdown.get("gst_amount", 0),
        "gst_rate_pct": breakdown.get("gst_rate_pct", 0),
        "product_pk": product.get("pk", ""),
        "user_sub": order_data.get("user_sub", ""),
        "importer_sub": order_data.get("user_sub", ""),
        "dest_lat": _decimal(order_data.get("dest_lat", 0)),
        "dest_lng": _decimal(order_data.get("dest_lng", 0)),
        "arn": arn,
        "order_status": "placed",
        "invoice_sent_whatsapp": False,
        "invoice_sent_email": False,
        "ttl": _ttl(730),
    }
    table.put_item(Item=item)
    table.put_item(Item={
        "pk": f"ORDER#{arn}",
        "sk": "STATUS",
        "arn": arn,
        "ticket_id": ticket_id,
        "product_name": item["product_name"],
        "current_status": "Order Placed",
        "status_history": [{"status": "Order Placed", "timestamp": _now(), "updated_by": "system"}],
        "last_updated": _now(),
    })
    logger.info("[ADVANCED][TICKET] Importer ticket created: %s", ticket_id)
    return ticket_id


def _get_importer_ticket(ticket_id: str) -> dict:
    return table.get_item(Key={"pk": f"TICKET#IMPORTER#{ticket_id}"}).get("Item") or {}


def _update_importer_ticket(ticket_id: str, updates: dict) -> None:
    names = {f"#k{i}": key for i, key in enumerate(updates)}
    values = {f":v{i}": value for i, value in enumerate(updates.values())}
    expr = "SET " + ", ".join(f"{name} = {value}" for name, value in zip(names, values))
    table.update_item(
        Key={"pk": f"TICKET#IMPORTER#{ticket_id}"},
        UpdateExpression=expr,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def create_razorpay_payment_link(ticket: dict) -> dict:
    if not RAZORPAY_KEY_ID or not RAZORPAY_KEY_SECRET:
        logger.warning("[ADVANCED][PAYMENT] Razorpay credentials missing")
        return {}
    amount_major = _decimal(ticket.get("payment_amount"))
    body = {
        "amount": int(amount_major * 100),
        "currency": ticket.get("payment_currency", "INR"),
        "accept_partial": False,
        "description": f"Order #{ticket.get('arn')} - {ticket.get('product_name')} {ticket.get('quantity_kg')}kg",
        "customer": {
            "name": ticket.get("customer_name"),
            "email": ticket.get("email"),
            "contact": ticket.get("mobile"),
        },
        "notify": {"sms": True, "email": True},
        "reminder_enable": True,
        "notes": {
            "arn": ticket.get("arn"),
            "ticket_id": ticket.get("ticket_id"),
            "product": ticket.get("product_name"),
            "quantity": str(ticket.get("quantity_kg")),
        },
        "callback_url": f"{API_GATEWAY_BASE_URL.rstrip('/')}/razorpay-webhook" if API_GATEWAY_BASE_URL else "",
        "callback_method": "get",
    }
    auth = base64.b64encode(f"{RAZORPAY_KEY_ID}:{RAZORPAY_KEY_SECRET}".encode()).decode()
    req = urllib.request.Request(
        "https://api.razorpay.com/v1/payment_links",
        data=json.dumps(body, default=str).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Basic {auth}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        result = json.loads(resp.read())
    logger.info("[ADVANCED][PAYMENT] Razorpay link created: %s", result.get("id"))
    return result


def _cf_phone(raw: str) -> str:
    """Cashfree needs a plain phone number — strip to digits, keep last 10."""
    digits = "".join(ch for ch in str(raw or "") if ch.isdigit())
    if len(digits) > 10:
        digits = digits[-10:]
    return digits or "9999999999"


def create_cashfree_payment_link(ticket: dict) -> dict:
    """Create a Cashfree payment link for a ticket.

    Returns a dict shaped like the old Razorpay one — ``{"id", "short_url"}`` —
    so every existing caller keeps working unchanged. Returns ``{}`` on any
    failure (missing creds / API error) exactly like the Razorpay helper did.
    """
    if not CASHFREE_APP_ID or not CASHFREE_SECRET_KEY:
        logger.warning("[ADVANCED][PAYMENT] Cashfree credentials missing")
        return {}
    import re as _re
    amount_major = _decimal(ticket.get("payment_amount"))
    raw_id = str(ticket.get("arn") or ticket.get("ticket_id") or "")
    link_id = "AXV" + _re.sub(r"[^a-zA-Z0-9]", "", raw_id)[:40]
    if link_id == "AXV":
        link_id = "AXV" + _re.sub(r"[^0-9]", "", _now())[:20]
    link_id = link_id[:50]
    body = {
        "link_id": link_id,
        "link_amount": float(amount_major),
        "link_currency": ticket.get("payment_currency", "INR"),
        "link_purpose": (f"Order {ticket.get('arn')} - {ticket.get('product_name')} "
                         f"{ticket.get('quantity_kg')}kg")[:200],
        "customer_details": {
            "customer_name": ticket.get("customer_name") or "Customer",
            "customer_email": ticket.get("email") or "",
            "customer_phone": _cf_phone(ticket.get("mobile") or ticket.get("whatsapp_number") or ""),
        },
        "link_notify": {"send_sms": True, "send_email": True},
        "link_notes": {
            "arn": str(ticket.get("arn") or ""),
            "ticket_id": str(ticket.get("ticket_id") or ""),
            "product": str(ticket.get("product_name") or "")[:60],
            "quantity": str(ticket.get("quantity_kg") or ""),
        },
        "link_meta": {
            "notify_url": f"{API_GATEWAY_BASE_URL.rstrip('/')}/cashfree-webhook" if API_GATEWAY_BASE_URL else "",
            "return_url": f"{API_GATEWAY_BASE_URL.rstrip('/')}/payment-return" if API_GATEWAY_BASE_URL else "",
        },
    }
    req = urllib.request.Request(
        f"{CASHFREE_API_BASE}/links",
        data=json.dumps(body, default=str).encode(),
        headers={
            "Content-Type": "application/json",
            "x-client-id": CASHFREE_APP_ID,
            "x-client-secret": CASHFREE_SECRET_KEY,
            "x-api-version": "2023-08-01",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            result = json.loads(resp.read())
    except Exception as e:  # HTTPError / URLError / JSON — never crash the order
        detail = ""
        try:
            detail = e.read().decode(errors="ignore")  # type: ignore[attr-defined]
        except Exception:
            detail = str(e)
        logger.error("[ADVANCED][PAYMENT] Cashfree link error: %s", detail)
        return {}
    logger.info("[ADVANCED][PAYMENT] Cashfree link created: %s", result.get("link_id"))
    # Normalise to the Razorpay-style shape the callers expect.
    return {
        "id": result.get("link_id", link_id),
        "short_url": result.get("link_url", ""),
        "cf_link_id": result.get("cf_link_id", ""),
        "_raw": result,
    }


def create_cashfree_order(ticket: dict) -> dict:
    """Create a Cashfree PG *order* (not a hosted link) for IN-APP checkout.

    The frontend Cashfree JS SDK (cashfree.checkout({paymentSessionId})) opens a
    modal inside the app using the returned ``payment_session_id`` — no new tab,
    no WhatsApp round-trip. ``order_tags`` carries {arn, ticket_id} so the SAME
    /cashfree-webhook -> _finalize_captured_payment flow that payment links use
    marks the ticket paid / generates the invoice / activates the subscription.
    Returns {"order_id", "payment_session_id", "mode"}; {} on any failure.
    """
    if not CASHFREE_APP_ID or not CASHFREE_SECRET_KEY:
        logger.warning("[ADVANCED][PAYMENT] Cashfree credentials missing")
        return {}
    import re as _re
    amount_major = _decimal(ticket.get("payment_amount"))
    raw_id = str(ticket.get("arn") or ticket.get("ticket_id") or "")
    order_id = "AXV" + _re.sub(r"[^a-zA-Z0-9]", "", raw_id)[:40]
    if order_id == "AXV":
        order_id = "AXV" + _re.sub(r"[^0-9]", "", _now())[:20]
    order_id = order_id[:50]
    cust_id = ("CUST" + _re.sub(r"[^a-zA-Z0-9]", "", str(ticket.get("ticket_id") or raw_id)))[:50] or "CUSTGUEST"
    body = {
        "order_id": order_id,
        "order_amount": float(amount_major),
        "order_currency": ticket.get("payment_currency", "INR"),
        "customer_details": {
            "customer_id": cust_id,
            "customer_name": ticket.get("customer_name") or "Customer",
            "customer_email": ticket.get("email") or "noreply@aarvexglobal.com",
            "customer_phone": _cf_phone(ticket.get("mobile") or ticket.get("whatsapp_number") or ""),
        },
        "order_meta": {
            "notify_url": f"{API_GATEWAY_BASE_URL.rstrip('/')}/cashfree-webhook" if API_GATEWAY_BASE_URL else "",
            "return_url": (f"{API_GATEWAY_BASE_URL.rstrip('/')}/payment-return?order_id={{order_id}}"
                           if API_GATEWAY_BASE_URL else ""),
        },
        # order_tags come back on the webhook as order.order_tags — the webhook
        # already reads notes from there (see handle_cashfree_webhook).
        "order_tags": {
            "arn": str(ticket.get("arn") or ""),
            "ticket_id": str(ticket.get("ticket_id") or ""),
        },
        "order_note": (f"Order {ticket.get('arn')} - {ticket.get('product_name')}")[:200],
    }
    req = urllib.request.Request(
        f"{CASHFREE_API_BASE}/orders",
        data=json.dumps(body, default=str).encode(),
        headers={
            "Content-Type": "application/json",
            "x-client-id": CASHFREE_APP_ID,
            "x-client-secret": CASHFREE_SECRET_KEY,
            "x-api-version": "2023-08-01",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            result = json.loads(resp.read())
    except Exception as e:  # HTTPError / URLError / JSON — never crash the order
        detail = ""
        try:
            detail = e.read().decode(errors="ignore")  # type: ignore[attr-defined]
        except Exception:
            detail = str(e)
        logger.error("[ADVANCED][PAYMENT] Cashfree order error: %s", detail)
        return {}
    logger.info("[ADVANCED][PAYMENT] Cashfree order created: %s", result.get("order_id"))
    return {
        "order_id": result.get("order_id", order_id),
        "payment_session_id": result.get("payment_session_id", ""),
        "mode": "production" if CASHFREE_ENV in ("prod", "production", "live") else "sandbox",
        "_raw": result,
    }


def _confirm_order_and_payment(phone: str, state: dict) -> bool:
    ticket_id = create_importer_ticket(state.get("data", {}))
    ticket = _get_importer_ticket(ticket_id)
    link = create_cashfree_payment_link(ticket)
    if link:
        _update_importer_ticket(ticket_id, {
            "payment_link_id": link.get("id", ""),
            "payment_link_url": link.get("short_url", ""),
            "razorpay_payment_link_url": link.get("short_url", ""),  # legacy key
        })
        ticket.update({"razorpay_payment_link_url": link.get("short_url", "")})
    _save_adv_state(phone, "awaiting_payment", {"ticket_id": ticket_id, "arn": ticket.get("arn")})
    if not link:
        return send_whatsapp_text(
            phone,
            f"✅ Order register ho gaya.\n\n🔖 Order ID: {ticket.get('arn')}\n\n"
            "Payment link abhi create nahi hua kyunki Cashfree env vars missing hain. Team aapse contact karegi.",
        )
    return send_whatsapp_text(phone, (
        "💳 *Payment Link Ready!*\n\n"
        f"📦 Order: {ticket.get('product_name')} ({ticket.get('quantity_kg')} kg)\n"
        f"💰 Amount: {ticket.get('payment_currency')} {ticket.get('payment_amount')}\n"
        f"🔖 Order ID: {ticket.get('arn')}\n\n"
        f"Neeche diye link se payment karein:\n👉 {ticket.get('razorpay_payment_link_url')}\n\n"
        "_Payment ke baad invoice automatically WhatsApp aur email par aayega_"
    ))


def update_ticket_status(ticket_id: str, ticket_type: str, new_status: str, updated_by: str = "system") -> bool:
    pk = f"TICKET#{ticket_type.upper()}#{ticket_id}"
    try:
        item = table.get_item(Key={"pk": pk}).get("Item") or {}
        if not item:
            return False
        field = "order_status" if ticket_type.lower() == "importer" else "status"
        table.update_item(
            Key={"pk": pk},
            UpdateExpression=f"SET {field} = :s, last_updated = :u",
            ExpressionAttributeValues={":s": new_status, ":u": _now()},
        )
        arn = item.get("arn")
        if arn:
            order = table.get_item(Key={"pk": f"ORDER#{arn}"}).get("Item") or {}
            history = order.get("status_history", []) + [{"status": new_status, "timestamp": _now(), "updated_by": updated_by}]
            table.update_item(
                Key={"pk": f"ORDER#{arn}"},
                UpdateExpression="SET current_status=:s, status_history=:h, last_updated=:u",
                ExpressionAttributeValues={":s": new_status, ":h": history, ":u": _now()},
            )
        return True
    except ClientError as e:
        logger.error("[ADVANCED][TICKET] status update error: %s", e.response.get("Error"))
        return False


def _generate_invoice(ticket: dict, payment_id: str = "") -> str:
    if not S3_BUCKET_FOR_INVOICES:
        return ""
    arn = ticket.get("arn", "")
    key = f"invoices/{arn}/invoice_{arn}.pdf"
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfgen import canvas
        buffer = io.BytesIO()
        c = canvas.Canvas(buffer, pagesize=A4)
        y = 800
        lines = [
            COMPANY_NAME, COMPANY_ADDRESS, f"GST: {COMPANY_GST_NUMBER}", f"Email: {COMPANY_EMAIL}", "",
            "INVOICE", f"Invoice No: INV-{arn}", f"Date: {_now()[:10]}", "",
            "BILL TO:", ticket.get("customer_name", ""), ticket.get("company_name", ""),
            f"{ticket.get('address', '')}, {ticket.get('city', '')}, {ticket.get('state', '')}",
            ticket.get("country", ""), f"GST: {ticket.get('gst_number', '')}", "",
            "PRODUCT          QTY          AMOUNT",
            f"{ticket.get('product_name')}    {ticket.get('quantity_kg')} kg    {ticket.get('payment_currency')} {ticket.get('payment_amount')}",
            "", f"TOTAL: {ticket.get('payment_currency')} {ticket.get('payment_amount')}", f"Payment ID: {payment_id}",
        ]
        for line in lines:
            c.drawString(50, y, str(line)[:95])
            y -= 18
        c.save()
        s3.put_object(Bucket=S3_BUCKET_FOR_INVOICES, Key=key, Body=buffer.getvalue(), ContentType="application/pdf")
        return s3.generate_presigned_url("get_object", Params={"Bucket": S3_BUCKET_FOR_INVOICES, "Key": key}, ExpiresIn=604800)
    except Exception as e:
        logger.error("[ADVANCED][INVOICE] PDF generation failed: %s", e, exc_info=True)
        return ""


def _send_order_email(ticket: dict, invoice_url: str) -> bool:
    if not SES_FROM_EMAIL or not ticket.get("email"):
        return False
    subject = f"Order Confirmed - {ticket.get('arn')} | {COMPANY_NAME}"
    text = f"Your order {ticket.get('arn')} is confirmed. Invoice: {invoice_url}"
    html = (
        f"<h2>Order Confirmed</h2><p>Order ID: <b>{ticket.get('arn')}</b></p>"
        f"<p>Product: {ticket.get('product_name')}</p>"
        f"<p>Invoice: <a href='{invoice_url}'>Download invoice</a></p>"
        f"<p>{COMPANY_NAME}<br>{COMPANY_PHONE}</p>"
    )
    try:
        ses.send_email(
            Source=SES_FROM_EMAIL,
            Destination={"ToAddresses": [ticket["email"]]},
            Message={"Subject": {"Data": subject}, "Body": {"Text": {"Data": text}, "Html": {"Data": html}}},
        )
        return True
    except Exception as e:
        logger.error("[ADVANCED][EMAIL] SES send failed: %s", e)
        return False


def handle_razorpay_webhook(event: dict) -> dict:
    raw_body = event.get("body") or ""
    if event.get("isBase64Encoded"):
        raw_bytes = base64.b64decode(raw_body)
        raw_body = raw_bytes.decode("utf-8")
    else:
        raw_bytes = raw_body.encode("utf-8")
    headers = event.get("headers") or {}
    signature = headers.get("X-Razorpay-Signature") or headers.get("x-razorpay-signature", "")
    if not RAZORPAY_WEBHOOK_SECRET:
        logger.error("[ADVANCED][PAYMENT] RAZORPAY_WEBHOOK_SECRET missing")
        return _plain_response(403, "Webhook secret missing")
    expected = hmac.new(RAZORPAY_WEBHOOK_SECRET.encode(), raw_bytes, hashlib.sha256).hexdigest()
    if not signature or not hmac.compare_digest(signature, expected):
        logger.error("[ADVANCED][PAYMENT] Invalid Razorpay signature")
        return _plain_response(403, "Invalid signature")
    payload = json.loads(raw_body or "{}")
    if payload.get("event") != "payment.captured":
        return _json_response(200, {"handled": False})
    payment = payload.get("payload", {}).get("payment", {}).get("entity", {})
    notes = payment.get("notes", {}) or {}
    return _finalize_captured_payment(notes, payment.get("id", ""))


def _finalize_captured_payment(notes: dict, payment_id: str) -> dict:
    """Shared post-payment processing for BOTH gateways (Razorpay + Cashfree):
    activates a subscription / marks the ticket paid / generates the invoice /
    creates the delivery record / notifies. `notes` carries {ticket_id, arn}."""
    notes = notes or {}
    ticket_id = notes.get("ticket_id")
    arn_note = notes.get("arn", "")
    
    logger.info("[PAYMENT_FLOW] _finalize_captured_payment called - Payment ID: %s, ARN: %s, Ticket ID: %s", 
                payment_id, arn_note, ticket_id)

    # Shop subscription payment (notes.ticket_id = subscription_id)
    if ticket_id:
        for row in table.scan(FilterExpression=Attr("pk").begins_with("SUBSCRIPTION#")).get("Items", []):
            if row.get("subscription_id") == ticket_id and row.get("status") == "pending":
                import time as _time
                expires = int(_time.time()) + 30 * 86400
                table.update_item(
                    Key={"pk": row["pk"]},
                    UpdateExpression="SET #s = :a, paid_at = :p, expires_at_ts = :e, expires_at = :ed",
                    ExpressionAttributeNames={"#s": "status"},
                    ExpressionAttributeValues={
                        ":a": "active", ":p": _now(),
                        ":e": expires, ":ed": datetime.fromtimestamp(expires, timezone.utc).isoformat(),
                    },
                )
                return _json_response(200, {"success": True, "type": "subscription"})
                break

    if not ticket_id:
        return _json_response(200, {"handled": False, "reason": "ticket_id missing"})
    ticket = _get_importer_ticket(ticket_id)
    if not ticket:
        deal = table.get_item(Key={"pk": f"DEAL#SHOP#{ticket_id}"}).get("Item") or {}
        if deal:
            ticket = deal
    if not ticket:
        return _json_response(200, {"handled": False, "reason": "ticket not found"})

    product_pk = ticket.get("product_pk", "")
    arn = ticket.get("arn", arn_note)
    seller_sub = ""
    is_seller_product = False
    if product_pk and PLATFORM_UTILS:
        product_item = table.get_item(Key={"pk": product_pk}).get("Item") or {}
        is_seller_product = bool(product_item.get("is_seller_product"))
        seller_sub = ticket.get("seller_user_sub", "") or product_item.get("seller_user_sub", "")
        shop_id = ticket.get("shop_id") or product_item.get("shop_id", "")
        if not seller_sub and shop_id:
            shop = table.get_item(Key={"pk": f"SHOP#{shop_id}"}).get("Item") or {}
            seller_sub = shop.get("user_sub", "")

        # ── Resolve shop's permanent address coordinates for pickup location ──
        # The triangle rule requires the shopkeeper's real profile address
        # (not a centroid). We pull it from the SHOP record if available,
        # or from the seller's user profile as fallback.
        # Stored as seller_lat / seller_lng on the ticket for create_delivery_record.
        _s_lat = float(ticket.get("seller_lat", 0) or product_item.get("address_lat", 0) or 0)
        _s_lng = float(ticket.get("seller_lng", 0) or product_item.get("address_lng", 0) or 0)
        if (not _s_lat or not _s_lng) and shop_id:
            if not shop:  # may already be fetched above
                shop = table.get_item(Key={"pk": f"SHOP#{shop_id}"}).get("Item") or {}
            _s_lat = float(shop.get("address_lat", 0) or 0)
            _s_lng = float(shop.get("address_lng", 0) or 0)
            # If shop has no coords, geocode from shop pincode.
            if (not _s_lat or not _s_lng) and PLATFORM_UTILS:
                _sp = shop.get("pincode") or shop.get("shop_pincode") or product_item.get("seller_pincode", "")
                if _sp:
                    try:
                        _geo = geocode_pincode(str(_sp))
                        if _geo:
                            _s_lat, _s_lng = _geo
                            logger.info("[GEOCODE] Shop pincode %s -> %s", _sp, _geo)
                    except Exception as _sge:
                        logger.warning("[GEOCODE] Shop pincode %s failed: %s", _sp, _sge)

        # Stock commit happens in create_delivery_record — public available
        # only decreases on delivery COMPLETE (OTP).
        purchased_qty = ticket.get("quantity_kg", 0)
        if seller_sub:
            try:
                from marketplace import create_notification
                create_notification(
                    seller_sub, "shop_status", "Order received!",
                    f"{purchased_qty} kg of {ticket.get('product_name', 'product')} ordered. Order: {arn}. "
                    f"Stock stays listed until delivery is completed.",
                )
            except Exception:
                pass

    invoice_url = _generate_invoice(ticket, payment_id)
    _update_importer_ticket(ticket_id, {
        "payment_status": "completed",
        "payment_captured_at": _now(),
        "payment_id": payment_id,
        "razorpay_payment_id": payment_id,  # legacy key kept for any old reader
        "invoice_pdf_url": invoice_url,
        "invoice_sent_email": bool(invoice_url),
        "invoice_sent_whatsapp": bool(invoice_url),
    })
    update_ticket_status(ticket_id, "importer", "Payment Confirmed", "gateway")
    arn = ticket.get("arn", "")
    if arn and PLATFORM_UTILS:
        try:
            import delivery as _del
            import marketplace as _mp
            _del._bind_delivery_helpers(_mp)
            bd = ticket.get("payment_breakdown") or {}
            _del.create_delivery_record(
                arn=arn,
                product_name=ticket.get("product_name", ""),
                product_id=ticket.get("product_id", ""),
                product_pk=product_pk,
                importer_sub=ticket.get("importer_sub", ticket.get("user_sub", "")),
                pickup_city=ticket.get("seller_city", ""),
                # Shopkeeper's permanent profile address — used by the
                # triangle rule on the delivery boy's claims view.
                pickup_lat=_s_lat,
                pickup_lng=_s_lng,
                # Full address TEXT for the strips: importer = their picked
                # order address; seller = permanent address (best available).
                dest_address=ticket.get("address", ""),
                pickup_address=ticket.get("seller_address", "") or ticket.get("seller_city", ""),
                delivery_city=ticket.get("city", ""),
                delivery_pincode=ticket.get("pincode", ticket.get("delivery_pincode", "")),
                lot_size_kg=float(ticket.get("quantity_kg", 0)),
                distance_km=float(bd.get("distance_km", 15)),
                delivery_charge=float(bd.get("delivery_charge", 50)),
                # Importer's order-form address (location-picker selection).
                dest_lat=float(ticket.get("dest_lat", 0) or 0),
                dest_lng=float(ticket.get("dest_lng", 0) or 0),
                seller_sub=seller_sub,
                is_seller_product=is_seller_product,
                lot_price=float(bd.get("lot_price", ticket.get("lot_price", 0))),
                platform_fee=float(bd.get("platform_fee", ticket.get("platform_fee", 0))),
                gst_amount=float(bd.get("gst_amount", ticket.get("gst_amount", 0))),
                buyer_name=ticket.get("customer_name", ""),
                buyer_email=ticket.get("email", ""),
                buyer_mobile=ticket.get("whatsapp_number") or ticket.get("mobile", ""),
                buyer_gst_number=ticket.get("gst_number", ""),
            )
            table.update_item(
                Key={"pk": f"ORDER#{arn}"},
                UpdateExpression="SET current_status = :s, last_updated = :u",
                ExpressionAttributeValues={":s": "PENDING_DELIVERY", ":u": _now()},
            )
        except Exception as e:
            logger.error("[PAYMENT] delivery record: %s", e)
    logger.info("[PAYMENT_FLOW] Sending REGISTRATION WhatsApp - ARN: %s, Phone: %s", 
                ticket.get('arn'), ticket.get('whatsapp_number'))
    send_whatsapp_text(ticket.get("whatsapp_number", ""), (
        f"✅ *Payment Confirmed!*\n\n🔖 Order ID: {ticket.get('arn')}\n"
        f"📦 {ticket.get('product_name')}\n\nInvoice: {invoice_url or 'Team will share shortly'}"
    ))
    logger.info("[PAYMENT_FLOW] Registration WhatsApp sent successfully - ARN: %s", ticket.get('arn'))
    if invoice_url:
        _send_order_email(ticket, invoice_url)
    return _json_response(200, {"success": True})


def handle_cashfree_webhook(event: dict) -> dict:
    """Cashfree PG webhook. Verifies the signature
    (base64(HMAC-SHA256(timestamp + rawBody, secret))) then runs the shared
    post-payment processing. Handles both payment-link and order webhooks."""
    raw_body = event.get("body") or ""
    if event.get("isBase64Encoded"):
        raw_body = base64.b64decode(raw_body).decode("utf-8")
    headers = {(k or "").lower(): v for k, v in (event.get("headers") or {}).items()}
    signature = headers.get("x-webhook-signature", "")
    timestamp = headers.get("x-webhook-timestamp", "")
    secret = CASHFREE_WEBHOOK_SECRET or CASHFREE_SECRET_KEY
    if not secret:
        logger.error("[ADVANCED][PAYMENT] Cashfree webhook secret missing")
        return _plain_response(403, "Webhook secret missing")
    signed = (timestamp + raw_body).encode("utf-8")
    expected = base64.b64encode(hmac.new(secret.encode(), signed, hashlib.sha256).digest()).decode()
    if not signature or not hmac.compare_digest(signature, expected):
        logger.error("[ADVANCED][PAYMENT] Invalid Cashfree signature")
        return _plain_response(403, "Invalid signature")
    payload = json.loads(raw_body or "{}")
    data = payload.get("data", {}) or {}
    order = data.get("order", {}) or {}
    payment = data.get("payment", {}) or {}
    # The custom fields we set on the payment link come back as link_notes;
    # for order-flow webhooks they may ride on order_tags.
    notes = data.get("link_notes") or order.get("order_tags") or {}
    status = str(
        data.get("link_status")
        or payment.get("payment_status")
        or order.get("order_status")
        or ""
    ).upper()
    is_paid = status in {"PAID", "SUCCESS", "ACTIVE_PAID", "PARTIALLY_PAID"} \
        or str(payment.get("payment_status", "")).upper() == "SUCCESS"
    if not is_paid:
        logger.info("[PAYMENT_FLOW] Webhook ignored - Status '%s' is not a paid status", status)
        return _json_response(200, {"handled": False, "reason": "not a paid event", "status": status})
    payment_id = str(
        payment.get("cf_payment_id")
        or data.get("cf_link_id")
        or data.get("link_id")
        or order.get("order_id")
        or ""
    )
    logger.info("[PAYMENT_FLOW] Cashfree webhook received - Status: %s, Payment ID: %s, ARN: %s, Ticket ID: %s", 
                status, payment_id, notes.get("arn", ""), notes.get("ticket_id", ""))
    return _finalize_captured_payment(notes, payment_id)


def _track_order_prompt(phone: str) -> bool:
    _save_adv_state(phone, "tracking_input", {})
    return send_whatsapp_text(phone, "📦 Apna Order ID (ARN) bhejein\nExample: AX202506481293")


def _show_order_status(phone: str, arn: str) -> bool:
    arn = arn.strip().upper()
    if PLATFORM_UTILS and not arn_valid(arn):
        return send_whatsapp_text(phone, "Order ID format valid nahi hai. Example: ARN-2026-847291")
    if not PLATFORM_UTILS and not ARN_RE.match(arn):
        return send_whatsapp_text(phone, "Order ID format valid nahi hai. Example: AX202506481293")
    item = table.get_item(Key={"pk": f"ORDER#{arn}"}).get("Item") or {}
    if not item:
        return send_whatsapp_text(phone, "Yeh Order ID humse match nahi kar raha. Please check karein ya humse contact karein.")
    history = item.get("status_history", [])
    lines = [f"✅ {h.get('status')} — {str(h.get('timestamp', ''))[:10]}" for h in history[-6:]]
    done = {h.get("status") for h in history}
    for status in ("Processing", "Shipped", "Delivered"):
        if status not in done:
            lines.append(f"⏳ {status} — pending")
    msg = (
        f"📦 *Order Status*\n\n🔖 Order ID: {arn}\n"
        f"📦 Product: {item.get('product_name', '')}\n"
        f"📊 Status: {item.get('current_status', '')}\n\n"
        "📅 *Status History:*\n" + "\n".join(lines) + "\n\n_Kisi bhi help ke liye reply karein_"
    )
    _clear_adv_state(phone)
    return send_whatsapp_text(phone, msg)


def create_exporter_ticket(exporter_data: dict) -> str:
    ticket_id = str(uuid.uuid4())
    item = {
        "pk": f"TICKET#EXPORTER#{ticket_id}",
        "sk": "METADATA",
        "ticket_id": ticket_id,
        "created_at": _now(),
        "status": "new",
        "ttl": _ttl(730),
    }
    item.update(exporter_data)
    table.put_item(Item=item)
    logger.info("[ADVANCED][TICKET] Exporter ticket created: %s", ticket_id)
    return ticket_id


def parse_broadcast_list(s3_key: str) -> list[dict]:
    if not BROADCAST_BUCKET or not s3_key:
        return []
    try:
        obj = s3.get_object(Bucket=BROADCAST_BUCKET, Key=s3_key)
        body = obj["Body"].read()
        recipients: list[dict] = []
        if s3_key.lower().endswith(".csv"):
            text = body.decode("utf-8-sig")
            rows = csv.DictReader(io.StringIO(text))
            recipients = [dict(row) for row in rows]
        elif s3_key.lower().endswith(".xlsx"):
            import openpyxl
            workbook = openpyxl.load_workbook(io.BytesIO(body), read_only=True, data_only=True)
            sheet = workbook.active
            header = [str(c.value or "").strip().lower() for c in next(sheet.rows)]
            for row in sheet.iter_rows(min_row=2):
                recipients.append({header[i]: cell.value for i, cell in enumerate(row) if i < len(header)})
    except Exception as e:
        logger.error("[ADVANCED][BROADCAST] list parse failed: %s", e, exc_info=True)
        return []
    clean = []
    for row in recipients:
        phone = re.sub(r"[^\d+]", "", str(row.get("whatsapp") or row.get("mobile") or row.get("phone") or ""))
        if MOBILE_RE.match(phone):
            row["whatsapp"] = phone
            clean.append(row)
    return clean


def _upload_base64_image_to_s3(base64_data: str, batch_id: str) -> str:
    """Upload base64 image to S3 and return public URL for WhatsApp."""
    try:
        # Strip data URI prefix if present: "data:image/jpeg;base64,/9j/..."
        if "," in base64_data:
            header, data = base64_data.split(",", 1)
            ext = "jpg"
            if "png" in header:
                ext = "png"
            elif "gif" in header:
                ext = "gif"
            elif "webp" in header:
                ext = "webp"
        else:
            data = base64_data
            ext = "jpg"

        img_bytes = base64.b64decode(data)
        key = f"broadcast-images/{batch_id}.{ext}"
        content_type = f"image/{ext}" if ext != "jpg" else "image/jpeg"

        s3.put_object(
            Bucket=S3_BUCKET_FOR_CATALOGUE_MEDIA,
            Key=key,
            Body=img_bytes,
            ContentType=content_type,
        )
        region = os.environ.get("AWS_REGION", "ap-southeast-1")
        public_url = f"https://{S3_BUCKET_FOR_CATALOGUE_MEDIA}.s3.{region}.amazonaws.com/{key}"
        logger.info("[ADVANCED][BROADCAST] Image uploaded to S3: %s", public_url)
        return public_url
    except Exception as e:
        logger.error("[ADVANCED][BROADCAST] Image upload failed: %s", e)
        return ""


def _normalize_phone(phone_raw: str) -> str:
    """Normalize phone number to WhatsApp format (country code + number, no + or spaces)."""
    phone_str = str(phone_raw or "").strip()
    # Remove +, spaces, dashes, brackets
    digits = re.sub(r"\D", "", phone_str)
    # Handle scientific notation from Excel (e.g. 9.18767E+11)
    if not digits and "E" in phone_str.upper():
        try:
            digits = str(int(float(phone_str)))
        except Exception:
            pass
    # India 10-digit — add 91
    if len(digits) == 10 and digits[0] in "6789":
        return f"91{digits}"
    # Already has country code (12-13 digits starting with 91)
    if len(digits) == 12 and digits.startswith("91"):
        return digits
    # International — return as-is if 10+ digits
    if len(digits) >= 10:
        return digits
    return ""


def start_broadcast(
    s3_key: str,
    message: str,
    media_url: str | None = None,
    recipients_direct: list[dict] | None = None,
) -> str:
    """
    Queue and SEND a broadcast to all recipients.

    recipients_direct: list of dicts with 'name' and 'whatsapp' or 'phone' keys.
                       If provided, s3_key is ignored.
    media_url:         Public image URL OR base64 data URI (data:image/...;base64,...).
                       Base64 images are auto-uploaded to S3.
    """
    batch_id = str(uuid.uuid4())

    # ── Step 1: Get recipients ──
    if recipients_direct:
        recipients = recipients_direct
        logger.info("[ADVANCED][BROADCAST] Using %d direct recipients", len(recipients))
    else:
        recipients = parse_broadcast_list(s3_key)

    if not recipients:
        logger.warning("[ADVANCED][BROADCAST] No recipients found for batch %s", batch_id)

    # ── Step 2: Handle base64 image — upload to S3 for public URL ──
    final_media_url = media_url or ""
    if final_media_url.startswith("data:image"):
        final_media_url = _upload_base64_image_to_s3(final_media_url, batch_id)

    # ── Step 3: Save ONLY metadata to DynamoDB (no recipients list, no base64) ──
    try:
        table.put_item(Item={
            "pk": f"BROADCAST#{batch_id}",
            "batch_id": batch_id,
            "created_at": _now(),
            "created_by": "admin",
            "total_numbers": len(recipients),
            "success_count": 0,
            "failed_count": 0,
            "message_template": message[:500],        # cap at 500 chars
            "media_url": (final_media_url or "")[:500],  # S3 URL only, no base64
            "status": "sending",
        })
    except Exception as e:
        logger.error("[ADVANCED][BROADCAST] DynamoDB metadata save failed: %s", e)
        # Continue anyway — sending is more important than logging

    # ── Step 4: ACTUALLY SEND messages to each recipient ──
    success = 0
    failed = 0
    for recipient in recipients:
        # Support multiple column name formats
        name = (
            recipient.get("name") or recipient.get("Name") or
            recipient.get("NAME") or recipient.get("customer_name") or "Customer"
        )
        phone_raw = (
            recipient.get("whatsapp") or recipient.get("WhatsApp Number") or
            recipient.get("phone") or recipient.get("Phone") or
            recipient.get("mobile") or recipient.get("Mobile") or
            recipient.get("number") or recipient.get("Number") or ""
        )
        phone = _normalize_phone(str(phone_raw))
        if not phone or len(phone) < 10:
            logger.warning("[ADVANCED][BROADCAST] Skipping invalid phone: %s", phone_raw)
            failed += 1
            continue

        # Personalize message: {name} → recipient's name
        personalized_msg = message.replace("{name}", name)

        try:
            if final_media_url:
                sent = _send_image(phone, final_media_url, personalized_msg)
            else:
                sent = send_whatsapp_text(phone, personalized_msg)

            if sent:
                success += 1
                logger.info("[ADVANCED][BROADCAST] Sent to %s (%s)", phone, name)
            else:
                failed += 1
                logger.warning("[ADVANCED][BROADCAST] Failed to send to %s", phone)

            # Small delay to avoid WhatsApp rate limits (1 msg/sec safe)
            import time as _time
            _time.sleep(1)

        except Exception as e:
            failed += 1
            logger.error("[ADVANCED][BROADCAST] Error sending to %s: %s", phone, e)

    # ── Step 5: Update batch status ──
    try:
        table.update_item(
            Key={"pk": f"BROADCAST#{batch_id}"},
            UpdateExpression="SET #s = :s, success_count = :sc, failed_count = :fc",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": "completed", ":sc": success, ":fc": failed},
        )
    except Exception as e:
        logger.error("[ADVANCED][BROADCAST] Status update failed: %s", e)

    logger.info(
        "[ADVANCED][BROADCAST] Batch %s done — sent: %d, failed: %d",
        batch_id, success, failed
    )
    return batch_id


def _verify_totp(code: str) -> bool:
    if not ADMIN_TOTP_SECRET:
        return False
    try:
        import pyotp
        return bool(pyotp.TOTP(ADMIN_TOTP_SECRET).verify(code, valid_window=1))
    except Exception:
        return False


def _admin_session_token() -> str:
    try:
        from admin_session import legacy_hour_token
        return legacy_hour_token()
    except Exception:
        seed = f"{ADMIN_TOTP_SECRET}:{datetime.utcnow().strftime('%Y%m%d%H')}"
        return hmac.new(seed.encode(), b"aarvex-admin", hashlib.sha256).hexdigest()


def _admin_authorized(event: dict) -> bool:
    if not ADMIN_TOTP_SECRET:
        logger.error("[SECURITY] Admin request denied — ADMIN_TOTP_SECRET not configured.")
        return False
    try:
        from admin_session import extract_admin_token, session_valid
        token = extract_admin_token(event)
        return session_valid(token)
    except Exception:
        headers = event.get("headers") or {}
        token = (
            headers.get("X-Admin-Session")
            or headers.get("x-admin-session")
            or headers.get("Authorization", "").replace("Bearer ", "")
        )
        return bool(token and hmac.compare_digest(token, _admin_session_token()))


def _event_body(event: dict) -> dict:
    body = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8")
    return json.loads(body or "{}")


def _admin_stats() -> dict:
    tickets = _scan_by_pk_prefix("TICKET#IMPORTER#")
    today = datetime.now(timezone.utc).date().isoformat()
    today_tickets = [t for t in tickets if str(t.get("created_at", "")).startswith(today)]
    revenue = sum(
        (_decimal(t.get("payment_amount")) for t in today_tickets if t.get("payment_status") == "completed"),
        Decimal("0"),
    )
    stats = {
        "total_orders_today": len(today_tickets),
        "revenue_today": revenue,
        "pending_payments": len([t for t in tickets if t.get("payment_status") == "pending"]),
        "new_exporters": len(_scan_by_pk_prefix("TICKET#EXPORTER#")),
    }
    if MARKETPLACE_AVAILABLE:
        stats.update(admin_marketplace_stats())
    return stats


def get_admin_api_handler(event: dict) -> dict:
    method = event.get("requestContext", {}).get("http", {}).get("method") or event.get("httpMethod", "GET")
    if method == "OPTIONS":
        return _json_response(200, {})
    path = event.get("rawPath") or event.get("path") or ""
    if MARKETPLACE_AVAILABLE:
        mp_resp = handle_portal_route(event)
        if mp_resp is not None:
            return mp_resp
    if path.endswith("/verify-totp") and method == "POST":
        try:
            from admin_session import is_locked_out, record_totp_failure, create_admin_session
            locked, rem = is_locked_out()
            if locked:
                return _json_response(429, {
                    "success": False,
                    "message": f"Too many failed attempts. Try again in {max(1, rem // 60)} min.",
                    "locked_seconds": rem,
                })
            code = _event_body(event).get("code", "")
            if _verify_totp(code):
                session = create_admin_session()
                return _json_response(200, {"success": True, "session": session})
            info = record_totp_failure()
            if info.get("locked_until"):
                return _json_response(429, {
                    "success": False,
                    "message": "Too many failed attempts. Locked for 15 minutes.",
                })
            return _json_response(403, {"success": False, "message": "Invalid code. Try again."})
        except Exception as e:
            logger.exception("[ADMIN] verify-totp failed: %s", e)
            code = _event_body(event).get("code", "")
            if _verify_totp(code):
                return _json_response(200, {"success": True, "session": _admin_session_token()})
            return _json_response(403, {"success": False, "message": "Invalid code"})
    if path.endswith("/logout") and method == "POST":
        try:
            from admin_session import extract_admin_token, revoke_admin_session
            revoke_admin_session(extract_admin_token(event))
        except Exception:
            pass
        return _json_response(200, {"success": True})
    if not _admin_authorized(event):
        return _json_response(403, {"error": "Unauthorized"})
    if path.endswith("/stats"):
        return _json_response(200, _admin_stats())
    if path.endswith("/tickets"):
        ticket_type = (event.get("queryStringParameters") or {}).get("type", "importer").upper()
        items = _scan_by_pk_prefix(f"TICKET#{ticket_type}#")[:100]
        return _json_response(200, {"tickets": items, "total": len(items), "page": 1})
    if "/admin/api/order/" in path and path.endswith("/status") and method == "POST":
        arn = path.split("/admin/api/order/", 1)[1].split("/", 1)[0]
        order = table.get_item(Key={"pk": f"ORDER#{arn}"}).get("Item") or {}
        status = _event_body(event).get("status", "")
        ok = bool(order and status and update_ticket_status(order.get("ticket_id"), "importer", status, "admin"))
        return _json_response(200, {"success": ok})
    if "/admin/api/order/" in path and method == "GET":
        arn = path.rsplit("/", 1)[-1]
        order = table.get_item(Key={"pk": f"ORDER#{arn}"}).get("Item") or {}
        ticket = _get_importer_ticket(order.get("ticket_id", "")) if order else {}
        return _json_response(200, {"order": order, "ticket": ticket})
    if path.endswith("/broadcast") and method == "POST":
        body = _event_body(event)
        recipients_direct = body.get("recipients") or None  # direct list from dashboard
        batch_id = start_broadcast(
            s3_key=body.get("s3_key", ""),
            message=body.get("message", ""),
            media_url=body.get("media_url"),
            recipients_direct=recipients_direct,
        )
        return _json_response(200, {"batch_id": batch_id})
    if path.endswith("/feedbacks"):
        items = _scan_by_pk_prefix("FEEDBACK#")
        items.sort(key=lambda x: x.get("created_at", ""), reverse=True)
        # Mark all as read
        for item in items:
            if item.get("status") == "unread":
                try:
                    table.update_item(
                        Key={"pk": item["pk"]},
                        UpdateExpression="SET #s = :r",
                        ExpressionAttributeNames={"#s": "status"},
                        ExpressionAttributeValues={":r": "read"},
                    )
                except Exception:
                    pass
        return _json_response(200, {"feedbacks": items[:200], "total": len(items)})
    if path.endswith("/feedbacks/unread-count"):
        items = _scan_by_pk_prefix("FEEDBACK#")
        unread = sum(1 for i in items if i.get("status") == "unread")
        return _json_response(200, {"unread": unread, "total": len(items)})

    # ── Portal telemetry Command Center ──
    try:
        import ax_telemetry as _ax_tel
        def _tel_rate(user_sub, action, limit=40, window_seconds=60):
            # Admin module has no shared rate limiter — fail-open.
            return False
        if not getattr(_ax_tel, "_BOUND_ADMIN", False):
            _ax_tel._bind({
                "table": table,
                "json_response": _json_response,
                "event_body": _event_body,
                "admin_authorized": _admin_authorized,
                "rate_limited": _tel_rate,
                "scan_by_pk_prefix": _scan_by_pk_prefix,
            })
            _ax_tel._BOUND_ADMIN = True
        if path.endswith("/telemetry") and method == "GET":
            return _ax_tel.handle_admin_telemetry_list(event)
        if path.endswith("/telemetry/ack") and method == "POST":
            return _ax_tel.handle_admin_telemetry_ack(event)
        if path.endswith("/setup-map") and method == "GET":
            return _ax_tel.handle_admin_setup_map(event)
    except Exception as _tel_e:
        logger.warning("[TELEMETRY] admin route failed: %s", _tel_e)

    # ── DELETE FEEDBACK ──
    if "/admin/api/feedback/" in path and path.endswith("/delete") and method == "POST":
        body = _event_body(event)
        feedback_id = body.get("feedback_id") or path.split("/admin/api/feedback/", 1)[1].split("/", 1)[0]
        pk = feedback_id if feedback_id.startswith("FEEDBACK#") else f"FEEDBACK#{feedback_id}"
        try:
            table.delete_item(Key={"pk": pk})
            logger.info(f"[ADMIN] Feedback deleted: {pk}")
            return _json_response(200, {"success": True, "deleted": feedback_id})
        except Exception as e:
            logger.error(f"[ADMIN] Feedback delete failed: {e}")
            return _json_response(500, {"success": False, "error": str(e)})
    # ── DELETE TICKET ──
    if "/admin/api/ticket/" in path and path.endswith("/delete") and method == "POST":
        body = _event_body(event)
        ticket_id = body.get("ticket_id") or path.split("/admin/api/ticket/", 1)[1].split("/", 1)[0]
        ticket_type = (body.get("ticket_type") or "importer").upper()
        pk = f"TICKET#{ticket_type}#{ticket_id}"
        try:
            # Try with sk="METADATA" first (composite key), fallback to pk-only
            try:
                table.delete_item(Key={"pk": pk, "sk": "METADATA"})
            except Exception:
                table.delete_item(Key={"pk": pk})
            logger.info(f"[ADMIN] Ticket deleted: {pk}")
            return _json_response(200, {"success": True, "deleted": ticket_id})
        except Exception as e:
            logger.error(f"[ADMIN] Delete failed: {e}")
            return _json_response(500, {"success": False, "error": str(e)})
    # ── PRODUCT CATALOGUE — LIST ALL (admin: includes inactive) ──────────────
    if path.endswith("/catalogue/list") and method == "GET":
        try:
            all_items = list(_scan_by_pk_prefix("CATALOGUE#CATEGORY#"))
            cats: dict = {}
            for item in all_items:
                cid = item.get("category_id", "")
                cname = item.get("category_name", cid.replace("_", " ").title())
                cats.setdefault(cid, {"category_id": cid, "category_name": cname, "products": []})
                cats[cid]["products"].append(item)
            logger.info(f"[ADMIN] Catalogue list: {len(all_items)} items, {len(cats)} categories")
            return _json_response(200, {"categories": list(cats.values()), "total_items": len(all_items)})
        except Exception as e:
            logger.error(f"[ADMIN] Catalogue list failed: {e}")
            return _json_response(500, {"error": str(e)})

    # ── PRODUCT CATALOGUE — UPSERT (add / edit) ──────────────────────────────
    if path.endswith("/catalogue/upsert") and method == "POST":
        body = _event_body(event)
        category_id  = (body.get("category_id") or "").strip().lower().replace(" ", "_")
        category_name = (body.get("category_name") or category_id.replace("_", " ").title()).strip()
        product_name  = (body.get("product_name") or "").strip()
        product_id    = (body.get("product_id") or "").strip()
        if not product_id:
            product_id = product_name.lower().replace(" ", "_")
            import re as _re
            product_id = _re.sub(r"[^a-z0-9_]", "", product_id)[:40]
        if not category_id or not product_name or not product_id:
            return _json_response(400, {"error": "category_id, product_name required"})
        pk = f"CATALOGUE#CATEGORY#{category_id}#{product_id}"
        try:
            item = {
                "pk":             pk,
                "category_id":    category_id,
                "category_name":  category_name,
                "product_id":     product_id,
                "product_name":   product_name,
                "description":    (body.get("description") or "").strip(),
                "price_per_kg":   Decimal(str(body.get("price_per_kg") or 0)),
                "min_order_kg":   Decimal(str(body.get("min_order_kg") or 0)),
                "available_stock": (body.get("available_stock") or "In Stock").strip(),
                "image_url":      (body.get("image_url") or "").strip(),
                "is_active":      bool(body.get("is_active", True)),
                "updated_at":     datetime.now(timezone.utc).isoformat(),
            }
            table.put_item(Item=item)
            logger.info(f"[ADMIN] Catalogue upsert OK: {pk}")
            return _json_response(200, {"success": True, "pk": pk, "product_id": product_id})
        except Exception as e:
            logger.error(f"[ADMIN] Catalogue upsert failed: {e}")
            return _json_response(500, {"error": str(e)})

    # ── PAYOUTS — LIST (pending/paid seller + delivery-partner settlements) ──
    if path.endswith("/payouts/list") and method == "GET":
        if not PLATFORM_UTILS:
            return _json_response(503, {"error": "Payout tracking unavailable"})
        qs = event.get("queryStringParameters") or {}
        status = (qs.get("status") or "").strip() or None
        payee_type = (qs.get("payee_type") or "").strip() or None
        try:
            payouts = list_payouts(status=status, payee_type=payee_type)
            return _json_response(200, {"payouts": payouts, "total": len(payouts)})
        except Exception as e:
            logger.error(f"[ADMIN] Payout list failed: {e}")
            return _json_response(500, {"error": str(e)})

    # ── PAYOUTS — bank details for one payout, decrypted just-in-time ────────
    # Never logged, never cached, never returned except in this direct
    # admin-authorized response — used right before making the transfer.
    if "/payouts/" in path and path.endswith("/bank-details") and method == "GET":
        if not PLATFORM_UTILS:
            return _json_response(503, {"error": "Payout tracking unavailable"})
        payee_sub = (event.get("queryStringParameters") or {}).get("payee_sub", "")
        if not payee_sub:
            return _json_response(400, {"error": "payee_sub required"})
        try:
            details = get_bank_details_for_payout(payee_sub)
            return _json_response(200, details)
        except Exception as e:
            logger.error(f"[ADMIN] Bank detail fetch failed: {e}")
            return _json_response(500, {"error": str(e)})

    # ── PAYOUTS — MARK PAID (admin confirms bank transfer was sent) ──────────
    if path.endswith("/payouts/mark-paid") and method == "POST":
        if not PLATFORM_UTILS:
            return _json_response(503, {"error": "Payout tracking unavailable"})
        body = _event_body(event)
        payout_id = (body.get("payout_id") or "").strip()
        paid_ref = (body.get("paid_ref") or "").strip()
        admin_id = (body.get("admin_id") or "admin").strip()
        if not payout_id:
            return _json_response(400, {"error": "payout_id required"})
        try:
            ok = mark_payout_paid(payout_id, admin_id, paid_ref)
            return _json_response(200, {"success": ok})
        except Exception as e:
            logger.error(f"[ADMIN] Mark payout paid failed: {e}")
            return _json_response(500, {"error": str(e)})

    # ── PRODUCT CATALOGUE — DELETE ────────────────────────────────────────────
    if path.endswith("/catalogue/delete") and method == "POST":
        body = _event_body(event)
        pk = (body.get("pk") or "").strip()
        if not pk or not pk.startswith("CATALOGUE#"):
            cid = (body.get("category_id") or "").strip().lower().replace(" ", "_")
            pid = (body.get("product_id") or "").strip()
            if not cid or not pid:
                return _json_response(400, {"error": "pk or (category_id + product_id) required"})
            pk = f"CATALOGUE#CATEGORY#{cid}#{pid}"
        try:
            table.delete_item(Key={"pk": pk})
            logger.info(f"[ADMIN] Catalogue deleted: {pk}")
            return _json_response(200, {"success": True, "deleted": pk})
        except Exception as e:
            logger.error(f"[ADMIN] Catalogue delete failed: {e}")
            return _json_response(500, {"error": str(e)})

    return _json_response(404, {"error": "Not found"})


def _normalize_web_mobile(mobile: str) -> str:
    """Web form sends a bare 10-digit Indian number; WhatsApp Cloud API needs
    the country code attached (no '+', no spaces) to address a contact."""
    digits = re.sub(r"\D", "", mobile or "")
    if len(digits) == 10:
        return f"91{digits}"
    return digits


def handle_web_order(event: dict) -> dict:
    """
    Public, unauthenticated endpoint for the S3-hosted order-form.html.
    Accepts a JSON order from the browser, reuses the SAME ticket-creation
    pipeline as the WhatsApp flow (create_importer_ticket + Razorpay link),
    then sends the customer a WhatsApp confirmation/payment message.

    This is intentionally NOT behind _verify_meta_signature in lambda_handler.py
    because the request originates from a browser form, not from Meta's webhook.
    """
    method = event.get("requestContext", {}).get("http", {}).get("method") or event.get("httpMethod", "POST")
    if method == "OPTIONS":
        return _json_response(200, {})

    try:
        body = _event_body(event)
    except (json.JSONDecodeError, ValueError):
        return _json_response(400, {"error": "Invalid JSON body"})

    _logged_in_user = _auth_user(event) if MARKETPLACE_AVAILABLE else None
    _logged_in_sub = _logged_in_user.get("sub", "") if _logged_in_user else ""

    category_id = (body.get("category_id") or "").strip()
    product_id = (body.get("product_id") or "").strip()
    order_type = (body.get("order_type") or "bulk").strip().lower()
    quantity_kg = body.get("quantity_kg")
    purchase_option = (body.get("purchase_option") or "").strip().lower()  # 'quarter' | 'half' | 'full' (bulk only)
    customer_name = (body.get("customer_name") or "").strip()
    company_name = (body.get("company_name") or "").strip()
    mobile_raw = (body.get("mobile") or "").strip()
    email = (body.get("email") or "").strip()
    gst_number = (body.get("gst_number") or "").strip()

    # ── Delivery address: either a saved address_id (address book, built on
    # the Leaflet + Geocoder location picker) or raw address fields sent
    # directly (kept for backward compatibility / non-logged-in buyers). ──
    address_id = (body.get("address_id") or "").strip()
    address = (body.get("address") or "").strip()
    city = (body.get("city") or "").strip()
    state_name = (body.get("state") or "").strip()
    country = (body.get("country") or "India").strip()
    pincode = (body.get("pincode") or "").strip()
    addr_lat = body.get("address_lat")
    addr_lng = body.get("address_lng")

    if address_id:
        _logged_in_user_early = _auth_user(event) if MARKETPLACE_AVAILABLE else None
        _sub_for_addr = _logged_in_user_early.get("sub", "") if _logged_in_user_early else ""
        saved_addr = table.get_item(Key={"pk": f"ADDRESS#{_sub_for_addr}#{address_id}"}).get("Item") or {} if _sub_for_addr else {}
        if not saved_addr:
            return _json_response(400, {"error": "Selected address not found. Please pick or add an address again."})
        address = saved_addr.get("address", "")
        city = saved_addr.get("city", "")
        state_name = saved_addr.get("state", "")
        pincode = saved_addr.get("pincode", pincode)
        addr_lat = saved_addr.get("lat", addr_lat)
        addr_lng = saved_addr.get("lng", addr_lng)

    missing = [
        field for field, value in (
            ("product_id", product_id), ("quantity_kg", quantity_kg if not purchase_option else "ok"),
            ("customer_name", customer_name), ("company_name", company_name),
            ("mobile", mobile_raw), ("email", email), ("address", address),
            ("city", city), ("state", state_name),
        ) if not value
    ]
    if missing:
        return _json_response(400, {"error": f"Missing required fields: {', '.join(missing)}"})

    recaptcha_token = (body.get("recaptcha_token") or "").strip()
    if not verify_recaptcha(recaptcha_token):
        return _json_response(400, {"error": "Captcha verification failed. Please try again."})

    if order_type not in ("sample", "bulk"):
        order_type = "bulk"

    if not EMAIL_RE.match(email):
        return _json_response(400, {"error": "Invalid email address"})

    mobile_digits = re.sub(r"\D", "", mobile_raw)
    if not MOBILE_RE.match(mobile_digits):
        return _json_response(400, {"error": "Invalid mobile number"})

    if gst_number and not GST_RE.match(gst_number):
        return _json_response(400, {"error": "Invalid GST number format"})

    product = _get_product(category_id, product_id) if category_id else {}
    if not product:
        # Fall back to scanning all categories for this product_id, in case
        # the form only knows the product_id and not its category.
        for item in _scan_catalogue():
            sk = item.get("sk") or item.get("SK") or ""
            pid = item.get("product_id") or sk.replace("PRODUCT#", "") or _safe_product_id(item.get("product_name", ""))
            if pid == product_id:
                product = item
                category_id = item.get("category_id", category_id)
                break

    if not product:
        logger.error("[WEB_ORDER] Product not found in catalogue: category=%s product_id=%s", category_id, product_id)
        return _json_response(404, {"error": "Product not found in catalogue. Please contact support."})

    # ── Quantity from FREE stock (available − committed). Public
    # available_stock_kg is unchanged until order COMPLETE.
    available_now = _decimal(product.get("available_stock_kg"), _decimal(product.get("lot_size_kg", 0)))
    committed_now = _decimal(product.get("committed_kg", 0))
    free_now = available_now - committed_now
    if free_now < 0:
        free_now = Decimal("0")
    if order_type == "bulk" and purchase_option in ("quarter", "half", "full"):
        fraction = {"quarter": Decimal("0.25"), "half": Decimal("0.5"), "full": Decimal("1")}[purchase_option]
        qty = (free_now * fraction) if purchase_option != "full" else free_now
        if qty <= 0:
            return _json_response(409, {"error": "This product is out of stock for new orders."})
    else:
        qty = _decimal(quantity_kg, Decimal("-1"))
        if qty <= 0:
            return _json_response(400, {"error": "quantity_kg must be a positive number"})
        if qty > free_now:
            return _json_response(409, {
                "error": f"Only {free_now} kg available for new orders — please refresh and choose a smaller quantity.",
            })

    whatsapp_number = _normalize_web_mobile(mobile_digits)

    order_data = {
        "category_id": category_id,
        "product_id": product_id,
        "product": product,
        "order_type": order_type,
        "quantity_kg": qty,
        "customer_name": customer_name,
        "company_name": company_name,
        "mobile": mobile_digits,
        "whatsapp_number": whatsapp_number,
        "email": email,
        "address": address,
        "city": city,
        "state": state_name,
        "country": country,
        "gst_number": gst_number,
        "pincode": pincode,
        "delivery_pincode": pincode,
        "user_sub": _logged_in_sub,
    }

    # ── Destination coordinates for live delivery tracking ──
    # Prefer the precise lat/lng from the Leaflet + Geocoder location picker
    # (either just-picked, sent as address_lat/address_lng, or pulled from a
    # saved address book entry above) — far more accurate than a pincode
    # centroid. Pincode geocoding is kept only as a fallback.
    try:
        _addr_lat = float(addr_lat or 0)
        _addr_lng = float(addr_lng or 0)
    except (TypeError, ValueError):
        _addr_lat = _addr_lng = 0.0
    if _addr_lat and _addr_lng:
        order_data["dest_lat"] = _addr_lat
        order_data["dest_lng"] = _addr_lng
    else:
        if pincode and PLATFORM_UTILS:
            try:
                geo = geocode_pincode(pincode)
                if geo:
                    order_data["dest_lat"], order_data["dest_lng"] = geo
                    logger.info(f"[GEOCODE] Pincode {pincode} -> {geo}")
            except Exception as _ge:
                logger.warning(f"[GEOCODE] Failed for pincode {pincode}: {_ge}")

    try:
        ticket_id = create_importer_ticket(order_data)
        ticket = _get_importer_ticket(ticket_id)
    except Exception as e:
        logger.error("[WEB_ORDER] Ticket creation failed: %s", e, exc_info=True)
        return _json_response(500, {"error": "Could not create order. Please try again or contact support."})

    payment_method = (body.get("payment_method") or "online").strip().lower()
    is_cod = payment_method == "cod"

    link = {}
    order_session = {}
    if not is_cod:
        try:
            # Cashfree is the live gateway (same as the WhatsApp flow in
            # _confirm_order_and_payment). Legacy razorpay_* keys are kept so
            # existing webhook/readers that look them up keep working. The link
            # is still created so the WhatsApp payment message keeps working.
            link = create_cashfree_payment_link(ticket) or {}
            if link:
                _update_importer_ticket(ticket_id, {
                    "payment_link_id": link.get("id", ""),
                    "payment_link_url": link.get("short_url", ""),
                    "razorpay_payment_link_id": link.get("id", ""),  # legacy key
                    "razorpay_payment_link_url": link.get("short_url", ""),  # legacy key
                })
                ticket["razorpay_payment_link_url"] = link.get("short_url", "")
        except Exception as e:
            logger.error("[WEB_ORDER] Cashfree link creation failed: %s", e, exc_info=True)
        # In-app checkout: a Cashfree ORDER gives a payment_session_id the
        # frontend JS SDK uses to open the payment modal right inside the app.
        try:
            order_session = create_cashfree_order(ticket) or {}
            if order_session.get("order_id"):
                _update_importer_ticket(ticket_id, {"cf_order_id": order_session.get("order_id", "")})
        except Exception as e:
            logger.error("[WEB_ORDER] Cashfree order creation failed: %s", e, exc_info=True)
    else:
        _update_importer_ticket(ticket_id, {
            "payment_method": "cod",
            "payment_status": "cod_pending",
        })
        arn = ticket.get("arn", "")
        if arn and PLATFORM_UTILS:
            try:
                import delivery as _del
                import marketplace as _mp
                _del._bind_delivery_helpers(_mp)
                bd = ticket.get("payment_breakdown") or {}
                seller_sub = ""
                is_seller_product = False
                product_pk = ticket.get("product_pk", "")
                if product_pk:
                    product_item = table.get_item(Key={"pk": product_pk}).get("Item") or {}
                    is_seller_product = bool(product_item.get("is_seller_product"))
                    seller_sub = product_item.get("seller_user_sub", "")
                    shop_id = product_item.get("shop_id", "")
                    if not seller_sub and shop_id:
                        shop = table.get_item(Key={"pk": f"SHOP#{shop_id}"}).get("Item") or {}
                        seller_sub = shop.get("user_sub", "")
                # Resolve shopkeeper's permanent address coords for pickup.
                _cod_s_lat = float(ticket.get("seller_lat", 0) or (product_item.get("address_lat", 0) if product_pk else 0) or 0)
                _cod_s_lng = float(ticket.get("seller_lng", 0) or (product_item.get("address_lng", 0) if product_pk else 0) or 0)
                if (not _cod_s_lat or not _cod_s_lng) and product_pk:
                    _cod_shop = shop if 'shop' in dir() else {}
                    if not _cod_shop and shop_id:
                        _cod_shop = table.get_item(Key={"pk": f"SHOP#{shop_id}"}).get("Item") or {}
                    _cod_s_lat = float(_cod_shop.get("address_lat", 0) or 0)
                    _cod_s_lng = float(_cod_shop.get("address_lng", 0) or 0)
                    if (not _cod_s_lat or not _cod_s_lng) and PLATFORM_UTILS:
                        _cod_sp = _cod_shop.get("pincode") or _cod_shop.get("shop_pincode") or ""
                        if _cod_sp:
                            try:
                                _cod_geo = geocode_pincode(str(_cod_sp))
                                if _cod_geo:
                                    _cod_s_lat, _cod_s_lng = _cod_geo
                            except Exception:
                                pass
                _del.create_delivery_record(
                    arn=arn,
                    product_name=ticket.get("product_name", ""),
                    product_id=ticket.get("product_id", ""),
                    product_pk=product_pk,
                    importer_sub=ticket.get("importer_sub", ticket.get("user_sub", "")),
                    pickup_city=ticket.get("seller_city", ""),
                    # Shopkeeper permanent address for triangle rule.
                    pickup_lat=_cod_s_lat,
                    pickup_lng=_cod_s_lng,
                    # Full address TEXT for the strips (importer picked address,
                    # seller permanent address — best available).
                    dest_address=ticket.get("address", ""),
                    pickup_address=ticket.get("seller_address", "") or ticket.get("seller_city", ""),
                    delivery_city=ticket.get("city", ""),
                    delivery_pincode=ticket.get("pincode", ticket.get("delivery_pincode", "")),
                    lot_size_kg=float(ticket.get("quantity_kg", 0)),
                    distance_km=float(bd.get("distance_km", 15)),
                    delivery_charge=float(bd.get("delivery_charge", 50)),
                    # Importer order-form address.
                    dest_lat=float(ticket.get("dest_lat", 0) or 0),
                    dest_lng=float(ticket.get("dest_lng", 0) or 0),
                    is_cod=True,
                    cod_amount=float(bd.get("total", ticket.get("payment_amount", 0))),
                    seller_sub=seller_sub,
                    is_seller_product=is_seller_product,
                    lot_price=float(bd.get("lot_price", ticket.get("lot_price", 0))),
                    platform_fee=float(bd.get("platform_fee", ticket.get("platform_fee", 0))),
                    gst_amount=float(bd.get("gst_amount", ticket.get("gst_amount", 0))),
                    buyer_name=ticket.get("customer_name", ""),
                    buyer_email=ticket.get("email", ""),
                    buyer_mobile=ticket.get("whatsapp_number") or ticket.get("mobile", ""),
                    buyer_gst_number=ticket.get("gst_number", ""),
                )
                table.update_item(
                    Key={"pk": f"ORDER#{arn}"},
                    UpdateExpression="SET current_status = :s, last_updated = :u",
                    ExpressionAttributeValues={":s": "PENDING_DELIVERY", ":u": _now()},
                )
                # Stock is committed when create_delivery_record runs — public
                # available_stock_kg stays unchanged until OTP complete.
                if seller_sub:
                    try:
                        from marketplace import create_notification
                        create_notification(
                            seller_sub, "shop_status", "Order received!",
                            f"{ticket.get('quantity_kg', 0)} kg of {ticket.get('product_name', 'product')} ordered (COD). "
                            f"Order: {arn}. Stock stays listed until delivery is completed.",
                        )
                    except Exception:
                        pass
            except Exception as e:
                logger.error("[WEB_ORDER] COD delivery record: %s", e, exc_info=True)

    logger.info("[PAYMENT_FLOW] handle_web_order WhatsApp section - ARN: %s, Ticket ID: %s, Payment Method: %s, Has Link: %s", 
                ticket.get('arn'), ticket_id, 'COD' if is_cod else 'Online', bool(link))
    try:
        if is_cod:
            send_whatsapp_text(whatsapp_number, (
                "✅ *Order Confirmed (Cash on Delivery)*\n\n"
                f"🔖 Order ID: {ticket.get('arn')}\n"
                f"📦 {ticket.get('product_name')} ({ticket.get('quantity_kg')} kg)\n"
                f"💰 Amount to pay on delivery: {ticket.get('payment_currency')} {ticket.get('payment_amount')}\n\n"
                "Our delivery partner will collect cash upon delivery."
            ))
            logger.info("[PAYMENT_FLOW] Sent COD confirmation WhatsApp - ARN: %s", ticket.get('arn'))
        elif link:
            send_whatsapp_text(whatsapp_number, (
                "💳 *Payment Link Ready!*\n\n"
                f"📦 Order: {ticket.get('product_name')} ({ticket.get('quantity_kg')} kg)\n"
                f"💰 Amount: {ticket.get('payment_currency')} {ticket.get('payment_amount')}\n"
                f"🔖 Order ID: {ticket.get('arn')}\n\n"
                f"Neeche diye link se payment karein:\n👉 {ticket.get('razorpay_payment_link_url')}\n\n"
                "_Payment ke baad invoice automatically WhatsApp aur email par aayega_"
            ))
            logger.info("[PAYMENT_FLOW] Sent PAYMENT LINK WhatsApp (NOT registration) - ARN: %s, Link: %s", ticket.get('arn'), ticket.get('razorpay_payment_link_url'))
        else:
            send_whatsapp_text(whatsapp_number, (
                f"✅ Order register ho gaya.\n\n🔖 Order ID: {ticket.get('arn')}\n\n"
                f"📦 {ticket.get('product_name')} ({ticket.get('quantity_kg')} kg)\n\n"
                "Our team will contact you shortly with the payment link."
            ))
            logger.info("[PAYMENT_FLOW] Sent fallback WhatsApp (no link) - ARN: %s", ticket.get('arn'))
        _save_adv_state(whatsapp_number, "awaiting_payment", {"ticket_id": ticket_id, "arn": ticket.get("arn")})
    except Exception as e:
        # Order is already saved at this point — a WhatsApp send failure should
        # not make the form look like it failed, just log it.
        logger.error("[PAYMENT_FLOW] [WEB_ORDER] WhatsApp confirmation send FAILED - ARN: %s, Error: %s", ticket.get('arn'), e, exc_info=True)

    if MARKETPLACE_AVAILABLE and product.get("is_seller_product"):
        try:
            notify_seller_lead(product, customer_name, order_type, qty)
        except Exception as e:
            logger.error("[WEB_ORDER] Seller lead notification failed: %s", e)

    # Referral reward (Phase 2): a referred buyer's first order pays out both
    # sides. Best-effort — must never affect the order response.
    if MARKETPLACE_AVAILABLE and _logged_in_sub:
        try:
            import marketplace as _mp
            _mp._maybe_reward_referral(_logged_in_sub)
        except Exception as e:
            logger.warning("[WEB_ORDER] referral reward hook failed: %s", e)

    return _json_response(200, {
        "success": True,
        "arn": ticket.get("arn"),
        "ticket_id": ticket_id,
        "amount": str(ticket.get("payment_amount", "")),
        "currency": ticket.get("payment_currency", ""),
        "payment_link": ticket.get("razorpay_payment_link_url", ""),
        "payment_link_url": ticket.get("razorpay_payment_link_url", ""),
        "payment_method": "cod" if is_cod else "online",
        # In-app Cashfree checkout (frontend JS SDK opens the modal with these):
        "payment_session_id": order_session.get("payment_session_id", ""),
        "cf_order_id": order_session.get("order_id", ""),
        "payment_mode": order_session.get("mode", ""),
        "breakdown": ticket.get("payment_breakdown", {}),
        "gst_amount": ticket.get("gst_amount", 0),
    })


def handle_web_sell(event: dict) -> dict:
    """
    Public, unauthenticated endpoint for the S3-hosted sell-form.html.
    Mirrors handle_web_order() above, but for farmers/exporters: reuses the
    SAME create_exporter_ticket() pipeline as the WhatsApp "Sell Your Produce"
    flow (_start_sell_flow / _continue_sell_flow in lambda_handler.py), so
    web submissions show up in the admin dashboard's Exporters tab exactly
    like WhatsApp submissions do.

    This is intentionally NOT behind _verify_meta_signature in lambda_handler.py
    because the request originates from a browser form, not from Meta's webhook.
    """
    method = event.get("requestContext", {}).get("http", {}).get("method") or event.get("httpMethod", "POST")
    if method == "OPTIONS":
        return _json_response(200, {})

    try:
        body = _event_body(event)
    except (json.JSONDecodeError, ValueError):
        return _json_response(400, {"error": "Invalid JSON body"})

    crop = (body.get("crop") or "").strip()
    quantity_available_kg = body.get("quantity_available_kg")
    expected_price = body.get("expected_price")
    contact_name = (body.get("contact_name") or "").strip()
    mobile_raw = (body.get("mobile") or "").strip()
    email = (body.get("email") or "").strip()
    location_city = (body.get("location_city") or "").strip()
    location_state = (body.get("location_state") or "").strip()
    pincode = (body.get("pincode") or "").strip()

    missing = [
        field for field, value in (
            ("crop", crop), ("quantity_available_kg", quantity_available_kg),
            ("contact_name", contact_name), ("mobile", mobile_raw),
            ("location_city", location_city), ("location_state", location_state),
            # Pincode is now required so every produce listing has a pickup
            # location the delivery-triangle can geocode — without it a claimed
            # produce order would surface "incomplete location data" to the rider.
            ("pincode", pincode),
        ) if not value
    ]
    if missing:
        return _json_response(400, {"error": f"Missing required fields: {', '.join(missing)}"})

    recaptcha_token = (body.get("recaptcha_token") or "").strip()
    if not verify_recaptcha(recaptcha_token):
        return _json_response(400, {"error": "Captcha verification failed. Please try again."})

    qty = _decimal(quantity_available_kg, Decimal("-1"))
    if qty <= 0:
        return _json_response(400, {"error": "quantity_available_kg must be a positive number"})

    mobile_digits = re.sub(r"\D", "", mobile_raw)
    if not MOBILE_RE.match(mobile_digits):
        return _json_response(400, {"error": "Invalid mobile number"})

    if email and not EMAIL_RE.match(email):
        return _json_response(400, {"error": "Invalid email address"})

    price_decimal = _decimal(expected_price, Decimal("0")) if expected_price not in (None, "") else None

    whatsapp_number = _normalize_web_mobile(mobile_digits)

    exporter_data = {
        "contact_name": contact_name,
        "mobile": mobile_digits,
        "whatsapp_number": whatsapp_number,
        "email": email,
        "product_name": crop,
        "quantity_available_kg": qty,
        "location_city": location_city,
        "location_state": location_state,
        "pincode": pincode,
        "status": "new",
        "source": "web",
    }
    if price_decimal is not None:
        exporter_data["expected_price"] = price_decimal

    try:
        ticket_id = create_exporter_ticket(exporter_data)
    except Exception as e:
        logger.error("[WEB_SELL] Ticket creation failed: %s", e, exc_info=True)
        return _json_response(500, {"error": "Could not submit your listing. Please try again or contact support."})

    ref_id = ticket_id[:8].upper()

    try:
        price_line = f"💰 Expected Price: ₹{expected_price}/kg\n" if expected_price not in (None, "") else ""
        send_whatsapp_text(whatsapp_number, (
            "✅ *SELL REQUEST REGISTERED!*\n\n"
            f"🌾 Crop: {crop}\n"
            f"⚖️ Quantity: {qty} kg\n"
            f"{price_line}"
            f"📍 Location: {location_city}, {location_state}\n\n"
            "Our team will contact you within 24 hours.\n"
            f"🎫 Reference ID: {ref_id}\n"
            "📞 +91-8767205473 | ✉️ aarvexglo@gmail.com"
        ))
    except Exception as e:
        # Ticket is already saved at this point — a WhatsApp send failure should
        # not make the form look like it failed, just log it.
        logger.error("[WEB_SELL] WhatsApp confirmation send failed: %s", e, exc_info=True)

    try:
        from marketplace import notify_shopkeepers_of_listing
        notified = notify_shopkeepers_of_listing(exporter_data, ticket_id, ref_id)
        logger.info("[WEB_SELL] Shopkeepers notified: %s", notified)
    except Exception as e:
        logger.error("[WEB_SELL] Shopkeeper notify failed: %s", e, exc_info=True)

    return _json_response(200, {
        "success": True,
        "ticket_id": ticket_id,
        "reference_id": ref_id,
    })


def _handle_opt_in_out(phone: str, text: str) -> bool | None:
    t = text.strip().lower()
    if t == "stop updates":
        table.put_item(Item={"pk": f"CONTACT#WA#{phone}", "social_updates_opted_in": False, "opted_out_at": _now()})
        send_whatsapp_text(phone, "Aap social updates se unsubscribe ho gaye hain. Dobara start karne ke liye START UPDATES bhejein.")
        return True
    if t == "start updates":
        table.put_item(Item={"pk": f"CONTACT#WA#{phone}", "social_updates_opted_in": True, "opted_in_at": _now()})
        send_whatsapp_text(phone, "Aap social updates ke liye subscribed hain. Dhanyavaad!")
        return True
    return None


def route_advanced_feature(
    message_type: str,
    message_body: str,
    wa_from: str,
    user_state: dict,
    message_data: dict,
) -> dict | None:
    """
    Main advanced router.

    Returns a Lambda-style response when the advanced module handled the message,
    otherwise returns None so lambda_handler.py can continue its existing flow.
    """
    try:
        text = (message_body or "").strip()
        interactive_id = (user_state or {}).get("interactive_id", "") or ""
        action = interactive_id or text
        action_l = action.lower().strip()

        if _handle_opt_in_out(wa_from, text):
            return _plain_response(200, "OK")

        state = _get_adv_state(wa_from)
        flow = state.get("advanced_flow")

        if interactive_id in ("adv_catalogue", "menu_catalogue") or action_l in ("product catalogue", "get order", "order", "menu_catalogue"):
            _clear_adv_state(wa_from)
            _send_category_list(wa_from)
            return _plain_response(200, "OK")

        if interactive_id.startswith("adv_cat_"):
            _send_product_list(wa_from, interactive_id[len("adv_cat_"):])
            return _plain_response(200, "OK")

        if interactive_id.startswith("adv_prod_"):
            rest = interactive_id[len("adv_prod_"):]
            category_id, product_id = rest.split("_", 1)
            _send_product_detail(wa_from, category_id, _get_product(category_id, product_id))
            return _plain_response(200, "OK")

        if interactive_id.startswith("adv_order_"):
            rest = interactive_id[len("adv_order_"):]
            category_id, product_id = rest.split("_", 1)
            _start_order(wa_from, category_id, product_id)
            return _plain_response(200, "OK")

        if interactive_id == "adv_restart_order":
            data = state.get("data", {})
            _start_order(wa_from, data.get("category_id", ""), data.get("product_id", ""))
            return _plain_response(200, "OK")

        if interactive_id == "adv_confirm_payment" and flow == "order_form_confirm":
            _confirm_order_and_payment(wa_from, state)
            return _plain_response(200, "OK")

        if interactive_id == "menu_track_order" or action_l in ("track order", "order tracking", "menu_track_order", "track"):
            _track_order_prompt(wa_from)
            return _plain_response(200, "OK")

        if flow == "tracking_input":
            _show_order_status(wa_from, text)
            return _plain_response(200, "OK")

        if flow == "order_form_step_1":
            _handle_order_step_1(wa_from, text, state)
            return _plain_response(200, "OK")

        if flow == "order_form_step_2":
            _handle_order_step_2(wa_from, text, state)
            return _plain_response(200, "OK")

        if flow == "order_form_step_3":
            _handle_order_step_3(wa_from, text, state)
            return _plain_response(200, "OK")

        if action_l.startswith("broadcast_start ") and wa_from == ADMIN_WHATSAPP_NUMBER:
            s3_key = action.split(maxsplit=1)[1]
            batch_id = start_broadcast(s3_key, "")
            send_whatsapp_text(wa_from, f"📊 Broadcast queued\nBatch ID: {batch_id}")
            return _plain_response(200, "OK")

        return None
    except Exception as e:
        logger.error("[ADVANCED][ROUTER] Unexpected error: %s", e, exc_info=True)
        if wa_from:
            send_whatsapp_text(wa_from, "Sorry, advanced service me temporary issue hai. Team ko notify kar diya gaya hai.")
        return _plain_response(200, "OK")


def handle_portal_route(event: dict) -> dict | None:
    """Delegate marketplace/portal HTTP routes."""
    if not MARKETPLACE_AVAILABLE:
        return None
    from marketplace import handle_portal_route as _mp_route
    return _mp_route(event)