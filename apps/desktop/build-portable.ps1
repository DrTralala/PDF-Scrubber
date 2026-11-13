[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$desktopRoot = $PSScriptRoot
$artifactParent = Join-Path $repositoryRoot 'artifacts'
$artifactRoot = Join-Path $repositoryRoot 'artifacts\desktop'
$packageInput = Join-Path $artifactRoot 'package-input'
$outputDirectory = Join-Path $artifactRoot 'output'
$electronBuilderConfig = Join-Path $desktopRoot 'electron-builder.config.cjs'
$launcherSource = Join-Path $desktopRoot 'launcher\main.cpp'
$nodeModulesBinary = Join-Path $repositoryRoot 'node_modules\.bin\electron-builder.cmd'
$buildId = [Guid]::NewGuid().ToString('N')
$launcherBuildDirectory = Join-Path $artifactRoot "launcher-build-$buildId"
$electronBuildDirectory = Join-Path $artifactRoot "electron-build-$buildId"
$stagingDirectory = Join-Path $artifactRoot "portable-stage-$buildId"
$createdLauncherBuild = $false
$createdStaging = $false
$createdElectronBuild = $false
$previousElectronBuildOutput = $env:PDF_SCRUBBER_ELECTRON_BUILD_OUTPUT

function Assert-RegularDirectory([string] $Path, [string] $Description) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "$Description is missing or is not a directory: $Path"
  }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Description must not be a reparse point: $Path"
  }
}

function Assert-RegularFile([string] $Path, [string] $Description) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Description is missing or is not a file: $Path"
  }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Description must not be a reparse point: $Path"
  }
}

function Assert-NoReparseTree([string] $Path) {
  $entries = @(Get-Item -LiteralPath $Path -Force) + @(Get-ChildItem -LiteralPath $Path -Force -Recurse)
  foreach ($entry in $entries) {
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Packaged Electron output contains a reparse point: $($entry.FullName)"
    }
  }
}

function Get-X64Compiler {
  $compilerOnPath = Get-Command 'cl.exe' -ErrorAction SilentlyContinue
  $programFilesX86 = ${env:ProgramFiles(x86)}
  if ([string]::IsNullOrWhiteSpace($programFilesX86)) {
    if ($null -ne $compilerOnPath) { return $compilerOnPath.Source }
    throw 'A native x64 MSVC compiler is required, but Program Files (x86) is unavailable and cl.exe is not on PATH.'
  }
  $vswhere = Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
    if ($null -ne $compilerOnPath) { return $compilerOnPath.Source }
    throw 'A native x64 MSVC compiler is required; verified Visual Studio discovery (vswhere.exe) is unavailable.'
  }

  $installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($installation -join '').Trim())) {
    throw 'vswhere.exe did not find an installed Visual Studio x64 C++ toolchain.'
  }
  $installationPath = ($installation -join '').Trim()
  $developerCommand = Join-Path $installationPath 'Common7\Tools\VsDevCmd.bat'
  if (-not (Test-Path -LiteralPath $developerCommand -PathType Leaf)) {
    throw "The discovered Visual Studio installation has no VsDevCmd.bat: $developerCommand"
  }

  $command = 'call "' + $developerCommand + '" -no_logo -arch=x64 -host_arch=x64 && set'
  $environmentLines = & $env:ComSpec /d /s /c $command
  if ($LASTEXITCODE -ne 0) {
    throw 'VsDevCmd.bat could not initialise the installed x64 MSVC environment.'
  }
  foreach ($line in $environmentLines) {
    $separator = $line.IndexOf('=')
    if ($separator -le 0 -or $line[0] -eq '=') { continue }
    $name = $line.Substring(0, $separator)
    $value = $line.Substring($separator + 1)
    Set-Item -LiteralPath "Env:$name" -Value $value
  }

  $compiler = Get-Command 'cl.exe' -ErrorAction SilentlyContinue
  if ($null -eq $compiler) {
    throw 'VsDevCmd.bat completed, but cl.exe is still unavailable.'
  }
  return $compiler.Source
}

function Ensure-ArtifactDirectory([string] $Path, [string] $Description) {
  if (Test-Path -LiteralPath $Path) {
    Assert-RegularDirectory $Path $Description
    return
  }
  New-Item -ItemType Directory -Path $Path | Out-Null
  Assert-RegularDirectory $Path $Description
}

try {
  Ensure-ArtifactDirectory $artifactParent 'Artifact parent directory'
  Ensure-ArtifactDirectory $artifactRoot 'Desktop artifact directory'
  Assert-RegularDirectory $packageInput 'Prepared desktop package input'
  $packageManifestPath = Join-Path $packageInput 'package.json'
  $provenancePath = Join-Path $packageInput 'provenance.json'
  Assert-RegularFile $packageManifestPath 'Prepared package manifest'
  Assert-RegularFile $provenancePath 'Prepared provenance'

  $packageManifest = Get-Content -LiteralPath $packageManifestPath -Raw | ConvertFrom-Json
  $version = [string]$packageManifest.version
  if ($version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
    throw "Prepared desktop version is not a stable MAJOR.MINOR.PATCH value: $version"
  }
  $provenanceBytes = [IO.File]::ReadAllBytes($provenancePath)
  $provenance = [Text.Encoding]::UTF8.GetString($provenanceBytes) | ConvertFrom-Json
  if ($provenance.schemaVersion -ne 1 -or $provenance.editor.version -ne $version
      -or $provenance.editor.tag -ne "v$version"
      -or $provenance.editor.sha -notmatch '^[0-9a-fA-F]{40}$'
      -or $provenance.packaging.sha -notmatch '^[0-9a-fA-F]{40}$') {
    throw 'Prepared desktop provenance does not match its stable editor version and full source SHAs.'
  }

  Ensure-ArtifactDirectory $outputDirectory 'Desktop output directory'
  $archiveName = "PDF-Scrubber-${version}-win-x64-portable.7z"
  $archivePath = Join-Path $outputDirectory $archiveName
  $checksumPath = "$archivePath.sha256"
  $outputProvenance = Join-Path $outputDirectory 'provenance.json'
  if ((Test-Path -LiteralPath $archivePath) -or (Test-Path -LiteralPath $checksumPath)
      -or (Test-Path -LiteralPath $outputProvenance)) {
    throw "Refusing to replace existing desktop output: $archivePath, $checksumPath, or $outputProvenance"
  }

  if (-not (Test-Path -LiteralPath $launcherSource -PathType Leaf)) {
    throw "Native launcher source is missing: $launcherSource"
  }
  if (-not (Test-Path -LiteralPath $nodeModulesBinary -PathType Leaf)) {
    throw "Pinned electron-builder is unavailable at $nodeModulesBinary; run the repository's dependency setup before building."
  }
  Assert-RegularFile $nodeModulesBinary 'Pinned electron-builder command'

  $sevenZipCommand = Get-Command '7z.exe' -ErrorAction SilentlyContinue
  if ($null -eq $sevenZipCommand) { $sevenZipCommand = Get-Command '7z' -ErrorAction SilentlyContinue }
  if ($null -eq $sevenZipCommand -or $sevenZipCommand.CommandType -ne 'Application') {
    throw '7-Zip command-line tool 7z.exe is required but was not found on PATH; no tool was installed.'
  }

  $compilerPath = Get-X64Compiler
  foreach ($scratchDirectory in @($launcherBuildDirectory, $electronBuildDirectory, $stagingDirectory)) {
    if (Test-Path -LiteralPath $scratchDirectory) {
      throw "Refusing to use existing desktop build scratch output: $scratchDirectory"
    }
  }
  New-Item -ItemType Directory -Path $launcherBuildDirectory | Out-Null
  $createdLauncherBuild = $true
  $launcherExecutable = Join-Path $launcherBuildDirectory 'PDF-Scrubber.exe'
  $launcherObject = Join-Path $launcherBuildDirectory 'main.obj'
  & $compilerPath /nologo /std:c++17 /EHsc /O2 /MT /DUNICODE /D_UNICODE "/Fo$launcherObject" $launcherSource /link "/OUT:$launcherExecutable" /SUBSYSTEM:WINDOWS /MACHINE:X64 user32.lib shell32.lib
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcherExecutable -PathType Leaf)) {
    throw 'MSVC failed to compile the static x64 Windows GUI launcher.'
  }
  $dumpbinCommand = Get-Command 'dumpbin.exe' -ErrorAction SilentlyContinue
  if ($null -eq $dumpbinCommand) {
    throw 'MSVC dumpbin.exe is required to inspect the compiled launcher imports; no tool was installed.'
  }
  $launcherDependencies = & $dumpbinCommand.Source /nologo /dependents $launcherExecutable
  if ($LASTEXITCODE -ne 0) {
    throw 'MSVC dumpbin.exe could not inspect the compiled launcher imports.'
  }
  $dependencyReport = [string]::Join("`n", $launcherDependencies)
  if ($dependencyReport -match '(?im)^\s*(?:VCRUNTIME|MSVCP|CONCRT|MFC)[A-Z0-9_]*\.DLL\s*$') {
    throw 'The native portable launcher imports a separately installed Visual C++ redistributable DLL.'
  }

  New-Item -ItemType Directory -Path $electronBuildDirectory | Out-Null
  $createdElectronBuild = $true
  $env:PDF_SCRUBBER_ELECTRON_BUILD_OUTPUT = $electronBuildDirectory
  Push-Location $repositoryRoot
  try {
    & $nodeModulesBinary --config $electronBuilderConfig --win --x64 --dir
    if ($LASTEXITCODE -ne 0) {
      throw 'electron-builder failed to produce the unpacked Windows x64 application.'
    }
  } finally {
    Pop-Location
  }
  $unpackedApplication = Join-Path $electronBuildDirectory 'win-unpacked'
  Assert-RegularDirectory $unpackedApplication 'Unpacked Windows Electron application'
  Assert-NoReparseTree $unpackedApplication
  if (-not (Test-Path -LiteralPath (Join-Path $unpackedApplication 'PDF-Scrubber.exe') -PathType Leaf)) {
    throw 'The unpacked Electron application does not contain PDF-Scrubber.exe.'
  }

  New-Item -ItemType Directory -Path $stagingDirectory | Out-Null
  $createdStaging = $true
  $applicationRoot = Join-Path $stagingDirectory 'PDF-Scrubber'
  $configDirectory = Join-Path $applicationRoot 'config'
  $runtimeDirectory = Join-Path $configDirectory 'runtime'
  New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
  $packagedLauncher = Join-Path $applicationRoot 'PDF-Scrubber.exe'
  Copy-Item -LiteralPath $launcherExecutable -Destination $packagedLauncher
  $packagedLauncherDependencies = & $dumpbinCommand.Source /nologo /dependents $packagedLauncher
  if ($LASTEXITCODE -ne 0) {
    throw 'MSVC dumpbin.exe could not inspect the final staged launcher imports.'
  }
  $packagedDependencyReport = [string]::Join("`n", $packagedLauncherDependencies)
  if ($packagedDependencyReport -match '(?im)^\s*(?:VCRUNTIME|MSVCP|CONCRT|MFC)[A-Z0-9_]*\.DLL\s*$') {
    throw 'The final staged portable launcher imports a separately installed Visual C++ redistributable DLL.'
  }
  foreach ($entry in Get-ChildItem -LiteralPath $unpackedApplication -Force) {
    Copy-Item -LiteralPath $entry.FullName -Destination $runtimeDirectory -Recurse
  }
  [IO.File]::WriteAllText(
    (Join-Path $applicationRoot 'settings.json'),
    "{`n  `"schemaVersion`": 1,`n  `"window`": {`n    `"width`": 1280,`n    `"height`": 860`n  }`n}`n",
    [Text.UTF8Encoding]::new($false)
  )
  Copy-Item -LiteralPath $provenancePath -Destination (Join-Path $configDirectory 'provenance.json')

  $rootEntries = @(Get-ChildItem -LiteralPath $applicationRoot -Force | Sort-Object Name | ForEach-Object Name)
  $expectedRootEntries = @('PDF-Scrubber.exe', 'config', 'settings.json')
  if (Compare-Object -ReferenceObject $expectedRootEntries -DifferenceObject $rootEntries) {
    throw "Portable application root must contain exactly PDF-Scrubber.exe, settings.json, and config/. Found: $($rootEntries -join ', ')"
  }
  $configEntries = @(Get-ChildItem -LiteralPath $configDirectory -Force | Sort-Object Name | ForEach-Object Name)
  if (Compare-Object -ReferenceObject @('provenance.json', 'runtime') -DifferenceObject $configEntries) {
    throw "Staged config must contain only provenance.json and runtime/. Found: $($configEntries -join ', ')"
  }
  $stagedProvenanceBytes = [IO.File]::ReadAllBytes((Join-Path $configDirectory 'provenance.json'))
  if ([Convert]::ToBase64String($provenanceBytes) -ne [Convert]::ToBase64String($stagedProvenanceBytes)) {
    throw 'Staged config/provenance.json differs from the prepared provenance source.'
  }

  Push-Location $stagingDirectory
  try {
    & $sevenZipCommand.Source a -t7z -mx=9 $archivePath 'PDF-Scrubber'
    if ($LASTEXITCODE -ne 0) { throw '7-Zip failed to create the ordinary .7z portable archive.' }
    & $sevenZipCommand.Source t -t7z $archivePath
    if ($LASTEXITCODE -ne 0) { throw '7-Zip could not validate the completed portable archive.' }
  } finally {
    Pop-Location
  }
  if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
    throw "7-Zip did not produce the expected archive: $archivePath"
  }
  Copy-Item -LiteralPath $provenancePath -Destination $outputProvenance
  Write-Output "Created $archivePath"
  Write-Output "Provenance: $outputProvenance"
} finally {
  if ($previousElectronBuildOutput -eq $null) {
    Remove-Item Env:PDF_SCRUBBER_ELECTRON_BUILD_OUTPUT -ErrorAction SilentlyContinue
  } else {
    $env:PDF_SCRUBBER_ELECTRON_BUILD_OUTPUT = $previousElectronBuildOutput
  }
  if ($createdStaging -and (Test-Path -LiteralPath $stagingDirectory)) {
    Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
  }
  if ($createdElectronBuild -and (Test-Path -LiteralPath $electronBuildDirectory)) {
    Remove-Item -LiteralPath $electronBuildDirectory -Recurse -Force
  }
  if ($createdLauncherBuild -and (Test-Path -LiteralPath $launcherBuildDirectory)) {
    Remove-Item -LiteralPath $launcherBuildDirectory -Recurse -Force
  }
}
