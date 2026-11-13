[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('ExpectError', 'ExpectUnwritableProfile', 'ForceRuntimeExit', 'TerminateOwnedTree')]
  [string] $Operation,
  [Parameter(Mandatory = $true)]
  [string] $ApplicationRoot,
  [Parameter(Mandatory = $true)]
  [string] $LauncherPath,
  [string] $ExecutablePath,
  [string] $ExpectedText,
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

if (-not ('PdfScrubberPortableSmoke.NativeWindows' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace PdfScrubberPortableSmoke {
  public sealed class SmokeWindow {
    public IntPtr Handle { get; set; }
    public uint ProcessId { get; set; }
    public string Title { get; set; }
    public string Text { get; set; }
  }

  public static class NativeWindows {
    private delegate bool WindowCallback(IntPtr handle, IntPtr state);
    private const uint WmClose = 0x0010;

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(WindowCallback callback, IntPtr state);
    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr parent, WindowCallback callback, IntPtr state);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetWindowText(IntPtr handle, StringBuilder text, int maximum);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetWindowTextLength(IntPtr handle);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);

    private static string ReadText(IntPtr handle) {
      int length = GetWindowTextLength(handle);
      StringBuilder text = new StringBuilder(Math.Max(length + 1, 2));
      GetWindowText(handle, text, text.Capacity);
      return text.ToString();
    }

    public static List<SmokeWindow> FindVisibleWindows(int[] processIds) {
      HashSet<uint> allowed = new HashSet<uint>();
      foreach (int processId in processIds) allowed.Add((uint)processId);
      List<SmokeWindow> found = new List<SmokeWindow>();
      EnumWindows((handle, _) => {
        if (!IsWindowVisible(handle)) return true;
        uint processId;
        GetWindowThreadProcessId(handle, out processId);
        if (!allowed.Contains(processId)) return true;
        List<string> childText = new List<string>();
        EnumChildWindows(handle, (child, __) => {
          string value = ReadText(child);
          if (!String.IsNullOrWhiteSpace(value)) childText.Add(value);
          return true;
        }, IntPtr.Zero);
        found.Add(new SmokeWindow {
          Handle = handle,
          ProcessId = processId,
          Title = ReadText(handle),
          Text = String.Join(" ", childText.ToArray())
        });
        return true;
      }, IntPtr.Zero);
      return found;
    }

    public static bool Dismiss(IntPtr handle) {
      return PostMessage(handle, WmClose, IntPtr.Zero, IntPtr.Zero);
    }
  }
}
'@
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
    if (-not $rootPath.Equals($launcher, [StringComparison]::OrdinalIgnoreCase)
      -and -not $rootPath.Equals($nativeRuntime, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Refusing to clean up a process whose executable is outside the task-owned portable root.'
    }
  }
  $ownedIds = Get-OwnedProcessTree $RootId
  $runtimePrefix = $nativeRuntimeDirectory.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  foreach ($candidate in $processes | Where-Object { $ownedIds -contains [int]$_.ProcessId }) {
    $candidateId = [int]$candidate.ProcessId
    if ($candidateId -eq $RootId -or [string]::IsNullOrWhiteSpace([string]$candidate.ExecutablePath)) { continue }
    $candidatePath = [IO.Path]::GetFullPath([string]$candidate.ExecutablePath)
    if ($candidatePath.Equals($nativeRuntime, [StringComparison]::OrdinalIgnoreCase)
      -or $candidatePath.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)) {
      Stop-Process -Id $candidateId -Force -ErrorAction SilentlyContinue
    }
  }
  if ($null -ne $rootProcess) { Stop-Process -Id $RootId -Force -ErrorAction SilentlyContinue }
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
  return Start-Process @startParameters
}

function Wait-ForOwnedErrorDialog([Diagnostics.Process] $Process, [string] $RequiredText) {
  if ([string]::IsNullOrWhiteSpace($RequiredText)) {
    throw 'ExpectedText is required for a native error-dialog smoke.'
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(25)
  while ([DateTime]::UtcNow -lt $deadline) {
    $processIds = Get-OwnedProcessTree $Process.Id
    foreach ($window in [PdfScrubberPortableSmoke.NativeWindows]::FindVisibleWindows($processIds)) {
      $visibleText = "$($window.Title) $($window.Text)"
      if ($visibleText.IndexOf($RequiredText, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
      if (-not [PdfScrubberPortableSmoke.NativeWindows]::Dismiss($window.Handle)) {
        throw 'Could not dismiss the owned portable-app error dialog.'
      }
      if (-not $Process.WaitForExit(15000)) {
        throw 'Owned portable-app process did not exit after its error dialog was dismissed.'
      }
      if ($Process.ExitCode -eq 0) {
        throw 'Portable-app error path unexpectedly returned success.'
      }
      return
    }
    if ($Process.HasExited) {
      throw "Owned portable app exited before showing the required actionable error: $RequiredText"
    }
    Start-Sleep -Milliseconds 100
  }
  throw "Owned portable app did not show the required actionable error: $RequiredText"
}

try {
  switch ($Operation) {
    'ExpectError' {
      if ([string]::IsNullOrWhiteSpace($ExecutablePath)) { $target = $launcher }
      else { $target = [IO.Path]::GetFullPath($ExecutablePath) }
      if (-not $target.Equals($launcher, [StringComparison]::OrdinalIgnoreCase)
        -and -not $target.Equals($nativeRuntime, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Error-path smoke may start only the task-owned root launcher or its packaged inner runtime.'
      }
      $process = Start-OwnedProcess $target
      Wait-ForOwnedErrorDialog $process $ExpectedText
    }

    'ExpectUnwritableProfile' {
      $profile = Join-Path $root 'config/profile'
      if (-not (Test-Path -LiteralPath $profile -PathType Container)) {
        throw 'The task-owned profile directory is missing before ACL testing.'
      }
      $originalAcl = Get-Acl -LiteralPath $profile
      $originalSddl = $originalAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)
      $denyRule = [Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.WindowsIdentity]::GetCurrent().User,
        [Security.AccessControl.FileSystemRights]::Modify,
        [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Deny
      )
      try {
        $testAcl = Get-Acl -LiteralPath $profile
        [void]$testAcl.AddAccessRule($denyRule)
        Set-Acl -LiteralPath $profile -AclObject $testAcl
        $process = Start-OwnedProcess $launcher
        Wait-ForOwnedErrorDialog $process 'profile or temporary storage folder is not writable'
      } finally {
        $restoreAcl = Get-Acl -LiteralPath $profile
        $restoreAcl.SetSecurityDescriptorSddlForm(
          $originalSddl,
          [Security.AccessControl.AccessControlSections]::All
        )
        Set-Acl -LiteralPath $profile -AclObject $restoreAcl
        $restoredSddl = (Get-Acl -LiteralPath $profile).GetSecurityDescriptorSddlForm(
          [Security.AccessControl.AccessControlSections]::All
        )
        if ($restoredSddl -ne $originalSddl) { throw 'Could not restore the task-owned profile ACL exactly.' }
      }
    }

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
      if ($process.ExitCode -eq 0) { throw 'Forced runtime exit was incorrectly reported as success.' }
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
