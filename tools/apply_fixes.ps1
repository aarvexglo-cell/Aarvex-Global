<#
Safe fix script for local use
Run from the repository root in PowerShell (run as a developer, not as admin):

powershell -ExecutionPolicy Bypass -File .\tools\apply_fixes.ps1

What it does:
- Backs up lambda_handler.py and advanced_features.py with timestamped copies
- Finds Authorization placeholder lines like: "Authorization": f"******"
- For each occurrence, inspects nearby lines to pick the correct env var to insert:
  * WA_ACCESS_TOKEN for WhatsApp (WA_PHONE_NUMBER_ID in same block)
  * INSTAGRAM_ACCESS_TOKEN for Instagram (ig_id or INSTAGRAM_PAGE_ID nearby)
  * PAGE_ACCESS_TOKEN for Facebook ("/me/messages" or "/me/messages" url)
  * OPENROUTER_API_KEY for openrouter calls
- Replaces the malformed advanced_features Request signature with a proper request and sets Authorization Bearer header
- Optionally runs python -m py_compile across .py files if python is available
- Optionally runs svgo on Icons if svgo is installed

NOTE: The script performs text edits but cannot fully verify runtime correctness. Review the backups before committing.
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)  # repo root (two levels up from tools)
Set-Location $root

function Backup-File($path) {
    if (Test-Path $path) {
        $ts = Get-Date -Format yyyyMMddHHmmss
        $bak = "$path.bak.$ts"
        Copy-Item -Path $path -Destination $bak -Force
        Write-Host "Backed up $path -> $bak"
        return $bak
    } else {
        Write-Host "File not found: $path"
        return $null
    }
}

$lambda = "lambda_handler.py"
$adv = "advanced_features.py"

# Backups
$lbak = Backup-File $lambda
$abak = Backup-File $adv

# Load file as lines
if (-not (Test-Path $lambda)) { Write-Error "$lambda not found in current directory"; exit 1 }
$lines = Get-Content $lambda

# Insert ALLOWED_ORIGINS after OPENROUTER_MODEL if not present
$inserted = $false
for ($i=0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match 'OPENROUTER_MODEL' -and ($lines -notcontains 'ALLOWED_ORIGINS     = os.environ.get("ALLOWED_ORIGINS", "*")')) {
        $insertLine = 'ALLOWED_ORIGINS     = os.environ.get("ALLOWED_ORIGINS", "*")  # configure to tighten CORS for admin routes'
        $lines = $lines[0..$i] + $insertLine + $lines[($i+1)..($lines.Count-1)]
        $inserted = $true
        break
    }
}
if ($inserted) { Write-Host "Inserted ALLOWED_ORIGINS into $lambda" }

# Find Authorization placeholder occurrences and replace based on nearby context
$pattern = '"Authorization"\s*:\s*f"\*{6}"'
$matches = Select-String -Path $lambda -Pattern $pattern -AllMatches

if ($matches.Count -eq 0) { Write-Host "No Authorization placeholders found in $lambda" }

foreach ($m in $matches) {
    $ln = $m.LineNumber - 1 # zero-based
    # inspect up to 8 lines above for context
    $context = ''
    $start = [Math]::Max(0, $ln - 8)
    $end = [Math]::Min($lines.Count - 1, $ln + 2)
    for ($j = $start; $j -le $end; $j++) { $context += "`n" + $lines[$j] }

    $replacement = '"Authorization": f"Bearer {WA_ACCESS_TOKEN}"'
    if ($context -match 'WA_PHONE_NUMBER_ID') {
        $replacement = '"Authorization": f"Bearer {WA_ACCESS_TOKEN}"'
    } elseif ($context -match 'INSTAGRAM_PAGE_ID|ig_id') {
        $replacement = '"Authorization": f"Bearer {INSTAGRAM_ACCESS_TOKEN}"'
    } elseif ($context -match '/me/messages' -or $context -match 'facebook.com/.*/me/messages') {
        $replacement = '"Authorization": f"Bearer {PAGE_ACCESS_TOKEN}"'
    } elseif ($context -match 'openrouter' -or $context -match 'openrouter.ai') {
        $replacement = '"Authorization": f"Bearer {OPENROUTER_API_KEY}"'
    } elseif ($context -match 'Zoho-oauthtoken') {
        # leave zoho ones alone (they were already correct)
        continue
    } else {
        # default to WA token to avoid leaving placeholder
        $replacement = '"Authorization": f"Bearer {WA_ACCESS_TOKEN}"'
    }

    # Replace only the specific line
    $origLine = $lines[$ln]
    $newLine = $origLine -replace $pattern, $replacement
    if ($origLine -ne $newLine) {
        $lines[$ln] = $newLine
        Write-Host "Replaced Authorization at line $($ln+1) -> $replacement"
    } else {
        Write-Host "Skipped line $($ln+1); no change made"
    }
}

# Write back lambda file
Set-Content -Path $lambda -Value $lines -Encoding UTF8
Write-Host "Updated $lambda (review backup: $lbak)"

# Fix advanced_features.py malformed Request call if present
if (Test-Path $adv) {
    $atext = Get-Content $adv -Raw
    $malformed = 'headers={"Content-Type": "application/json", "Authorization": f"\*{6}"},' # literal sequence
    if ($atext -match 'Authorization": f"\*{6}"') {
        Write-Host "Fixing malformed request call and Authorization in $adv"
        # Replace the inline headers with proper headers and Bearer token
        $atext = $atext -replace 'req = urllib.request.Request\\n\s*url,\\n\s*data=json.dumps\(payload, default=str\)\.encode\("utf-8"\),\\n\s*headers=\{"Content-Type": "application/json", "Authorization": f"\*{6}"\},\\n\s*method="POST",\\n\s*\)', 'data = json.dumps(payload, default=str).encode("utf-8")\n    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {WA_ACCESS_TOKEN}"}\n    req = urllib.request.Request(url, data=data, headers=headers, method="POST")'
        # Also try to catch simpler inline headers forms
        $atext = $atext -replace '"Authorization": f"\*{6}"', '"Authorization": f"Bearer {WA_ACCESS_TOKEN}"'
        Set-Content -Path $adv -Value $atext -Encoding UTF8
        Write-Host "Updated $adv (review backup: $abak)"
    } else {
        Write-Host "No malformed Authorization usage found in $adv"
    }
}

# Optionally run python compile on all .py files
$python = Get-Command python -ErrorAction SilentlyContinue
if ($python) {
    Write-Host "Running python -m py_compile on all .py files..."
    $pyfiles = Get-ChildItem -Path . -Recurse -Filter *.py | Select-Object -ExpandProperty FullName
    foreach ($f in $pyfiles) {
        Write-Host "Compiling $f"
        & python -m py_compile $f 2>&1 | ForEach-Object { Write-Host $_ }
    }
} else {
    Write-Host "Python not found in PATH; skipping py_compile step"
}

# Optionally run svgo if available to check Icons folder
$svgo = Get-Command svgo -ErrorAction SilentlyContinue
if ($svgo -and (Test-Path "Icons")) {
    Write-Host "Running svgo --check on Icons (will not overwrite files). Install svgo to auto-optimize."
    # run svgo with --verbose to list potential changes
    & svgo --pretty --multipass -f Icons 2>&1 | ForEach-Object { Write-Host $_ }
} else {
    Write-Host "svgo not found or Icons folder missing; skipping svgo step"
}

Write-Host "Done. Please review changed files and run your test suite / linters locally before committing."
