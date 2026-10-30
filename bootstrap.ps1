# One-command install for a new machine.
#
#   irm https://raw.githubusercontent.com/zzy-super/dsh-buddy-control/main/bootstrap.ps1 | iex
#
# or, after downloading the archive:
#   powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1 -Source .
#
# Then enable the plugin once in DSH (Plugin Manager -> install_bundle this
# directory, or add the row to the profile patch), and call
#   buddy_deploy({ apply: true, acceptInstall: true })
[CmdletBinding()]
param(
    [string]$Source = 'https://github.com/zzy-super/dsh-buddy-control.git',
    [string]$Target = '',
    [switch]$Check
)

$ErrorActionPreference = 'Stop'

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
if (-not $Target) { $Target = Join-Path $dshHome 'local-plugins\dsh-buddy-control' }
$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) { $git = Get-Command (Join-Path 'C:\Program Files\Git\cmd' 'git.exe') -ErrorAction SilentlyContinue }

Write-Host "dsh-buddy-control bootstrap" -ForegroundColor Cyan
Write-Host "  source: $Source"
Write-Host "  target: $Target"
Write-Host ''

if ($Check) {
    Write-Host 'Check mode: nothing will be changed.' -ForegroundColor Yellow
    if (Test-Path (Join-Path $Target 'index.js')) { Write-Host '  plugin present' -ForegroundColor Green }
    else { Write-Host '  plugin not installed' -ForegroundColor Yellow }
    if ($git) { Write-Host "  git: $(& $git.Source --version)" -ForegroundColor Green }
    else { Write-Host '  git missing (install Git for Windows first)' -ForegroundColor Red }
    exit 0
}

# 1. Materialise the package.
if (Test-Path (Join-Path $Target 'index.js')) {
    Write-Host 'Plugin already present; refreshing in place.' -ForegroundColor Gray
    if ($git -and (Test-Path (Join-Path $Target '.git'))) {
        Push-Location $Target
        try { & $git.Source pull --ff-only 2>&1 | Select-Object -Last 3 } catch { Write-Host '  pull skipped' -ForegroundColor Yellow }
        finally { Pop-Location }
    }
} else {
    New-Item -ItemType Directory -Path (Split-Path $Target) -Force | Out-Null
    if (Test-Path $Source) {
        # Local directory (e.g. an extracted archive): copy it.
        New-Item -ItemType Directory -Path $Target -Force | Out-Null
        Copy-Item (Join-Path $Source '*') $Target -Recurse -Force
        Write-Host 'Copied from local source.' -ForegroundColor Gray
    } elseif ($git) {
        & $git.Source clone --depth 1 $Source $Target 2>&1 | Select-Object -Last 3
        if ($LASTEXITCODE -ne 0) { throw "git clone failed. Check network / URL, or download the archive and use -Source <dir>." }
        Write-Host 'Cloned.' -ForegroundColor Gray
    } else {
        throw 'git is not installed. Install Git for Windows, or download the archive and run: bootstrap.ps1 -Source <extracted-dir>'
    }
}

# 2. Fix the dependency link, install the skill, self-test.
$installer = Join-Path $Target 'install.ps1'
if (-not (Test-Path $installer)) { throw "install.ps1 missing from $Target" }
& powershell -NoProfile -ExecutionPolicy Bypass -File $installer
if ($LASTEXITCODE -ne 0) { throw 'install.ps1 reported a problem; see its output above.' }

Write-Host ''
Write-Host 'Next, enable the plugin once in DSH:' -ForegroundColor Cyan
Write-Host "  1. Plugin Manager -> install_bundle -> $Target"
Write-Host '  2. Restart DSH (or toggle the plugin off/on)'
Write-Host '  3. In a DSH session: buddy_doctor() then buddy_deploy({apply:true, acceptInstall:true})'
