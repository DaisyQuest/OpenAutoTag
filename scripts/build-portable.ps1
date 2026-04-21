param(
  [string]$ConfigPath,
  [string]$OutputRoot,
  [switch]$NoZip,
  [switch]$Force,
  [switch]$SkipInstall,
  [switch]$SkipVeraPdf,
  [switch]$SkipFonts,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir ".."))
if (-not $ConfigPath) {
  $ConfigPath = Join-Path $RepoRoot "install_locations.cfg"
}

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message"
}

function Read-InstallConfig {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Configuration file not found: $Path"
  }

  $values = @{}
  $section = ""
  foreach ($rawLine in Get-Content -LiteralPath $Path) {
    $line = $rawLine.Trim()
    if ($line.Length -eq 0 -or $line.StartsWith("#") -or $line.StartsWith(";")) {
      continue
    }
    if ($line -match '^\[(.+)\]$') {
      $section = $Matches[1].Trim().ToLowerInvariant()
      continue
    }
    $equals = $line.IndexOf("=")
    if ($equals -lt 0) {
      continue
    }
    $name = $line.Substring(0, $equals).Trim().ToLowerInvariant()
    $value = $line.Substring($equals + 1).Trim()
    $values["$section.$name"] = [Environment]::ExpandEnvironmentVariables($value)
  }

  return $values
}

$Config = Read-InstallConfig -Path $ConfigPath

function Get-Cfg {
  param(
    [string]$Key,
    [string]$Default = ""
  )

  $normalized = $Key.ToLowerInvariant()
  if ($Config.ContainsKey($normalized) -and $Config[$normalized].Length -gt 0) {
    return $Config[$normalized]
  }
  return $Default
}

function Get-CfgBool {
  param(
    [string]$Key,
    [bool]$Default = $false
  )

  $raw = Get-Cfg -Key $Key -Default ""
  if ($raw.Length -eq 0) {
    return $Default
  }
  return @("1", "true", "yes", "on").Contains($raw.ToLowerInvariant())
}

function Resolve-RepoPath {
  param([string]$PathValue)

  if (-not $PathValue -or $PathValue.Trim().Length -eq 0) {
    return ""
  }
  if ([System.IO.Path]::IsPathRooted($PathValue)) {
    return [System.IO.Path]::GetFullPath($PathValue)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $PathValue))
}

function New-Directory {
  param([string]$Path)

  if ($DryRun) {
    Write-Host "[dry-run] create directory $Path"
    return
  }
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

function Test-UnderPath {
  param(
    [string]$Child,
    [string]$Parent
  )

  $childFull = [System.IO.Path]::GetFullPath($Child).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  return $childFull.Equals($parentFull, [StringComparison]::OrdinalIgnoreCase) -or
    $childFull.StartsWith($parentFull + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
    $childFull.StartsWith($parentFull + [System.IO.Path]::AltDirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Remove-DirectorySafe {
  param(
    [string]$Path,
    [string]$AllowedRoot
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }
  if (-not (Test-UnderPath -Child $Path -Parent $AllowedRoot)) {
    throw "Refusing to remove $Path because it is outside $AllowedRoot"
  }
  if ($DryRun) {
    Write-Host "[dry-run] remove directory $Path"
    return
  }
  Remove-Item -LiteralPath $Path -Recurse -Force
}

function Get-OsKey {
  if ($env:OS -eq "Windows_NT") {
    return "windows"
  }
  $uname = ""
  try {
    $uname = (& uname -s).Trim().ToLowerInvariant()
  } catch {
    $uname = ""
  }
  if ($uname -eq "darwin") {
    return "macos"
  }
  return "linux"
}

function Get-ArchKey {
  $arch = ""
  try {
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  } catch {
    $arch = $env:PROCESSOR_ARCHITECTURE
    if (-not $arch) {
      $arch = ""
    }
    $arch = $arch.ToLowerInvariant()
  }
  if ($arch -match "arm64|aarch64") {
    return "arm64"
  }
  return "x64"
}

function Get-PlatformSuffix {
  param(
    [string]$OsKey,
    [string]$ArchKey
  )

  if ($OsKey -eq "windows") {
    return "win-$ArchKey.zip"
  }
  if ($OsKey -eq "macos") {
    return "darwin-$ArchKey.tar.gz"
  }
  return "linux-$ArchKey.tar.xz"
}

function Download-File {
  param(
    [string]$Url,
    [string]$Destination
  )

  if ((Test-Path -LiteralPath $Destination) -and -not $Force) {
    Write-Host "[skip] $Destination already exists"
    return
  }

  New-Directory -Path (Split-Path -Parent $Destination)
  if ($DryRun) {
    Write-Host "[dry-run] download $Url -> $Destination"
    return
  }

  $tmp = "$Destination.partial"
  if (Test-Path -LiteralPath $tmp) {
    Remove-Item -LiteralPath $tmp -Force
  }
  Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing
  Move-Item -LiteralPath $tmp -Destination $Destination -Force
}

function Get-UrlText {
  param([string]$Url)

  $response = Invoke-WebRequest -Uri $Url -UseBasicParsing
  return $response.Content
}

function Resolve-NodeArchive {
  param(
    [string]$BaseUrl,
    [string]$PlatformSuffix
  )

  $sumsUrl = "$($BaseUrl.TrimEnd('/'))/SHASUMS256.txt"
  $sums = Get-UrlText -Url $sumsUrl
  $escapedSuffix = [regex]::Escape($PlatformSuffix)
  foreach ($line in $sums -split "`n") {
    if ($line -match "^\s*([a-fA-F0-9]{64})\s+(node-v[^\s]+-$escapedSuffix)\s*$") {
      return @{
        Url = "$($BaseUrl.TrimEnd('/'))/$($Matches[2])"
        FileName = $Matches[2]
        Sha256 = $Matches[1].ToLowerInvariant()
      }
    }
  }
  throw "Unable to find Node archive for $PlatformSuffix in $sumsUrl"
}

function Assert-Sha256 {
  param(
    [string]$Path,
    [string]$Expected
  )

  if (-not $Expected) {
    return
  }
  if ($DryRun) {
    Write-Host "[dry-run] verify SHA-256 for $Path"
    return
  }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) {
    throw "SHA-256 mismatch for $Path. Expected $Expected, got $actual"
  }
}

function Expand-ArchivePortable {
  param(
    [string]$ArchivePath,
    [string]$Destination
  )

  New-Directory -Path $Destination
  if ($DryRun) {
    Write-Host "[dry-run] extract $ArchivePath -> $Destination"
    return
  }

  if ($ArchivePath.EndsWith(".zip", [StringComparison]::OrdinalIgnoreCase)) {
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $Destination -Force
    return
  }

  & tar -xf $ArchivePath -C $Destination
  if ($LASTEXITCODE -ne 0) {
    throw "tar failed while extracting $ArchivePath"
  }
}

function Get-SingleExtractedDirectory {
  param([string]$Path)

  $dirs = @(Get-ChildItem -LiteralPath $Path -Directory | Select-Object -First 2)
  if ($dirs.Count -eq 1) {
    return $dirs[0].FullName
  }
  return $Path
}

function Copy-DirectoryContent {
  param(
    [string]$Source,
    [string]$Destination
  )

  New-Directory -Path $Destination
  if ($DryRun) {
    Write-Host "[dry-run] copy $Source -> $Destination"
    return
  }
  Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
  }
}

function Find-JavaHome {
  param([string]$Root)

  $javaName = if ($env:OS -eq "Windows_NT") { "java.exe" } else { "java" }
  $javacName = if ($env:OS -eq "Windows_NT") { "javac.exe" } else { "javac" }

  $candidates = @($Root)
  if (Test-Path -LiteralPath $Root) {
    $candidates += Get-ChildItem -LiteralPath $Root -Directory -Recurse -Depth 4 |
      ForEach-Object { $_.FullName }
  }

  foreach ($candidate in $candidates) {
    if (
      (Test-Path -LiteralPath (Join-Path $candidate "bin/$javaName")) -and
      (Test-Path -LiteralPath (Join-Path $candidate "bin/$javacName"))
    ) {
      return $candidate
    }
  }
  return ""
}

function Ensure-PortableNode {
  param(
    [string]$BootstrapRoot,
    [string]$OsKey,
    [string]$ArchKey
  )

  Write-Step "Preparing portable Node runtime"
  $nodeRoot = Join-Path $BootstrapRoot "node"
  $downloadsRoot = Join-Path $BootstrapRoot "downloads"
  New-Directory -Path $nodeRoot
  New-Directory -Path $downloadsRoot

  $platformConfigKey = "node_engine.$($OsKey)_$($ArchKey)_archive"
  $archiveUrl = Get-Cfg -Key $platformConfigKey
  if ($archiveUrl) {
    $archiveInfo = @{
      Url = $archiveUrl
      FileName = Split-Path -Leaf ([Uri]$archiveUrl).AbsolutePath
      Sha256 = ""
    }
  } elseif ($DryRun) {
    $baseUrl = Get-Cfg -Key "node_engine.base_url" -Default "https://nodejs.org/dist/latest-v22.x"
    $platformSuffix = Get-PlatformSuffix -OsKey $OsKey -ArchKey $ArchKey
    Write-Host "[dry-run] resolve Node archive for $platformSuffix from $baseUrl/SHASUMS256.txt"
    return @{
      Root = "<portable-node-root>"
      Node = "<portable-node>"
      Npm = "<portable-npm>"
    }
  } else {
    $baseUrl = Get-Cfg -Key "node_engine.base_url" -Default "https://nodejs.org/dist/latest-v22.x"
    $platformSuffix = Get-PlatformSuffix -OsKey $OsKey -ArchKey $ArchKey
    $archiveInfo = Resolve-NodeArchive -BaseUrl $baseUrl -PlatformSuffix $platformSuffix
  }

  $archivePath = Join-Path $downloadsRoot $archiveInfo.FileName
  Download-File -Url $archiveInfo.Url -Destination $archivePath
  Assert-Sha256 -Path $archivePath -Expected $archiveInfo.Sha256

  $extractRoot = Join-Path $nodeRoot "extract"
  Remove-DirectorySafe -Path $extractRoot -AllowedRoot $nodeRoot
  Expand-ArchivePortable -ArchivePath $archivePath -Destination $extractRoot
  $extracted = Get-SingleExtractedDirectory -Path $extractRoot

  $finalRoot = Join-Path $nodeRoot "runtime"
  Remove-DirectorySafe -Path $finalRoot -AllowedRoot $nodeRoot
  if (-not $DryRun) {
    Move-Item -LiteralPath $extracted -Destination $finalRoot
    Remove-DirectorySafe -Path $extractRoot -AllowedRoot $nodeRoot
  }

  $nodePath = if ($OsKey -eq "windows") {
    Join-Path $finalRoot "node.exe"
  } else {
    Join-Path $finalRoot "bin/node"
  }
  $npmPath = if ($OsKey -eq "windows") {
    Join-Path $finalRoot "npm.cmd"
  } else {
    Join-Path $finalRoot "bin/npm"
  }

  return @{
    Root = $finalRoot
    Node = $nodePath
    Npm = $npmPath
  }
}

function Ensure-PortableJava {
  param(
    [string]$BootstrapRoot,
    [string]$OsKey,
    [string]$ArchKey
  )

  Write-Step "Preparing portable Java runtime"
  if (-not (Get-CfgBool -Key "java_runtime.bundle" -Default $true)) {
    Write-Host "[skip] java_runtime.bundle=false"
    return @{ Root = "" }
  }

  $configuredHome = Resolve-RepoPath (Get-Cfg -Key "java_runtime.home")
  if (-not $configuredHome) {
    $configuredHome = Resolve-RepoPath (Get-Cfg -Key "java_dependencies.java_home")
  }

  $javaRoot = Join-Path $BootstrapRoot "java"
  $downloadsRoot = Join-Path $BootstrapRoot "downloads"
  $finalRoot = Join-Path $javaRoot "runtime"
  New-Directory -Path $javaRoot
  New-Directory -Path $downloadsRoot

  if ($configuredHome) {
    $sourceHome = Find-JavaHome -Root $configuredHome
    if (-not $sourceHome) {
      throw "Configured Java runtime does not contain java and javac under bin: $configuredHome"
    }
    Remove-DirectorySafe -Path $finalRoot -AllowedRoot $javaRoot
    if ($DryRun) {
      Write-Host "[dry-run] copy Java runtime $sourceHome -> $finalRoot"
    } else {
      Copy-Item -LiteralPath $sourceHome -Destination $finalRoot -Recurse -Force
    }
    return @{ Root = $finalRoot }
  }

  $url = Get-Cfg -Key "java_runtime.$($OsKey)_$($ArchKey)_url"
  if (-not $url) {
    throw "No Java runtime URL configured for $OsKey/$ArchKey"
  }

  $archiveName = if ($url -match "windows") { "jdk-21-$OsKey-$ArchKey.zip" } else { "jdk-21-$OsKey-$ArchKey.tar.gz" }
  $archivePath = Join-Path $downloadsRoot $archiveName
  Download-File -Url $url -Destination $archivePath

  $extractRoot = Join-Path $javaRoot "extract"
  Remove-DirectorySafe -Path $extractRoot -AllowedRoot $javaRoot
  Expand-ArchivePortable -ArchivePath $archivePath -Destination $extractRoot
  $sourceJavaHome = if ($DryRun) { "<portable-java-root>" } else { Find-JavaHome -Root $extractRoot }
  if (-not $sourceJavaHome) {
    throw "Unable to locate Java home in $extractRoot"
  }

  Remove-DirectorySafe -Path $finalRoot -AllowedRoot $javaRoot
  if (-not $DryRun) {
    Move-Item -LiteralPath $sourceJavaHome -Destination $finalRoot
    Remove-DirectorySafe -Path $extractRoot -AllowedRoot $javaRoot
  }
  return @{ Root = $finalRoot }
}

function Copy-AppSource {
  param([string]$AppRoot)

  Write-Step "Copying application source"
  New-Directory -Path $AppRoot

  $files = @(
    "package.json",
    "package-lock.json",
    "README.md",
    "install_locations.cfg"
  )
  $dirs = @(
    "contracts",
    "modules",
    "orchestrator",
    "scripts"
  )

  if ($DryRun) {
    foreach ($file in $files) {
      Write-Host "[dry-run] copy $file"
    }
    foreach ($dir in $dirs) {
      Write-Host "[dry-run] copy $dir"
    }
    return
  }

  foreach ($file in $files) {
    Copy-Item -LiteralPath (Join-Path $RepoRoot $file) -Destination (Join-Path $AppRoot $file) -Force
  }

  foreach ($dir in $dirs) {
    $src = Join-Path $RepoRoot $dir
    $dst = Join-Path $AppRoot $dir
    Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
  }

  $removeRelativePaths = @(
    "modules/validator/vendor/verapdf",
    "modules/validator/vendor/verapdf-pdfbox-installer.zip",
    "modules/validator/vendor/java",
    "modules/font-embedder/vendor/fonts/noto-sans-cjk",
    "modules/parser/.cache",
    "scripts/.build"
  )
  foreach ($relativePath in $removeRelativePaths) {
    Remove-Item -LiteralPath (Join-Path $AppRoot $relativePath) -Recurse -Force -ErrorAction SilentlyContinue
  }

  Get-ChildItem -LiteralPath $AppRoot -Directory -Recurse -Force |
    Where-Object { $_.Name -in @(".build", ".cache", "test") } |
    Sort-Object FullName -Descending |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}

function Invoke-External {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$WorkingDirectory,
    [hashtable]$Environment = @{}
  )

  Write-Host "$FilePath $($Arguments -join ' ')"
  if ($DryRun) {
    Write-Host "[dry-run] working directory: $WorkingDirectory"
    if ($Environment.Count -gt 0) {
      Write-Host "[dry-run] environment overrides: $($Environment.Keys -join ', ')"
    }
    return
  }

  $old = @{}
  foreach ($key in $Environment.Keys) {
    $old[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
    [Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], "Process")
  }

  $pushedLocation = $false
  try {
    Push-Location $WorkingDirectory
    $pushedLocation = $true
    & $FilePath @Arguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
      throw "Command failed with exit code $exitCode`: $FilePath $($Arguments -join ' ')"
    }
  } finally {
    if ($pushedLocation) {
      Pop-Location
    }
    foreach ($key in $Environment.Keys) {
      [Environment]::SetEnvironmentVariable($key, $old[$key], "Process")
    }
  }
}

function Install-AppDependencies {
  param(
    [string]$AppRoot,
    [hashtable]$NodeTools,
    [hashtable]$JavaTools
  )

  if ($SkipInstall) {
    Write-Step "Skipping portable dependency install"
    return
  }

  Write-Step "Installing portable node_modules"
  $registry = Get-Cfg -Key "node_modules.registry" -Default "https://registry.npmjs.org/"
  $npmCommand = Get-Cfg -Key "node_modules.npm_command" -Default "ci"
  $envMap = @{
    "npm_config_registry" = $registry
    "PATH" = "$(Split-Path -Parent $NodeTools.Node)$([System.IO.Path]::PathSeparator)$env:PATH"
  }
  if ($JavaTools.Root) {
    $envMap["JAVA_HOME"] = $JavaTools.Root
    $envMap["PIPELINE_JAVA_HOME"] = $JavaTools.Root
    $envMap["VALIDATOR_JAVA_HOME"] = $JavaTools.Root
    $envMap["PATH"] = "$(Join-Path $JavaTools.Root "bin")$([System.IO.Path]::PathSeparator)$($envMap["PATH"])"
  }

  Invoke-External -FilePath $NodeTools.Npm -Arguments @($npmCommand, "--registry", $registry) -WorkingDirectory $AppRoot -Environment $envMap

  if (-not $SkipVeraPdf) {
    Write-Step "Installing portable veraPDF"
    $urls = @(
      Get-Cfg -Key "verapdf.installer_url" -Default "https://software.verapdf.org/releases/1.28/verapdf-pdfbox-1.28.2-installer.zip"
      Get-Cfg -Key "verapdf.fallback_url" -Default "https://software.verapdf.org/releases/verapdf-pdfbox-installer.zip"
    ) | Where-Object { $_ -and $_.Length -gt 0 }
    $envMap["VERAPDF_INSTALLER_URLS"] = ($urls -join ",")
    Invoke-External -FilePath $NodeTools.Node -Arguments @("scripts/install-verapdf.js") -WorkingDirectory $AppRoot -Environment $envMap
  }

  if (-not $SkipFonts) {
    Write-Step "Installing portable CJK fallback fonts"
    $envMap["OPENAUTOTAG_NOTO_CJK_BASE_URL"] = Get-Cfg -Key "fonts.noto_cjk_base_url" -Default "https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF"
    $envMap["OPENAUTOTAG_NOTO_CJK_LICENSE_URL"] = Get-Cfg -Key "fonts.noto_cjk_license_url" -Default "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/LICENSE"
    Invoke-External -FilePath $NodeTools.Node -Arguments @("scripts/install-fonts.js") -WorkingDirectory $AppRoot -Environment $envMap
  }
}

function Write-PortableLaunchers {
  param(
    [string]$PackageRoot,
    [string]$OsKey,
    [string]$Port
  )

  Write-Step "Writing portable launchers"
  $bat = @(
    "@echo off"
    "setlocal"
    "set `"OPENAUTOTAG_ROOT=%~dp0`""
    "set `"OPENAUTOTAG_APP_ROOT=%OPENAUTOTAG_ROOT%app`""
    "set `"OPENAUTOTAG_NODE_HOME=%OPENAUTOTAG_ROOT%runtime\node`""
    "set `"JAVA_HOME=%OPENAUTOTAG_ROOT%runtime\java`""
    "set `"PIPELINE_JAVA_HOME=%JAVA_HOME%`""
    "set `"VALIDATOR_JAVA_HOME=%JAVA_HOME%`""
    "set `"PIPELINE_JAVA_PATH=%JAVA_HOME%\bin\java.exe`""
    "set `"PIPELINE_JAVAC_PATH=%JAVA_HOME%\bin\javac.exe`""
    "set `"VALIDATOR_JAVA_PATH=%JAVA_HOME%\bin\java.exe`""
    "set `"VALIDATOR_JAVAC_PATH=%JAVA_HOME%\bin\javac.exe`""
    "set `"PIPELINE_DATA_ROOT=%OPENAUTOTAG_ROOT%data`""
    "set `"APP_RUNTIME_ROOT=%OPENAUTOTAG_ROOT%data`""
    "set `"VERAPDF_PATH=%OPENAUTOTAG_APP_ROOT%\modules\validator\vendor\verapdf\app\verapdf.bat`""
    "set `"PATH=%OPENAUTOTAG_NODE_HOME%;%JAVA_HOME%\bin;%PATH%`""
    "if `"%PORT%`"==`"`" set `"PORT=$Port`""
  )

  $startBat = $bat + @(
    "echo OpenAutoTag is starting on http://127.0.0.1:%PORT%/"
    "cd /d `"%OPENAUTOTAG_APP_ROOT%`""
    "`"%OPENAUTOTAG_NODE_HOME%\node.exe`" orchestrator\server.js"
  )

  $cliBat = $bat + @(
    "if `"%~1`"==`"`" ("
    "  echo Usage: process-pdf.bat C:\path\file.pdf [output-dir]"
    "  exit /b 2"
    ")"
    "set `"OUT=%~2`""
    "if `"%OUT%`"==`"`" set `"OUT=%OPENAUTOTAG_ROOT%data\manual-runs\%~n1`""
    "mkdir `"%OUT%`" 2>nul"
    "cd /d `"%OPENAUTOTAG_APP_ROOT%`""
    "`"%OPENAUTOTAG_NODE_HOME%\node.exe`" orchestrator\pipeline-runner.js --pdf `"%~1`" --output-dir `"%OUT%`""
  )

  $sh = @(
    "#!/usr/bin/env sh"
    "set -eu"
    'OPENAUTOTAG_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"'
    'OPENAUTOTAG_APP_ROOT="$OPENAUTOTAG_ROOT/app"'
    'OPENAUTOTAG_NODE_HOME="$OPENAUTOTAG_ROOT/runtime/node"'
    'JAVA_HOME="$OPENAUTOTAG_ROOT/runtime/java"'
    'export JAVA_HOME'
    'export PIPELINE_JAVA_HOME="$JAVA_HOME"'
    'export VALIDATOR_JAVA_HOME="$JAVA_HOME"'
    'export PIPELINE_JAVA_PATH="$JAVA_HOME/bin/java"'
    'export PIPELINE_JAVAC_PATH="$JAVA_HOME/bin/javac"'
    'export VALIDATOR_JAVA_PATH="$JAVA_HOME/bin/java"'
    'export VALIDATOR_JAVAC_PATH="$JAVA_HOME/bin/javac"'
    'export PIPELINE_DATA_ROOT="$OPENAUTOTAG_ROOT/data"'
    'export APP_RUNTIME_ROOT="$OPENAUTOTAG_ROOT/data"'
    'export VERAPDF_PATH="$OPENAUTOTAG_APP_ROOT/modules/validator/vendor/verapdf/app/verapdf"'
    'export PATH="$OPENAUTOTAG_NODE_HOME/bin:$JAVA_HOME/bin:$PATH"'
    "PORT=`"${PORT:-$Port}`""
    "export PORT"
  )

  $startSh = $sh + @(
    'echo "OpenAutoTag is starting on http://127.0.0.1:$PORT/"'
    'cd "$OPENAUTOTAG_APP_ROOT"'
    'exec "$OPENAUTOTAG_NODE_HOME/bin/node" orchestrator/server.js'
  )

  $cliSh = $sh + @(
    'if [ "$#" -lt 1 ]; then'
    '  echo "Usage: ./process-pdf.sh /path/file.pdf [output-dir]"'
    '  exit 2'
    'fi'
    'INPUT="$1"'
    'OUT="${2:-$OPENAUTOTAG_ROOT/data/manual-runs/$(basename "$INPUT" .pdf)}"'
    'mkdir -p "$OUT"'
    'cd "$OPENAUTOTAG_APP_ROOT"'
    'exec "$OPENAUTOTAG_NODE_HOME/bin/node" orchestrator/pipeline-runner.js --pdf "$INPUT" --output-dir "$OUT"'
  )

  if ($DryRun) {
    Write-Host "[dry-run] write launchers under $PackageRoot"
    return
  }

  Set-Content -LiteralPath (Join-Path $PackageRoot "start.bat") -Value $startBat -Encoding ASCII
  Set-Content -LiteralPath (Join-Path $PackageRoot "process-pdf.bat") -Value $cliBat -Encoding ASCII
  Set-Content -LiteralPath (Join-Path $PackageRoot "start.sh") -Value $startSh -Encoding ASCII
  Set-Content -LiteralPath (Join-Path $PackageRoot "process-pdf.sh") -Value $cliSh -Encoding ASCII
}

function Write-PortableReadme {
  param(
    [string]$PackageRoot,
    [string]$PackageName,
    [string]$OsKey,
    [string]$ArchKey,
    [string]$Port
  )

  $readme = @'
# OpenAutoTag Portable

This folder is a self-contained OpenAutoTag runtime for __OS_KEY__/__ARCH_KEY__.
It does not require TomEE, system Node.js, npm, or system Java.

## Start the Dashboard

Windows:

```bat
start.bat
```

Linux/macOS:

```sh
chmod +x ./start.sh ./process-pdf.sh
./start.sh
```

Then open:

```text
http://127.0.0.1:__PORT__/
```

Override the port by setting `PORT` before launching.

## Process One PDF From The Command Line

Windows:

```bat
process-pdf.bat C:\path\document.pdf
```

Linux/macOS:

```sh
./process-pdf.sh /path/document.pdf
```

Job data and manual-run output are written under `data/` next to these launchers.

## Contents

- `app/`: OpenAutoTag application source and `node_modules`.
- `runtime/node/`: bundled Node.js runtime.
- `runtime/java/`: bundled JDK used by PDFBox, helper compilers, and veraPDF.
- `data/`: writable runtime data, created by the launchers.
'@
  $readme = $readme.Replace("__OS_KEY__", $OsKey).Replace("__ARCH_KEY__", $ArchKey).Replace("__PORT__", $Port)

  if ($DryRun) {
    Write-Host "[dry-run] write portable README"
    return
  }
  Set-Content -LiteralPath (Join-Path $PackageRoot "README_PORTABLE.md") -Value $readme -Encoding ASCII
}

function Compress-PortablePackage {
  param(
    [string]$PackageRoot,
    [string]$StagingRoot,
    [string]$PackageName
  )

  if ($NoZip -or -not (Get-CfgBool -Key "portable.zip" -Default $true)) {
    return
  }

  Write-Step "Creating portable zip"
  $zipPath = Join-Path $StagingRoot "$PackageName.zip"
  if ($DryRun) {
    Write-Host "[dry-run] zip $PackageRoot -> $zipPath"
    return
  }
  Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
  Compress-Archive -LiteralPath $PackageRoot -DestinationPath $zipPath -Force
  Write-Host "[ok] $zipPath"
}

$osKey = Get-OsKey
$archKey = Get-ArchKey
$bootstrapRoot = Resolve-RepoPath (Get-Cfg -Key "portable.bootstrap_root" -Default ".portable-bootstrap")
$stagingRoot = if ($OutputRoot) {
  Resolve-RepoPath $OutputRoot
} else {
  Resolve-RepoPath (Get-Cfg -Key "portable.staging_root" -Default "dist/portable")
}
$packageBaseName = Get-Cfg -Key "portable.package_name" -Default "OpenAutoTag-portable"
$packageName = "$packageBaseName-$osKey-$archKey"
$packageRoot = Join-Path $stagingRoot $packageName
$appRoot = Join-Path $packageRoot "app"
$runtimeRoot = Join-Path $packageRoot "runtime"
$port = Get-Cfg -Key "portable.port" -Default "3001"

Write-Host "OpenAutoTag portable package builder"
Write-Host "Repository: $RepoRoot"
Write-Host "Config:     $ConfigPath"
Write-Host "Target:     $osKey/$archKey"
Write-Host "Output:     $packageRoot"

New-Directory -Path $bootstrapRoot
New-Directory -Path $stagingRoot
Remove-DirectorySafe -Path $packageRoot -AllowedRoot $stagingRoot
New-Directory -Path $packageRoot
New-Directory -Path $runtimeRoot
New-Directory -Path (Join-Path $packageRoot "data")

$nodeTools = Ensure-PortableNode -BootstrapRoot $bootstrapRoot -OsKey $osKey -ArchKey $archKey
$javaTools = Ensure-PortableJava -BootstrapRoot $bootstrapRoot -OsKey $osKey -ArchKey $archKey

Copy-AppSource -AppRoot $appRoot
Copy-DirectoryContent -Source $nodeTools.Root -Destination (Join-Path $runtimeRoot "node")
if ($javaTools.Root) {
  Copy-DirectoryContent -Source $javaTools.Root -Destination (Join-Path $runtimeRoot "java")
}

$portableNode = if ($osKey -eq "windows") {
  Join-Path $runtimeRoot "node/node.exe"
} else {
  Join-Path $runtimeRoot "node/bin/node"
}
$portableNpm = if ($osKey -eq "windows") {
  Join-Path $runtimeRoot "node/npm.cmd"
} else {
  Join-Path $runtimeRoot "node/bin/npm"
}

Install-AppDependencies -AppRoot $appRoot -NodeTools @{ Node = $portableNode; Npm = $portableNpm } -JavaTools @{ Root = (Join-Path $runtimeRoot "java") }
Write-PortableLaunchers -PackageRoot $packageRoot -OsKey $osKey -Port $port
Write-PortableReadme -PackageRoot $packageRoot -PackageName $packageName -OsKey $osKey -ArchKey $archKey -Port $port
Compress-PortablePackage -PackageRoot $packageRoot -StagingRoot $stagingRoot -PackageName $packageName

Write-Host ""
Write-Host "Portable package ready at $packageRoot"
