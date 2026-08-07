# ═══════════════════════════════════════════════════════════════
# Aarvex deploy — 6 Aug 2026 changes (stock + telemetry + CC + i18n + shop)
# Run in ClaudeShell / PowerShell AFTER: aws configure (full keys)
# Region: ap-southeast-1 | API: j1yound90m | S3: aarvex-invoices-prod
# ═══════════════════════════════════════════════════════════════

$ErrorActionPreference = 'Stop'
$ROOT   = 'D:\parag\Code base\Claude ai\16 July 2026'
$REGION = 'ap-southeast-1'
$BUCKET = 'aarvex-invoices-prod'
$API    = 'https://j1yound90m.execute-api.ap-southeast-1.amazonaws.com'

Set-Location $ROOT

Write-Host "`n=== 0) Discover Lambda function name ===" -ForegroundColor Cyan
$fns = aws lambda list-functions --region $REGION --query "Functions[].FunctionName" --output text
$fns -split "`t" | ForEach-Object { $_ }
$FN = Read-Host "Paste exact Lambda FunctionName from list above"
if (-not $FN) { throw "Function name required" }

Write-Host "`n=== 1) Build Lambda zip (Python package) ===" -ForegroundColor Cyan
$ZIPDIR = Join-Path $env:TEMP "aarvex-lambda-deploy"
$ZIP    = Join-Path $env:TEMP "aarvex-lambda.zip"
if (Test-Path $ZIPDIR) { Remove-Item $ZIPDIR -Recurse -Force }
New-Item -ItemType Directory -Path $ZIPDIR | Out-Null

# Core modules changed / required today
$PY = @(
  'lambda_handler.py','marketplace.py','delivery.py','advanced_features.py',
  'platform_utils.py','ax_telemetry.py','cod_invoice.py',
  'content_moderation.py','admin_session.py','design_auditor.py'
)
foreach ($f in $PY) {
  if (-not (Test-Path (Join-Path $ROOT $f))) { Write-Warning "Missing $f — skip" ; continue }
  Copy-Item (Join-Path $ROOT $f) $ZIPDIR -Force
  Write-Host "  + $f"
}

# IMPORTANT: if your live Lambda zip has MORE files (deps, other modules),
# download current package first and merge instead of replacing with only these.
# Safer merge path:
#   aws lambda get-function --function-name $FN --region $REGION --query 'Code.Location' --output text
#   → download zip, extract, overwrite the py files above, re-zip, upload.

Write-Host "`n=== 1b) Prefer MERGE with live package (recommended) ===" -ForegroundColor Yellow
$url = aws lambda get-function --function-name $FN --region $REGION --query 'Code.Location' --output text
$liveZip = Join-Path $env:TEMP "aarvex-live.zip"
$liveDir = Join-Path $env:TEMP "aarvex-live-unpack"
Invoke-WebRequest -Uri $url -OutFile $liveZip
if (Test-Path $liveDir) { Remove-Item $liveDir -Recurse -Force }
Expand-Archive -LiteralPath $liveZip -DestinationPath $liveDir -Force
foreach ($f in $PY) {
  $src = Join-Path $ROOT $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $liveDir $f) -Force; Write-Host "  merged $f" }
}
if (Test-Path $ZIP) { Remove-Item $ZIP -Force }
Compress-Archive -Path (Join-Path $liveDir '*') -DestinationPath $ZIP -Force
Write-Host "Zip: $ZIP  size=$((Get-Item $ZIP).Length) bytes"

Write-Host "`n=== 2) Upload Lambda code ===" -ForegroundColor Cyan
aws lambda update-function-code --function-name $FN --region $REGION --zip-file "fileb://$ZIP" | Out-Null
aws lambda wait function-updated --function-name $FN --region $REGION
Write-Host "Lambda updated OK"

Write-Host "`n=== 3) S3 sync — frontend (today's changed files) ===" -ForegroundColor Cyan
$S3FILES = @(
  'admin_dashboard.html',
  'portal.html','index.html',
  'product-modal.js','portal-marketplace.js','portal-nav.js','portal-order-flow.js',
  'portal-listings.js','portal-catalogue-render.js','catalogue-ui.js',
  'ax-i18n.js','ax-telemetry.js','ax-error-log.js','ax-delivery-ux.js','ax-social.js',
  'ax-preloader.css','ax-preloader.js',
  'portal-base.css','portal-ui.css','ax-nav-pro.css','ax-features.css','ax-feed.css',
  'ax-social.css','ax-preloader.css','catalogue-ui.css',
  'ax-preloader.js','ax-feed.js'
)
foreach ($f in $S3FILES) {
  $path = Join-Path $ROOT $f
  if (-not (Test-Path $path)) { Write-Warning "skip missing $f"; continue }
  aws s3 cp $path "s3://$BUCKET/$f" --region $REGION --cache-control "no-cache, max-age=0"
  Write-Host "  s3://$BUCKET/$f"
}

# Optional assets
if (Test-Path (Join-Path $ROOT 'assets\car-loader.json')) {
  aws s3 cp (Join-Path $ROOT 'assets\car-loader.json') "s3://$BUCKET/assets/car-loader.json" --region $REGION
}

Write-Host "`n=== 4) API smoke tests (no new API Gateway routes needed) ===" -ForegroundColor Cyan
Write-Host "Already wired in code:"
Write-Host "  POST $API/telemetry/report"
Write-Host "  GET  $API/admin/api/telemetry"
Write-Host "  POST $API/admin/api/telemetry/ack"
Write-Host "  GET  $API/admin/api/setup-map"
Write-Host "  GET/POST $API/admin/api/settings"
Write-Host "  POST $API/admin/api/design-audit/run"
Write-Host "  GET  $API/admin/api/design-audit/report"
Write-Host "  POST $API/admin/api/logout  (revokes ADMINSESS#)"
# Public ping
try {
  $r = Invoke-WebRequest -Uri "$API/shops/top" -Method GET -UseBasicParsing -TimeoutSec 20
  Write-Host "shops/top → $($r.StatusCode)"
} catch { Write-Warning "shops/top failed: $_" }

Write-Host "`n=== 5) CloudFront (if used) — list + invalidate ===" -ForegroundColor Cyan
aws cloudfront list-distributions --query "DistributionList.Items[?Origins.Items[?DomainName!=null]].{Id:Id,Domain:DomainName,Origin:Origins.Items[0].DomainName}" --output table
$CF = Read-Host "CloudFront DistributionId (blank to skip)"
if ($CF) {
  aws cloudfront create-invalidation --distribution-id $CF --paths "/*" | Out-Null
  Write-Host "Invalidation started for $CF"
}

Write-Host "`n=== DONE ===" -ForegroundColor Green
Write-Host "Hard refresh admin + portal (Ctrl+Shift+R)."
Write-Host "Command Center should load cloud telemetry (not 'Not found')."
Write-Host "Test: place order → public stock unchanged; complete OTP → stock decreases."
