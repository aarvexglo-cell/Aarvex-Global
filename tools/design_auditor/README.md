# Design Auditor capture tool

Admin **Run Design Audit** always scores brand/CSS heuristics in Lambda and writes `DESIGNAUDIT#` + findings + optional `s3://…/design-audits/{id}/report.json`.

For real desktop/mobile PNGs:

```bash
cd tools/design_auditor
npm i playwright
npx playwright install chromium
node capture.mjs --base https://YOUR_STAGING --audit-id YOUR_AUDIT_ID --out ./out
# Optional upload:
set S3_BUCKET=your-bucket
node capture.mjs --base https://YOUR_STAGING --audit-id YOUR_AUDIT_ID
```

Viewports: 1440×900 desktop, 390×844 mobile. Tab list matches `design_auditor.py`.

## Soften / CSP

See `tools/aws_waf_throttle_notes.md` for CloudFront CSP response-headers policy snippet.
