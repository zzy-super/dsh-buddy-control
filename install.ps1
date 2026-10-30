# Repairs this plugin's own install so other people can get it working.
#
# The one failure that no tool can report: the plugin directory is a linked
# checkout, Node resolves the REAL path, so `import '@deepseek-ai/dsh-tools'`
# has to resolve from the checkout itself. Without this link the row fails to
# activate and none of the buddy_* tools ever appear.
#
# Idempotent. `-Check` only inspects and never writes.
[CmdletBinding()]
param(
    [switch]$Check
)

$ErrorActionPreference = 'Stop'

$pkg = $PSScriptRoot
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$sharedRoot = Join-Path $dshHome 'profiles\node_modules\@deepseek-ai'
$sharedTools = Join-Path $sharedRoot 'dsh-tools'
$linkParent = Join-Path $pkg 'node_modules\@deepseek-ai'
$link = Join-Path $linkParent 'dsh-tools'
$skillSource = Join-Path $pkg 'skills\buddy-control\SKILL.md'
$skillTarget = Join-Path $dshHome 'skills\buddy-control\SKILL.md'
$ok = $true

function Write-Step($status, $text) {
    $colour = switch ($status) {
        'ok' { 'Green' }
        'fix' { 'Cyan' }
        'warn' { 'Yellow' }
        'bad' { 'Red' }
        default { 'Gray' }
    }
    Write-Host ("  [{0,-4}] {1}" -f $status, $text) -ForegroundColor $colour
}

Write-Host "dsh-buddy-control install check" -ForegroundColor Cyan
Write-Host "  package: $pkg"
Write-Host "  dsh home: $dshHome"
Write-Host ''

if (-not (Test-Path (Join-Path $pkg 'index.js'))) {
    Write-Step 'bad' "index.js not found next to this script"
    exit 1
}
Write-Step 'ok' 'index.js present'

if (-not (Test-Path $sharedTools)) {
    Write-Step 'bad' "shared dependency not found: $sharedTools"
    Write-Host '        DSH is probably installed elsewhere. Set DSH_HOME and retry, e.g.' -ForegroundColor Yellow
    Write-Host '        $env:DSH_HOME = ''C:\Users\you\.dsh''; .\install.ps1' -ForegroundColor Yellow
    exit 1
}
Write-Step 'ok' "shared dependency: $sharedTools"

# Recreate the directory junction. A junction (not a copy) keeps `node --check`
# and profile reload cheap while surviving pnpm re-installs of the profile.
$linked = $false
if (Test-Path $link) {
    try {
        $resolved = (Get-Item $link -Force).Target
        if (Test-Path (Join-Path $link 'lib\index.js')) { $linked = $true }
        Write-Step 'ok' "dependency link present -> $resolved"
    } catch {
        $linked = $false
    }
}

if (-not $linked) {
    if ($Check) {
        Write-Step 'bad' "dependency link missing: $link"
        $ok = $false
    } else {
        New-Item -ItemType Directory -Path $linkParent -Force | Out-Null
        # rmdir removes ONLY the junction; Remove-Item -Recurse would follow it
        # into the shared package and delete real files.
        if (Test-Path $link) { cmd /c rmdir "$link" | Out-Null }
        cmd /c mklink /J "$link" "$sharedTools" | Out-Null
        if (-not (Test-Path (Join-Path $link 'lib\index.js'))) {
            Write-Step 'bad' "junction creation failed: $link"
            exit 1
        }
        Write-Step 'fix' "dependency link created -> $sharedTools"
    }
}

if (Test-Path $skillSource) {
    $same = (Test-Path $skillTarget) -and ((Get-FileHash $skillSource).Hash -eq (Get-FileHash $skillTarget).Hash)
    if ($same) {
        Write-Step 'ok' 'skill up to date'
    } elseif ($Check) {
        Write-Step 'bad' "skill missing or stale: $skillTarget"
        $ok = $false
    } else {
        New-Item -ItemType Directory -Path (Split-Path $skillTarget) -Force | Out-Null
        Copy-Item $skillSource $skillTarget -Force
        Write-Step 'fix' "skill installed -> $skillTarget"
    }
} else {
    Write-Step 'warn' 'skills/buddy-control/SKILL.md not found in the package; skipped'
}

# The decisive check: can the module actually import with the resolution DSH uses?
if (-not $Check) {
    Push-Location $pkg
    try {
        $probe = & node -e "import('./index.js').then(m => console.log('TOOLS=' + (m.apply ? 'apply-ok' : 'no-apply'))).catch(e => { console.error(String(e.message)); process.exit(1) })" 2>&1
        if ($LASTEXITCODE -eq 0 -and "$probe" -match 'apply-ok') {
            Write-Step 'ok' 'index.js imports cleanly (dependency, syntax and exports all fine)'
        } else {
            Write-Step 'bad' "import probe failed: $probe"
            $ok = $false
        }
    } finally {
        Pop-Location
    }
}

Write-Host ''
if ($ok) {
    Write-Host 'Ready.' -ForegroundColor Green
    Write-Host 'Reload the plugin (Plugin Manager: disable then enable `buddy-control`), then call:' -ForegroundColor Gray
    Write-Host '  buddy_doctor    # diagnose this device' -ForegroundColor Gray
    Write-Host '  buddy_discover  # what is installed, where' -ForegroundColor Gray
    Write-Host '  buddy_deploy    # install what is missing, wire it up, verify' -ForegroundColor Gray
} else {
    Write-Host 'Problems remain — see TROUBLESHOOTING.md in this package.' -ForegroundColor Red
    exit 1
}
