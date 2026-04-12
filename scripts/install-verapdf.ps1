$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$vendorDir = Join-Path $root "modules\validator\vendor"
$zipPath = Join-Path $vendorDir "verapdf-pdfbox-installer.zip"
$extractDir = Join-Path $vendorDir "verapdf"
$appDir = Join-Path $extractDir "app"
$autoInstallPath = Join-Path $extractDir "auto-install.xml"

New-Item -ItemType Directory -Force -Path $vendorDir | Out-Null
New-Item -ItemType Directory -Force -Path $extractDir | Out-Null

if (-not (Test-Path $zipPath)) {
  Invoke-WebRequest -Uri "https://software.verapdf.org/releases/verapdf-pdfbox-installer.zip" -OutFile $zipPath
}

if (-not (Get-ChildItem -Path $extractDir -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "verapdf-pdfbox-*" })) {
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force
}

$installerDir = Get-ChildItem -Path $extractDir -Directory | Where-Object { $_.Name -like "verapdf-pdfbox-*" } | Select-Object -First 1
if (-not $installerDir) {
  throw "Unable to find extracted veraPDF installer directory."
}

$xml = @"
<AutomatedInstallation langpack="eng">
  <com.izforge.izpack.panels.htmlhello.HTMLHelloPanel id="welcome"/>
  <com.izforge.izpack.panels.target.TargetPanel id="install_dir">
    <installpath>$appDir</installpath>
  </com.izforge.izpack.panels.target.TargetPanel>
  <com.izforge.izpack.panels.packs.PacksPanel id="sdk_pack_select">
    <pack index="0" name="veraPDF GUI" selected="true"/>
    <pack index="1" name="veraPDF Batch files" selected="true"/>
    <pack index="2" name="veraPDF Validation model" selected="true"/>
  </com.izforge.izpack.panels.packs.PacksPanel>
  <com.izforge.izpack.panels.install.InstallPanel id="install"/>
  <com.izforge.izpack.panels.finish.FinishPanel id="finish"/>
</AutomatedInstallation>
"@

$xml | Set-Content -Encoding UTF8 $autoInstallPath

& (Join-Path $installerDir.FullName "verapdf-install.bat") $autoInstallPath

Write-Host "veraPDF installed at $appDir"
