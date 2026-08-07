"""
=============================================================
  AARVEX GLOBAL — Social Media AI Auto-Reply Bot
  WhatsApp Business API + Instagram Direct + Facebook Messenger
  (Native Meta Graph API webhooks)
  AWS Lambda — Python 3.12
=============================================================
  Author  : Parag Lakhadive / Aarvex Global
  Version : 5.0 — Full Working: Catalogue Buttons + Quote Flow + Rating + Social + Credentials
=============================================================

CHANGES IN v5.0:
1. Catalogue → interactive list with product buttons (no typing needed)
2. Quote → product button → type qty only → separate demand confirmation message
3. Rating 1–5 stars automatically sent after every quote/demand request
4. About Us → fully formatted company credentials (GST, IEC, Udyam, PAN, RC)
5. Every reply has TWO quick-action buttons: [Menu] + [🌐 Social Connect]
6. Social Connect → interactive list of all 8 platforms with direct links
7. _build_about_message bug fixed (format placeholders now properly filled)
8. Rating flow integrated into _continue_flow
9. All bugs reviewed and fixed
"""

import json
import os
import re
import time
import base64
import hmac
import hashlib
import logging
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

try:
    from advanced_features import (
        route_advanced_feature,
        handle_razorpay_webhook,
        handle_cashfree_webhook,
        get_admin_api_handler,
        handle_web_order,
        handle_web_sell,
        get_public_catalogue,
        handle_portal_route,
    )
    ADVANCED_FEATURES_AVAILABLE = True
except Exception as e:
    ADVANCED_FEATURES_AVAILABLE = False
    logger.error(f"[ADVANCED] advanced_features import failed: {e}", exc_info=True)

    def route_advanced_feature(*args, **kwargs):
        return None

    def handle_razorpay_webhook(event):
        return {"statusCode": 503, "body": "Advanced features unavailable"}

    def handle_cashfree_webhook(event):
        return {"statusCode": 503, "body": "Advanced features unavailable"}

    def get_admin_api_handler(event):
        return {"statusCode": 503, "body": "Advanced features unavailable"}

    def handle_web_order(event):
        return {"statusCode": 503, "body": "Advanced features unavailable"}

    def handle_web_sell(event):
        return {"statusCode": 503, "body": "Advanced features unavailable"}

    def get_public_catalogue(event):
        # Advanced module down — return an empty (but valid + CORS-safe) list.
        # The website's loadCatalogue() JS already falls back to its own
        # DEFAULT_PRODUCTS when it gets an empty products array, so visitors
        # still see a catalogue instead of a broken page.
        return {
            "statusCode": 200,
            "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
            "body": json.dumps({"products": [], "total": 0}),
        }

    def handle_portal_route(event):
        return None

# ─────────────────────────────────────────────
#  ENV CONFIG
# ─────────────────────────────────────────────
OPENROUTER_API_KEY  = os.environ.get("OPENROUTER_API_KEY", "")
WEBHOOK_SECRET      = os.environ.get("WEBHOOK_SECRET", "")
META_APP_SECRET     = os.environ.get("META_APP_SECRET", "")
DYNAMODB_TABLE      = os.environ.get("DYNAMODB_TABLE", "aarvex-social-bot-state")
COOLDOWN_MINUTES    = int(os.environ.get("COOLDOWN_MINUTES", "60"))
OPENROUTER_MODEL    = os.environ.get("OPENROUTER_MODEL", "meta-llama/llama-3.1-8b-instruct")

# WhatsApp Config
WA_PHONE_NUMBER_ID  = os.environ.get("WA_PHONE_NUMBER_ID", "")
WA_ACCESS_TOKEN     = os.environ.get("WA_ACCESS_TOKEN", "")

# Facebook Messenger Config
PAGE_ACCESS_TOKEN   = os.environ.get("PAGE_ACCESS_TOKEN", "")
FACEBOOK_PAGE_ID    = os.environ.get("FACEBOOK_PAGE_ID", "")

# Instagram Direct Config (separate token from Facebook; falls back to
# PAGE_ACCESS_TOKEN automatically if INSTAGRAM_ACCESS_TOKEN is not set,
# so nothing breaks for anyone still relying on the old shared-token setup)
INSTAGRAM_ACCESS_TOKEN = os.environ.get("INSTAGRAM_ACCESS_TOKEN", "") or PAGE_ACCESS_TOKEN
INSTAGRAM_PAGE_ID   = os.environ.get("INSTAGRAM_PAGE_ID", "")
GRAPH_API_VERSION   = os.environ.get("GRAPH_API_VERSION", "v20.0")

# Business / Catalogue Config
PRODUCT_CATALOGUE   = os.environ.get(
    "PRODUCT_CATALOGUE",
    "Teja Lal Mirch,Kashmiri Mirch,Haldi,Jeera,Basmati Rice 1121,Wheat,Soybean,Onion,Garlic,Sesame",
)
COMPANY_PHONE       = os.environ.get("COMPANY_PHONE", "+91-8767205473")
COMPANY_EMAIL       = os.environ.get("COMPANY_EMAIL", "aarvexglo@gmail.com")
COMPANY_UPI         = os.environ.get("COMPANY_UPI", "aarvex@upi")
COMPANY_GST         = os.environ.get("COMPANY_GST", "27AZJPL8251G1Z3")
COMPANY_IEC         = os.environ.get("COMPANY_IEC", "AZJPL8251G")
COMPANY_UDYAM       = os.environ.get("COMPANY_UDYAM", "UDYAM-MH-08-0090771")
COMPANY_PAN         = os.environ.get("COMPANY_PAN", "AZJPL8251G")
COMPANY_ADDRESS     = os.environ.get(
    "COMPANY_ADDRESS",
    "Voltas Sagar Colony, Warora, Chandrapur, Maharashtra — 442907",
)
COMPANY_WEBSITE     = os.environ.get("COMPANY_WEBSITE", "https://aarvexglobal.com")
COMPANY_RC          = os.environ.get("COMPANY_RC", "AA270526178767H")
CERT_UDYAM_URL      = os.environ.get("CERT_UDYAM_URL", "")
CERT_IEC_URL        = os.environ.get("CERT_IEC_URL", "")
CERT_RC_URL         = os.environ.get("CERT_RC_URL", "")

# Social media — priority order for customer-facing list
SOCIAL_LINKS = [
    ("social_website", "website",  "🌐", "https://dskm35im55r5u.cloudfront.net/portal.html"),
    ("social_instagram", "Instagram",  "📸", "https://www.instagram.com/aarvexglobal"),
    ("social_facebook",  "Facebook",   "📘", "https://www.facebook.com/profile.php?id=61590539051710"),
    ("social_whatsapp",  "WhatsApp",   "💬", "https://wa.link/o0a5u0"),
    ("social_linkedin",  "LinkedIn",   "💼", "https://www.linkedin.com/in/aarvex-global-994305415/"),
    ("social_x",         "X (Twitter)","✖️", "https://x.com/aarvexglobal"),
    ("social_telegram",  "Telegram",   "✈️", "https://t.me/aarvexglobal_bot"),
    ("social_pinterest", "Pinterest",  "📌", "https://in.pinterest.com/aarvexglobal/"),
    ("social_threads",   "Threads",    "🧵", "https://www.threads.com/@aarvexglobal"),
]
ADMIN_PASSWORD      = os.environ.get("ADMIN_PASSWORD", "")
# === CHANGE 3: TOTP 2FA — New env vars for admin access control ===
ADMIN_TOTP_SECRET   = os.environ.get("ADMIN_TOTP_SECRET", "")      # Base32 string, Google Authenticator compatible
ADMIN_WHATSAPP_NUMBER = os.environ.get("ADMIN_WHATSAPP_NUMBER", "") # Admin's WhatsApp number (with country code, e.g. 918767205473)
SAMPLE_BASE_COST    = int(os.environ.get("SAMPLE_BASE_COST", "500"))
COURIER_CHARGES     = int(os.environ.get("COURIER_CHARGES", "150"))
QUOTE_VALID_HOURS   = int(os.environ.get("QUOTE_VALID_HOURS", "48"))

# Zoho Desk (Sample tickets) + Zoho CRM (Quote leads)
ZOHO_ACCESS_TOKEN   = os.environ.get("ZOHO_ACCESS_TOKEN", "")
ZOHO_DESK_ORG_ID    = os.environ.get("ZOHO_DESK_ORG_ID", "")
ZOHO_DESK_DEPARTMENT_ID = os.environ.get("ZOHO_DESK_DEPARTMENT_ID", "")
ZOHO_API_DOMAIN     = os.environ.get("ZOHO_API_DOMAIN", "https://desk.zoho.in")
ZOHO_CRM_DOMAIN     = os.environ.get("ZOHO_CRM_DOMAIN", "https://www.zohoapis.in")
PRIVACY_POLICY_URL  = os.environ.get(
    "PRIVACY_POLICY_URL",
    "https://paragartbook-star.github.io/aarvex-global/privacy-policy.html",
)

DEFAULT_SYSTEM_PROMPT = os.environ.get(
    "AI_SYSTEM_PROMPT",
    (
        # === CHANGE 1: SPELLING + GRAMMAR — Improved system prompt for professional, international tone ===
        "You are a professional and warm customer support assistant for Aarvex Global, "
        "a certified import-export company specialising in food and agricultural products, "
        "based in Warora, Maharashtra, India. "
        "Always be polite, helpful, and concise. "
        "Do not use hashtags. Do not place quotes around your reply. "
        "If a customer asks about pricing or rates, inform them that our team will reach out shortly with details. "
        "Always reply in the same language the customer has used. "
        "For English, use clear and simple language suitable for international buyers from the Middle East, Africa, Southeast Asia, and beyond. "
        "For Hindi, use respectful and grammatically correct modern Hindi. "
        "Keep all replies under 80 words."
    ),
)

MENU_TRIGGERS = {
    "hi", "hello", "help", "start", "menu", "hey", "hii", "hola", "namaste", "namaskar",
    "मेनू", "मदद", "शुरू", "help me",
}
SAMPLE_TRIGGERS = {
    "sample", "sample chahiye", "namuna", "नमूना", "नमूना चाहिए", "सैंपल",
    "sample request", "free sample",
}
SEPARATOR = "━━━━━━━━━━━━━━━━━━━━━"
SUPPORTED_LANGS = ("en", "hi")

# === CHANGE 2: MENU REORDER — New priority sequence for better business funnel ===
# === CHANGE 1: SPELLING FIX — niryaat (was: niryat) throughout Hindi entries ===
MENU_ROWS_I18N = {
    "en": [
        # Position 1: Primary CTA — most-clicked by buyers
        {"id": "menu_catalogue", "title": "📦 Product Catalogue",  "description": "Browse & order export products"},
        # Position 2: B2B exporters — second most important
        {"id": "menu_export",    "title": "🚢 Export Services",    "description": "End-to-end international export"},
        # Position 3: Trust building — new customers explore here
        {"id": "menu_about",     "title": "🏢 About Us",           "description": "Company profile & credentials"},
        # Position 4: Existing customers — feedback
        {"id": "menu_feedback",  "title": "⭐ Feedback",           "description": "Share your experience"},
        {"id": "menu_track_order", "title": "📦 Track Order",       "description": "Check order status by ARN"},
        # Position 5: Reference — rarely clicked but essential
        {"id": "menu_terms",     "title": "📋 Terms & Policies",   "description": "Terms, MOQ & policies"},
        # Remaining — utility & farmer segment
        {"id": "menu_sell",      "title": "🌾 Sell Your Produce",  "description": "Farmers — sell via Aarvex"},
        {"id": "menu_talk",      "title": "📞 Talk to Team",       "description": "Speak with our team"},
        {"id": "social_connect_menu", "title": "🌐 Social Connect", "description": "Follow us on all platforms"},
        {"id": "menu_language",  "title": "🌐 Change Language",    "description": "Switch Hindi / English"},
        # ============================================================
        # [FUTURE - advanced_features.py] Order Tracking
        # Customer apna ARN number dalega aur order status milega
        # Yahan se route_advanced_feature() call hogi
        # DO NOT implement here — will be added in Phase 2
        # ============================================================
        # ============================================================
        # [FUTURE - advanced_features.py] Contact Us
        # Direct agent se connect karne ka option
        # Yahan se route_advanced_feature() call hogi
        # DO NOT implement here — will be added in Phase 2
        # ============================================================
        # ============================================================
        # [FUTURE - advanced_features.py] Broadcast / Updates
        # Subscribers ko updates bhejne ka system
        # Yahan se route_advanced_feature() call hogi
        # DO NOT implement here — will be added in Phase 2
        # ============================================================
    ],
    "hi": [
        # Position 1: Primary CTA
        {"id": "menu_catalogue", "title": "📦 उत्पाद सूची",         "description": "निर्यात उत्पाद देखें व ऑर्डर करें"},
        # Position 2: निर्यात सेवाएं
        {"id": "menu_export",    "title": "🚢 निर्यात सेवाएं",      "description": "अंतर्राष्ट्रीय निर्यात सहायता"},
        # Position 3: About
        {"id": "menu_about",     "title": "🏢 हमारे बारे में",      "description": "कंपनी प्रोफाइल व प्रमाण-पत्र"},
        # Position 4: Feedback
        {"id": "menu_feedback",  "title": "⭐ प्रतिक्रिया",          "description": "अपना अनुभव साझा करें"},
        {"id": "menu_track_order", "title": "📦 ऑर्डर ट्रैक करें",    "description": "ARN से ऑर्डर स्थिति देखें"},
        # Position 5: Terms
        {"id": "menu_terms",     "title": "📋 नियम व नीतियां",       "description": "शर्तें, MOQ व नीतियां"},
        # Remaining
        {"id": "menu_sell",      "title": "🌾 अपनी उपज बेचें",      "description": "किसान — Aarvex से जुड़ें"},
        {"id": "menu_talk",      "title": "📞 टीम से बात करें",     "description": "हमारी टीम से संपर्क करें"},
        {"id": "social_connect_menu", "title": "🌐 सोशल कनेक्ट",     "description": "हमें सभी प्लेटफ़ॉर्म पर फॉलो करें"},
        {"id": "menu_language",  "title": "🌐 भाषा बदलें",           "description": "Hindi / English"},
        # ============================================================
        # [FUTURE - advanced_features.py] Order Tracking
        # Customer apna ARN number dalega aur order status milega
        # DO NOT implement here — will be added in Phase 2
        # ============================================================
        # ============================================================
        # [FUTURE - advanced_features.py] Contact Us
        # Direct agent se connect karne ka option
        # DO NOT implement here — will be added in Phase 2
        # ============================================================
        # ============================================================
        # [FUTURE - advanced_features.py] Broadcast / Updates
        # Subscribers ko updates bhejne ka system
        # DO NOT implement here — will be added in Phase 2
        # ============================================================
    ],
}

TEXTS = {
    "en": {
        "lang_picker_body": (
            "🌾 *AARVEX GLOBAL*\n"
            f"{SEPARATOR}\n"
            "Welcome! Please choose your language:\n"
            "स्वागत है! अपनी भाषा चुनें 👇"
        ),
        "lang_set_hi": "✅ भाषा हिंदी में सेट हो गई।",
        "lang_set_en": "✅ Language set to English.",
        "ai_fallback_error": (
            "🙏 Sorry, we're facing a temporary technical issue and could not process your message right now.\n"
            "Please try again in a few minutes, or type *MENU* to browse our services.\n"
            "Our team has been notified."
        ),
        "welcome_body": (
            "🌾 *AARVEX GLOBAL*\n"
            "*PREMIUM AGRI EXPORT HOUSE*\n"
            "*Digital · AI-Powered · Social · Modern*\n"
            f"{SEPARATOR}\n"
            "Hello! 🙏\n"
            "Welcome to Aarvex Global — India's trusted agricultural export partner.\n"
            "🏆 Quality Assured | 🌍 Global Reach\n"
            "📦 Farm to Port | ✅ Certified Exporter\n"
            "🤖 Smart Support | 📱 Socially Connected\n"
            f"{SEPARATOR}\n"
            "✅ IEC · GST · Udyam MSME Registered\n"
            "Please select an option below 👇"
        ),
        "menu_body": f"*Welcome to Aarvex Global!* 🌍\n{SEPARATOR}\nWe are your trusted partners in international trade. Please explore our services and manage your export requirements by selecting the *'View Menu'* button below. 👇",
        "view_menu_btn": "📋 View Menu",
        "view_menu_hint": "Need something else? Tap below 👇",
        "social_connect_btn": "🌐 Social Connect",
        "action_footer_hint": "What would you like to do next? 👇",
        "action_list_button": "Choose an Option",
        "action_list_section": "Quick Actions",
        "social_list_header": "🌐 *CONNECT WITH AARVEX GLOBAL*",
        "social_list_body": "Select a platform — we'll share the direct link 👇",
        "social_list_button": "Choose Platform",
        "social_list_section": "Our Channels",
        "social_link_body": (
            "{emoji} *{name}*\n"
            f"{SEPARATOR}\n"
            "Tap the button below to connect with us 👇"
        ),
        "social_link_btn": "Open {name}",
        "catalogue_header": "📦 *AARVEX GLOBAL — PRODUCT CATALOGUE*",
        "catalogue_pick": "Tap a product below to view full details 👇",
        "catalogue_list_btn": "Select Product",
        "catalogue_list_section": "Export Products",
        "quote_pick_header": "💰 *GET QUOTE / ORDER*",
        "quote_pick_body": "Select a product — then enter quantity only 👇",
        "quote_btn": "💰 Get Quote",
        "sample_btn": "🧪 Sample",
        "quote_ask_qty": (
            "💰 *QUOTE REQUEST*\n"
            f"{SEPARATOR}\n"
            "📦 Product: *{product}*\n"
            f"{SEPARATOR}\n"
            "Please enter *quantity only*:\n"
            "Example: 500 kg | 2 MT | 10 bags"
        ),
        "quote_qty_invalid": "⚠️ Please enter a valid quantity.\nExample: 500 kg or 2 MT",
        "demand_header": "✅ *DEMAND REQUEST REGISTERED*",
        "rating_header": "⭐ *RATE YOUR EXPERIENCE*",
        "rating_body": "How was your experience with Aarvex Global?\nPlease select 1–5 stars 👇",
        "rating_list_btn": "Rate Us",
        "rating_list_section": "Your Rating",
        "rating_thanks": "🙏 Thank you for rating us *{stars}/5*! Your feedback helps us serve you better.",
        "rating_row": "{stars} Star{plural}",
        "quote_sample_hint": "📞 Or tap *Sample* from product details",
        "export_header": "🚢 *EXPORT SERVICES*",
        "export_body": (
            "Aarvex Global handles end-to-end export:\n"
            "✅ IEC registered exporter\n"
            "✅ Phytosanitary & COA documentation\n"
            "✅ Port logistics & customs support\n"
            "✅ Middle East, Africa & SE Asia markets"
        ),
        "sell_header": "🌾 *SELL YOUR PRODUCE*",
        "sell_body": (
            "Farmers & suppliers — partner with Aarvex:\n"
            "• We connect you to international buyers\n"
            "• Fair market-linked pricing\n"
            "• Complete export documentation\n"
            "• Flexible MOQ for new products\n"
            f"{SEPARATOR}\n"
            "Reply with crop name + quantity + location."
        ),
        "about_header": "🏢 *ABOUT AARVEX GLOBAL*",
        "about_body": (
            "*Premium Agri Export House*\n"
            "Warora, Chandrapur, Maharashtra, India\n"
            f"{SEPARATOR}\n"
            "🌐 *Digital · AI-Powered · Social · Modern*\n"
            "Smart export support with certified documentation.\n"
            f"{SEPARATOR}\n"
            "📋 *REGISTERED CREDENTIALS*\n"
            "🏛 GSTIN: {gst}\n"
            "🌍 IEC Code: {iec}\n"
            "🏭 Udyam MSME: {udyam}\n"
            "📄 PAN: {pan}\n"
            "📜 RC No.: {rc}\n"
            f"{SEPARATOR}\n"
            "✅ *VERIFIED CERTIFICATES*\n"
            "• Udyam Registration Certificate\n"
            "• IEC (Import Export Code) Certificate\n"
            "• RC / Registration Certificate\n"
            "{cert_links}"
            f"{SEPARATOR}\n"
            "🌾 Spices · Grains · Pulses · Fresh Produce\n"
            "🌍 Trusted partner for global importers.\n"
            f"{SEPARATOR}\n"
            "📍 {address}\n"
            "📞 {phone} | ✉️ {email}\n"
            "🌐 {website}"
        ),
        "cert_links_block": (
            f"{SEPARATOR}\n"
            "📎 *Certificate Downloads:*\n"
            "{links}"
        ),
        "cert_on_request": "📎 Certificate copies available on request via email.",
        "terms_header": "📋 *TERMS & POLICIES*",
        "terms_body": (
            "• Quotes valid {hours} hours\n"
            "• Sample qty: 100g – 1kg (paid + courier)\n"
            "• MOQ varies by product — ask for details\n"
            "• Payment: Advance for new buyers\n"
            "• Quality: COA & inspection on request\n"
            f"{SEPARATOR}\n"
            "📄 Privacy Policy:\n{privacy_url}\n"
            f"{SEPARATOR}\n"
            "Full terms on request via email."
        ),
        "talk_header": "📞 *TALK TO OUR TEAM*",
        "talk_body": (
            "Our export team is ready to assist:\n"
            "📱 WhatsApp/Call: {phone}\n"
            "✉️ Email: {email}\n"
            "⏰ Response within 24 hours\n"
            f"{SEPARATOR}\n"
            "Share your product & quantity — we'll call back!"
        ),
        "product_detail": (
            "📦 *{product}*\n"
            f"{SEPARATOR}\n"
            "Premium grade export quality.\n"
            "💰 Pricing: Market linked — request quote\n"
            "🧪 Samples: 100g–1kg available\n"
            "📋 Docs: COA, Phytosanitary, Invoice\n"
            f"{SEPARATOR}\n"
            "Tap *Get Quote* below — enter quantity only.\n"
            "Or tap *Sample* for sample request."
        ),
        "sample_header": "🧪 *SAMPLE REQUEST*",
        "sample_products": "Available products for sample:",
        "sample_reply": "Reply with *product name* (100g – 1kg sample).",
        "sample_invalid_product": "Please reply with a valid product name from the list.",
        "sample_product_ok": "✅ Product: *{product}*\n\nEnter sample quantity (100g – 1kg):\nExample: 250g or 500g",
        "sample_qty_invalid": "⚠️ Sample qty must be between 100g and 1kg. Example: 250g",
        "sample_ask_address": "📍 Please share your *full delivery address* (with PIN code):",
        "sample_address_invalid": "Please provide a complete address with PIN code.",
        "sample_summary": (
            "🧪 *SAMPLE ORDER SUMMARY*\n"
            f"{SEPARATOR}\n"
            "📦 Product: {product}\n"
            "⚖️ Qty: {qty}\n"
            "📍 Address: {address}\n"
            f"{SEPARATOR}\n"
            "💰 Sample cost: ₹{sample_cost}\n"
            "🚚 Courier: ₹{courier}\n"
            "*Total: ₹{total}*\n"
            f"{SEPARATOR}\n"
            "💳 Pay via UPI: *{upi}*\n"
            "🔗 Payment link:\n{upi_link}\n"
            f"{SEPARATOR}\n"
            "Send payment screenshot here. Team will dispatch within 48hrs."
        ),
        "quote_received": (
            "💰 *QUOTE REQUEST RECEIVED*\n"
            f"{SEPARATOR}\n"
            "📦 Product: {product}\n"
            "⚖️ Quantity: {qty}\n"
            "🌍 Buyer: {buyer_type}\n"
            f"{SEPARATOR}\n"
            "Our team is preparing your {sym} quote.\n"
            "⏰ Valid for *{hours} hours*.\n"
            "You will receive pricing shortly.\n"
            f"{SEPARATOR}\n"
            "📞 {phone} | ✉️ {email}"
        ),
        "feedback_header": "⭐ *FEEDBACK*",
        "feedback_ask": "Please share your feedback. We value your opinion! 🙏",
        "feedback_thanks": "🙏 Thank you for your feedback! Our team will review it shortly.",
        "list_button": "View Menu",
        "list_section": "Aarvex Services",
        "ai_lang_hint": "Always reply in English unless the customer writes in Hindi.",
    },
    "hi": {
        "lang_picker_body": (
            "🌾 *AARVEX GLOBAL*\n"
            f"{SEPARATOR}\n"
            "स्वागत है! कृपया भाषा चुनें:\n"
            "Welcome! Please choose your language 👇"
        ),
        "lang_set_hi": "✅ भाषा हिंदी में सेट हो गई।",
        "lang_set_en": "✅ Language set to English.",
        "ai_fallback_error": (
            "🙏 माफ़ कीजिए, अभी हमें एक तकनीकी समस्या आ रही है इसलिए आपका संदेश process नहीं हो पाया।\n"
            "कृपया कुछ मिनट बाद दोबारा कोशिश करें, या *MENU* टाइप करें।\n"
            "हमारी टीम को सूचित कर दिया गया है।"
        ),
        "welcome_body": (
            "🌾 *AARVEX GLOBAL*\n"
            "*प्रीमियम कृषि निर्यात घर*\n"
            "*Digital · AI · Social · Modern*\n"
            f"{SEPARATOR}\n"
            "नमस्ते! 🙏\n"
            "Aarvex Global में आपका स्वागत है — भारत का भरोसेमंद कृषि निर्यात साथी।\n"
            "🏆 गुणवत्ता | 🌍 वैश्विक पहुंच\n"
            "📦 खेत से बंदरगाह | ✅ प्रमाणित निर्यातक\n"
            "🤖 Smart Support | 📱 Socially Connected\n"
            f"{SEPARATOR}\n"
            "✅ IEC · GST · Udyam MSME पंजीकृत\n"
            "नीचे से विकल्प चुनें 👇"
        ),
        "menu_body": f"📋 *मुख्य मेनू*\n{SEPARATOR}\nनीचे से विकल्प चुनें 👇",
        "view_menu_btn": "📋 मेनू देखें",
        "view_menu_hint": "और कुछ चाहिए? नीचे टैप करें 👇",
        "social_connect_btn": "🌐 Social Connect",
        "action_footer_hint": "आगे क्या करना चाहेंगे? 👇",
        "action_list_button": "विकल्प चुनें",
        "action_list_section": "त्वरित विकल्प",
        "social_list_header": "🌐 *AARVEX GLOBAL — CONNECT*",
        "social_list_body": "प्लेटफ़ॉर्म चुनें — direct link मिलेगा 👇",
        "social_list_button": "प्लेटफ़ॉर्म",
        "social_list_section": "हमारे चैनल",
        "social_link_body": (
            "{emoji} *{name}*\n"
            f"{SEPARATOR}\n"
            "नीचे दिए गए बटन पर टैप करें 👇"
        ),
        "social_link_btn": "{name} खोलें",
        "catalogue_header": "📦 *AARVEX GLOBAL — उत्पाद सूची*",
        "catalogue_pick": "विवरण के लिए उत्पाद चुनें 👇",
        "catalogue_list_btn": "उत्पाद चुनें",
        "catalogue_list_section": "निर्यात उत्पाद",
        "quote_pick_header": "💰 *कोट / ऑर्डर*",
        "quote_pick_body": "उत्पाद चुनें — फिर सिर्फ मात्रा लिखें 👇",
        "quote_btn": "💰 कोट मांगें",
        "sample_btn": "🧪 नमूना",
        "quote_ask_qty": (
            "💰 *कोट अनुरोध*\n"
            f"{SEPARATOR}\n"
            "📦 उत्पाद: *{product}*\n"
            f"{SEPARATOR}\n"
            "कृपया *सिर्फ मात्रा* भेजें:\n"
            "उदाहरण: 500 kg | 2 MT | 10 bags"
        ),
        "quote_qty_invalid": "⚠️ सही मात्रा भेजें।\nउदाहरण: 500 kg या 2 MT",
        "demand_header": "✅ *मांग दर्ज हो गई*",
        "rating_header": "⭐ *अपना अनुभव रेट करें*",
        "rating_body": "Aarvex Global का अनुभव कैसा रहा?\n1–5 सितारे चुनें 👇",
        "rating_list_btn": "रेट करें",
        "rating_list_section": "आपकी रेटिंग",
        "rating_thanks": "🙏 *{stars}/5* रेटिंग के लिए धन्यवाद! आपकी राय हमारे लिए महत्वपूर्ण है।",
        "rating_row": "{stars} सितार{plural}",
        "quote_sample_hint": "📞 या उत्पाद से *नमूना* चुनें",
        "export_header": "🚢 *निर्यात सेवाएं*",
        "export_body": (
            "Aarvex Global पूरा निर्यात संभालता है:\n"
            "✅ IEC पंजीकृत निर्यातक\n"
            "✅ फाइटोसैनिटरी व COA दस्तावेज़\n"
            "✅ बंदरगाह व सीमा शुल्क सहायता\n"
            "✅ मध्य पूर्व, अफ्रीका व SE Asia"
        ),
        "sell_header": "🌾 *अपनी उपज बेचें*",
        "sell_body": (
            "किसान और suppliers — Aarvex से जुड़ें:\n"
            "• अंतर्राष्ट्रीय खरीदारों से जोड़ते हैं\n"
            "• उचित बाज़ार-आधारित कीमत\n"
            "• पूरा निर्यात दस्तावेज़\n"
            "• नए उत्पादों के लिए लचीला MOQ\n"
            f"{SEPARATOR}\n"
            "फसल + मात्रा + स्थान भेजें।"
        ),
        "about_header": "🏢 *AARVEX GLOBAL — परिचय*",
        "about_body": (
            "*प्रीमियम कृषि निर्यात घर*\n"
            "Warora, Chandrapur, Maharashtra, India\n"
            f"{SEPARATOR}\n"
            "🌐 *Digital · AI · Social · Modern*\n"
            "प्रमाणित दस्तावेज़ के साथ smart export support।\n"
            f"{SEPARATOR}\n"
            "📋 *पंजीकृत विवरण*\n"
            "🏛 GSTIN: {gst}\n"
            "🌍 IEC Code: {iec}\n"
            "🏭 Udyam MSME: {udyam}\n"
            "📄 PAN: {pan}\n"
            "📜 RC No.: {rc}\n"
            f"{SEPARATOR}\n"
            "✅ *प्रमाणित प्रमाणपत्र*\n"
            "• Udyam Registration Certificate\n"
            "• IEC (Import Export Code) Certificate\n"
            "• RC / Registration Certificate\n"
            "{cert_links}"
            f"{SEPARATOR}\n"
            "🌾 मसाले · अनाज · दाल · ताज़ी उपज\n"
            "🌍 वैश्विक आयातकों का भरोसेमंद साथी।\n"
            f"{SEPARATOR}\n"
            "📍 {address}\n"
            "📞 {phone} | ✉️ {email}\n"
            "🌐 {website}"
        ),
        "cert_links_block": (
            f"{SEPARATOR}\n"
            "📎 *प्रमाणपत्र डाउनलोड:*\n"
            "{links}"
        ),
        "cert_on_request": "📎 प्रमाणपत्र की copy email पर उपलब्ध।",
        "terms_header": "📋 *नियम व नीतियां*",
        "terms_body": (
            "• कोट {hours} घंटे तक मान्य\n"
            "• नमूना: 100g – 1kg (शुल्क + कूरियर)\n"
            "• MOQ उत्पाद के अनुसार — पूछें\n"
            "• भुगतान: नए खरीदारों से अग्रिम\n"
            "• गुणवत्ता: COA व निरीक्षण उपलब्ध\n"
            f"{SEPARATOR}\n"
            "📄 गोपनीयता नीति:\n{privacy_url}\n"
            f"{SEPARATOR}\n"
            "पूरी शर्तें ईमेल पर उपलब्ध।"
        ),
        "talk_header": "📞 *टीम से बात करें*",
        "talk_body": (
            "हमारी निर्यात टीम तैयार है:\n"
            "📱 WhatsApp/Call: {phone}\n"
            "✉️ Email: {email}\n"
            "⏰ 24 घंटे में जवाब\n"
            f"{SEPARATOR}\n"
            "उत्पाद + मात्रा भेजें — हम कॉल करेंगे!"
        ),
        "product_detail": (
            "📦 *{product}*\n"
            f"{SEPARATOR}\n"
            "प्रीमियम निर्यात ग्रेड।\n"
            "💰 कीमत: बाज़ार से जुड़ी — कोट मांगें\n"
            "🧪 नमूना: 100g–1kg उपलब्ध\n"
            "📋 COA, Phytosanitary, Invoice\n"
            f"{SEPARATOR}\n"
            "नीचे *कोट मांगें* — सिर्फ मात्रा लिखें।\n"
            "या *नमूना* टैप करें।"
        ),
        "sample_header": "🧪 *नमूना अनुरोध*",
        "sample_products": "नमूने के लिए उपलब्ध उत्पाद:",
        "sample_reply": "*उत्पाद का नाम* भेजें (100g – 1kg)।",
        "sample_invalid_product": "कृपया सूची से सही उत्पाद का नाम भेजें।",
        "sample_product_ok": "✅ उत्पाद: *{product}*\n\nनमूना मात्रा (100g – 1kg):\nउदाहरण: 250g या 500g",
        "sample_qty_invalid": "⚠️ नमूना 100g से 1kg के बीच होना चाहिए। उदाहरण: 250g",
        "sample_ask_address": "📍 *पूरा पता* भेजें (PIN code सहित):",
        "sample_address_invalid": "कृपया PIN code सहित पूरा पता भेजें।",
        "sample_summary": (
            "🧪 *नमूना ऑर्डर सारांश*\n"
            f"{SEPARATOR}\n"
            "📦 उत्पाद: {product}\n"
            "⚖️ मात्रा: {qty}\n"
            "📍 पता: {address}\n"
            f"{SEPARATOR}\n"
            "💰 नमूना: ₹{sample_cost}\n"
            "🚚 कूरियर: ₹{courier}\n"
            "*कुल: ₹{total}*\n"
            f"{SEPARATOR}\n"
            "💳 UPI: *{upi}*\n"
            "🔗 भुगतान लिंक:\n{upi_link}\n"
            f"{SEPARATOR}\n"
            "भुगतान screenshot भेजें। 48 घंटे में dispatch।"
        ),
        "quote_received": (
            "💰 *कोट अनुरोध प्राप्त*\n"
            f"{SEPARATOR}\n"
            "📦 उत्पाद: {product}\n"
            "⚖️ मात्रा: {qty}\n"
            "🌍 खरीदार: {buyer_type}\n"
            f"{SEPARATOR}\n"
            "हम आपका {sym} कोट तैयार कर रहे हैं।\n"
            "⏰ *{hours} घंटे* तक मान्य।\n"
            "जल्द कीमत मिलेगी।\n"
            f"{SEPARATOR}\n"
            "📞 {phone} | ✉️ {email}"
        ),
        "feedback_header": "⭐ *प्रतिक्रिया*",
        "feedback_ask": "अपनी प्रतिक्रिया साझा करें। हम आपकी राय की कदर करते हैं! 🙏",
        "feedback_thanks": "🙏 धन्यवाद! हमारी टीम जल्द समीक्षा करेगी।",
        "list_button": "मेनू देखें",
        "list_section": "Aarvex सेवाएं",
        "ai_lang_hint": "हमेशा हिंदी में जवाब दें जब तक ग्राहक अंग्रेजी में न लिखे।",
    },
}

dynamodb = boto3.resource("dynamodb")
table    = dynamodb.Table(DYNAMODB_TABLE)

if not WEBHOOK_SECRET:
    logger.warning("[CONFIG] WEBHOOK_SECRET not set — GET webhook verification will always fail (403).")
if not META_APP_SECRET:
    logger.warning("[CONFIG] META_APP_SECRET not set — incoming POST requests will NOT be signature-verified.")
if not INSTAGRAM_PAGE_ID:
    logger.warning("[CONFIG] INSTAGRAM_PAGE_ID not set — Instagram replies may fall back to 'me' endpoint.")


# ─────────────────────────────────────────────
#  LAMBDA ENTRYPOINT
# ─────────────────────────────────────────────
def lambda_handler(event, context):
    logger.info("[LAMBDA] Event received")

    http_method  = event.get("requestContext", {}).get("http", {}).get("method", "POST")
    query_params = event.get("queryStringParameters") or {}
    raw_path = (
        event.get("rawPath")
        or event.get("path")
        or event.get("requestContext", {}).get("http", {}).get("path", "")
    )
    request_path = raw_path.split("?")[0]
    for stage in ("/prod", "/dev", "/staging", "/$default"):
        if request_path.startswith(stage + "/"):
            request_path = request_path[len(stage):]
            break
    if request_path and not request_path.startswith("/"):
        request_path = "/" + request_path
    if request_path != "/" and request_path.endswith("/"):
        request_path = request_path.rstrip("/")

    logger.info(f"[ROUTE] {http_method} {request_path}")
    if request_path == "/cashfree-webhook":
        return handle_cashfree_webhook(event)
    if request_path == "/razorpay-webhook":  # legacy — kept for old links
        return handle_razorpay_webhook(event)

    if request_path.startswith("/admin/api/"):
        if http_method == "OPTIONS":
            return {
                "statusCode": 200,
                "headers": {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Admin-Session",
                    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
                },
                "body": "",
            }
        return get_admin_api_handler(event)

    if request_path == "/catalogue":
        # Public, no-auth endpoint — read by the marketing website (index.html)
        # to render live products from the DynamoDB catalogue. NOT a Meta
        # webhook, so it must never go through _verify_meta_signature below.
        if event.get("requestContext", {}).get("http", {}).get("method") == "OPTIONS":
            return {
                "statusCode": 200,
                "headers": {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "Content-Type",
                    "Access-Control-Allow-Methods": "GET,OPTIONS"
                },
                "body": ""
            }
        return get_public_catalogue(event)

    if request_path == "/web/order":
        # Browser-originated request from order-form.html — NOT a Meta webhook,
        # so it must never go through _verify_meta_signature below.
        if event.get("requestContext", {}).get("http", {}).get("method") == "OPTIONS":
            return {
                "statusCode": 200,
                "headers": {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "Content-Type,Authorization",
                    "Access-Control-Allow-Methods": "POST,OPTIONS"
                },
                "body": ""
            }
        return handle_web_order(event)

    if request_path == "/web/sell":
        # Browser-originated request from sell-form.html — NOT a Meta webhook,
        # so it must never go through _verify_meta_signature below.
        if event.get("requestContext", {}).get("http", {}).get("method") == "OPTIONS":
            return {
                "statusCode": 200,
                "headers": {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "Content-Type,Authorization",
                    "Access-Control-Allow-Methods": "POST,OPTIONS"
                },
                "body": ""
            }
        return handle_web_sell(event)

    # ── Marketplace / Portal routes (before Meta webhook signature check) ──
    _portal_paths = (
        "/kyc/submit", "/kyc/status",
        "/shop/create", "/shop/update", "/shop/delete", "/shop/subscribe", "/shop/info", "/shop/toggle", "/shop/products",
        "/account/summary", "/account/delete", "/order/invoice",
        "/rfq/create", "/rfq/message", "/rfq/list", "/rfq/get",
        "/dispute/create", "/dispute/get", "/dispute/list",
        "/alert/create", "/alert/list", "/alert/delete",
        "/shop/public", "/shop/react", "/shop/like", "/shop/feedback",
        "/shops/top", "/shop/list",
        "/catalogue/sections", "/catalogue/search", "/favourites/products",
        "/product/view", "/shop/analytics",
        "/referral/code", "/referral/apply", "/referral/list",
        "/listing/deal", "/listing/deal/preview",
        "/shop/product/add", "/shop/product/edit", "/shop/product/delete", "/shop/product/pause",
        "/review/submit", "/reviews",
        "/notifications", "/notifications/read", "/notifications/delete",
        "/banner/active", "/banner/upload", "/banner/remove",
        "/category/images", "/category/image/upload", "/category/image/remove",
        "/category/list", "/category/rename", "/category/delete",
        "/feed", "/feed/post", "/feed/edit", "/feed/delete", "/feed/like", "/feed/likers",
        "/feed/follow", "/feed/follow/stats",
        "/story/create", "/story/list", "/story/view", "/story/like", "/story/reply", "/story/delete",
        "/feed/comment", "/feed/comment/like", "/feed/comments", "/feed/view", "/feed/share",
        "/user/profile", "/user/search", "/user/block", "/user/blocklist", "/user/report", "/privacy/update",
        "/chat/send", "/chat/thread", "/chat/list", "/chat/read",
        "/chat/conv", "/chat/message", "/chat/starred", "/chat/broadcast",
        "/user/username", "/user/by-username", "/connect/request", "/chat/group/create",
        "/call/start", "/call/incoming", "/call/signal", "/call/signals", "/call/end",
        "/chat/e2e/register", "/chat/e2e/key",
        "/delivery/record", "/delivery/release", "/shop/team", "/shop/team/add", "/shop/team/remove",
        "/delivery/approve", "/delivery/reject-claim",
        "/importer/verify",
        "/order/detail",
        "/geo/set",
        "/geo/users",
        "/profile/cover", "/shop/favourites",
        "/favourites", "/favourites/toggle",
        "/track", "/profile", "/profile/update",
        "/order/cancel",
        "/delivery/orders", "/delivery/claim", "/delivery/start",
        "/delivery/location", "/delivery/complete", "/delivery/picked-up", "/delivery/send-otp", "/delivery/earnings",
        "/delivery/rate", "/delivery/rating",
        "/delivery/active", "/delivery/reject", "/delivery/review/submit",
        "/delivery/my-claims", "/delivery/cancel",
        "/address/list", "/address/save", "/address/delete",
        "/telemetry/report",
    )
    if request_path in _portal_paths:
        if http_method == "OPTIONS":
            return {
                "statusCode": 200,
                "headers": {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Admin-Session",
                    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
                },
                "body": "",
            }
        if ADVANCED_FEATURES_AVAILABLE:
            resp = handle_portal_route(event)
            if resp is not None:
                logger.info(f"[PORTAL] {request_path} → {resp.get('statusCode', '?')}")
                return resp
        logger.error(f"[PORTAL] {request_path} → 503 Marketplace unavailable")
        return {"statusCode": 503, "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"}, "body": json.dumps({"error": "Marketplace unavailable"})}



    if http_method == "GET":
        return _handle_webhook_verification(query_params)

    body_raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        raw_bytes = base64.b64decode(body_raw)
        body_raw  = raw_bytes.decode("utf-8")
    else:
        raw_bytes = body_raw.encode("utf-8")

    if not _verify_meta_signature(event, raw_bytes):
        logger.error("[SECURITY] Signature verification failed — rejecting request")
        return _response(403, "Invalid signature")

    try:
        payload = json.loads(body_raw)
    except json.JSONDecodeError:
        logger.error("[PARSE] Invalid JSON")
        return _response(400, "Bad Request")

    logger.info(f"[PAYLOAD] {json.dumps(payload)[:500]}")

    if not isinstance(payload, dict):
        logger.error(f"[PARSE] Unexpected payload type: {type(payload)}")
        return _response(200, "Unexpected payload")

    object_type = payload.get("object", "")

    if object_type == "whatsapp_business_account":
        return _handle_whatsapp(payload)

    if object_type == "instagram":
        return _handle_instagram(payload)

    if object_type == "page":
        return _handle_facebook(payload)

    logger.warning(f"[ROUTE] Unknown object type: {object_type} — skipping")
    return _response(200, "Unknown object type")


# ─────────────────────────────────────────────
#  WEBHOOK VERIFICATION (GET)
# ─────────────────────────────────────────────
def _handle_webhook_verification(params):
    mode      = params.get("hub.mode")
    token     = params.get("hub.verify_token")
    challenge = params.get("hub.challenge")

    if not WEBHOOK_SECRET:
        logger.error("[VERIFY] WEBHOOK_SECRET not configured in env vars — cannot verify")
        return _response(403, "Forbidden")

    logger.info(f"[VERIFY] mode={mode} token_match={token == WEBHOOK_SECRET}")

    if mode == "subscribe" and token == WEBHOOK_SECRET:
        logger.info("[VERIFY] Webhook verified!")
        return {
            "statusCode": 200,
            "body": challenge,
            "headers": {"Content-Type": "text/plain"},
        }

    logger.error("[VERIFY] Verification FAILED — check WEBHOOK_SECRET env var")
    return _response(403, "Forbidden")


def _verify_meta_signature(event, raw_body: bytes) -> bool:
    if not META_APP_SECRET:
        return True

    headers = event.get("headers") or {}
    signature_header = headers.get("x-hub-signature-256") or headers.get("X-Hub-Signature-256", "")

    if not signature_header or not signature_header.startswith("sha256="):
        logger.error("[SECURITY] Missing or malformed X-Hub-Signature-256 header")
        return False

    expected_sig = signature_header.split("sha256=", 1)[1]
    computed_sig = hmac.new(META_APP_SECRET.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()

    if not hmac.compare_digest(expected_sig, computed_sig):
        logger.error("[SECURITY] Signature mismatch — possible spoofed request")
        return False

    return True


# ─────────────────────────────────────────────
#  PRODUCT CATALOGUE HELPERS
# ─────────────────────────────────────────────
def _get_products() -> list:
    return [p.strip() for p in PRODUCT_CATALOGUE.split(",") if p.strip()]


def _build_catalogue_message(lang: str = "en") -> str:
    products = _get_products()
    lines = "\n".join(f"• {p}" for p in products)
    return (
        f"{_t('catalogue_header', lang)}\n"
        f"{SEPARATOR}\n"
        f"{lines}\n"
        f"{_t('catalogue_pricing', lang)}\n"
        f"{_t('catalogue_reply', lang)}\n"
        f"{SEPARATOR}"
    )


def _build_quote_prompt(lang: str = "en") -> str:
    products = ", ".join(_get_products()[:5])
    return (
        f"{_t('quote_header', lang)}\n"
        f"{SEPARATOR}\n"
        f"{_t('quote_instr', lang)}\n\n"
        f"{_t('quote_example', lang)}\n\n"
        f"{_t('quote_available', lang)}: {products}...\n"
        f"{_t('quote_sample_hint', lang)}"
    )


def _build_export_services_message(lang: str = "en") -> str:
    return (
        f"{_t('export_header', lang)}\n"
        f"{SEPARATOR}\n"
        f"{_t('export_body', lang)}\n"
        f"{SEPARATOR}\n"
        f"📞 {COMPANY_PHONE} | ✉️ {COMPANY_EMAIL}"
    )


def _build_sell_produce_message(lang: str = "en") -> str:
    return f"{_t('sell_header', lang)}\n{SEPARATOR}\n{_t('sell_body', lang)}"


def _build_about_message(lang: str = "en") -> str:
    # Build certificate links block
    cert_parts = []
    if CERT_UDYAM_URL:
        cert_parts.append(f"• Udyam: {CERT_UDYAM_URL}")
    if CERT_IEC_URL:
        cert_parts.append(f"• IEC: {CERT_IEC_URL}")
    if CERT_RC_URL:
        cert_parts.append(f"• RC: {CERT_RC_URL}")

    if cert_parts:
        links_str = "\n".join(cert_parts)
        cert_links = _t("cert_links_block", lang, links=links_str) + "\n"
    else:
        cert_links = _t("cert_on_request", lang) + "\n"

    about_body = _t(
        "about_body", lang,
        gst=COMPANY_GST,
        iec=COMPANY_IEC,
        udyam=COMPANY_UDYAM,
        pan=COMPANY_PAN,
        rc=COMPANY_RC,
        cert_links=cert_links,
        address=COMPANY_ADDRESS,
        phone=COMPANY_PHONE,
        email=COMPANY_EMAIL,
        website=COMPANY_WEBSITE,
    )
    return f"{_t('about_header', lang)}\n{SEPARATOR}\n{about_body}"


def _build_terms_message(lang: str = "en") -> str:
    return (
        f"{_t('terms_header', lang)}\n"
        f"{SEPARATOR}\n"
        f"{_t('terms_body', lang, hours=QUOTE_VALID_HOURS, privacy_url=PRIVACY_POLICY_URL)}"
    )


def _build_talk_to_team_message(lang: str = "en") -> str:
    return _t("talk_body", lang, phone=COMPANY_PHONE, email=COMPANY_EMAIL)


def _build_product_detail(product: str, phone: str, lang: str = "en") -> str:
    sym = _currency_symbol(phone)
    return _t("product_detail", lang, product=product, sym=sym)



# === CHANGE 3: TOTP 2FA — Helper functions for admin authentication ===

def _verify_totp(code: str) -> bool:
    """
    Verify 6-digit TOTP code against ADMIN_TOTP_SECRET (RFC 6238).
    Tries pyotp first; falls back to manual RFC 6238 implementation.
    Returns True only on valid code. Fails securely on any error.
    """
    secret = ADMIN_TOTP_SECRET
    if not secret:
        logger.error("[TOTP] ADMIN_TOTP_SECRET not configured — admin commands disabled")
        return False

    # Strategy 1: Use pyotp if available (preferred)
    try:
        import pyotp
        totp = pyotp.TOTP(secret)
        result = totp.verify(code, valid_window=1)
        logger.info(f"[TOTP] pyotp verify result: {result}")
        return result
    except ImportError:
        pass  # pyotp not installed — use manual implementation below
    except Exception as e:
        logger.error(f"[TOTP] pyotp exception: {e}")
        return False

    # Strategy 2: Manual RFC 6238 TOTP (HMAC-SHA1, 30s window, 6 digits)
    try:
        import base64
        import hmac as _hmac
        import hashlib
        import struct

        # Decode base32 secret (pad if needed)
        padded = secret.upper()
        pad_len = (8 - len(padded) % 8) % 8
        padded += "=" * pad_len
        secret_bytes = base64.b32decode(padded)

        current_counter = int(time.time()) // 30

        def _hotp(key: bytes, counter: int) -> str:
            msg = struct.pack(">Q", counter)
            h = _hmac.new(key, msg, hashlib.sha1).digest()
            offset = h[-1] & 0x0F
            code_int = struct.unpack(">I", h[offset:offset + 4])[0] & 0x7FFFFFFF
            return str(code_int % 1_000_000).zfill(6)

        # Check current window ± 1 (3 windows total for clock skew tolerance)
        for delta in (-1, 0, 1):
            expected = _hotp(secret_bytes, current_counter + delta)
            if _hmac.compare_digest(expected, str(code).zfill(6)):
                return True

        return False

    except Exception as e:
        logger.error(f"[TOTP] Manual TOTP exception: {e}")
        return False


def _is_admin_number(phone: str) -> bool:
    """Check if the incoming WhatsApp number matches the configured admin number."""
    if not ADMIN_WHATSAPP_NUMBER:
        return False
    # Normalise: strip all non-digits and compare
    return re.sub(r"\D", "", phone) == re.sub(r"\D", "", ADMIN_WHATSAPP_NUMBER)


def _get_admin_failed_attempts(phone: str) -> int:
    """Return count of failed TOTP attempts in the last hour for this number."""
    try:
        resp = table.get_item(Key={"pk": f"ADMIN_FAIL#{phone}"})
        item = resp.get("Item") or {}
        return int(item.get("count", 0))
    except ClientError:
        return 0


def _increment_admin_failed_attempts(phone: str):
    """Increment failed TOTP attempts counter. TTL = 1 hour."""
    try:
        resp = table.get_item(Key={"pk": f"ADMIN_FAIL#{phone}"})
        item = resp.get("Item") or {}
        new_count = int(item.get("count", 0)) + 1
        table.put_item(Item={
            "pk":    f"ADMIN_FAIL#{phone}",
            "count": new_count,
            "ttl":   int(time.time()) + 3600,
        })
    except ClientError as e:
        logger.error(f"[TOTP] Failed to increment attempt counter: {e}")


def _clear_admin_failed_attempts(phone: str):
    """Clear failed attempt counter on successful TOTP verification."""
    try:
        table.delete_item(Key={"pk": f"ADMIN_FAIL#{phone}"})
    except ClientError as e:
        logger.error(f"[TOTP] Failed to clear attempt counter: {e}")


def _set_admin_verified(phone: str):
    """Mark this admin session as verified in DynamoDB. TTL = 30 minutes."""
    try:
        table.put_item(Item={
            "pk":           f"ADMIN_SESSION#{phone}",
            "verified":     True,
            "verified_at":  int(time.time()),
            "ttl":          int(time.time()) + 1800,
        })
        logger.info(f"[TOTP] Admin session set for ...{phone[-4:]}")
    except ClientError as e:
        logger.error(f"[TOTP] Failed to set admin session: {e}")


def _is_admin_verified(phone: str) -> bool:
    """Check if admin session is active and not expired."""
    if not _is_admin_number(phone):
        return False
    try:
        resp = table.get_item(Key={"pk": f"ADMIN_SESSION#{phone}"})
        item = resp.get("Item") or {}
        if not item.get("verified"):
            return False
        # Extra time check — DynamoDB TTL may have up to 48h delay
        verified_at = int(item.get("verified_at", 0))
        if int(time.time()) - verified_at > 1800:
            return False
        return True
    except ClientError:
        return False


def _build_admin_stats() -> str:
    return (
        f"🔐 *ADMIN PANEL*\n"
        f"{SEPARATOR}\n"
        f"Products: {len(_get_products())}\n"
        f"Catalogue: {PRODUCT_CATALOGUE[:80]}...\n"
        f"Cooldown: {COOLDOWN_MINUTES} min\n"
        f"Model: {OPENROUTER_MODEL}\n"
        f"Bot v5.0 running ✅"
    )


def _send_admin_panel(to_number: str):
    """
    Admin login ke baad ya kisi bhi admin action ke baad
    ek interactive list bhejta hai jisme sabhi admin options
    as clickable rows hain — type karne ki zaroorat nahi.
    """
    ADMIN_DASHBOARD_URL = "https://d11r34jvtscrqz.cloudfront.net/admin_dashboard.html"
    rows = [
        {
            "id": "admin_stats",
            "title": "📊 Bot Stats",
            "description": "Products, model, cooldown info dekhein",
        },
        {
            "id": "admin_dashboard",
            "title": "🖥️ Admin Dashboard",
            "description": "Orders, tickets, broadcast manage karein",
        },
        {
            "id": "admin_stop_updates",
            "title": "🔕 Stop Updates",
            "description": "Broadcast updates band karein",
        },
        {
            "id": "admin_start_updates",
            "title": "🔔 Start Updates",
            "description": "Broadcast updates shuru karein",
        },
    ]
    payload = {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": to_number,
        "type": "interactive",
        "interactive": {
            "type": "cta_url",  # <-- Yahan list se badalkar cta_url kiya
            "body": {
                "text": (
                    "✅ *Admin Login Successful!*\n"
                    f"{SEPARATOR}\n"
                    "🔐 You are now in Admin Mode *(Valid for 30 min)*\n"
                    f"{SEPARATOR}\n"
                    "Please click the button below to access your dashboard 👇"
                )[:1024],
            },
            "action": {
                "name": "cta_url",
                "parameters": {
                    "display_text": "Open Dashboard",  # <-- Button ke upar ye likha dikhega
                    "url": ADMIN_DASHBOARD_URL,          # <-- Click karte hi ye link khulegi
                },
            },
        },
    }
    _send_whatsapp_payload(to_number, payload)


    text_lower = text.lower()
    for product in _get_products():
        if product.lower() in text_lower:
            return product
    return ""


def _match_product_in_text(text: str) -> str:
    """
    Best-effort match of a known PRODUCT_CATALOGUE item inside free text.
    Lets a customer type e.g. "Teja Lal Mirch 50kg" instead of tapping a button.
    Returns the product name exactly as stored in PRODUCT_CATALOGUE, or "" if
    nothing in the catalogue matches (e.g. menu/category titles, random text).

    NOTE: this was previously called but never defined in this file — that
    caused a NameError every time a message reached this point (including
    catalogue category/product taps like "adv_cat_*"), which silently crashed
    message processing before it could ever reach the advanced router.
    """
    if not text:
        return ""
    text_l = text.lower()
    for product in _get_products():
        if re.search(r"\b" + re.escape(product.lower()) + r"\b", text_l):
            return product
    return ""


def _extract_quantity(text: str) -> str:
    patterns = [
        r"(\d+(?:\.\d+)?\s*(?:kg|g|ton|tons|mt|quintal|qtl|bag|bags|tonne|ltr|litre|liter)s?)",
        r"(\d+(?:\.\d+)?)\s*(?:quintals?|quintals)",
    ]
    for pat in patterns:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            return m.group(1).strip()
    return ""


def _is_indian_buyer(phone: str) -> bool:
    digits = re.sub(r"\D", "", phone)
    return digits.startswith("91") and len(digits) >= 12


def _currency_symbol(phone: str) -> str:
    return "₹" if _is_indian_buyer(phone) else "$"


# ─────────────────────────────────────────────
#  i18n — Language helpers
# ─────────────────────────────────────────────
def _t(key: str, lang: str = "en", **kwargs) -> str:
    lang = lang if lang in SUPPORTED_LANGS else "en"
    text = TEXTS.get(lang, TEXTS["en"]).get(key, TEXTS["en"].get(key, key))
    if kwargs:
        return text.format(**kwargs)
    return text


def _get_lang(phone: str) -> str:
    try:
        resp = table.get_item(Key={"pk": f"CONTACT#WA#{phone}"})
        item = resp.get("Item") or {}
        lang = item.get("language", "")
        return lang if lang in SUPPORTED_LANGS else ""
    except ClientError:
        return ""


def _set_lang(phone: str, lang: str, name: str = ""):
    if lang not in SUPPORTED_LANGS:
        lang = "en"
    try:
        existing = table.get_item(Key={"pk": f"CONTACT#WA#{phone}"}).get("Item") or {}
        table.put_item(Item={
            "pk":            f"CONTACT#WA#{phone}",
            "language":      lang,
            "name":          name or existing.get("name", "Customer"),
            "first_seen_ts": existing.get("first_seen_ts", int(time.time())),
            "updated_at":    datetime.now(timezone.utc).isoformat(),
        })
    except ClientError as e:
        logger.error(f"[DYNAMO] Set language error: {e}")


def _needs_language(phone: str) -> bool:
    return not _get_lang(phone)


def _get_menu_rows(lang: str) -> list:
    return MENU_ROWS_I18N.get(lang if lang in SUPPORTED_LANGS else "en", MENU_ROWS_I18N["en"])


# ─────────────────────────────────────────────
#  WHATSAPP MESSAGE HANDLER
# ─────────────────────────────────────────────
def _handle_whatsapp(payload):
    try:
        if not WA_ACCESS_TOKEN:
            logger.error("[WA] WA_ACCESS_TOKEN not set in env variables!")
            return _response(200, "Config error")

        entry   = payload.get("entry", [])
        if not entry:
            return _response(200, "No entry")

        changes = entry[0].get("changes", [])
        if not changes:
            return _response(200, "No changes")

        value    = changes[0].get("value", {})
        messages = value.get("messages", [])

        if not messages:
            statuses = value.get("statuses", [])
            if statuses:
                logger.info("[WA] Status update received — skipping")
            else:
                logger.info("[WA] No messages in payload — skipping")
            return _response(200, "OK")

        contacts     = value.get("contacts", [])
        contact_name = contacts[0].get("profile", {}).get("name", "Customer") if contacts else "Customer"

        for msg in messages:
            try:
                _process_whatsapp_message(msg, contact_name)
            except Exception as e:
                logger.error(f"[WA] Error processing one message: {e}", exc_info=True)
                # FIX: pehle yahan sirf log hota tha — user ko WhatsApp pe kuch reply nahi
                # jaata tha, isliye unko lagta tha bot "stuck" ho gaya / kuch process hi
                # nahi hua. Ab ek generic fallback bhejte hain taaki user blank na rahe.
                try:
                    _send_whatsapp_text(
                        msg.get("from", ""),
                        "Good Luck 🤞"
                        #"ya 'menu' likh kar dobara shuru karein.",
                    )
                except Exception:
                    pass

        return _response(200, "OK")

    except Exception as e:
        logger.error(f"[WA] Unhandled exception: {e}", exc_info=True)
        return _response(200, "OK")


def _extract_whatsapp_input(msg: dict) -> tuple:
    """Returns (user_text, interactive_id, msg_type)."""
    msg_type = msg.get("type", "")

    if msg_type == "text":
        text = msg.get("text", {}).get("body", "").strip()
        return text, "", "text"

    if msg_type == "interactive":
        interactive = msg.get("interactive", {})
        itype = interactive.get("type", "")
        if itype == "button_reply":
            reply = interactive.get("button_reply", {})
            return reply.get("title", "").strip(), reply.get("id", "").strip(), "interactive"
        if itype == "list_reply":
            reply = interactive.get("list_reply", {})
            return reply.get("title", "").strip(), reply.get("id", "").strip(), "interactive"

    return "", "", msg_type


def _process_whatsapp_message(msg: dict, contact_name: str):
    msg_type_raw = msg.get("type", "")
    msg_id       = msg.get("id", "")

    if msg_type_raw not in ("text", "interactive"):
        logger.info(f"[WA] Non-text/interactive type: {msg_type_raw} — skipping")
        return

    from_number = msg.get("from", "")
    user_text, interactive_id, msg_type = _extract_whatsapp_input(msg)
    action_key = interactive_id or user_text
    lang       = _get_lang(from_number) or "en"

    if not action_key and not from_number:
        logger.info("[WA] Empty input — skipping")
        return

    logger.info(f"[WA] Message from {from_number} ({contact_name}): {action_key[:100]}")

    if _is_duplicate_message(msg_id):
        logger.info(f"[WA] Duplicate message {msg_id} — skipping")
        return

    # === CHANGE 3: TOTP 2FA — Admin authentication gate ===
    # Step 1: Check if message matches ADMIN <6-digit> pattern
    # Sirf 6 digits — admin number se aaye to TOTP check, warna normal flow
    _admin_totp_match = re.match(r'^(\d{6})$', (user_text or "").strip())
    if _admin_totp_match and _is_admin_number(from_number):
        # Step 3: Brute-force guard — block if 5+ failures in last hour
        if _get_admin_failed_attempts(from_number) >= 5:
            logger.warning(f"[TOTP] Brute-force block active for ...{from_number[-4:]} — silently ignoring")
            _save_message_id(msg_id)
            return
        # Step 4: Verify TOTP code
        totp_code = _admin_totp_match.group(1)
        if _verify_totp(totp_code):
            # SUCCESS — set session, clear fail counter, send WhatsApp confirmation
            _set_admin_verified(from_number)
            _clear_admin_failed_attempts(from_number)
            logger.info(f"[TOTP] Admin verified successfully for ...{from_number[-4:]}")
            _send_admin_panel(from_number)
        else:
            # FAILURE — increment counter, inform admin
            _increment_admin_failed_attempts(from_number)
            logger.error(f"[TOTP] Admin TOTP verification failed for ...{from_number[-4:]}")
            attempts = _get_admin_failed_attempts(from_number)
            remaining = max(0, 5 - attempts)
            _send_whatsapp_text(from_number, (
                "❌ *Invalid OTP Code*\n\n"
                "Google Authenticator ka code galat hai ya expire ho gaya.\n\n"
                f"⚠️ Remaining attempts: *{remaining}/5*\n\n"
                "_Naya 6-digit code generate karke dobara bhejein._"
            ))
        _save_message_id(msg_id)
        return

    # ── Admin stats (legacy password-based) ──
    if ADMIN_PASSWORD and user_text == f"ADMIN {ADMIN_PASSWORD}":
        _send_admin_panel(from_number)
        _save_message_id(msg_id)
        return

    # ── Admin interactive panel buttons ──
    if interactive_id and interactive_id.startswith("admin_") and _is_admin_number(from_number) and _is_admin_verified(from_number):
        if interactive_id == "admin_stats":
            _send_whatsapp_text(from_number, _build_admin_stats())
            _send_admin_panel(from_number)
            _save_message_id(msg_id)
            return
        if interactive_id == "admin_dashboard":
            _send_whatsapp_text(
                from_number,
                "🖥️ *Admin Dashboard*\n"
                f"{SEPARATOR}\n"
                "Neeche diye link par click karke Admin Dashboard kholein:\n\n"
                "👉 http://aarvex-admin-dashboard-prod.s3-website-ap-southeast-1.amazonaws.com\n\n"
                "_Dashboard mein orders, tickets, stats aur broadcast manage kar sakte hain._"
            )
            _send_admin_panel(from_number)
            _save_message_id(msg_id)
            return
        if interactive_id == "admin_stop_updates":
            _send_whatsapp_text(from_number, "✅ *STOP UPDATES* command execute ho raha hai...")
            # Admin khud opt-out nahi karta — yeh broadcast ke liye use hota hai
            _send_whatsapp_text(from_number, "ℹ️ STOP UPDATES customer ke liye hota hai, admin ke liye nahi.\nBroadcast list manage karne ke liye Dashboard use karein.")
            _send_admin_panel(from_number)
            _save_message_id(msg_id)
            return
        if interactive_id == "admin_start_updates":
            _send_whatsapp_text(from_number, "✅ *START UPDATES* command execute ho raha hai...")
            _send_whatsapp_text(from_number, "ℹ️ START UPDATES customer ke liye hota hai, admin ke liye nahi.\nBroadcast list manage karne ke liye Dashboard use karein.")
            _send_admin_panel(from_number)
            _save_message_id(msg_id)
            return

    # ── Admin commands (text-based, TOTP session verified hone ke baad) ──
    if _is_admin_number(from_number) and _is_admin_verified(from_number):
        text_upper = user_text.strip().upper()
        # ADMIN STATS
        if text_upper == "ADMIN STATS":
            _send_whatsapp_text(from_number, _build_admin_stats())
            _send_admin_panel(from_number)
            _save_message_id(msg_id)
            return
        # BROADCAST START
        if user_text.strip().lower().startswith("broadcast_start "):
            s3_key = user_text.strip().split(maxsplit=1)[1]
            if ADVANCED_FEATURES_AVAILABLE:
                try:
                    from advanced_features import start_broadcast, send_whatsapp_text as _adv_wa
                    batch_id = start_broadcast(s3_key, "")
                    _adv_wa(from_number, f"📊 *Broadcast Queued!*\n\nBatch ID: `{batch_id}`\nFile: {s3_key}")
                except Exception as e:
                    logger.error(f"[ADMIN] Broadcast error: {e}")
                    _send_whatsapp_text(from_number, f"❌ Broadcast failed: {e}")
            else:
                _send_whatsapp_text(from_number, "❌ Advanced features unavailable.")
            _send_admin_panel(from_number)
            _save_message_id(msg_id)
            return

    # ── Language selection (Hindi / English) ──
    if interactive_id in ("lang_hi", "lang_en"):
        lang = "hi" if interactive_id == "lang_hi" else "en"
        _set_lang(from_number, lang, contact_name)
        _send_whatsapp_text(from_number, _t("lang_set_hi" if lang == "hi" else "lang_set_en", lang))
        _send_main_menu(from_number, lang, is_welcome=True)
        _save_message_id(msg_id)
        return

    # ── View Menu button (clears active flow) ──
    if interactive_id == "menu_main":
        _clear_flow_state(from_number)
        lang = _get_lang(from_number) or "en"
        _send_main_menu(from_number, lang, is_welcome=False)
        _save_message_id(msg_id)
        return

    # ── Social platform selected → send link as a tappable CTA button ──
    if interactive_id and interactive_id.startswith("social_"):
        lang = _get_lang(from_number) or "en"
        for sid, name, emoji, url in SOCIAL_LINKS:
            if interactive_id == sid:
                _send_social_link_cta(from_number, lang, emoji, name, url)
                _save_message_id(msg_id)
                return
        # Unknown social id — just show connect list again
        _send_social_connect_list(from_number, lang)
        _save_message_id(msg_id)
        return

    # ── Rating received ──
    if interactive_id and interactive_id.startswith("rating_"):
        lang = _get_lang(from_number) or "en"
        stars = interactive_id.split("_")[-1]
        _save_rating(from_number, stars)
        _send_reply_with_menu(from_number, _t("rating_thanks", lang, stars=stars), lang)
        _save_message_id(msg_id)
        return

    # ── Change language from menu ──
    if interactive_id == "menu_language":
        _send_language_picker(from_number)
        _save_message_id(msg_id)
        return

    # ── No language yet → show language picker first ──
    # FIX: agar user ne already kisi interactive button/list par tap kiya hai
    # (catalogue, quote, sample, prod_*, cat_*, menu_* etc.), to uska intent clear hai —
    # language picker baar-baar dikhane se action block nahi karna chahiye.
    # Sirf plain free-text (interactive_id empty) ke liye language-gate lagani hai,
    # taaki bilkul naya user pehli baar "hi" type kare to use language choose karne ko mile.
    # Also skip for opt-in/out commands — they are self-contained.
    _opt_cmds = {"stop updates", "start updates"}
    if _needs_language(from_number) and not interactive_id and user_text.lower().strip() not in _opt_cmds:
        _send_language_picker(from_number)
        _save_message_id(msg_id)
        return

    lang = _get_lang(from_number) or "en"
    text_norm = user_text.lower().strip()

    # ── Menu keyword → main menu (also cancels active flow) ──
    if text_norm in MENU_TRIGGERS:
        _clear_flow_state(from_number)
        _send_main_menu(from_number, lang, is_welcome=False)
        _save_message_id(msg_id)
        return

    # ── Catalogue product tapped (detail mode) ──
    if interactive_id and interactive_id.startswith("cat_detail_"):
        try:
            idx = int(interactive_id.split("_")[-1])
            products = _get_products()
            if 0 <= idx < len(products):
                product_name = products[idx]
                if ADVANCED_FEATURES_AVAILABLE:
                    advanced_response = route_advanced_feature(
                        message_type="interactive",
                        message_body=product_name,
                        wa_from=from_number,
                        user_state={"language": lang, "contact_name": contact_name, "message_id": msg_id, "interactive_id": f"adv_catalogue_search_{product_name}"},
                        message_data=msg,
                    )
                    if advanced_response is not None:
                        _save_message_id(msg_id)
                        return
                _send_product_detail_with_buttons(from_number, product_name, from_number, lang)
                _save_message_id(msg_id)
                return
        except (ValueError, IndexError):
            pass

    # ── Product detail: Place Order button (env-var catalogue products) ──
    if interactive_id and interactive_id.startswith("prod_quote_"):
        _pq_safe_id = interactive_id[len("prod_quote_"):]
        _pq_display = _pq_safe_id.replace("_", " ").strip()
        _pq_url = ("https://aarvex-admin-dashboard-prod.s3.ap-southeast-1.amazonaws.com"
                   "/order-form.html?product=" + _pq_safe_id.lower())
        _pq_cta = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": from_number,
            "type": "interactive",
            "interactive": {
                "type": "cta_url",
                "body": {
                    "text": (
                        "Place Order - " + _pq_display + "\n\n"
                        "Neeche button tap karke order form bharo.\n"
                        "Name, address, quantity sab ek jagah fill hoga."
                    ),
                },
                "action": {
                    "name": "cta_url",
                    "parameters": {
                        "display_text": "Place Order - " + _pq_display,
                        "url": _pq_url,
                    },
                },
            },
        }
        _send_whatsapp_payload(from_number, _pq_cta)
        _save_message_id(msg_id)
        return

    # ── Product detail: Sample button ──
    if interactive_id and interactive_id.startswith("prod_sample_"):
        product = interactive_id[len("prod_sample_"):]
        data = {"product": product, "contact_name": contact_name, "lang": lang}
        _save_flow_state(from_number, "sample", "quantity", data)
        _send_whatsapp_text(from_number, _t("sample_product_ok", lang, product=product))
        _save_message_id(msg_id)
        return

    # ── Catalogue product tapped (quote mode) ──
    if interactive_id and interactive_id.startswith("cat_quote_"):
        try:
            idx = int(interactive_id.split("_")[-1])
            products = _get_products()
            if 0 <= idx < len(products):
                product = products[idx]
                _save_flow_state(from_number, "quote", "quantity", {"product": product, "contact_name": contact_name, "lang": lang})
                _send_whatsapp_text(from_number, _t("quote_ask_qty", lang, product=product))
                _save_message_id(msg_id)
                return
        except (ValueError, IndexError):
            pass

    # ── Interactive menu selection (always takes priority over a stale flow) ──
    # FIX: pehle yahan flow-continuation check tha menu check se UPAR, jiski wajah se
    # agar user ka koi purana active flow (quote/sample/feedback) DynamoDB me bacha hota
    # tha, to naya menu tap (jaise "menu_catalogue") us purane flow me hijack ho jata tha —
    # list_reply ka title text ("Product Catalogue") feedback/quote answer ban jata tha.
    # Ab: explicit menu_* tap hamesha turant apna correct action chalayega, flow continuation
    # sirf plain free-text input (interactive_id empty) ke liye hi try hogi.
    if interactive_id and interactive_id.startswith("menu_"):
        _clear_flow_state(from_number)
        _handle_menu_selection(from_number, contact_name, interactive_id, msg_id, lang)
        return

    # ── Active conversation flow (quote / sample / feedback / rating) ──
    # FIX: flow-continuation ab SIRF plain free-text (interactive_id empty) ke liye chalegi.
    # Pehle sirf "menu_main" ko exclude kiya gaya tha, jiski wajah se naye catalogue ke
    # interactive taps — "adv_cat_*" (category), "adv_prod_*" (product), "adv_order_*" (order) —
    # ek purane bache hue flow (quote/sample/feedback/sell) me hijack ho jaate the. Isi wajah se
    # category tap ("Spices & Masale") wahi flow ka free-text jawab ban jata tha aur asli
    # product-list handler kabhi call hi nahi hota tha — catalogue wahi par ruk jata tha.
    # Saare flows (quote/sample/feedback/sell) sirf typed text expect karte hain, kisi button
    # tap ka nahi, isliye yahan check "interactive_id bilkul na ho" tak sakht kar diya gaya hai.
    flow = _get_flow_state(from_number)
    if flow and not interactive_id:
        handled = _continue_flow(from_number, contact_name, user_text, flow, msg_id, lang)
        if handled:
            return

    # ── Sample request trigger ──
    if _is_sample_trigger(user_text):
        _start_sample_flow(from_number, contact_name, msg_id, lang)
        return

    # ── Quote request (product + quantity) ──
    product  = _match_product_in_text(user_text)
    quantity = _extract_quantity(user_text)
    if product and quantity:
        _handle_quote_request(from_number, contact_name, product, quantity, user_text, msg_id, lang)
        return

    # ── Product name only → details ──
    if product and not quantity:
        _send_product_detail_with_buttons(from_number, product, from_number, lang)
        _save_message_id(msg_id)
        return

    # ── Advanced features router (catalogue/order/tracking/broadcast opt-in) ──
    if ADVANCED_FEATURES_AVAILABLE:
        advanced_response = route_advanced_feature(
            message_type=msg_type,
            message_body=user_text,
            wa_from=from_number,
            user_state={
                "language": lang,
                "contact_name": contact_name,
                "message_id": msg_id,
                "interactive_id": interactive_id,
            },
            message_data=msg,
        )
        if advanced_response is not None:
            _save_message_id(msg_id)
            return

    # ── AI fallback (with cooldown) ──
    if not user_text:
        return

    if _is_on_cooldown(f"WA#{from_number}"):
        logger.info(f"[WA] Cooldown active for {from_number}")
        return

    ai_reply = _get_ai_reply(contact_name, user_text, user_text, "WhatsApp", lang)
    if not ai_reply:
        logger.error("[WA] AI reply generation failed — sending fallback message instead of staying silent")
        _send_whatsapp_text(from_number, _t("ai_fallback_error", lang))
        _save_message_id(msg_id)
        return

    logger.info(f"[WA] AI reply: {ai_reply[:200]}")
    if _send_reply_with_menu(from_number, ai_reply, lang):
        _save_state(f"WA#{from_number}", msg_id, "WhatsApp", ai_reply)
        _save_message_id(msg_id)
        logger.info(f"[WA] DONE — replied to {from_number}")


def _is_sample_trigger(text: str) -> bool:
    t = text.lower().strip()
    return any(kw in t for kw in SAMPLE_TRIGGERS)


def _send_product_detail_with_buttons(to_number: str, product: str, phone: str, lang: str = "en"):
    """Send product detail text + 3 reply buttons: Place Order / Other Product / Go Back."""
    detail_text = _build_product_detail(product, phone, lang)
    _send_whatsapp_text(to_number, detail_text)

    safe_id = re.sub(r"[^a-zA-Z0-9_]", "_", product)[:50]

    payload = {
        "messaging_product": "whatsapp",
        "recipient_type":    "individual",
        "to":                to_number,
        "type":              "interactive",
        "interactive": {
            "type": "button",
            "body": {"text": "What would you like to do?"},
            "action": {
                "buttons": [
                    {"type": "reply", "reply": {
                        "id":    "prod_quote_" + safe_id,
                        "title": "Place Order",
                    }},
                    {"type": "reply", "reply": {
                        "id":    "menu_catalogue",
                        "title": "Other Product",
                    }},
                    {"type": "reply", "reply": {
                        "id":    "menu_main",
                        "title": "Go Back",
                    }},
                ],
            },
        },
    }
    _send_whatsapp_payload(to_number, payload)




def _start_sell_flow(to_number: str, contact_name: str, lang: str = "en"):
    """Start Sell Your Produce flow — CTA button + WhatsApp text option."""
    _save_flow_state(to_number, "sell", "step1_crop", {"contact_name": contact_name, "lang": lang})
    
    form_url = "https://aarvex-admin-dashboard-prod.s3.ap-southeast-1.amazonaws.com/sell-form.html"
    
    sell_cta = {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": to_number,
        "type": "interactive",
        "interactive": {
            "type": "cta_url",
            "body": {
                "text": (
                    "Sell Your Produce - Aarvex Global\n\n"
                    "*Sell Your Produce - Aarvex Global*\n\n"
                    "🌾 *English:* Tap the button below to list your crop.\n"
                    "⏱️ The form takes *only 2 minutes* to submit.\n\n"
                    "🌾 *हिंदी:* अपनी फसल को लिस्ट करने के लिए नीचे दिए गए बटन पर टैप करें।\n"
                    "⏱️ फॉर्म सबमिट करने में *सिर्फ 2 मिनट* का समय लगता है।"
                ),
            },
            "action": {
                "name": "cta_url",
                "parameters": {
                    "display_text": "List My Produce",
                    "url": form_url,
                },
            },
        },
    }
    _send_whatsapp_payload(to_number, sell_cta)
    _send_whatsapp_text(
        to_number,
        "📲 *Alternatively, you can send these details in a single WhatsApp message:*\n"
        "या फिर, आप यह विवरण एक ही व्हाट्सएप (WhatsApp) संदेश में भेज सकते हैं:\n\n"
        
        "📌 *Format:*\n"
        "• *CROP:* Name of your produce / फसल का नाम\n"
        "• *QUANTITY:* Available quantity / उपलब्ध मात्रा (kg/MT)\n"
        "• *PRICE:* Your expected price / आपकी अपेक्षित कीमत (Rs/kg)\n\n"
        
        "💡 *Example / उदाहरण:*\n"
        "CROP: Red Chili\n"
        "QUANTITY: 500 kg\n"
        "PRICE: 150"
    )



def _continue_sell_flow(to_number: str, contact_name: str, user_text: str, step: str, data: dict, msg_id: str, lang: str = "en") -> bool:
    """Continue Sell Your Produce flow."""
    import re as _re

    def parse_kv(text):
        result = {}
        for line in text.strip().splitlines():
            if ":" in line:
                k, _, v = line.partition(":")
                result[k.strip().lower()] = v.strip()
        return result

    if step == "step1_crop":
        vals = parse_kv(user_text)
        crop = vals.get("crop", "")
        quantity = vals.get("quantity", "")
        price = vals.get("price", "")
        if not crop or not quantity:
            _send_whatsapp_text(to_number, "⚠️ CROP aur QUANTITY zaroori hain. Kripya dobara bhejein.\nExample:\nCROP: Lal Mirch\nQUANTITY: 500 kg\nPRICE: 150")
            return True
        data.update({"crop": crop, "quantity_available_kg": quantity, "expected_price": price})
        _save_flow_state(to_number, "sell", "step2_location", data)
        _send_whatsapp_text(
            to_number,
            "🌾 *SELL YOUR PRODUCE — Step 2 of 3*\n"
            f"{SEPARATOR}\n"
            "Apni location details bhejein:\n\n"
            "CITY: Aapka shehar\n"
            "STATE: Aapka rajya\n"
            "PINCODE: PIN code\n\n"
            "*Example:*\n"
            "CITY: Nagpur\n"
            "STATE: Maharashtra\n"
            "PINCODE: 440001"
        )
        return True

    if step == "step2_location":
        vals = parse_kv(user_text)
        city = vals.get("city", "")
        state = vals.get("state", "")
        pincode = vals.get("pincode", "")
        if not city or not state:
            _send_whatsapp_text(to_number, "⚠️ CITY aur STATE zaroori hain. Kripya dobara bhejein.")
            return True
        data.update({"location_city": city, "location_state": state, "pincode": pincode})
        _save_flow_state(to_number, "sell", "step3_contact", data)
        _send_whatsapp_text(
            to_number,
            "🌾 *SELL YOUR PRODUCE — Step 3 of 3*\n"
            f"{SEPARATOR}\n"
            "Apni contact details bhejein:\n\n"
            "NAME: Aapka poora naam\n"
            "MOBILE: Mobile number\n"
            "EMAIL: Email (optional)\n\n"
            "*Example:*\n"
            "NAME: Ramesh Patel\n"
            "MOBILE: 9876543210\n"
            "EMAIL: ramesh@email.com"
        )
        return True

    if step == "step3_contact":
        vals = parse_kv(user_text)
        name = vals.get("name", contact_name)
        mobile = _re.sub(r"[\s\-]", "", vals.get("mobile", to_number))
        email = vals.get("email", "")
        if not name or not mobile:
            _send_whatsapp_text(to_number, "⚠️ NAME aur MOBILE zaroori hain. Kripya dobara bhejein.")
            return True
        data.update({"contact_name": name, "mobile": mobile, "email": email, "whatsapp_number": to_number})

        # Save to DynamoDB as Exporter Ticket
        try:
            from advanced_features import create_exporter_ticket
            ticket_id = create_exporter_ticket({
                "contact_name": name,
                "mobile": mobile,
                "email": email,
                "whatsapp_number": to_number,
                "product_name": data.get("crop", ""),
                "quantity_available_kg": data.get("quantity_available_kg", ""),
                "expected_price": data.get("expected_price", ""),
                "location_city": data.get("location_city", ""),
                "location_state": data.get("location_state", ""),
                "pincode": data.get("pincode", ""),
                "status": "new",
                "source": "whatsapp",
            })
            logger.info(f"[SELL] Exporter ticket created: {ticket_id}")
        except Exception as e:
            logger.error(f"[SELL] Ticket creation failed: {e}")
            ticket_id = None

        # Confirmation message
        summary = (
            "✅ *SELL REQUEST REGISTERED!*\n"
            f"{SEPARATOR}\n"
            f"🌾 Crop: {data.get('crop')}\n"
            f"⚖️ Quantity: {data.get('quantity_available_kg')}\n"
            f"💰 Expected Price: ₹{data.get('expected_price', 'N/A')}/kg\n"
            f"📍 Location: {data.get('location_city')}, {data.get('location_state')}\n"
            f"👤 Name: {name}\n"
            f"📞 Mobile: {mobile}\n"
            f"{SEPARATOR}\n"
            "Our team will contact you within 24 hours.\n"
            "📞 +91-8767205473 | ✉️ aarvexglo@gmail.com"
        )
        if ticket_id:
            summary += f"\n\n🎫 Reference ID: {ticket_id[:8].upper()}"

        _send_reply_with_menu(to_number, summary, lang)
        _clear_flow_state(to_number)
        _save_message_id(msg_id)
        return True

    return False

def _save_rating(phone: str, stars: str):
    """Persist customer rating to DynamoDB."""
    try:
        table.put_item(Item={
            "pk":         f"RATING#WA#{phone}",
            "stars":      stars,
            "phone":      phone,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "ttl":        int(time.time()) + 86400 * 90,
        })
        logger.info(f"[RATING] Saved {stars} stars for {phone}")
    except ClientError as e:
        logger.error(f"[DYNAMO] Save rating error: {e}")




def _save_feedback(phone: str, name: str, message: str, lang: str = "en"):
    """Persist customer text feedback to DynamoDB for admin dashboard."""
    try:
        import uuid as _uuid
        feedback_id = str(_uuid.uuid4())
        table.put_item(Item={
            "pk":          f"FEEDBACK#{feedback_id}",
            "feedback_id": feedback_id,
            "phone":       phone,
            "name":        name or "",
            "message":     message[:2000],
            "lang":        lang,
            "status":      "unread",
            "created_at":  datetime.now(timezone.utc).isoformat(),
            "ttl":         int(time.time()) + 86400 * 365,
        })
        logger.info(f"[FEEDBACK] Saved feedback from {phone}")
    except ClientError as e:
        logger.error(f"[DYNAMO] Save feedback error: {e}")

# ─────────────────────────────────────────────
#  WHATSAPP MENU & SEND HELPERS
# ─────────────────────────────────────────────
def _send_language_picker(to_number: str):
    payload = {
        "messaging_product": "whatsapp",
        "recipient_type":    "individual",
        "to":                to_number,
        "type":              "interactive",
        "interactive": {
            "type": "button",
            "body": {"text": TEXTS["en"]["lang_picker_body"][:4096]},
            "action": {
                "buttons": [
                    {"type": "reply", "reply": {"id": "lang_hi", "title": "🇮🇳 हिंदी"}},
                    {"type": "reply", "reply": {"id": "lang_en", "title": "🇬🇧 English"}},
                ],
            },
        },
    }
    return _send_whatsapp_payload(to_number, payload)


def _send_main_menu(to_number: str, lang: str, is_welcome: bool = False):
    body = _t("welcome_body", lang) if is_welcome else _t("menu_body", lang)
    _send_whatsapp_list_menu(to_number, body, lang)


def _send_whatsapp_list_menu(to_number: str, body_text: str, lang: str = "en"):
    payload = {
        "messaging_product": "whatsapp",
        "recipient_type":    "individual",
        "to":                to_number,
        "type":              "interactive",
        "interactive": {
            "type":   "list",
            "body":   {"text": body_text[:4096]},
            "action": {
                "button":   _t("list_button", lang)[:20],
                "sections": [{"title": _t("list_section", lang)[:24], "rows": _get_menu_rows(lang)}],
            },
        },
    }
    return _send_whatsapp_payload(to_number, payload)


def _send_view_menu_button(to_number: str, lang: str = "en"):
    payload = {
        "messaging_product": "whatsapp",
        "recipient_type":    "individual",
        "to":                to_number,
        "type":              "interactive",
        "interactive": {
            "type": "button",
            "body": {"text": _t("view_menu_hint", lang)[:1024]},
            "action": {
                "buttons": [
                    {"type": "reply", "reply": {
                        "id":    "menu_main",
                        "title": _t("view_menu_btn", lang)[:20],
                    }},
                ],
            },
        },
    }
    return _send_whatsapp_payload(to_number, payload)


def _send_reply_with_menu(to_number: str, text: str, lang: str = "en") -> bool:
    ok = _send_whatsapp_text(to_number, text)
    if ok:
        _send_action_buttons(to_number, lang)
    return ok


def _send_action_buttons(to_number: str, lang: str = "en"):
    """Send a dropdown list (View Menu + Social Connect) shown after every reply."""
    rows = [
        {"id": "menu_main",          "title": _t("view_menu_btn", lang)[:24]},
        {"id": "social_connect_menu", "title": _t("social_connect_btn", lang)[:24]},
    ]
    payload = {
        "messaging_product": "whatsapp",
        "recipient_type":    "individual",
        "to":                to_number,
        "type":              "interactive",
        "interactive": {
            "type": "list",
            "body": {"text": _t("action_footer_hint", lang)[:1024]},
            "action": {
                "button":   _t("action_list_button", lang)[:20],
                "sections": [{"title": _t("action_list_section", lang)[:24], "rows": rows}],
            },
        },
    }
    _send_whatsapp_payload(to_number, payload)


def _handle_menu_selection(to_number: str, contact_name: str, menu_id: str, msg_id: str, lang: str = "en"):
    if menu_id == "menu_language":
        _send_language_picker(to_number)
        _save_message_id(msg_id)
        return

    if menu_id == "menu_catalogue":
        if ADVANCED_FEATURES_AVAILABLE:
            advanced_response = route_advanced_feature(
                message_type="interactive",
                message_body="menu_catalogue",
                wa_from=to_number,
                user_state={"language": lang, "contact_name": contact_name, "message_id": msg_id, "interactive_id": "menu_catalogue"},
                message_data={"id": msg_id},
            )
            if advanced_response is not None:
                _save_message_id(msg_id)
                return
        _send_catalogue_product_list(to_number, lang, mode="detail")
        _save_message_id(msg_id)
        return

    if menu_id == "menu_track_order":
        if ADVANCED_FEATURES_AVAILABLE:
            route_advanced_feature(
                message_type="interactive",
                message_body="menu_track_order",
                wa_from=to_number,
                user_state={"language": lang, "contact_name": contact_name, "message_id": msg_id, "interactive_id": "menu_track_order"},
                message_data={"id": msg_id},
            )
        else:
            _send_reply_with_menu(to_number, "Order tracking is not available right now.", lang)
        _save_message_id(msg_id)
        return

    if menu_id == "menu_quote":
        _send_catalogue_product_list(to_number, lang, mode="quote")
        _save_message_id(msg_id)
        return

    if menu_id == "social_connect_menu":
        _send_social_connect_list(to_number, lang)
        _save_message_id(msg_id)
        return

    handlers = {
        "menu_export":    lambda: _send_reply_with_menu(to_number, _build_export_services_message(lang), lang),
        "menu_sell":      lambda: _start_sell_flow(to_number, contact_name, lang),
        "menu_about":     lambda: _send_reply_with_menu(to_number, _build_about_message(lang), lang),
        "menu_terms":     lambda: _send_reply_with_menu(to_number, _build_terms_message(lang), lang),
        "menu_feedback":  lambda: _start_feedback_flow(to_number, contact_name, lang),
        "menu_talk":      lambda: _send_reply_with_menu(to_number, _build_talk_to_team_message(lang), lang),
    }
    handler = handlers.get(menu_id)
    if handler:
        handler()
        _save_message_id(msg_id)
        logger.info(f"[WA] Menu handled: {menu_id} lang={lang}")


# ─────────────────────────────────────────────
#  CATALOGUE INTERACTIVE LIST (tap-to-select)
# ─────────────────────────────────────────────
def _send_catalogue_product_list(to_number: str, lang: str = "en", mode: str = "detail"):
    """
    Send interactive list of all products.
    mode='detail' → tapping opens product detail + quote/sample buttons
    mode='quote'  → tapping starts quote flow (ask qty only)
    """
    products = _get_products()
    rows = []
    for idx, p in enumerate(products):
        row_id = f"cat_{mode}_{idx}"
        rows.append({
            "id":          row_id,
            "title":       p[:24],
            "description": ("View details & request quote" if lang == "en" else "विवरण व कोट देखें"),
        })

    if mode == "quote":
        header_text = _t("quote_pick_header", lang)
        body_text   = _t("quote_pick_body", lang)
        btn_label   = _t("catalogue_list_btn", lang)[:20]
    else:
        header_text = _t("catalogue_header", lang)
        body_text   = _t("catalogue_pick", lang)
        btn_label   = _t("catalogue_list_btn", lang)[:20]

    payload = {
        "messaging_product": "whatsapp",
        "recipient_type":    "individual",
        "to":                to_number,
        "type":              "interactive",
        "interactive": {
            "type":   "list",
            "body":   {"text": f"{header_text}\n\n{body_text}"[:1024]},
            "action": {
                "button":   btn_label,
                "sections": [{"title": _t("catalogue_list_section", lang)[:24], "rows": rows}],
            },
        },
    }
    _send_whatsapp_payload(to_number, payload)


def _send_social_connect_list(to_number: str, lang: str = "en"):
    """Send interactive list of all social media platforms."""
    rows = []
    for sid, name, emoji, url in SOCIAL_LINKS:
        rows.append({
            "id":          sid,
            "title":       f"{emoji} {name}"[:24],
            "description": url[:72],
        })

    payload = {
        "messaging_product": "whatsapp",
        "recipient_type":    "individual",
        "to":                to_number,
        "type":              "interactive",
        "interactive": {
            "type":   "list",
            "body":   {"text": f"{_t('social_list_header', lang)}\n\n{_t('social_list_body', lang)}"[:1024]},
            "action": {
                "button":   _t("social_list_button", lang)[:20],
                "sections": [{"title": _t("social_list_section", lang)[:24], "rows": rows}],
            },
        },
    }
    _send_whatsapp_payload(to_number, payload)


def _send_social_link_cta(to_number: str, lang: str, emoji: str, name: str, url: str) -> bool:
    """Send the chosen platform's link as a tappable CTA-URL button.

    Tapping the button opens the link directly in the browser/app — the raw
    URL is no longer shown as copy-paste text inside the message body.
    """
    body_text = _t("social_link_body", lang, emoji=emoji, name=name)
    btn_text  = _t("social_link_btn", lang, name=name)[:20]
    payload = {
        "messaging_product": "whatsapp",
        "recipient_type":    "individual",
        "to":                to_number,
        "type":              "interactive",
        "interactive": {
            "type": "cta_url",
            "body": {"text": body_text[:1024]},
            "action": {
                "name": "cta_url",
                "parameters": {
                    "display_text": btn_text,
                    "url":          url,
                },
            },
        },
    }
    ok = _send_whatsapp_payload(to_number, payload)
    if ok:
        _send_action_buttons(to_number, lang)
    return ok


def _send_rating_list(to_number: str, lang: str = "en"):
    """Send interactive 1–5 star rating list."""
    star_map = [
        ("rating_5", "⭐⭐⭐⭐⭐", "5"),
        ("rating_4", "⭐⭐⭐⭐",   "4"),
        ("rating_3", "⭐⭐⭐",     "3"),
        ("rating_2", "⭐⭐",       "2"),
        ("rating_1", "⭐",        "1"),
    ]
    rows = []
    for rid, stars, n in star_map:
        plural = "" if n == "1" else "s"
        rows.append({
            "id":          rid,
            "title":       stars[:24],
            "description": _t("rating_row", lang, stars=n, plural=plural)[:72],
        })

    payload = {
        "messaging_product": "whatsapp",
        "recipient_type":    "individual",
        "to":                to_number,
        "type":              "interactive",
        "interactive": {
            "type":   "list",
            "body":   {"text": f"{_t('rating_header', lang)}\n\n{_t('rating_body', lang)}"[:1024]},
            "action": {
                "button":   _t("rating_list_btn", lang)[:20],
                "sections": [{"title": _t("rating_list_section", lang)[:24], "rows": rows}],
            },
        },
    }
    _send_whatsapp_payload(to_number, payload)


# ─────────────────────────────────────────────
#  SAMPLE REQUEST FLOW
# ─────────────────────────────────────────────
def _start_sample_flow(to_number: str, contact_name: str, msg_id: str, lang: str = "en"):
    products = _get_products()
    product_list = "\n".join(f"{i+1}. {p}" for i, p in enumerate(products))
    msg = (
        f"{_t('sample_header', lang)}\n"
        f"{SEPARATOR}\n"
        f"{_t('sample_products', lang)}\n"
        f"{product_list}\n"
        f"{SEPARATOR}\n"
        f"{_t('sample_reply', lang)}"
    )
    _save_flow_state(to_number, "sample", "product", {"contact_name": contact_name, "lang": lang})
    _send_reply_with_menu(to_number, msg, lang)
    _save_message_id(msg_id)


def _start_feedback_flow(to_number: str, contact_name: str, lang: str = "en"):
    _save_flow_state(to_number, "feedback", "message", {"contact_name": contact_name, "lang": lang})
    _send_whatsapp_text(
        to_number,
        f"{_t('feedback_header', lang)}\n{SEPARATOR}\n{_t('feedback_ask', lang)}",
    )


def _continue_flow(to_number: str, contact_name: str, user_text: str, flow: dict, msg_id: str, lang: str = "en") -> bool:
    flow_type = flow.get("flow", "")
    step      = flow.get("step", "")
    data      = flow.get("data", {})
    lang      = data.get("lang") or lang or _get_lang(to_number) or "en"

    if flow_type == "sample":
        return _continue_sample_flow(to_number, contact_name, user_text, step, data, msg_id, lang)

    if flow_type == "quote":
        return _continue_quote_flow(to_number, contact_name, user_text, step, data, msg_id, lang)

    if flow_type == "feedback":
        if step == "message" and user_text.strip():
            # Save feedback to DynamoDB so admin dashboard can show it
            _save_feedback(to_number, data.get("contact_name", contact_name), user_text, lang)
            ticket_id = _create_zoho_ticket(
                subject=f"WhatsApp Feedback — {contact_name}",
                description=f"From: {to_number}\nName: {data.get('contact_name', contact_name)}\n\n{user_text}",
                phone=to_number,
                name=data.get("contact_name", contact_name),
            )
            thanks = _t("feedback_thanks", lang)
            if ticket_id:
                thanks += f"\nTicket: #{ticket_id}"
            _send_reply_with_menu(to_number, thanks, lang)
            _clear_flow_state(to_number)
            _save_message_id(msg_id)
            return True
        return False

    if flow_type == "sell":
        return _continue_sell_flow(to_number, contact_name, user_text, step, data, msg_id, lang)

    return False


def _continue_quote_flow(to_number, contact_name, user_text, step, data, msg_id, lang="en") -> bool:
    """Quote flow: qty → demand confirmation → rating."""
    if step == "quantity":
        qty = _extract_quantity(user_text) or user_text.strip()
        if not qty or len(qty) < 2:
            _send_reply_with_menu(to_number, _t("quote_qty_invalid", lang), lang)
            _save_message_id(msg_id)
            return True

        product    = data.get("product", "Product")
        sym        = _currency_symbol(to_number)
        buyer_type = "Indian" if sym == "₹" else "International"
        if lang == "hi":
            buyer_type = "भारतीय" if sym == "₹" else "अंतर्राष्ट्रीय"

        # Create Zoho lead
        _create_zoho_lead(
            name=data.get("contact_name", contact_name),
            phone=to_number,
            product=product,
            quantity=qty,
            description=f"Product: {product} | Qty: {qty} | Buyer: {buyer_type}",
            buyer_type=buyer_type,
        )

        # 1. Send quote received confirmation
        quote_msg = _t(
            "quote_received", lang,
            product=product, qty=qty, buyer_type=buyer_type,
            sym=sym, hours=QUOTE_VALID_HOURS,
            phone=COMPANY_PHONE, email=COMPANY_EMAIL,
        )
        _send_whatsapp_text(to_number, quote_msg)

        # 2. Send separate DEMAND confirmation message
        demand_header = _t("demand_header", lang)
        demand_msg = (
            f"{demand_header}\n"
            f"{SEPARATOR}\n"
            f"📦 {'Product' if lang=='en' else 'उत्पाद'}: *{product}*\n"
            f"⚖️ {'Quantity' if lang=='en' else 'मात्रा'}: *{qty}*\n"
            f"🌍 {'Buyer' if lang=='en' else 'खरीदार'}: {buyer_type}\n"
            f"{SEPARATOR}\n"
            f"{'✅ Your demand has been registered. Our team will contact you shortly with pricing.' if lang=='en' else '✅ आपकी मांग दर्ज हो गई। हमारी टीम जल्द कीमत के साथ संपर्क करेगी।'}\n"
            f"📞 {COMPANY_PHONE} | ✉️ {COMPANY_EMAIL}"
        )
        _send_reply_with_menu(to_number, demand_msg, lang)

        # 3. Send rating request
        _send_rating_list(to_number, lang)

        _clear_flow_state(to_number)
        _save_message_id(msg_id)
        return True

    return False


def _continue_sample_flow(to_number, contact_name, user_text, step, data, msg_id, lang="en") -> bool:
    if step == "product":
        product = _match_product_in_text(user_text) or user_text.strip()
        if not product:
            _send_reply_with_menu(to_number, _t("sample_invalid_product", lang), lang)
            _save_message_id(msg_id)
            return True
        data["product"] = product
        _save_flow_state(to_number, "sample", "quantity", data)
        _send_whatsapp_text(to_number, _t("sample_product_ok", lang, product=product))
        _save_message_id(msg_id)
        return True

    if step == "quantity":
        qty = _extract_quantity(user_text) or user_text.strip()
        if not _validate_sample_quantity(qty):
            _send_reply_with_menu(to_number, _t("sample_qty_invalid", lang), lang)
            _save_message_id(msg_id)
            return True
        data["quantity"] = qty
        _save_flow_state(to_number, "sample", "address", data)
        _send_whatsapp_text(to_number, _t("sample_ask_address", lang))
        _save_message_id(msg_id)
        return True

    if step == "address":
        if len(user_text.strip()) < 10:
            _send_reply_with_menu(to_number, _t("sample_address_invalid", lang), lang)
            _save_message_id(msg_id)
            return True

        data["address"] = user_text.strip()
        total = SAMPLE_BASE_COST + COURIER_CHARGES
        upi_link = (
            f"upi://pay?pa={urllib.parse.quote(COMPANY_UPI)}"
            f"&pn=Aarvex%20Global&am={total}&cu=INR&tn=Sample%20{urllib.parse.quote(data['product'])}"
        )

        ticket_id = _create_zoho_ticket(
            subject=f"Sample Request — {data['product']}",
            description=(
                f"Product: {data['product']}\n"
                f"Quantity: {data['quantity']}\n"
                f"Address: {data['address']}\n"
                f"Phone: {to_number}\n"
                f"Sample Cost: ₹{SAMPLE_BASE_COST}\n"
                f"Courier: ₹{COURIER_CHARGES}\n"
                f"Total: ₹{total}\n"
                f"Payment: {COMPANY_UPI}"
            ),
            phone=to_number,
            name=data.get("contact_name", contact_name),
        )

        msg = _t(
            "sample_summary", lang,
            product=data["product"],
            qty=data["quantity"],
            address=data["address"][:60] + "...",
            sample_cost=SAMPLE_BASE_COST,
            courier=COURIER_CHARGES,
            total=total,
            upi=COMPANY_UPI,
            upi_link=upi_link,
        )
        if ticket_id:
            msg += f"\n🎫 Ticket: #{ticket_id}"

        _send_reply_with_menu(to_number, msg, lang)

        # Send rating after sample order registered
        _send_rating_list(to_number, lang)

        _clear_flow_state(to_number)
        _save_message_id(msg_id)
        return True

    return False


def _validate_sample_quantity(qty: str) -> bool:
    m = re.search(r"(\d+(?:\.\d+)?)\s*(g|kg)", qty, re.IGNORECASE)
    if not m:
        return False
    val = float(m.group(1))
    unit = m.group(2).lower()
    grams = val if unit == "g" else val * 1000
    return 100 <= grams <= 1000


# ─────────────────────────────────────────────
#  QUOTE REQUEST FLOW
# ─────────────────────────────────────────────
def _handle_quote_request(to_number, contact_name, product, quantity, full_text, msg_id, lang="en"):
    sym = _currency_symbol(to_number)
    buyer_type = "Indian" if sym == "₹" else "International"
    if lang == "hi":
        buyer_type = "भारतीय" if sym == "₹" else "अंतर्राष्ट्रीय"

    _create_zoho_lead(
        name=contact_name,
        phone=to_number,
        product=product,
        quantity=quantity,
        description=full_text,
        buyer_type=buyer_type,
    )

    # 1. Quote received message
    quote_msg = _t(
        "quote_received", lang,
        product=product, qty=quantity, buyer_type=buyer_type,
        sym=sym, hours=QUOTE_VALID_HOURS,
        phone=COMPANY_PHONE, email=COMPANY_EMAIL,
    )
    _send_whatsapp_text(to_number, quote_msg)

    # 2. Separate demand confirmation message
    demand_msg = (
        f"{_t('demand_header', lang)}\n"
        f"{SEPARATOR}\n"
        f"📦 {'Product' if lang=='en' else 'उत्पाद'}: *{product}*\n"
        f"⚖️ {'Quantity' if lang=='en' else 'मात्रा'}: *{quantity}*\n"
        f"🌍 {'Buyer' if lang=='en' else 'खरीदार'}: {buyer_type}\n"
        f"{SEPARATOR}\n"
        f"{'✅ Your demand has been registered. Our team will contact you shortly with pricing.' if lang=='en' else '✅ आपकी मांग दर्ज हो गई। हमारी टीम जल्द कीमत के साथ संपर्क करेगी।'}\n"
        f"📞 {COMPANY_PHONE} | ✉️ {COMPANY_EMAIL}"
    )
    _send_reply_with_menu(to_number, demand_msg, lang)

    # 3. Rating request
    _send_rating_list(to_number, lang)

    _save_state(f"WA#{to_number}", msg_id, "WhatsApp-Quote", quote_msg[:500])
    _save_message_id(msg_id)
    logger.info(f"[WA] Quote request handled for {to_number}: {product} {quantity}")


# ─────────────────────────────────────────────
#  FLOW STATE (DynamoDB)
# ─────────────────────────────────────────────
def _get_flow_state(phone: str) -> dict:
    try:
        resp = table.get_item(Key={"pk": f"FLOW#WA#{phone}"})
        return resp.get("Item") or {}
    except ClientError:
        return {}


def _save_flow_state(phone: str, flow: str, step: str, data: dict):
    try:
        table.put_item(Item={
            "pk":      f"FLOW#WA#{phone}",
            "flow":    flow,
            "step":    step,
            "data":    data,
            "updated": datetime.now(timezone.utc).isoformat(),
            "ttl":     int(time.time()) + 86400,
        })
    except ClientError as e:
        logger.error(f"[DYNAMO] Save flow error: {e}")


def _clear_flow_state(phone: str):
    try:
        table.delete_item(Key={"pk": f"FLOW#WA#{phone}"})
    except ClientError as e:
        logger.error(f"[DYNAMO] Clear flow error: {e}")


# ─────────────────────────────────────────────
#  ZOHO DESK + CRM
# ─────────────────────────────────────────────
def _create_zoho_ticket(subject: str, description: str, phone: str, name: str) -> str:
    if not ZOHO_ACCESS_TOKEN or not ZOHO_DESK_ORG_ID:
        logger.warning("[ZOHO] Desk credentials not set — skipping ticket creation")
        return ""

    payload = {
        "subject":     subject[:255],
        "description": description,
        "phone":       phone,
        "contact":     {"lastName": name or "WhatsApp Customer", "phone": phone},
        "channel":     "WhatsApp",
        "priority":    "High",
    }
    if ZOHO_DESK_DEPARTMENT_ID:
        payload["departmentId"] = ZOHO_DESK_DEPARTMENT_ID

    url = f"{ZOHO_API_DOMAIN.rstrip('/')}/api/v1/tickets"
    result = _zoho_post(url, payload, org_id=ZOHO_DESK_ORG_ID)
    if result:
        ticket_id = str(result.get("id", ""))
        logger.info(f"[ZOHO] Ticket created: {ticket_id}")
        return ticket_id
    return ""


def _create_zoho_lead(name: str, phone: str, product: str, quantity: str,
                      description: str, buyer_type: str) -> str:
    if not ZOHO_ACCESS_TOKEN:
        logger.warning("[ZOHO] Access token not set — skipping lead creation")
        return ""

    lead_data = {
        "Last_Name":   name or "WhatsApp Lead",
        "Phone":       phone,
        "Lead_Source": "WhatsApp",
        "Company":     "WhatsApp Inquiry",
        "Description": (
            f"Product: {product}\nQuantity: {quantity}\n"
            f"Buyer Type: {buyer_type}\nMessage: {description}"
        ),
    }

    url = f"{ZOHO_CRM_DOMAIN.rstrip('/')}/crm/v2/Leads"
    result = _zoho_post(url, {"data": [lead_data]})
    if result:
        records = result.get("data", [])
        if records and records[0].get("status") == "success":
            lead_id = records[0].get("details", {}).get("id", "")
            logger.info(f"[ZOHO] Lead created: {lead_id}")
            return str(lead_id)
    return ""


def _zoho_post(url: str, payload: dict, org_id: str = "") -> dict:
    data = json.dumps(payload).encode()
    headers = {
        "Content-Type":  "application/json",
        "Authorization": f"Zoho-oauthtoken {ZOHO_ACCESS_TOKEN}",
    }
    if org_id:
        headers["orgId"] = org_id

    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        logger.error(f"[ZOHO] HTTP {e.code}: {body[:500]}")
    except Exception as e:
        logger.error(f"[ZOHO] Exception: {e}")
    return {}


# ─────────────────────────────────────────────
#  WHATSAPP SEND HELPERS
# ─────────────────────────────────────────────
def _send_whatsapp_text(to_number: str, message: str) -> bool:
    payload = {
        "messaging_product": "whatsapp",
        "recipient_type":    "individual",
        "to":                to_number,
        "type":              "text",
        "text":              {"preview_url": True, "body": message[:4096]},
    }
    return _send_whatsapp_payload(to_number, payload)


def _send_whatsapp_reply(to_number: str, message: str) -> bool:
    return _send_whatsapp_text(to_number, message)


def _send_whatsapp_payload(to_number: str, payload: dict) -> bool:
    if not WA_PHONE_NUMBER_ID:
        logger.error("[WA] WA_PHONE_NUMBER_ID not set!")
        return False

    url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/{WA_PHONE_NUMBER_ID}/messages"
    data    = json.dumps(payload).encode()
    headers = {
        "Content-Type":  "application/json",
        "Authorization": f"Bearer {WA_ACCESS_TOKEN}",
    }
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read())
            logger.info(f"[WA] Sent successfully: {json.dumps(result)[:200]}")
            return True
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        logger.error(f"[WA] Send HTTP {e.code}: {body[:500]}")
    except Exception as e:
        logger.error(f"[WA] Send exception: {e}")
    return False


# ─────────────────────────────────────────────
#  INSTAGRAM DIRECT MESSAGE HANDLER (unchanged)
# ─────────────────────────────────────────────
def _handle_instagram(payload):
    try:
        if not INSTAGRAM_ACCESS_TOKEN:
            logger.error("[IG] INSTAGRAM_ACCESS_TOKEN not set in env variables!")
            return _response(200, "Config error")

        entry = payload.get("entry", [])
        if not entry:
            return _response(200, "No entry")

        messaging_events = entry[0].get("messaging", [])
        if not messaging_events:
            logger.info("[IG] No messaging events — skipping")
            return _response(200, "No messaging events")

        for msg_event in messaging_events:
            try:
                _process_instagram_message(msg_event)
            except Exception as e:
                logger.error(f"[IG] Error processing one message: {e}", exc_info=True)

        return _response(200, "OK")

    except Exception as e:
        logger.error(f"[IG] Unhandled exception: {e}", exc_info=True)
        return _response(200, "OK")


def _process_instagram_message(msg_event: dict):
    message = msg_event.get("message", {})

    if message.get("is_echo"):
        logger.info("[IG] Echo message (bot's own) — skipping")
        return

    sender_id = msg_event.get("sender", {}).get("id", "")
    msg_id    = message.get("mid", "")
    msg_text  = (message.get("text") or "").strip()

    if not sender_id:
        logger.info("[IG] No sender id — skipping")
        return

    if not msg_text:
        logger.info("[IG] Non-text / empty message — skipping")
        return

    logger.info(f"[IG] Message from {sender_id}: {msg_text[:100]}")

    if _is_duplicate_message(msg_id):
        logger.info(f"[IG] Duplicate message {msg_id} — skipping")
        return

    if _is_on_cooldown(f"IG#{sender_id}"):
        logger.info(f"[IG] Cooldown active for {sender_id}")
        return

    ai_reply = _get_ai_reply("Customer", msg_text, msg_text, "Instagram Direct")
    if not ai_reply:
        logger.error("[IG] AI reply generation failed — sending fallback message instead of staying silent")
        _send_instagram_reply(sender_id, _t("ai_fallback_error", "en"))
        _save_message_id(msg_id)
        return

    logger.info(f"[IG] AI reply: {ai_reply[:200]}")

    success = _send_instagram_reply(sender_id, ai_reply)
    if success:
        _save_state(f"IG#{sender_id}", msg_id, "Instagram Direct", ai_reply)
        _save_message_id(msg_id)
        logger.info(f"[IG] DONE — replied to {sender_id}")
    else:
        logger.error(f"[IG] Failed to send reply to {sender_id}")


def _send_instagram_reply(recipient_id: str, message: str) -> bool:
    ig_id = INSTAGRAM_PAGE_ID or "me"
    url   = f"https://graph.facebook.com/{GRAPH_API_VERSION}/{ig_id}/messages"

    payload = {
        "recipient": {"id": recipient_id},
        "message":   {"text": message},
    }
    data    = json.dumps(payload).encode()
    headers = {
        "Content-Type":  "application/json",
        "Authorization": f"Bearer {INSTAGRAM_ACCESS_TOKEN}",
    }
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read())
            logger.info(f"[IG] Reply sent successfully: {json.dumps(result)[:200]}")
            return True
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        logger.error(f"[IG] Send HTTP {e.code}: {body[:500]}")
    except Exception as e:
        logger.error(f"[IG] Send exception: {e}")
    return False


# ─────────────────────────────────────────────
#  FACEBOOK MESSENGER HANDLER (unchanged)
# ─────────────────────────────────────────────
def _handle_facebook(payload):
    try:
        if not PAGE_ACCESS_TOKEN:
            logger.error("[FB] PAGE_ACCESS_TOKEN not set in env variables!")
            return _response(200, "Config error")

        entry = payload.get("entry", [])
        if not entry:
            return _response(200, "No entry")

        messaging_events = entry[0].get("messaging", [])
        if not messaging_events:
            logger.info("[FB] No messaging events — skipping")
            return _response(200, "No messaging events")

        for msg_event in messaging_events:
            try:
                _process_facebook_message(msg_event)
            except Exception as e:
                logger.error(f"[FB] Error processing one message: {e}", exc_info=True)

        return _response(200, "OK")

    except Exception as e:
        logger.error(f"[FB] Unhandled exception: {e}", exc_info=True)
        return _response(200, "OK")


def _process_facebook_message(msg_event: dict):
    message = msg_event.get("message", {})

    if message.get("is_echo"):
        logger.info("[FB] Echo message (bot's own) — skipping")
        return

    sender_id = msg_event.get("sender", {}).get("id", "")
    msg_id    = message.get("mid", "")
    msg_text  = (message.get("text") or "").strip()

    if not sender_id:
        logger.info("[FB] No sender id — skipping")
        return

    if not msg_text:
        logger.info("[FB] Non-text / empty message — skipping")
        return

    logger.info(f"[FB] Message from {sender_id}: {msg_text[:100]}")

    if _is_duplicate_message(msg_id):
        logger.info(f"[FB] Duplicate message {msg_id} — skipping")
        return

    if _is_on_cooldown(f"FB#{sender_id}"):
        logger.info(f"[FB] Cooldown active for {sender_id}")
        return

    ai_reply = _get_ai_reply("Customer", msg_text, msg_text, "Facebook Messenger")
    if not ai_reply:
        logger.error("[FB] AI reply generation failed — sending fallback message instead of staying silent")
        _send_facebook_reply(sender_id, _t("ai_fallback_error", "en"))
        _save_message_id(msg_id)
        return

    logger.info(f"[FB] AI reply: {ai_reply[:200]}")

    success = _send_facebook_reply(sender_id, ai_reply)
    if success:
        _save_state(f"FB#{sender_id}", msg_id, "Facebook Messenger", ai_reply)
        _save_message_id(msg_id)
        logger.info(f"[FB] DONE — replied to {sender_id}")
    else:
        logger.error(f"[FB] Failed to send reply to {sender_id}")


def _send_facebook_reply(recipient_id: str, message: str) -> bool:
    url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/me/messages"

    payload = {
        "recipient":      {"id": recipient_id},
        "messaging_type": "RESPONSE",
        "message":        {"text": message},
    }
    data    = json.dumps(payload).encode()
    headers = {
        "Content-Type":  "application/json",
        "Authorization": f"Bearer {PAGE_ACCESS_TOKEN}",
    }
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read())
            logger.info(f"[FB] Reply sent successfully: {json.dumps(result)[:200]}")
            return True
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        logger.error(f"[FB] Send HTTP {e.code}: {body[:500]}")
    except Exception as e:
        logger.error(f"[FB] Send exception: {e}")
    return False


# ─────────────────────────────────────────────
#  OPENROUTER AI
# ─────────────────────────────────────────────
def _get_ai_reply(customer_name: str, subject: str, message: str, channel: str, lang: str = "en") -> str:
    lang_hint = _t("ai_lang_hint", lang if lang in SUPPORTED_LANGS else "en")
    system_prompt = f"{DEFAULT_SYSTEM_PROMPT}\n\nLANGUAGE: {lang_hint}"

    user_message = (
        f"Customer name: {customer_name}\n"
        f"Platform: {channel}\n"
        f"Preferred language: {lang}\n"
        f"Subject: {subject}\n"
        f"Message: {message}\n\n"
        f"Write a helpful, concise reply for this customer inquiry."
    )
    payload = {
        "model":      OPENROUTER_MODEL,
        "max_tokens": 300,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_message},
        ],
    }
    data    = json.dumps(payload).encode()
    headers = {
        "Content-Type":  "application/json",
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "HTTP-Referer":  "https://aarvexglobal.com",
        "X-Title":       "Aarvex Global Support Bot",
    }
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=data, headers=headers, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            result  = json.loads(resp.read())
            choices = result.get("choices", [])
            if choices:
                reply = choices[0].get("message", {}).get("content", "").strip()
                if reply:
                    logger.info(f"[AI] Reply generated — model: {OPENROUTER_MODEL}")
                    return reply
            logger.error(f"[AI] Empty response: {result}")
    except urllib.error.HTTPError as e:
        logger.error(f"[AI] HTTP {e.code}: {e.read().decode()[:300]}")
    except Exception as e:
        logger.error(f"[AI] Exception: {e}")
    return ""


# ─────────────────────────────────────────────
#  DYNAMODB — Cooldown + Deduplication
# ─────────────────────────────────────────────
def _is_on_cooldown(contact_id: str) -> bool:
    if COOLDOWN_MINUTES <= 0:
        return False
    try:
        resp = table.get_item(Key={"pk": f"CONTACT#{contact_id}"})
        item = resp.get("Item")
        if item:
            elapsed_min = (int(time.time()) - int(item.get("last_reply_ts", 0))) / 60
            if elapsed_min < COOLDOWN_MINUTES:
                logger.info(f"[DYNAMO] {contact_id} cooldown — {elapsed_min:.1f} min ago")
                return True
    except ClientError as e:
        logger.error(f"[DYNAMO] Cooldown check error: {e}")
    return False


def _is_duplicate_message(msg_id: str) -> bool:
    if not msg_id:
        return False
    try:
        resp = table.get_item(Key={"pk": f"MSGID#{msg_id}"})
        return bool(resp.get("Item"))
    except ClientError:
        return False


def _save_message_id(msg_id: str):
    if not msg_id:
        return
    try:
        table.put_item(Item={
            "pk":         f"MSGID#{msg_id}",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "ttl":        int(time.time()) + 86400,
        })
    except ClientError as e:
        logger.error(f"[DYNAMO] Save message ID error: {e}")


def _save_state(contact_id: str, msg_id: str, channel: str, reply: str):
    pk = f"CONTACT#{contact_id}"
    try:
        existing = table.get_item(Key={"pk": pk}).get("Item") or {}
        table.put_item(Item={
            "pk":            pk,
            "last_msg_id":   msg_id,
            "channel":       channel,
            "last_reply":    reply[:500],
            "last_reply_ts": int(time.time()),
            "updated_at":    datetime.now(timezone.utc).isoformat(),
            "language":      existing.get("language", ""),
            "name":          existing.get("name", ""),
            "first_seen_ts": existing.get("first_seen_ts", int(time.time())),
        })
        logger.info(f"[DYNAMO] State saved for {contact_id}")
    except ClientError as e:
        logger.error(f"[DYNAMO] Save state error: {e}")


def _response(status: int, message: str) -> dict:
    return {
        "statusCode": status,
        "body":       json.dumps({"message": message}),
        "headers":    {"Content-Type": "application/json"},
    }

# ─────────────────────────────────────────────
#  WEB FORM ORDER HANDLER
# ─────────────────────────────────────────────
def _handle_web_order(event):
    import uuid, time
    try:
        body_raw = event.get("body") or "{}"
        if event.get("isBase64Encoded"):
            body_raw = base64.b64decode(body_raw).decode("utf-8")
        data = json.loads(body_raw)
    except Exception as e:
        return _response(400, "Invalid JSON")

    cors = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST,OPTIONS"
    }

    required = ["product_name","order_type","quantity_kg","customer_name","mobile","email","address","city","state"]
    missing = [f for f in required if not data.get(f)]
    if missing:
        return {"statusCode": 400, "headers": cors, "body": json.dumps({"error": "Missing: " + ", ".join(missing)})}

    # ARN generate karo
    arn = "AX" + time.strftime("%Y%m%d") + str(uuid.uuid4())[:6].upper()
    ticket_id = str(uuid.uuid4())

    mobile = str(data.get("mobile","")).replace("+","").replace(" ","").replace("-","")
    if not mobile.startswith("91") and len(mobile) == 10:
        mobile = "91" + mobile

    qty = float(data.get("quantity_kg", 0))
    amount = int(data.get("amount_inr", 500))
    total = amount + 150

    item = {
        "pk": f"TICKET#IMPORTER#{ticket_id}",
        "sk": "METADATA",
        "ticket_id": ticket_id,
        "arn": arn,
        "customer_name": data.get("customer_name",""),
        "company_name": data.get("company_name",""),
        "gst_number": data.get("gst_number",""),
        "product_name": data.get("product_name",""),
        "product_id": data.get("product_id",""),
        "category_id": data.get("category_id",""),
        "order_type": data.get("order_type",""),
        "quantity_kg": str(qty),
        "price_per_kg": str(data.get("price_per_kg",0)),
        "amount_inr": str(amount),
        "courier_charges": "150",
        "total_inr": str(total),
        "address": data.get("address",""),
        "city": data.get("city",""),
        "state": data.get("state",""),
        "country": data.get("country","India"),
        "pincode": data.get("pincode",""),
        "mobile": mobile,
        "email": data.get("email",""),
        "payment_status": "Pending",
        "order_status": "New",
        "source": "web_form",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ")
    }

    try:
        table.put_item(Item=item)
        logger.info(f"[WEB_ORDER] Saved ticket {ticket_id} ARN={arn}")
    except Exception as e:
        logger.error(f"[WEB_ORDER] DynamoDB error: {e}")
        return {"statusCode": 500, "headers": cors, "body": json.dumps({"error": "DB error"})}

    # Cashfree payment link generate karo
    try:
        from advanced_features import create_cashfree_payment_link
        ticket_for_payment = {
            "arn": arn,
            "ticket_id": ticket_id,
            "product_name": data.get("product_name",""),
            "quantity_kg": str(qty),
            "customer_name": data.get("customer_name",""),
            "email": data.get("email",""),
            "mobile": mobile,
            "payment_amount": str(total),
            "payment_currency": "INR",
        }
        rzp_link = create_cashfree_payment_link(ticket_for_payment)
        if rzp_link and rzp_link.get("short_url"):
            rzp_url = rzp_link.get("short_url","")
            table.update_item(
                Key={"pk": f"TICKET#IMPORTER#{ticket_id}"},
                UpdateExpression="SET razorpay_payment_link_url = :u, razorpay_payment_link_id = :i, payment_link_url = :u, payment_link_id = :i",
                ExpressionAttributeValues={":u": rzp_url, ":i": rzp_link.get("id","")}
            )
            logger.info(f"[WEB_ORDER] Cashfree link created: {rzp_url}")
        else:
            rzp_url = ""
    except Exception as e:
        logger.error(f"[WEB_ORDER] Cashfree error: {e}")
        rzp_url = ""

    # WhatsApp pe notification bhejo
    try:
        from advanced_features import send_whatsapp_text as _send_wa
        wa_msg = (
            f"🎉 *Naya Web Order!*\n\n"
            f"📦 *ARN:* {arn}\n"
            f"👤 *Customer:* {data.get('customer_name','')}\n"
            f"🌶️ *Product:* {data.get('product_name','')}\n"
            f"⚖️ *Qty:* {qty} kg ({data.get('order_type','').upper()})\n"
            f"💰 *Total:* ₹{total}\n"
            f"📞 *Mobile:* +{mobile}\n"
            f"📧 *Email:* {data.get('email','')}\n"
            f"📍 *City:* {data.get('city','')}, {data.get('state','')}\n\n"
            f"Payment pending hai."
        )
        if rzp_url:
            payment_msg = f"✅ *Order Confirmed!*\n\n*ARN:* {arn}\n*Product:* {data.get('product_name','')}\n*Qty:* {qty} kg\n*Total:* ₹{total}\n\n💳 *Payment Link:*\n👉 {rzp_url}\n\n_Payment ke baad invoice automatically aayega_ 🙏"
        else:
            payment_msg = f"✅ *Order Confirmed!*\n\n*ARN:* {arn}\n*Product:* {data.get('product_name','')}\n*Qty:* {qty} kg\n*Total:* ₹{total}\n\nPayment ke liye UPI: aarvex@upi\nScreenshot yahan bhejein.\n\nDhanyawad! 🙏"
        _send_wa(mobile, payment_msg)
        admin_num = ADMIN_WHATSAPP_NUMBER.replace("+","").replace(" ","")
        if admin_num:
            _send_wa(admin_num, wa_msg)
    except Exception as e:
        logger.error(f"[WEB_ORDER] WhatsApp error: {e}")

    return {"statusCode": 200, "headers": cors, "body": json.dumps({"success": True, "arn": arn, "total": total})}
