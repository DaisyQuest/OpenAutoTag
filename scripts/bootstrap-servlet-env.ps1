param(
  [string]$ConfigPath,
  [switch]$DryRun,
  [switch]$Force,
  [switch]$SkipNode,
  [switch]$SkipNodeModules,
  [switch]$SkipVeraPdf,
  [switch]$SkipFonts,
  [switch]$SkipJavaDeps,
  [switch]$BuildWar
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

function New-Directory {
  param([string]$Path)

  if ($DryRun) {
    Write-Host "[dry-run] create directory $Path"
    return
  }
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
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

function Test-NodeMajor {
  param(
    [string]$NodePath,
    [int]$RequiredMajor
  )

  if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath)) {
    return $false
  }

  try {
    $version = (& $NodePath --version 2>$null).Trim()
  } catch {
    return $false
  }
  if ($LASTEXITCODE -ne 0) {
    return $false
  }
  return $version -match '^v?([0-9]+)\.' -and [int]$Matches[1] -eq $RequiredMajor
}

function Find-SystemNode {
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }
  return ""
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

  $parent = Split-Path -Parent $Destination
  New-Directory -Path $parent
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

function Expand-NodeArchive {
  param(
    [string]$ArchivePath,
    [string]$NodeRoot,
    [string]$InstallRoot
  )

  $extractRoot = Join-Path $NodeRoot "_extract"
  Remove-DirectorySafe -Path $extractRoot -AllowedRoot $NodeRoot
  New-Directory -Path $extractRoot

  if ($DryRun) {
    Write-Host "[dry-run] extract $ArchivePath -> $NodeRoot"
    return ""
  }

  if ($ArchivePath.EndsWith(".zip", [StringComparison]::OrdinalIgnoreCase)) {
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $extractRoot -Force
  } else {
    & tar -xf $ArchivePath -C $extractRoot
    if ($LASTEXITCODE -ne 0) {
      throw "tar failed while extracting $ArchivePath"
    }
  }

  $nodeDir = Get-ChildItem -LiteralPath $extractRoot -Directory |
    Where-Object { $_.Name -like "node-v*" } |
    Select-Object -First 1
  if (-not $nodeDir) {
    throw "Unable to find extracted Node directory under $extractRoot"
  }

  $finalPath = Join-Path $NodeRoot $nodeDir.Name
  Remove-DirectorySafe -Path $finalPath -AllowedRoot $NodeRoot
  Move-Item -LiteralPath $nodeDir.FullName -Destination $finalPath
  Remove-DirectorySafe -Path $extractRoot -AllowedRoot $NodeRoot
  return $finalPath
}

function Find-ExistingLocalNode {
  param(
    [string]$NodeRoot,
    [int]$RequiredMajor
  )

  if (-not (Test-Path -LiteralPath $NodeRoot)) {
    return $null
  }

  $dirs = Get-ChildItem -LiteralPath $NodeRoot -Directory |
    Where-Object { $_.Name -like "node-v*" } |
    Sort-Object Name -Descending
  foreach ($dir in $dirs) {
    $candidate = if ($env:OS -eq "Windows_NT") {
      Join-Path $dir.FullName "node.exe"
    } else {
      Join-Path $dir.FullName "bin/node"
    }
    if (Test-NodeMajor -NodePath $candidate -RequiredMajor $RequiredMajor) {
      return $dir.FullName
    }
  }

  return $null
}

function Get-NodeTools {
  param(
    [string]$NodeDir,
    [string]$NodePath
  )

  $npmCandidates = @()
  if ($NodeDir) {
    $npmCandidates += Join-Path $NodeDir "npm.cmd"
    $npmCandidates += Join-Path $NodeDir "bin/npm"
  }
  $systemNpm = Get-Command npm -ErrorAction SilentlyContinue
  if ($systemNpm) {
    $npmCandidates += $systemNpm.Source
  }

  $npmPath = $npmCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if (-not $npmPath) {
    throw "Unable to find npm for Node executable $NodePath"
  }

  return @{
    Node = $NodePath
    NodeDir = $NodeDir
    Npm = $npmPath
  }
}

function Ensure-NodeEngine {
  if ($SkipNode) {
    Write-Step "Skipping Node engine"
    $node = Find-SystemNode
    return Get-NodeTools -NodeDir "" -NodePath $node
  }

  Write-Step "Preparing Node engine"
  $requiredMajor = [int](Get-Cfg -Key "node_engine.required_major" -Default "22")
  $explicitNode = Resolve-RepoPath (Get-Cfg -Key "node_engine.executable")
  if ($explicitNode -and (Test-NodeMajor -NodePath $explicitNode -RequiredMajor $requiredMajor)) {
    Write-Host "[ok] using configured Node: $explicitNode"
    return Get-NodeTools -NodeDir (Split-Path -Parent $explicitNode) -NodePath $explicitNode
  }

  $preferSystem = Get-CfgBool -Key "node_engine.prefer_system" -Default $true
  $systemNode = Find-SystemNode
  if ($preferSystem -and $systemNode -and (Test-NodeMajor -NodePath $systemNode -RequiredMajor $requiredMajor)) {
    Write-Host "[ok] using system Node: $systemNode"
    return Get-NodeTools -NodeDir (Split-Path -Parent $systemNode) -NodePath $systemNode
  }

  $installRoot = Resolve-RepoPath (Get-Cfg -Key "bootstrap.install_root" -Default ".servlet-bootstrap")
  $nodeRoot = Join-Path $installRoot "node"
  $downloadsRoot = Join-Path $installRoot "downloads"
  New-Directory -Path $nodeRoot
  New-Directory -Path $downloadsRoot

  $localNodeDir = Find-ExistingLocalNode -NodeRoot $nodeRoot -RequiredMajor $requiredMajor
  if ($localNodeDir -and -not $Force) {
    $nodePath = if ($env:OS -eq "Windows_NT") {
      Join-Path $localNodeDir "node.exe"
    } else {
      Join-Path $localNodeDir "bin/node"
    }
    Write-Host "[ok] using bootstrapped Node: $nodePath"
    return Get-NodeTools -NodeDir $localNodeDir -NodePath $nodePath
  }

  $osKey = Get-OsKey
  $archKey = Get-ArchKey
  $platformConfigKey = "node_engine.$($osKey)_$($archKey)_archive"
  $archiveUrl = Get-Cfg -Key $platformConfigKey
  $archiveInfo = $null
  if ($archiveUrl) {
    $archiveInfo = @{
      Url = $archiveUrl
      FileName = Split-Path -Leaf ([Uri]$archiveUrl).AbsolutePath
      Sha256 = ""
    }
  } elseif ($DryRun) {
    $baseUrl = Get-Cfg -Key "node_engine.base_url" -Default "https://nodejs.org/dist/latest-v22.x"
    $platformSuffix = Get-PlatformSuffix -OsKey $osKey -ArchKey $archKey
    Write-Host "[dry-run] resolve Node archive for $platformSuffix from $baseUrl/SHASUMS256.txt"
    return @{
      Node = "<resolved-node>"
      NodeDir = "<resolved-node-dir>"
      Npm = "<resolved-npm>"
    }
  } else {
    $baseUrl = Get-Cfg -Key "node_engine.base_url" -Default "https://nodejs.org/dist/latest-v22.x"
    $platformSuffix = Get-PlatformSuffix -OsKey $osKey -ArchKey $archKey
    $archiveInfo = Resolve-NodeArchive -BaseUrl $baseUrl -PlatformSuffix $platformSuffix
  }

  $archivePath = Join-Path $downloadsRoot $archiveInfo.FileName
  Download-File -Url $archiveInfo.Url -Destination $archivePath
  Assert-Sha256 -Path $archivePath -Expected $archiveInfo.Sha256
  $installedDir = Expand-NodeArchive -ArchivePath $archivePath -NodeRoot $nodeRoot -InstallRoot $installRoot
  $nodeExe = if ($env:OS -eq "Windows_NT") {
    Join-Path $installedDir "node.exe"
  } else {
    Join-Path $installedDir "bin/node"
  }
  if (-not (Test-NodeMajor -NodePath $nodeExe -RequiredMajor $requiredMajor)) {
    throw "Installed Node does not satisfy required major version $requiredMajor"
  }

  Write-Host "[ok] installed Node: $nodeExe"
  return Get-NodeTools -NodeDir $installedDir -NodePath $nodeExe
}

function Get-ToolEnvironment {
  param([hashtable]$NodeTools)

  $envMap = @{}
  $javaHome = Resolve-RepoPath (Get-Cfg -Key "java_dependencies.java_home")
  if (-not $javaHome) {
    $javaHome = $env:JAVA_HOME
  }
  if ($javaHome) {
    $envMap["JAVA_HOME"] = $javaHome
    $envMap["PIPELINE_JAVA_HOME"] = $javaHome
  }

  $pathParts = @()
  if ($NodeTools.NodeDir -and $NodeTools.NodeDir -notmatch "^<") {
    if ($env:OS -eq "Windows_NT") {
      $pathParts += $NodeTools.NodeDir
    } else {
      $pathParts += Join-Path $NodeTools.NodeDir "bin"
    }
  }
  if ($javaHome) {
    $pathParts += Join-Path $javaHome "bin"
  }
  if ($pathParts.Count -gt 0) {
    $envMap["PATH"] = ($pathParts -join [System.IO.Path]::PathSeparator) + [System.IO.Path]::PathSeparator + $env:PATH
  }

  return $envMap
}

function Invoke-External {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$WorkingDirectory = $RepoRoot,
    [hashtable]$Environment = @{}
  )

  $display = "$FilePath $($Arguments -join ' ')"
  Write-Host $display
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
      throw "Command failed with exit code $exitCode`: $display"
    }
  } catch {
    throw
  } finally {
    if ($pushedLocation) {
      Pop-Location
    }
    foreach ($key in $Environment.Keys) {
      [Environment]::SetEnvironmentVariable($key, $old[$key], "Process")
    }
  }
}

function Ensure-NodeModules {
  param([hashtable]$NodeTools)

  if ($SkipNodeModules) {
    Write-Step "Skipping node_modules"
    return
  }

  Write-Step "Installing node_modules as one dependency"
  $registry = Get-Cfg -Key "node_modules.registry" -Default "https://registry.npmjs.org/"
  $envMap = Get-ToolEnvironment -NodeTools $NodeTools
  $envMap["npm_config_registry"] = $registry
  Invoke-External -FilePath $NodeTools.Npm -Arguments @("ci", "--registry", $registry) -Environment $envMap
}

function Install-VeraPdf {
  param([hashtable]$NodeTools)

  $enabled = Get-CfgBool -Key "bootstrap.install_verapdf" -Default $true
  if ($SkipVeraPdf -or -not $enabled) {
    Write-Step "Skipping veraPDF"
    return
  }

  Write-Step "Installing veraPDF"
  $urls = @(
    Get-Cfg -Key "verapdf.installer_url" -Default "https://software.verapdf.org/releases/1.28/verapdf-pdfbox-1.28.2-installer.zip"
    Get-Cfg -Key "verapdf.fallback_url" -Default "https://software.verapdf.org/releases/verapdf-pdfbox-installer.zip"
  ) | Where-Object { $_ -and $_.Length -gt 0 }

  $envMap = Get-ToolEnvironment -NodeTools $NodeTools
  $envMap["VERAPDF_INSTALLER_URLS"] = ($urls -join ",")
  Invoke-External -FilePath $NodeTools.Node -Arguments @("scripts/install-verapdf.js") -Environment $envMap
}

function Install-Fonts {
  param([hashtable]$NodeTools)

  $enabled = Get-CfgBool -Key "bootstrap.install_fonts" -Default $true
  if ($SkipFonts -or -not $enabled) {
    Write-Step "Skipping CJK fallback fonts"
    return
  }

  Write-Step "Installing CJK fallback fonts"
  $envMap = Get-ToolEnvironment -NodeTools $NodeTools
  $envMap["OPENAUTOTAG_NOTO_CJK_BASE_URL"] = Get-Cfg -Key "fonts.noto_cjk_base_url" -Default "https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF"
  $envMap["OPENAUTOTAG_NOTO_CJK_LICENSE_URL"] = Get-Cfg -Key "fonts.noto_cjk_license_url" -Default "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/LICENSE"
  Invoke-External -FilePath $NodeTools.Node -Arguments @("scripts/install-fonts.js") -Environment $envMap
}

function Ensure-JavaDependencies {
  param([hashtable]$NodeTools)

  if ($SkipJavaDeps) {
    Write-Step "Skipping servlet Java dependencies"
    return
  }

  Write-Step "Resolving servlet Java dependencies"
  $buildTool = (Get-Cfg -Key "java_dependencies.build_tool" -Default "gradle").ToLowerInvariant()
  $mavenRepo = Get-Cfg -Key "java_dependencies.maven_repository" -Default "https://repo.maven.apache.org/maven2"
  $envMap = Get-ToolEnvironment -NodeTools $NodeTools
  $envMap["OPENAUTOTAG_MAVEN_REPOSITORY"] = $mavenRepo

  $gradleUserHome = Resolve-RepoPath (Get-Cfg -Key "java_dependencies.gradle_user_home" -Default ".servlet-bootstrap/gradle")
  if ($gradleUserHome) {
    New-Directory -Path $gradleUserHome
    $envMap["GRADLE_USER_HOME"] = $gradleUserHome
  }

  $shouldBuildWar = $BuildWar -or (Get-CfgBool -Key "bootstrap.build_war" -Default $false)
  if ($buildTool -eq "ant") {
    $ant = Get-Command ant -ErrorAction SilentlyContinue
    if (-not $ant) {
      if ($DryRun) {
        Write-Host "[dry-run] Ant was requested; a real run requires ant on PATH"
        return
      }
      throw "Ant was requested but was not found on PATH"
    }
    $target = if ($shouldBuildWar) { "war" } else { "download-dependencies" }
    Invoke-External -FilePath $ant.Source -Arguments @("-f", "servlet/build.xml", "-Dmaven.repo.url=$mavenRepo", $target) -Environment $envMap
    return
  }

  $gradle = Get-Command gradle -ErrorAction SilentlyContinue
  if (-not $gradle) {
    $ant = Get-Command ant -ErrorAction SilentlyContinue
    if ($ant) {
      Write-Host "[warn] Gradle not found; falling back to Ant"
      $target = if ($shouldBuildWar) { "war" } else { "download-dependencies" }
      Invoke-External -FilePath $ant.Source -Arguments @("-f", "servlet/build.xml", "-Dmaven.repo.url=$mavenRepo", $target) -Environment $envMap
      return
    }
    if ($DryRun) {
      Write-Host "[dry-run] a real run requires gradle or ant on PATH"
      return
    }
    throw "Neither Gradle nor Ant was found on PATH"
  }

  $gradleTasks = if ($shouldBuildWar) { @("test", "war") } else { @("downloadDependencies") }
  Invoke-External -FilePath $gradle.Source -Arguments (@("-p", "servlet", "-PmavenRepoUrl=$mavenRepo") + $gradleTasks) -Environment $envMap
}

function Convert-ToBatchPath {
  param([string]$PathValue)
  return $PathValue.Replace('"', '""')
}

function Convert-ToShValue {
  param([string]$Value)
  return "'" + $Value.Replace("'", "'\''") + "'"
}

function Write-SetEnvTemplates {
  param([hashtable]$NodeTools)

  Write-Step "Writing TomEE setenv templates"
  $installRoot = Resolve-RepoPath (Get-Cfg -Key "bootstrap.install_root" -Default ".servlet-bootstrap")
  $runtimeRoot = Resolve-RepoPath (Get-Cfg -Key "bootstrap.runtime_root" -Default ".servlet-runtime")
  New-Directory -Path $installRoot
  New-Directory -Path $runtimeRoot

  $javaHome = Resolve-RepoPath (Get-Cfg -Key "java_dependencies.java_home")
  if (-not $javaHome) {
    $javaHome = $env:JAVA_HOME
  }
  $veraPdfPath = if ($env:OS -eq "Windows_NT") {
    Join-Path $RepoRoot "modules/validator/vendor/verapdf/app/verapdf.bat"
  } else {
    Join-Path $RepoRoot "modules/validator/vendor/verapdf/app/verapdf"
  }

  $batPath = Join-Path $installRoot "tomee-setenv.bat"
  $shPath = Join-Path $installRoot "tomee-setenv.sh"

  $bat = @(
    "@echo off"
    "set `"BUILD_EVERYTHING_REPO_ROOT=$(Convert-ToBatchPath $RepoRoot)`""
    "set `"BUILD_EVERYTHING_NODE_PATH=$(Convert-ToBatchPath $NodeTools.Node)`""
    "set `"PIPELINE_DATA_ROOT=$(Convert-ToBatchPath $runtimeRoot)`""
    "set `"VERAPDF_PATH=$(Convert-ToBatchPath $veraPdfPath)`""
  )
  if ($javaHome) {
    $bat += "set `"JAVA_HOME=$(Convert-ToBatchPath $javaHome)`""
    $bat += "set `"PIPELINE_JAVA_HOME=%JAVA_HOME%`""
  }
  $bat += "set `"CATALINA_OPTS=%CATALINA_OPTS% -Xms512m -Xmx4g`""

  $sh = @(
    "#!/usr/bin/env sh"
    "export BUILD_EVERYTHING_REPO_ROOT=$(Convert-ToShValue $RepoRoot)"
    "export BUILD_EVERYTHING_NODE_PATH=$(Convert-ToShValue $NodeTools.Node)"
    "export PIPELINE_DATA_ROOT=$(Convert-ToShValue $runtimeRoot)"
    "export VERAPDF_PATH=$(Convert-ToShValue $veraPdfPath)"
  )
  if ($javaHome) {
    $sh += "export JAVA_HOME=$(Convert-ToShValue $javaHome)"
    $sh += 'export PIPELINE_JAVA_HOME="$JAVA_HOME"'
  }
  $sh += 'export CATALINA_OPTS="$CATALINA_OPTS -Xms512m -Xmx4g"'

  if ($DryRun) {
    Write-Host "[dry-run] write $batPath"
    Write-Host "[dry-run] write $shPath"
    return
  }

  Set-Content -LiteralPath $batPath -Value $bat -Encoding ASCII
  Set-Content -LiteralPath $shPath -Value $sh -Encoding ASCII
  Write-Host "[ok] $batPath"
  Write-Host "[ok] $shPath"
}

Write-Host "OpenAutoTag servlet bootstrap"
Write-Host "Repository: $RepoRoot"
Write-Host "Config:     $ConfigPath"

$nodeTools = Ensure-NodeEngine
Ensure-NodeModules -NodeTools $nodeTools
Install-VeraPdf -NodeTools $nodeTools
Install-Fonts -NodeTools $nodeTools
Ensure-JavaDependencies -NodeTools $nodeTools
Write-SetEnvTemplates -NodeTools $nodeTools

Write-Host ""
Write-Host "Servlet environment bootstrap complete."
Write-Host "TomEE setenv templates were written under $(Resolve-RepoPath (Get-Cfg -Key "bootstrap.install_root" -Default ".servlet-bootstrap"))."
