# Aarvex V2 — Ops Soften + Design Auditor Master Plan

**Status:** Plan only — implement after your approval.  
**Does not replace** the Scale/Security plan; it **supersedes** what to do *next* by skipping already-shipped work and adding your Design Auditor.

---

## Seedha verdict

Purana Scale/Security plan sahi tha, lekin ab uska zyada hissa **code me aa chuka hai**. Dobara wahi rebuild karna waste hai.

**Naya V2 plan better hai kyunki:**

1. Pehle se done cheezein skip karta hai (purge, strikes, auto-mod, GSI feed, fail-closed rates, Content Queue).
2. Sirf **remaining security gaps** (Soften) complete karta hai.
3. Aapka **special Admin Design Auditor** (one-click → thinking → desktop+mobile screenshots → 12-section + motion analysis → brand-aware recommendations) ko core feature banata hai.
4. Crores-scale Redis/OpenSearch ko honest “baad me” rakhta hai.

| Priority | Focus | Kyun |
|----------|--------|------|
| **P0** | Design Auditor MVP (admin one-click) | Aapka naya primary ask |
| **P0** | Soften: ADMINSESS + TOTP lockout, MIME upload gate, report→MODFLAG | Purane plan ke unfinished holes |
| **P1** | Scorer deep: 12 sections + micro-interactions + brand tokens | Professional recommendations |
| **P1** | Findings UI + optional “apply safe token fixes” | Actionable, not just PDF noise |
| **P2** | Audit regression (vs last run) | Design quality over time |
| **P3** | Crores infra (Redis, OpenSearch, multi-region) | Abhi overkill |

**Locked defaults (approve = yehi):**
- Auditor = **manual only** (no cron).
- Capture = browser screenshots desktop **1440** + mobile **390** per tab; fallback = CSS/DOM heuristics if browser job unavailable.
- Brand = Aarvex lime `#D4ED6B` + ink `#0A0A0A` + deep green surfaces — never generic purple SaaS.

```mermaid
flowchart TD
  click[Admin_Run_Design_Audit]
  click --> think[Visible_thinking_steps]
  think --> capture[Desktop_and_mobile_screenshots]
  capture --> brand[Load_tokens_and_brand_rules]
  brand --> score[Score_12_sections_plus_motion]
  score --> report[Findings_with_fix]
  report --> admin[Admin_ack_or_pin]
```

---

## Part 0 — Already done (DO NOT rebuild)

Verify on deploy; don’t re-code:

- `_purge_user`, admin Warn / Block / Delete, strikes, Content Queue, auto-moderation ON/OFF  
  (`content_moderation.py`, `marketplace.py`, `admin_dashboard.html`)
- Feed + admin users GSI/cursor paths; fail-closed rate limits on sensitive writes
- Maintenance dry-run / orphan S3; `tools/aws_waf_throttle_notes.md`
- Nav brand lime + Products/Shops pill (`ax-nav-brand.css`)

### Wave Soften — still missing (small, do before/with Auditor)

1. **ADMINSESS#** server session + TTL + logout revoke; TOTP **5 fails → 15 min** lockout  
2. Upload **MIME allowlist** + max bytes **before** base64 decode (feed/chat/KYC)  
3. CloudFront **CSP** snippet in tools doc (optional policy attach)  
4. Settings: **editable keyword pack** → `SETTINGS#PLATFORM`  
5. User **Report post** → create `MODFLAG#` (not only `REPORT#`)

---

## Part 1 — Design Auditor (special feature)

### User story

Admin dashboard me **Design Studio** panel:

1. Ek baar **Run Design Audit** click (manual).  
2. Screen pe **Thinking** steps dikhein (silent nahi):  
   - Loading brand tokens…  
   - Capturing Portal → Home (desktop / mobile)…  
   - Scoring hierarchy, color, type, Fitts, Nielsen, motion…  
3. Har important tab ke **desktop + mobile** screenshots.  
4. Engine khud algorithms identify karke score kare.  
5. Report: severity + evidence (screenshot crop/ref) + **professional recommended changes** (CSS/HTML/motion).  
6. Admin: Ack / Dismiss / Pin. Optional later: Apply **safe token-only** fixes.

### Architecture

| Piece | Role |
|-------|------|
| `admin_dashboard.html` | Design Studio UI, thinking log, gallery, findings |
| `design_auditor.py` (new) | `POST /admin/api/design-audit/run`, status, report |
| `tools/design_auditor/` | Playwright (or cloud browser) capture + scorer + `brand_rubric.json` |
| S3 `design-audits/{audit_id}/` | PNGs + `report.json` |
| Dynamo `DESIGNAUDIT#…`, `DESIGNAUDITFINDING#…` | Job + findings |

### Tab checklist (v1)

**Portal:** login, home/dashboard, trade products, trade shops, sell, my orders, profile, messages/feed.  
**Admin:** users, KYC, shops, settings, content queue, command center.

Viewports: `1440×900` (desktop), `390×844` (mobile).

### Capture options

- **Preferred:** Admin click → job → Playwright/cloud browser against staging URL (demo or session cookie) → screenshots → S3 → score.  
- **Fallback:** No browser — parse live CSS/HTML/`tokens.css` only (weaker on layout/motion, still useful).

---

## Part 2 — Brand guidelines (always first)

Scorer pehle ye load kare (`tokens.css`, `ax-theme-aarvex-green.css`, logo):

- Accent `--brand-lime` `#D4ED6B`; **text-on-lime = `#0A0A0A`** (white-on-lime = fail)  
- Dark surfaces `#0D1712` / `#121F18` — pure `#000` page bg = fail  
- CTA = lime + dark ink; secondary = outline/muted  
- Fonts: Fraunces display + Plus Jakarta/Inter UI (≤3 families)  
- Icon patches = translucent surface mix (no muddy solid dark tiles)  
- Agri/export: lime + forest + gold sparingly — **reject** purple-on-white AI defaults  

Har recommendation `brand_ok: true/false` carry kare.

---

## Part 3 — Scoring rubric (aapke 12 sections → checks)

Har finding JSON:

```json
{
  "concept": "Fitts's Law",
  "category": "UX Psychology",
  "severity": "high|medium|low",
  "definition": "...",
  "formula_or_rule": "...",
  "practical_application": "...",
  "example": "Portal mobile: primary CTA outside thumb zone",
  "common_mistakes": "...",
  "evidence": { "tab": "trade", "viewport": "mobile", "screenshot": "..." },
  "recommendation": "Move sticky Buy CTA into bottom safe area…",
  "brand_ok": true
}
```

### 1. Hierarchy
- **1.1 Size:** H1 ≥ ~2× body; modular scale 12→14→16→24→32→48 (or 1.25 ratio).  
- **1.2 Color:** One brightest CTA; secondary muted/outline.  
- **1.3 Position:** First viewport Z/F — brand + one headline + one line + one CTA; flag hero clutter.  
- **1.4 Depth:** Consistent elevation; flag shadow soup / card-in-hero.

### 2. Color theory
- Harmony vs lime–forest ramp; gold only as accent.  
- Industry fit (agri ≠ kids rainbow / pure finance blue).  
- Never color-only status (icons+text).  
- Dark mode: no `#000`; text hierarchy ~87%/60% opacity feel.

### 3. Typography
- Body LH 1.4–1.6; headings 1.1–1.3; uppercase tracking.  
- ~45–75ch line length; mobile body ≥16px; ≤3 families.

### 4. Psychology
- Fitts (thumb zone), Hick (chip overload), Peak-End (success screens), Zeigarnik (profile %), Von Restorff (one CTA), Serial position (nav ends).

### 5. Nielsen’s 10
Status, real-world match, undo/cancel, consistency, error prevention, recognition, flexibility, minimalism, error recovery, help — present/partial/missing + evidence.

### 6. Design system
- Tokens vs hard-coded hex; **8-point grid**; atomic button consistency.

### 7. Platform
- Touch ≥44×44 / 48dp; bottom nav vs overflow appropriateness.

### 8. Micro-interactions / motion (explicit)
- Anatomy: trigger → rules → feedback → loops.  
- Timing: micro 100–300ms; page 300–500ms; flag >500ms.  
- Skeleton vs blank spinner; like/toggle/submit feedback complete.  
- Brand: 2–3 intentional motions — presence, not noise.

### 9–10. Navigation + a11y
- WCAG 4.5:1 text / 3:1 UI; focus order; alt text; no red/green-only errors.

### 11–12. Process + trends
- Recommend **token/hierarchy fixes**, not random neumorphism/glass unless contrast-safe + brand-fit.

---

## Part 4 — Implementation order (after you approve)

1. **Soften** — ADMINSESS/TOTP lockout, MIME gate, MODFLAG on report, keyword pack  
2. **DA1** — Admin Design Studio UI + run/status/report APIs + thinking log  
3. **DA1** — Screenshot pipeline (desktop+mobile tab list) → S3  
4. **DA1** — Scorer v1 (tokens + type + contrast + CTA + spacing + motion CSS)  
5. **DA2** — Full 12-section weights + animation notes + findings gallery  
6. **DA2** — Optional apply safe token-only patches + compare vs last audit  

**Out of scope now:** auto-cron audits; full crores architecture.

---

## Acceptance checks

- [ ] One admin click starts audit; thinking steps visible end-to-end  
- [ ] Each configured tab has desktop + mobile screenshots in S3  
- [ ] Report includes brand lime/ink rules + hierarchy, color, type, a11y, **motion** findings  
- [ ] Recommendations are Aarvex-specific (not generic purple SaaS)  
- [ ] Soften items: TOTP lockout, MIME gate, report→MODFLAG work  
- [ ] Manual-only (no scheduled spam audits)

---

## Extra (recommended, light)

- Presigned uploads (faster mobile, smaller Lambda payloads)  
- “Report post” already → MODFLAG in Soften  
- E2E chat: document client-side filter + report only (server can’t read ciphertext)  
- Design Auditor export PDF for stakeholders (DA3)

---

## Approve ke baad

Agar ye plan theek lage, bolo **“V2 plan approve — implement Soften + Design Auditor”** — tab coding start hogi. Plan file khud edit mat karwana during implement unless aap explicitly bolo.
