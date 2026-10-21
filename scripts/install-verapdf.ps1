$ErrorActionPreference = "Stop"
# Keep the PowerShell entry point on the same pinned, verified installer.
& node (Join-Path $PSScriptRoot "install-verapdf.js")
if ($LASTEXITCODE -ne 0) { throw "veraPDF installation failed ($LASTEXITCODE)" }
