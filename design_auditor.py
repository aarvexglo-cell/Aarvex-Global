"""
Aarvex Design Auditor — brand-aware scoring + audit jobs.

Flow: run → thinking steps → (optional capture meta) → score 12 sections → findings.
Screenshots: Playwright tool uploads to S3; Lambda fallback records viewport captures
and scores from tokens/CSS heuristics when browser unavailable.
"""

from __future__ import annotations

import json
import logging
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable

logger = logging.getLogger()

_H: dict[str, Any] = {}

PORTAL_TABS = [
    {"id": "login", "label": "Portal Login", "path": "portal.html"},
    {"id": "home", "label": "Home / Dashboard", "path": "portal.html#dashboard"},
    {"id": "trade_products", "label": "Trade · Products", "path": "portal.html#trade"},
    {"id": "trade_shops", "label": "Trade · Shops", "path": "portal.html#trade"},
    {"id": "sell", "label": "Sell Produce", "path": "portal.html#sell"},
    {"id": "myorders", "label": "My Orders", "path": "portal.html#myorders"},
    {"id": "profile", "label": "Profile", "path": "portal.html#profile"},
    {"id": "messages", "label": "Messages / Feed", "path": "portal.html#messages"},
]

ADMIN_TABS = [
    {"id": "users", "label": "Admin Users", "path": "admin_dashboard.html"},
    {"id": "kyc", "label": "Admin KYC", "path": "admin_dashboard.html"},
    {"id": "shops", "label": "Admin Shops", "path": "admin_dashboard.html"},
    {"id": "settings", "label": "Admin Settings", "path": "admin_dashboard.html"},
    {"id": "modqueue", "label": "Content Queue", "path": "admin_dashboard.html"},
    {"id": "clientlogs", "label": "Command Center", "path": "admin_dashboard.html"},
]

VIEWPORTS = [
    {"id": "desktop", "w": 1440, "h": 900},
    {"id": "mobile", "w": 390, "h": 844},
]

BRAND = {
    "lime": "#D4ED6B",
    "lime_ink": "#0A0A0A",
    "dark_page": "#0D1712",
    "dark_raised": "#121F18",
    "reject_purple_saas": True,
}


def _bind(helpers: dict) -> None:
    _H.update(helpers or {})


def _table():
    return _H.get("table")


def _now() -> str:
    fn = _H.get("now")
    return fn() if fn else datetime.now(timezone.utc).isoformat()


def _ttl(days: int) -> int:
    return int(time.time()) + days * 86400


def _json_response(status: int, body: dict):
    fn = _H.get("json_response")
    if fn:
        return fn(status, body)
    return {"statusCode": status, "body": json.dumps(body, default=str)}


def _admin_ok(event: dict) -> bool:
    fn = _H.get("admin_authorized")
    return bool(fn and fn(event))


def _event_body(event: dict) -> dict:
    fn = _H.get("event_body")
    return fn(event) if fn else {}


def _s3():
    return _H.get("s3")


def _bucket() -> str:
    return _H.get("s3_bucket") or ""


def _put_step(audit_id: str, steps: list, msg: str, persist: bool = False) -> list:
    steps.append({"at": _now(), "message": msg})
    if not persist:
        return steps
    t = _table()
    if t:
        try:
            t.update_item(
                Key={"pk": f"DESIGNAUDIT#{audit_id}"},
                UpdateExpression="SET thinking = :th, updated_at = :u",
                ExpressionAttributeValues={":th": steps[-40:], ":u": _now()},
            )
        except Exception as e:
            logger.warning("[DA] step update: %s", e)
    return steps


def _fetch_text(url: str) -> str:
    import urllib.request
    try:
        with urllib.request.urlopen(url, timeout=8) as resp:
            return resp.read().decode("utf-8", errors="ignore")[:200000]
    except Exception as e:
        logger.warning("[DA] fetch %s failed: %s", url, e)
        return ""


def _load_css_corpus() -> str:
    """Prefer local workspace files; else CloudFront/public tokens."""
    import os
    chunks = []
    base = os.path.dirname(os.path.abspath(__file__))
    for name in ("tokens.css", "ax-theme-aarvex-green.css", "ax-nav-brand.css", "portal-base.css"):
        path = os.path.join(base, name)
        try:
            with open(path, "r", encoding="utf-8") as f:
                chunks.append(f.read())
        except Exception:
            pass
    if not chunks:
        cf = (_H.get("cloudfront_base") or "https://aarvexglobal.com").rstrip("/")
        for name in ("tokens.css", "ax-theme-aarvex-green.css", "ax-nav-brand.css"):
            chunks.append(_fetch_text(f"{cf}/{name}"))
    return "\n".join(chunks)


def _finding(
    concept: str,
    category: str,
    severity: str,
    definition: str,
    formula: str,
    application: str,
    example: str,
    mistakes: str,
    recommendation: str,
    tab: str = "global",
    viewport: str = "desktop",
    brand_ok: bool = True,
    screenshot: str = "",
) -> dict:
    return {
        "finding_id": uuid.uuid4().hex[:10],
        "concept": concept,
        "category": category,
        "severity": severity,
        "definition": definition,
        "formula_or_rule": formula,
        "practical_application": application,
        "example": example,
        "common_mistakes": mistakes,
        "evidence": {"tab": tab, "viewport": viewport, "screenshot": screenshot},
        "recommendation": recommendation,
        "brand_ok": brand_ok,
        "status": "open",
    }


def score_design(css: str, captures: list[dict]) -> list[dict]:
    """Heuristic scorer implementing the 12-section rubric + brand rules."""
    findings: list[dict] = []
    css_l = (css or "").lower()
    has_lime = "d4ed6b" in css_l or "--brand-lime" in css_l
    has_ink = "0a0a0a" in css_l or "--brand-lime-ink" in css_l
    has_pure_black_bg = bool(re.search(r"background(?:-color)?:\s*#000(?:000)?\b", css_l))
    purple_saas = bool(re.search(r"#7c3aed|#8b5cf6|purple-to-indigo", css_l))
    white_on_action = "color:#fff" in css_l and "btn-primary" in css_l and has_lime

    # Brand first
    if not has_lime:
        findings.append(_finding(
            "Brand lime missing", "Brand Guidelines", "high",
            "Aarvex primary accent is logo lime.",
            "Use --brand-lime #D4ED6B",
            "Wire tokens into CTAs and active states",
            "tokens.css should define --brand-lime",
            "Hard-coding forest mint only",
            "Add --brand-lime ramp and map primary actions to lime + dark ink",
            brand_ok=False,
        ))
    if has_lime and not has_ink:
        findings.append(_finding(
            "Text on lime", "Brand Guidelines", "high",
            "Logo contrast rule: near-black on lime.",
            "color-text-on-lime = #0A0A0A",
            "Never use white text on lime CTAs",
            "btn-primary on lime with white fails WCAG/logo",
            "White on chartreuse",
            "Set --color-text-on-action to --brand-lime-ink",
            brand_ok=False,
        ))
    if white_on_action:
        findings.append(_finding(
            "White on lime CTA", "Brand Guidelines", "high",
            "White on lime fails brand + contrast.",
            "Ink #0A0A0A on #D4ED6B",
            "Primary buttons must use dark ink",
            "portal-base .btn-primary color:#fff",
            "Assuming green CTAs always need white text",
            "Change .btn-primary color to var(--color-text-on-action)",
            brand_ok=False,
        ))
    if has_pure_black_bg:
        findings.append(_finding(
            "Pure black surface", "Color Theory · Dark Mode", "medium",
            "Pure #000 causes eye strain.",
            "Prefer #0D1712 / #121F18 / #121212",
            "Dark theme page backgrounds",
            "background:#000 in CSS",
            "Using #000 for OLED aesthetics",
            "Replace pure black with Aarvex deep green-black surfaces",
            brand_ok=False,
        ))
    if purple_saas:
        findings.append(_finding(
            "Generic purple SaaS palette", "Brand Guidelines", "medium",
            "Aarvex is agri/export lime-forest, not purple AI defaults.",
            "Reject purple-on-white clusters",
            "Marketing and portal accents",
            "Detected purple hex / purple-indigo language",
            "Defaulting to Inter+purple",
            "Retint accents to brand-lime / forest; keep gold sparingly",
            brand_ok=False,
        ))

    # 1 Hierarchy
    findings.append(_finding(
        "Size-based hierarchy", "Hierarchy", "medium",
        "Larger type = more important.",
        "Type scale 12→14→16→24→32→48 or modular 1.25",
        "Audit display vs body ratios on first viewport",
        "Ensure Fraunces display ≥ ~2× body",
        "Same size for title and body",
        "Map .page-title / login headings to 32–48px; body 14–16px",
        tab="home",
    ))
    findings.append(_finding(
        "Color-based hierarchy", "Hierarchy", "medium",
        "High-saturation draws attention.",
        "One primary CTA brightest; secondary outline",
        "Trade and login CTAs",
        "Lime fill primary vs muted secondary",
        "Multiple competing bright greens",
        "Keep one lime CTA per section; demote others to outline",
        tab="trade_products",
    ))
    findings.append(_finding(
        "Position / Z-pattern", "Hierarchy", "low",
        "Landing first viewport: brand, headline, support, CTA.",
        "Z-pattern for marketing; F for text-heavy",
        "Login brand panel + portal home hero",
        "Avoid stats strips competing in hero",
        "Cluttered first screen",
        "Keep first viewport to brand + one H1 + one line + one CTA group",
        tab="login",
    ))
    findings.append(_finding(
        "Depth & elevation", "Hierarchy", "low",
        "Shadows create importance.",
        "Material-like 0–24dp; consistent tokens",
        "Cards vs hero — avoid shadow soup",
        "Prefer soft lime glow on primary only",
        "Multi-layer shadows everywhere",
        "Use --brand-lime-glow sparingly on CTAs; flatten idle cards",
        tab="home",
    ))

    # 2 Color
    findings.append(_finding(
        "Industry color logic", "Color Theory", "low",
        "Agri/export prefers green/lime/earth.",
        "Trust via deep green + lime energy",
        "Portal + admin chrome",
        "Current lime/forest direction is on-brand",
        "Finance-blue-only or kids rainbow",
        "Keep gold for premium accents only; do not introduce blue primary",
        brand_ok=True,
    ))
    findings.append(_finding(
        "Color as sole status", "Color Theory · A11y", "medium",
        "Never rely on color alone.",
        "Pair status color with icon/text",
        "Order status / KYC badges",
        "Badges should include labels + icons",
        "Red/green only dots",
        "Ensure success/error use icon + text (not color-only)",
        tab="myorders",
    ))

    # 3 Type
    findings.append(_finding(
        "Type scale & readability", "Typography", "medium",
        "Modular scale + readable measure.",
        "Body LH 1.4–1.6; mobile body ≥16px; ≤3 families",
        "Portal body and forms",
        "Fraunces + Plus Jakarta/Inter is within 3 families",
        "Mixing 4+ fonts",
        "Confirm mobile form inputs ≥16px to avoid iOS zoom; keep line-height 1.5 on body",
        tab="profile", viewport="mobile",
    ))

    # 4 Psychology
    findings.append(_finding(
        "Fitts's Law", "UX Psychology", "high",
        "Time to target grows with distance/size.",
        "T = a + b log2(D/S+1); thumb zone = bottom 1/3",
        "Mobile primary actions",
        "Bottom nav / sticky order CTA should sit in thumb reach",
        "Primary CTA top-right only on mobile",
        "Place primary Buy/Post actions in bottom safe area on mobile viewports",
        tab="trade_products", viewport="mobile",
    ))
    findings.append(_finding(
        "Hick's Law", "UX Psychology", "medium",
        "More choices → slower decisions.",
        "Decision time ∝ log2(n+1)",
        "Filters and trade mode chips",
        "Products/Shops toggle is good progressive disclosure",
        "Showing every filter at once",
        "Keep secondary filters behind 'More filters' on mobile",
        tab="trade_products", viewport="mobile",
    ))
    findings.append(_finding(
        "Peak-End Rule", "UX Psychology", "medium",
        "Peak and end moments dominate memory.",
        "Delight success / order complete",
        "Order success screen",
        "Confirm success has clear next step + calm motion",
        "Abrupt dead-end after pay",
        "Add short success confirmation (checkmark 200–300ms) + Track Orders CTA",
        tab="myorders",
    ))
    findings.append(_finding(
        "Zeigarnik Effect", "UX Psychology", "low",
        "Incomplete tasks stay salient.",
        "Progress cues motivate completion",
        "Profile completeness",
        "Show profile % complete if KYC/address missing",
        "Hiding incomplete state",
        "Surface 'Profile 80% complete' with one CTA to finish",
        tab="profile",
    ))
    findings.append(_finding(
        "Von Restorff / Serial position", "UX Psychology", "low",
        "Distinct and edge items are remembered.",
        "One unique CTA; important nav at ends",
        "Sidebar and header",
        "Lime active rail already isolates active nav",
        "Many equally loud buttons",
        "Keep Command Center / primary trade actions at start or end of nav groups",
        tab="home",
    ))

    # 5 Nielsen (compressed into key gaps)
    for concept, sev, rec in [
        ("Visibility of system status", "medium", "Ensure loaders/skeletons on feed and shop lists; never blank panels"),
        ("User control & freedom", "low", "Confirm cancel on destructive admin Delete; keep Undo where possible"),
        ("Error prevention", "medium", "Disable submit until required fields valid; keep typed DELETE confirm"),
        ("Help & documentation", "low", "Add short tooltips on KYC and Design Studio first run"),
    ]:
        findings.append(_finding(
            concept, "Nielsen Heuristics", sev,
            "Usability heuristic check.",
            "Nielsen Norman 10 heuristics",
            "Portal + admin",
            concept,
            "Silent failures / no affordance",
            rec,
        ))

    # 6 Design system
    token_usage = css_l.count("var(--") 
    hardcoded_hex = len(re.findall(r"#[0-9a-f]{3,8}\b", css_l))
    if hardcoded_hex > max(40, token_usage):
        findings.append(_finding(
            "Hard-coded hex spray", "Design System", "high",
            "Tokens should drive color/spacing.",
            "Prefer var(--token) over raw hex",
            "portal-base and feature CSS",
            f"Approx hex literals={hardcoded_hex}, var()={token_usage}",
            "One-off hex in every component",
            "Migrate repeated greens/grays to tokens; keep brand lime as token only",
            brand_ok=True,
        ))
    findings.append(_finding(
        "8-point grid", "Design System", "low",
        "Spacing multiples of 8.",
        "8 / 16 / 24 / 32…",
        "Nav already uses 8/13/21 φ — prefer 8/16/24 for new UI",
        "Sidebar φ spacing is intentional",
        "Random 7px/11px gaps",
        "For new Design Studio UI use 8px grid; keep existing φ nav as documented exception",
    ))

    # 7 Platform
    findings.append(_finding(
        "Touch targets", "Platform Guidelines", "medium",
        "Minimum touch size.",
        "iOS 44×44 / Android 48×48; 8px gap",
        "Mobile nav icons and trade tabs",
        "Verify .trade-mode-tab and bottom nav ≥44px tall",
        "Tiny icon-only hit areas",
        "Increase mobile tap targets for nav icons and filter chips to ≥44px",
        tab="trade_products", viewport="mobile",
    ))

    # 8 Motion
    long_anim = re.findall(r"(\d*\.?\d+)s", css_l)
    slow = [float(x) for x in long_anim if x and float(x) > 0.5]
    if slow:
        findings.append(_finding(
            "Animation timing", "Micro-interactions", "medium",
            "Micro 100–300ms; page 300–500ms.",
            "Avoid >500ms transitions",
            "CSS transitions/animations",
            f"Found durations >500ms: {slow[:5]}",
            "Sluggish 1s fades everywhere",
            "Cap decorative transitions at 300–400ms; keep micro-interactions ≤300ms",
        ))
    else:
        findings.append(_finding(
            "Motion presence", "Micro-interactions", "low",
            "2–3 intentional motions beat noise.",
            "Trigger → rules → feedback → loops",
            "Like, theme toggle, CTA press",
            "Ensure ripple/scale feedback on primary buttons",
            "Motion with no feedback meaning",
            "Add 150–250ms press feedback on .btn-primary; skeleton on feed load",
        ))

    # 9–10 Nav + a11y
    findings.append(_finding(
        "WCAG contrast", "Accessibility", "high",
        "Text/UI contrast minima.",
        "4.5:1 normal text; 3:1 UI",
        "Lime on white / ink on lime / muted text on dark",
        "Dark ink on lime passes; verify muted gray on #0D1712",
        "Light gray on dark green below 4.5:1",
        "Audit --neutral-700 on dark surfaces; bump to --neutral-800 where body text",
        tab="home", viewport="desktop",
    ))
    findings.append(_finding(
        "Color blindness", "Accessibility", "medium",
        "8% men deuteranopia risk.",
        "Do not use red/green alone for error/success",
        "Status badges",
        "Pair colors with icons/labels",
        "Green/red only pills",
        "Add icons to success/error chips in orders and KYC",
        tab="kyc",
    ))

    # 11–12 Process / trends
    findings.append(_finding(
        "Trends vs brand", "Advanced Concepts", "low",
        "Prefer token fixes over trendy glass/neuomorphism.",
        "Only use glass if contrast-safe + brand-fit",
        "Auditor recommendations",
        "Do not introduce neumorphism on agri portal",
        "Chasing dribbble trends",
        "Ship hierarchy/token/motion fixes; skip neumorphism and low-contrast glass",
        brand_ok=True,
    ))

    # Attach first capture screenshot refs when present
    if captures:
        shot = captures[0].get("s3_key") or captures[0].get("url") or ""
        for f in findings[:3]:
            if not f["evidence"].get("screenshot"):
                f["evidence"]["screenshot"] = shot

    return findings


def _store_findings(audit_id: str, findings: list[dict]) -> None:
    t = _table()
    if not t:
        return
    for i, f in enumerate(findings):
        try:
            item = {
                "pk": f"DESIGNAUDITFINDING#{audit_id}#{i:03d}",
                "audit_id": audit_id,
                "index": i,
                "ttl": _ttl(90),
                "created_at": _now(),
                **f,
            }
            t.put_item(Item=item)
        except Exception as e:
            logger.warning("[DA] finding put: %s", e)


def run_audit_job(base_url: str = "") -> dict:
    """Synchronous audit used by API (thinking steps persisted)."""
    audit_id = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"
    t = _table()
    steps: list = []
    item = {
        "pk": f"DESIGNAUDIT#{audit_id}",
        "audit_id": audit_id,
        "status": "running",
        "thinking": [],
        "captures": [],
        "created_at": _now(),
        "ttl": _ttl(90),
        "base_url": base_url or (_H.get("cloudfront_base") or "https://aarvexglobal.com"),
    }
    if t:
        t.put_item(Item=item)

    steps = _put_step(audit_id, steps, "Loading Aarvex brand tokens & guidelines…")
    css = _load_css_corpus()
    steps = _put_step(audit_id, steps, f"Brand corpus loaded ({len(css)} chars). Accent lime #D4ED6B, ink #0A0A0A.")

    captures = []
    tabs = PORTAL_TABS + ADMIN_TABS
    steps = _put_step(
        audit_id, steps,
        f"Building capture checklist — {len(tabs)} tabs × {len(VIEWPORTS)} viewports…",
    )
    for tab in tabs:
        for vp in VIEWPORTS:
            steps = _put_step(
                audit_id, steps,
                f"Queued {tab['label']} — {vp['id']} {vp['w']}×{vp['h']}",
            )
            cap = {
                "tab": tab["id"],
                "label": tab["label"],
                "path": tab["path"],
                "viewport": vp["id"],
                "width": vp["w"],
                "height": vp["h"],
                "mode": "heuristic",  # Playwright tool can upgrade to real PNG
                "s3_key": "",
                "url": f"{item['base_url'].rstrip('/')}/{tab['path']}",
            }
            captures.append(cap)

    # One mid-run persist so status polling can show progress without 30+ writes
    steps = _put_step(audit_id, steps, "Scoring hierarchy, color, type, psychology, Nielsen, motion, a11y…", persist=True)
    findings = score_design(css, captures)
    steps = _put_step(audit_id, steps, f"Generated {len(findings)} findings. Writing report…")
    _store_findings(audit_id, findings)

    # Optional: if Playwright uploaded shots under design-audits/latest, note in report
    steps = _put_step(
        audit_id, steps,
        "Note: Real PNGs appear when tools/design_auditor/capture.mjs runs against staging; "
        "this run used brand/CSS heuristics + capture checklist.",
    )

    report = {
        "audit_id": audit_id,
        "status": "complete",
        "brand": BRAND,
        "thinking": steps,
        "captures": captures,
        "findings": findings,
        "summary": {
            "total": len(findings),
            "high": sum(1 for f in findings if f["severity"] == "high"),
            "medium": sum(1 for f in findings if f["severity"] == "medium"),
            "low": sum(1 for f in findings if f["severity"] == "low"),
            "brand_fails": sum(1 for f in findings if not f.get("brand_ok", True)),
        },
        "completed_at": _now(),
    }

    # Persist report JSON to S3 when possible
    s3 = _s3()
    bucket = _bucket()
    report_key = f"design-audits/{audit_id}/report.json"
    if s3 and bucket:
        try:
            s3.put_object(
                Bucket=bucket, Key=report_key,
                Body=json.dumps(report, default=str).encode("utf-8"),
                ContentType="application/json",
            )
            report["report_s3_key"] = report_key
        except Exception as e:
            logger.warning("[DA] S3 report: %s", e)

    if t:
        try:
            t.update_item(
                Key={"pk": f"DESIGNAUDIT#{audit_id}"},
                UpdateExpression="SET #s=:s, thinking=:th, captures=:c, summary=:sum, completed_at=:u, report_s3_key=:rk",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={
                    ":s": "complete", ":th": steps, ":c": captures,
                    ":sum": report["summary"], ":u": _now(),
                    ":rk": report.get("report_s3_key", ""),
                },
            )
        except Exception as e:
            logger.warning("[DA] finalize: %s", e)

    return report


def handle_design_audit_run(event: dict) -> dict:
    if not _admin_ok(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    base = str(body.get("base_url") or "").strip()
    try:
        report = run_audit_job(base_url=base)
        return _json_response(200, {"success": True, "audit_id": report["audit_id"], "report": report})
    except Exception as e:
        logger.exception("[DA] run failed")
        return _json_response(500, {"error": str(e)})


def handle_design_audit_status(event: dict) -> dict:
    if not _admin_ok(event):
        return _json_response(403, {"error": "Unauthorized"})
    qs = event.get("queryStringParameters") or {}
    audit_id = (qs.get("audit_id") or "").strip()
    t = _table()
    if not audit_id or not t:
        return _json_response(400, {"error": "audit_id required"})
    it = t.get_item(Key={"pk": f"DESIGNAUDIT#{audit_id}"}).get("Item") or {}
    if not it:
        return _json_response(404, {"error": "Not found"})
    return _json_response(200, {"audit": it})


def handle_design_audit_report(event: dict) -> dict:
    if not _admin_ok(event):
        return _json_response(403, {"error": "Unauthorized"})
    qs = event.get("queryStringParameters") or {}
    audit_id = (qs.get("audit_id") or "").strip()
    t = _table()
    if not audit_id or not t:
        return _json_response(400, {"error": "audit_id required"})
    meta = t.get_item(Key={"pk": f"DESIGNAUDIT#{audit_id}"}).get("Item") or {}
    findings = []
    scan = _H.get("scan_by_pk_prefix")
    if scan:
        findings = scan(f"DESIGNAUDITFINDING#{audit_id}#") or []
        findings.sort(key=lambda x: int(x.get("index") or 0))
    # previous audit compare
    prev = None
    try:
        all_audits = scan("DESIGNAUDIT#") if scan else []
        others = [a for a in all_audits if a.get("audit_id") != audit_id and a.get("status") == "complete"]
        others.sort(key=lambda a: a.get("created_at", ""), reverse=True)
        if others:
            prev = {"audit_id": others[0].get("audit_id"), "summary": others[0].get("summary")}
    except Exception:
        pass
    return _json_response(200, {
        "audit": meta,
        "findings": findings,
        "previous": prev,
    })


def handle_design_audit_finding_update(event: dict) -> dict:
    if not _admin_ok(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    pk = str(body.get("pk") or "")
    status = str(body.get("status") or "").lower()
    if not pk.startswith("DESIGNAUDITFINDING#") or status not in ("open", "acked", "dismissed", "pinned"):
        return _json_response(400, {"error": "pk and status required"})
    t = _table()
    try:
        t.update_item(
            Key={"pk": pk},
            UpdateExpression="SET #s=:s, updated_at=:u",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": status, ":u": _now()},
        )
        return _json_response(200, {"success": True})
    except Exception as e:
        return _json_response(500, {"error": str(e)})


def handle_design_audit_apply_safe(event: dict) -> dict:
    """Document-only safe fixes list (no auto file write in Lambda)."""
    if not _admin_ok(event):
        return _json_response(403, {"error": "Unauthorized"})
    body = _event_body(event)
    audit_id = str(body.get("audit_id") or "")
    safe_patches = [
        {
            "id": "text-on-lime",
            "file": "portal-base.css",
            "change": "Ensure .btn-primary uses color:var(--color-text-on-action) not #fff when fill is lime",
            "patch": "diff --git a/portal-base.css b/portal-base.css\n--- a/portal-base.css\n+++ b/portal-base.css\n@@\n-.btn-primary { color: #fff; background: var(--color-lime); }\n+.btn-primary { color: var(--color-text-on-action); background: var(--color-lime); }\n"
        },
        {
            "id": "dark-surface",
            "file": "ax-theme-aarvex-green.css",
            "change": "Replace any #000 page backgrounds with #0D1712",
            "patch": "diff --git a/ax-theme-aarvex-green.css b/ax-theme-aarvex-green.css\n--- a/ax-theme-aarvex-green.css\n+++ b/ax-theme-aarvex-green.css\n@@\n-body { background-color: #000; }\n+body { background-color: #0D1712; }\n"
        },
        {
            "id": "touch-targets",
            "file": "portal-base.css",
            "change": "min-height:44px on .trade-mode-tab and mobile nav icons",
            "patch": "diff --git a/portal-base.css b/portal-base.css\n--- a/portal-base.css\n+++ b/portal-base.css\n@@\n-.trade-mode-tab, .mobile-nav-icon { min-height: 32px; }\n+.trade-mode-tab, .mobile-nav-icon { min-height: 44px; }\n"
        },
    ]
    return _json_response(200, {
        "success": True,
        "audit_id": audit_id,
        "message": "Safe token patches listed for manual/agent apply (Lambda does not mutate static site).",
        "patches": safe_patches,
    })
