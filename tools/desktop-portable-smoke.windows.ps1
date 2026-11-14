[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('ForceRuntimeExit', 'TerminateOwnedTree')]
  [string] $Operation,
  [Parameter(Mandatory = $true)]
  [string] $ApplicationRoot,
  [Parameter(Mandatory = $true)]
  [string] $LauncherPath,
  [int] $Port = 0,
  [int] $RootProcessId = 0
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($ApplicationRoot)
$launcher = [IO.Path]::GetFullPath($LauncherPath)
$nativeRuntime = [IO.Path]::GetFullPath((Join-Path $root 'config/runtime/PDF-Scrubber.exe'))
$nativeRuntimeDirectory = [IO.Path]::GetFullPath((Join-Path $root 'config/runtime'))
$tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $root.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Native portable smoke helpers may only operate inside the fresh task-owned extraction directory.'
}

function Get-OwnedProcessTree([int] $RootProcessId) {
  $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
  $owned = [Collections.Generic.HashSet[int]]::new()
  [void]$owned.Add($RootProcessId)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($candidate in $processes) {
      $candidateId = [int]$candidate.ProcessId
      if (-not $owned.Contains($candidateId) -and $owned.Contains([int]$candidate.ParentProcessId)) {
        [void]$owned.Add($candidateId)
        $changed = $true
      }
    }
  }
  return @($owned)
}

function Stop-OwnedPortableProcessTree([int] $RootId) {
  if ($RootId -le 0) { throw 'A positive task-owned root process ID is required for process-tree cleanup.' }
  $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
  $rootProcess = $processes | Where-Object { [int]$_.ProcessId -eq $RootId } | Select-Object -First 1
  if ($null -ne $rootProcess) {
    if ([string]::IsNullOrWhiteSpace([string]$rootProcess.ExecutablePath)) {
      throw 'Could not verify the task-owned portable process executable before cleanup.'
    }
    $rootPath = [IO.Path]::GetFullPath([string]$rootProcess.ExecutablePath)
    if (-not $rootPath.Equals($launcher, [StringComparison]::OrdinalIgnoreCase) -and
      -not $rootPath.Equals($nativeRuntime, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Refusing to clean up a process whose executable is outside the task-owned portable root.'
    }
  }
  $ownedIds = Get-OwnedProcessTree $RootId
  $runtimePrefix = $nativeRuntimeDirectory.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  foreach ($candidate in $processes | Where-Object { $ownedIds -contains [int]$_.ProcessId }) {
    $candidateId = [int]$candidate.ProcessId
    if ($candidateId -eq $RootId -or [string]::IsNullOrWhiteSpace([string]$candidate.ExecutablePath)) { continue }
    $candidatePath = [IO.Path]::GetFullPath([string]$candidate.ExecutablePath)
    if ($candidatePath.Equals($nativeRuntime, [StringComparison]::OrdinalIgnoreCase) -or
      $candidatePath.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)) {
      Stop-Process -Id $candidateId -Force -ErrorAction SilentlyContinue
    }
  }
  if ($null -ne $rootProcess) { Stop-Process -Id $RootId -Force -ErrorAction SilentlyContinue }
}

function Get-OwnedProcessExitCode([Diagnostics.Process] $Process) {
  if (-not $Process.HasExited) { throw 'The owned process has not exited.' }
  $exitCode = $Process.ExitCode
  if ($exitCode -isnot [int]) {
    throw 'Could not obtain an explicit integer exit code for the owned process; cache its Handle before waiting.'
  }
  return $exitCode
}

function Start-OwnedProcess([string] $Path, [string[]] $Arguments = @()) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Smoke executable is missing: $Path"
  }
  $startParameters = @{
    FilePath = $Path
    WorkingDirectory = $root
    PassThru = $true
    ErrorAction = 'Stop'
  }
  if ($Arguments.Count -gt 0) { $startParameters.ArgumentList = $Arguments }
  $process = Start-Process @startParameters
  # Windows PowerShell 5.1 otherwise loses ExitCode after WaitForExit/HasExited.
  [void]$process.Handle
  return $process
}

try {
  switch ($Operation) {
    'ForceRuntimeExit' {
      if ($Port -lt 1 -or $Port -gt 65535) { throw 'ForceRuntimeExit requires a valid owned loopback port.' }
      $process = Start-OwnedProcess $launcher @(
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=$Port"
      )
      $deadline = [DateTime]::UtcNow.AddSeconds(45)
      $runtimeProcess = $null
      while ([DateTime]::UtcNow -lt $deadline) {
        $ownedIds = Get-OwnedProcessTree $process.Id
        $runtimeProcess = Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
          Where-Object {
            $ownedIds -contains [int]$_.ProcessId -and
            $_.ExecutablePath -and
            [IO.Path]::GetFullPath([string]$_.ExecutablePath).Equals(
              $nativeRuntime,
              [StringComparison]::OrdinalIgnoreCase
            )
          } |
          Select-Object -First 1
        if ($null -ne $runtimeProcess) {
          try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" `
              -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
            if ($response.StatusCode -eq 200) { break }
          } catch {
            # The owned Electron process may need a short time to bind its loopback CDP listener.
          }
        }
        if ($process.HasExited) { throw 'Portable launcher exited before its owned runtime became ready.' }
        Start-Sleep -Milliseconds 150
      }
      if ($null -eq $runtimeProcess -or [DateTime]::UtcNow -ge $deadline) {
        throw 'Could not identify the task-owned runtime process and its ready loopback endpoint.'
      }
      $runtimeId = [int]$runtimeProcess.ProcessId
      $runtimePath = [IO.Path]::GetFullPath([string]$runtimeProcess.ExecutablePath)
      if (-not $runtimePath.Equals($nativeRuntime, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to stop a process outside the task-owned portable runtime path.'
      }
      Stop-Process -Id $runtimeId -Force -ErrorAction Stop
      if (-not $process.WaitForExit(15000)) {
        throw 'Owned portable launcher did not propagate the forced runtime exit.'
      }
      $exitCode = Get-OwnedProcessExitCode -Process $process
      if ($exitCode -eq 0) { throw 'Forced runtime exit was incorrectly reported as success.' }
    }

    'TerminateOwnedTree' {
      Stop-OwnedPortableProcessTree $RootProcessId
    }
  }

  Write-Output "PDF_SCRUBBER_WINDOWS_SMOKE operation=$Operation passed"
} finally {
  if ($null -ne $process -and -not $process.HasExited) {
    Stop-OwnedPortableProcessTree $process.Id
  }
}
