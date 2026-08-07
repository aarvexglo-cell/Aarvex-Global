"""
Cash-on-Delivery Invoice — separate from the online-payment invoice
(advanced_features._generate_invoice).

WHY A SEPARATE FILE:
  - Online invoices fire from the Razorpay webhook (payment.captured).
    COD orders never hit that webhook, so they never got an invoice at all.
  - COD invoices are generated only once delivery is confirmed (OTP
    verified, cash actually collected) — not at order placement — so the
    "amount due" printed always matches what was actually paid.
  - Keeping this in its own module means changes to COD invoicing can
    never accidentally break the online-payment invoice path, and vice versa.

Called from delivery.handle_delivery_complete() right after a COD order
is marked COMPLETED.
"""

from __future__ import annotations

import io
import logging
import os
from datetime import datetime, timezone
from decimal import Decimal

import boto3

logger = logging.getLogger()

S3_BUCKET_FOR_INVOICES = os.environ.get("S3_BUCKET_FOR_INVOICES", "")
COMPANY_NAME = os.environ.get("COMPANY_NAME", "Aarvex Global")
COMPANY_GST_NUMBER = os.environ.get("COMPANY_GST_NUMBER") or os.environ.get("COMPANY_GST", "")
COMPANY_ADDRESS = os.environ.get("COMPANY_ADDRESS", "Warora, Chandrapur, Maharashtra, India")
COMPANY_PHONE = os.environ.get("COMPANY_PHONE", "+91-8767205473")
COMPANY_EMAIL = os.environ.get("COMPANY_EMAIL", "aarvexglo@gmail.com")

s3 = boto3.client("s3")
ses = boto3.client("ses", region_name=os.environ.get("SES_REGION", "ap-south-1"))


def _money(v) -> str:
    try:
        return f"{Decimal(str(v)):,.2f}"
    except Exception:
        return str(v)


def _num(v, d=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def _derive_charges(rec: dict):
    """Return (lot, delivery, platform, gst) — filling any that were stored as
    0 (e.g. sample orders that skipped pricing) from platform settings, so the
    invoice ALWAYS shows the delivery + platform + GST cuts. The buyer must pay
    the shop and the delivery partner even on a sample."""
    try:
        from platform_utils import get_platform_settings
        s = get_platform_settings() or {}
    except Exception:
        s = {}
    lot = _num(rec.get("lot_price", 0))
    if lot <= 0:
        lot = _num(rec.get("cod_amount", 0)) or _num(rec.get("total_amount", 0))
    delivery = _num(rec.get("delivery_charge", 0))
    platform = _num(rec.get("platform_fee", 0))
    gst = _num(rec.get("gst_amount", 0))
    if delivery <= 0:
        dist = _num(rec.get("distance_km", 0))
        rate = _num(s.get("delivery_rate_per_km", 10), 10)
        mind = _num(s.get("min_delivery_charge", 50), 50)
        delivery = round(max(mind, rate * dist), 2) if dist > 0 else mind
    if platform <= 0:
        platform = round(lot * _num(s.get("platform_fee_pct", 10), 10) / 100.0, 2)
    if gst <= 0:
        gst = round((lot + delivery + platform) * _num(s.get("gst_rate_pct", 5), 5) / 100.0, 2)
    return round(lot, 2), round(delivery, 2), round(platform, 2), round(gst, 2)


def _invoice_total(rec: dict) -> float:
    """Definitive invoice amount = lot + delivery + platform + GST (charges
    derived when missing). Kept as its own helper for callers/notifications."""
    lot, delivery, platform, gst = _derive_charges(rec)
    return round(lot + delivery + platform + gst, 2)


def _invoice_rows(rec: dict, is_cod: bool):
    """Common (label, value) data used by both the PDF and HTML renderers."""
    lot, delivery, platform, gst = _derive_charges(rec)
    total = round(lot + delivery + platform + gst, 2)
    mode = "Cash on Delivery (collected by delivery partner)" if is_cod else "Paid Online (prepaid)"
    return {
        "arn": rec.get("arn", ""),
        "invoice_no": f"INV-{'COD' if is_cod else 'ONL'}-{rec.get('arn', '')}",
        "date": datetime.now(timezone.utc).date().isoformat(),
        "completed_at": str(rec.get("completed_at", ""))[:19],
        "buyer_name": rec.get("buyer_name", "") or "Customer",
        "buyer_city": rec.get("delivery_city", ""),
        "buyer_gst": rec.get("buyer_gst_number", ""),
        "product": rec.get("product_name", ""),
        "qty": rec.get("lot_size_kg", ""),
        "lot_price": lot,
        "delivery_charge": delivery,
        "platform_fee": platform,
        "gst_amount": gst,
        "total": total,
        "mode": mode,
        "tracking_key": rec.get("tracking_key", ""),
        "title": "TAX INVOICE" + (" — Cash on Delivery" if is_cod else " — Paid Online"),
        "total_label": "TOTAL CASH COLLECTED" if is_cod else "TOTAL PAID",
    }


def _build_invoice_html(d: dict) -> str:
    """Fallback invoice as printable HTML — works with NO extra Lambda layer
    (reportlab not required). The buyer can view it in the browser and
    print-to-PDF. This is why invoicing no longer depends on any gateway or
    a PDF library being installed."""
    gst_row = f'<tr><td>Buyer GST</td><td>{d["buyer_gst"]}</td></tr>' if d["buyer_gst"] else ""
    return f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invoice {d['arn']} — {COMPANY_NAME}</title>
<style>
 body{{font-family:Arial,Helvetica,sans-serif;color:#181410;max-width:720px;margin:0 auto;padding:24px}}
 .hd{{border-bottom:3px solid #2E6B41;padding-bottom:12px;margin-bottom:16px}}
 .hd h1{{color:#2E6B41;margin:0 0 4px;font-size:22px}} .hd small{{color:#555}}
 .title{{background:#2E6B41;color:#fff;padding:8px 12px;border-radius:6px;font-weight:700;margin:14px 0}}
 table{{width:100%;border-collapse:collapse;margin:10px 0}} td{{padding:6px 4px;border-bottom:1px solid #eee;font-size:14px}}
 .br td{{border:none}} .tot{{font-size:18px;font-weight:800;color:#2E6B41}}
 .muted{{color:#888;font-size:12px;margin-top:20px}}
 @media print{{.noprint{{display:none}}}}
</style></head><body>
<div class="hd"><h1>{COMPANY_NAME}</h1>
 <small>{COMPANY_ADDRESS}<br>GST: {COMPANY_GST_NUMBER} · {COMPANY_EMAIL} · {COMPANY_PHONE}</small></div>
<div class="title">{d['title']}</div>
<table class="br">
 <tr><td><b>Invoice No</b></td><td>{d['invoice_no']}</td></tr>
 <tr><td><b>Order ID</b></td><td>{d['arn']}</td></tr>
 <tr><td><b>Date</b></td><td>{d['date']}</td></tr>
 <tr><td><b>Delivered</b></td><td>{d['completed_at']}</td></tr>
</table>
<b>Bill To</b>
<table class="br"><tr><td>{d['buyer_name']}</td><td>{d['buyer_city']}</td></tr>{gst_row}</table>
<b>Order</b>
<table>
 <tr><td>{d['product']}</td><td style="text-align:right">{d['qty']} kg</td></tr>
 <tr><td>Product / Lot Price</td><td style="text-align:right">INR {_money(d['lot_price'])}</td></tr>
 <tr><td>Delivery Charge</td><td style="text-align:right">INR {_money(d['delivery_charge'])}</td></tr>
 <tr><td>Platform Fee</td><td style="text-align:right">INR {_money(d['platform_fee'])}</td></tr>
 <tr><td>GST</td><td style="text-align:right">INR {_money(d['gst_amount'])}</td></tr>
 <tr class="tot"><td>{d['total_label']}</td><td style="text-align:right">INR {_money(d['total'])}</td></tr>
</table>
<p><b>Payment Mode:</b> {d['mode']}</p>
<button class="noprint" onclick="window.print()" style="background:#2E6B41;color:#fff;border:none;padding:10px 18px;border-radius:8px;font-weight:700;cursor:pointer">Print / Save as PDF</button>
<p class="muted">This is a system-generated invoice. Thank you for choosing {COMPANY_NAME}.</p>
</body></html>"""


def generate_cod_invoice(delivery_record: dict) -> str:
    """Build + upload the FINAL delivery invoice and return a presigned URL.

    Fires at DELIVERY COMPLETION (handover / OTP verified) for BOTH COD and
    online orders — it does NOT depend on the payment gateway webhook. The
    delivery record already carries the full breakdown (stored at order time by
    create_delivery_record). Tries a PDF via reportlab; if that library isn't
    installed it falls back to a printable HTML invoice, so invoicing works
    from our own system with no extra Lambda layer.

    (Name kept for backward-compat; it now handles online orders too.)
    """
    if not S3_BUCKET_FOR_INVOICES:
        logger.warning("[INVOICE] S3_BUCKET_FOR_INVOICES not configured — skipping.")
        return ""
    arn = delivery_record.get("arn", "")
    if not arn:
        return ""

    is_cod = bool(delivery_record.get("is_cod"))
    d = _invoice_rows(delivery_record, is_cod)
    tag = "cod" if is_cod else "online"
    url = ""

    # 1) Preferred: PDF via reportlab.
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfgen import canvas

        buffer = io.BytesIO()
        c = canvas.Canvas(buffer, pagesize=A4)
        y = 800

        def line(text, size=11, gap=18, bold=False):
            nonlocal y
            c.setFont("Helvetica-Bold" if bold else "Helvetica", size)
            c.drawString(50, y, str(text)[:100])
            y -= gap

        line(COMPANY_NAME, 14, 20, bold=True)
        line(COMPANY_ADDRESS)
        line(f"GST: {COMPANY_GST_NUMBER}")
        line(f"Email: {COMPANY_EMAIL}  |  Phone: {COMPANY_PHONE}")
        y -= 8
        line(d["title"], 13, 22, bold=True)
        line(f"Invoice No: {d['invoice_no']}")
        line(f"Order ID: {arn}")
        line(f"Date: {d['date']}")
        line(f"Delivery completed: {d['completed_at']}")
        y -= 8
        line("BILL TO:", bold=True)
        line(d["buyer_name"])
        line(d["buyer_city"])
        if d["buyer_gst"]:
            line(f"GST: {d['buyer_gst']}")
        y -= 8
        line(f"Product: {d['product']}")
        line(f"Quantity: {d['qty']} kg")
        y -= 10
        line("PAYMENT BREAKDOWN", 11, 20, bold=True)
        line(f"Product / Lot Price ............ INR {_money(d['lot_price'])}")
        line(f"Delivery Charge ................. INR {_money(d['delivery_charge'])}")
        line(f"Platform Fee ..................... INR {_money(d['platform_fee'])}")
        line(f"GST .............................. INR {_money(d['gst_amount'])}")
        y -= 6
        line(f"{d['total_label']} ............ INR {_money(d['total'])}", 13, 22, bold=True)
        y -= 10
        line(f"Payment Mode: {d['mode']}")
        line(f"Tracking Key: {d['tracking_key']}")
        y -= 20
        line("This is a system-generated invoice. Thank you for choosing " + COMPANY_NAME + ".", 9, 14)
        c.save()

        key = f"invoices/{tag}/{arn}/invoice_{tag}_{arn}.pdf"
        s3.put_object(Bucket=S3_BUCKET_FOR_INVOICES, Key=key, Body=buffer.getvalue(), ContentType="application/pdf")
        url = s3.generate_presigned_url("get_object", Params={"Bucket": S3_BUCKET_FOR_INVOICES, "Key": key}, ExpiresIn=604800)
    except Exception as e:
        # 2) Fallback: printable HTML (no reportlab needed).
        logger.warning("[INVOICE] PDF path unavailable for %s (%s) — using HTML fallback.", arn, e)
        try:
            html = _build_invoice_html(d)
            key = f"invoices/{tag}/{arn}/invoice_{tag}_{arn}.html"
            s3.put_object(Bucket=S3_BUCKET_FOR_INVOICES, Key=key, Body=html.encode("utf-8"),
                          ContentType="text/html; charset=utf-8")
            url = s3.generate_presigned_url("get_object", Params={"Bucket": S3_BUCKET_FOR_INVOICES, "Key": key}, ExpiresIn=604800)
        except Exception as e2:
            logger.error("[INVOICE] HTML fallback also failed for %s: %s", arn, e2, exc_info=True)
            return ""

    # Best-effort delivery of the invoice to ALL THREE parties (importer, shop,
    # delivery partner) via in-app + WhatsApp + email — never fail the delivery.
    _deliver_invoice_all(delivery_record, url)
    return url


def _party_contacts(rec: dict):
    """[(role, sub, name, phone, email)] for importer, shop owner, delivery partner."""
    parties = [("Importer", rec.get("importer_sub", ""), rec.get("buyer_name", ""),
                rec.get("buyer_mobile", ""), rec.get("buyer_email", ""))]
    try:
        from marketplace import get_profile
    except Exception:
        get_profile = None
    for role, sub in (("Shop", rec.get("seller_sub", "")), ("Delivery", rec.get("claimed_by", ""))):
        if sub and get_profile:
            try:
                p = get_profile(sub) or {}
                parties.append((role, sub, p.get("user_name", ""),
                                p.get("mobile") or p.get("phone", ""), p.get("user_email", "")))
            except Exception:
                pass
    return parties


def _deliver_invoice_all(rec: dict, url: str) -> None:
    if not url:
        return
    arn = rec.get("arn", "")
    try:
        from marketplace import create_notification
    except Exception:
        create_notification = None
    try:
        from advanced_features import send_whatsapp_text
    except Exception:
        send_whatsapp_text = None
    for role, sub, name, phone, email in _party_contacts(rec):
        if sub and create_notification:
            try:
                create_notification(sub, "cod_invoice", "Invoice ready",
                                    f"Invoice for order {arn} ({role} copy) is ready.\n{url}", arn=arn)
            except Exception as e:
                logger.warning("[INVOICE] notify %s failed: %s", role, e)
        if phone and send_whatsapp_text:
            try:
                send_whatsapp_text(str(phone),
                                   f"🧾 {COMPANY_NAME}\nInvoice for order {arn} — {role} copy:\n{url}\n\n"
                                   f"Open the link to view / download the PDF.")
            except Exception as e:
                logger.warning("[INVOICE] WhatsApp %s failed: %s", role, e)
        if email:
            _email_invoice(email, arn, role, url, rec)


def _email_invoice(email: str, arn: str, role: str, url: str, rec: dict) -> None:
    if not email or "@" not in email or not url:
        return
    subject = f"Invoice — Order {arn} | {COMPANY_NAME}"
    lot, delivery, platform, gst = _derive_charges(rec)
    total = round(lot + delivery + platform + gst, 2)
    text = f"Your order {arn} has been delivered.\nInvoice ({role} copy): {url}\nTotal: INR {_money(total)}"
    html = (
        f"<h2>Delivered — Invoice ready</h2>"
        f"<p>Order ID: <b>{arn}</b> · {role} copy</p>"
        f"<table style='border-collapse:collapse'>"
        f"<tr><td>Product / Lot</td><td style='text-align:right'>INR {_money(lot)}</td></tr>"
        f"<tr><td>Delivery Charge</td><td style='text-align:right'>INR {_money(delivery)}</td></tr>"
        f"<tr><td>Platform Fee</td><td style='text-align:right'>INR {_money(platform)}</td></tr>"
        f"<tr><td>GST</td><td style='text-align:right'>INR {_money(gst)}</td></tr>"
        f"<tr><td><b>Total</b></td><td style='text-align:right'><b>INR {_money(total)}</b></td></tr>"
        f"</table>"
        f"<p><a href='{url}'>View / download the invoice PDF</a></p>"
        f"<p>{COMPANY_NAME}<br>{COMPANY_PHONE}</p>"
    )
    try:
        ses.send_email(
            Source=COMPANY_EMAIL,
            Destination={"ToAddresses": [email]},
            Message={"Subject": {"Data": subject},
                     "Body": {"Text": {"Data": text}, "Html": {"Data": html}}},
        )
    except Exception as e:
        logger.warning("[INVOICE] email to %s failed: %s", email, e)


def _notify_buyer(delivery_record: dict, invoice_url: str) -> None:
    importer_sub = delivery_record.get("importer_sub", "")
    if not importer_sub or not invoice_url:
        return
    try:
        from marketplace import create_notification
        create_notification(
            importer_sub,
            "shop_status",
            "COD Invoice ready",
            f"Your Cash-on-Delivery invoice for order {delivery_record.get('arn', '')} is ready.\n{invoice_url}",
            arn=delivery_record.get("arn", ""),
        )
    except Exception as e:
        logger.warning("[COD_INVOICE] in-app notification failed: %s", e)


def _email_buyer(delivery_record: dict, invoice_url: str) -> None:
    email = delivery_record.get("buyer_email", "")
    if not email or not invoice_url:
        return
    arn = delivery_record.get("arn", "")
    subject = f"COD Invoice — Order {arn} | {COMPANY_NAME}"
    text = f"Your Cash-on-Delivery order {arn} has been delivered. Invoice: {invoice_url}"
    html = (
        f"<h2>Delivered — Cash on Delivery</h2>"
        f"<p>Order ID: <b>{arn}</b></p>"
        f"<p>Amount collected: INR {_money(delivery_record.get('cod_amount', 0))}</p>"
        f"<p>Invoice: <a href='{invoice_url}'>Download invoice</a></p>"
        f"<p>{COMPANY_NAME}<br>{COMPANY_PHONE}</p>"
    )
    try:
        ses.send_email(
            Source=COMPANY_EMAIL,
            Destination={"ToAddresses": [email]},
            Message={"Subject": {"Data": subject}, "Body": {"Text": {"Data": text}, "Html": {"Data": html}}},
        )
    except Exception as e:
        logger.warning("[COD_INVOICE] email send failed: %s", e)