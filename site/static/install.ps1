#Requires -Version 5.1
<#
.SYNOPSIS
    Installs Pockode on Windows.

.DESCRIPTION
    Downloads the release binary, puts it in a per-user directory, and adds that
    directory to the user PATH. Re-running it installs over the existing copy,
    which is also how upgrades work.

    Nothing here needs administrator rights: the binary goes under
    %LOCALAPPDATA% and only the per-user PATH is touched. That is the difference
    from install.sh, which installs to /usr/local/bin with sudo.

.PARAMETER Version
    Release tag to install, e.g. "v0.12.1". Defaults to the latest release.

.PARAMETER InstallDir
    Where pockode.exe goes. Defaults to %LOCALAPPDATA%\Programs\Pockode.

.PARAMETER Url
    Download the binary from this URL instead of from a GitHub release. For
    mirrors, and for testing a build that has not been released yet.

.PARAMETER Uninstall
    Remove pockode.exe and take InstallDir back off the PATH.

.EXAMPLE
    irm https://pockode.com/install.ps1 | iex

.EXAMPLE
    # Piping into iex cannot pass arguments, so run it as a script block instead.
    & ([scriptblock]::Create((irm https://pockode.com/install.ps1))) -Uninstall
#>
[CmdletBinding()]
param(
    [string]$Version = 'latest',
    [string]$InstallDir,
    [string]$Url,
    [switch]$Uninstall
)

# Everything below runs in a child scope. The documented entry point is
# `irm ... | iex`, and Invoke-Expression runs its input in the *caller's* scope:
# without this, installing would leave the user's interactive session with a
# changed $ErrorActionPreference and every helper defined below still in it.
& {

$ErrorActionPreference = 'Stop'
# Windows PowerShell redraws its progress bar on every chunk of the download,
# which costs more wall clock than the transfer itself.
$ProgressPreference = 'SilentlyContinue'

# PowerShell also runs on macOS and Linux, where every step below is meaningless
# and the failure would otherwise be an obscure one about a null architecture.
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "install.ps1 installs the Windows binary. On macOS or Linux run: curl -fsSL https://pockode.com/install.sh | sh"
}

# Defaulted here rather than in param(): %LOCALAPPDATA% only exists on Windows,
# and a default that throws while binding parameters would pre-empt the check
# above with a message about a null path.
if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\Pockode' }

# A relative -InstallDir would put an entry on PATH that resolves against
# whatever directory each shell happens to be in. GetUnresolvedProviderPathFromPSPath
# rather than [IO.Path]::GetFullPath: the latter resolves against the .NET
# process directory, which is not necessarily where PowerShell thinks it is.
$InstallDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallDir)

$Repo = 'sijiaoh/pockode'
$BinaryName = 'pockode.exe'

function Get-ReleaseArch {
    # A 32-bit PowerShell on 64-bit Windows reports x86 in PROCESSOR_ARCHITECTURE
    # and the machine's real architecture in PROCESSOR_ARCHITEW6432.
    $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }

    switch ($arch.ToUpperInvariant()) {
        'AMD64' { return 'amd64' }
        'ARM64' {
            # There is no native arm64 release. Windows 11 on Arm runs x64
            # binaries under emulation; Windows 10 on Arm emulates x86 only, and
            # x86 is not a release target either.
            if ([Environment]::OSVersion.Version.Build -lt 22000) {
                throw "Pockode has no arm64 build, and Windows 10 on Arm cannot run the amd64 one - it emulates x86 only. Windows 11 on Arm can."
            }
            Write-Host "No native arm64 build; installing the amd64 binary, which Windows 11 on Arm runs under emulation."
            return 'amd64'
        }
        default { throw "Unsupported architecture: $arch. Pockode ships an amd64 binary only." }
    }
}

function Open-UserEnvironmentKey {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    if (-not $key) { throw 'Could not open HKCU\Environment for writing.' }
    return $key
}

function Read-RawUserPath($key) {
    # DoNotExpandEnvironmentNames is the whole point: PATH is normally
    # REG_EXPAND_SZ and other installers put entries like %JAVA_HOME%\bin in it.
    # Reading it expanded and writing it back would freeze every one of those
    # into whatever it happens to point at today.
    return [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
}

function Write-RawUserPath($key, [string]$value) {
    $kind = if ($key.GetValueNames() -contains 'Path') {
        $key.GetValueKind('Path')
    } else {
        [Microsoft.Win32.RegistryValueKind]::ExpandString
    }
    $key.SetValue('Path', $value, $kind)
}

function Split-PathValue([string]$value) {
    return @($value -split ';' | Where-Object { $_.Trim() -ne '' })
}

function Test-SamePath([string]$a, [string]$b) {
    return $a.Trim().TrimEnd('\', '/') -ieq $b.Trim().TrimEnd('\', '/')
}

function Add-UserPathEntry([string]$dir) {
    $key = Open-UserEnvironmentKey
    try {
        $entries = Split-PathValue (Read-RawUserPath $key)
        if ($entries | Where-Object { Test-SamePath $_ $dir }) { return $false }
        Write-RawUserPath $key (($entries + $dir) -join ';')
        return $true
    } finally {
        $key.Close()
    }
}

function Remove-UserPathEntry([string]$dir) {
    $key = Open-UserEnvironmentKey
    try {
        $entries = Split-PathValue (Read-RawUserPath $key)
        $kept = @($entries | Where-Object { -not (Test-SamePath $_ $dir) })
        if ($kept.Count -eq $entries.Count) { return $false }
        Write-RawUserPath $key ($kept -join ';')
        return $true
    } finally {
        $key.Close()
    }
}

function Publish-EnvironmentChange {
    # Explorer hands its own environment block to everything it launches and only
    # refreshes it when this message arrives. Without the broadcast, "open a new
    # terminal" is not enough for terminals started from Explorer - they would
    # keep the old PATH until the next sign-in.
    try {
        if (-not ('Pockode.Win32' -as [type])) {
            Add-Type -Namespace Pockode -Name Win32 -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
        }
        $HWND_BROADCAST = [IntPtr]0xffff
        $WM_SETTINGCHANGE = 0x1A
        $SMTO_ABORTIFHUNG = 0x2
        $unused = [UIntPtr]::Zero
        [void][Pockode.Win32]::SendMessageTimeout($HWND_BROADCAST, $WM_SETTINGCHANGE, [UIntPtr]::Zero, 'Environment', $SMTO_ABORTIFHUNG, 5000, [ref]$unused)
    } catch {
        Write-Warning "Could not broadcast the PATH change ($($_.Exception.Message)). Terminals started from Explorer may not see pockode until you sign out and back in."
    }
}

$target = Join-Path $InstallDir $BinaryName

if ($Uninstall) {
    if (Test-Path -LiteralPath $target) {
        try {
            Remove-Item -LiteralPath $target -Force
        } catch {
            throw "Could not remove ${target}: $($_.Exception.Message)`nIf Pockode is running, stop it and run this again."
        }
        Write-Host "Removed $target"
    } else {
        Write-Host "Nothing to remove at $target"
    }

    # Only clean up the install directory if uninstalling left it empty - a user
    # who pointed -InstallDir at a directory of their own keeps the rest of it.
    if ((Test-Path -LiteralPath $InstallDir) -and -not (Get-ChildItem -LiteralPath $InstallDir -Force)) {
        Remove-Item -LiteralPath $InstallDir -Force
    }

    if (Remove-UserPathEntry $InstallDir) {
        Publish-EnvironmentChange
        Write-Host "Removed $InstallDir from your PATH."
    }

    Write-Host "Project data is untouched: each project keeps its own .pockode directory."
    return
}

$arch = Get-ReleaseArch

if (-not $Url) {
    $asset = "pockode-windows-$arch.exe"
    if ($Version -eq 'latest') {
        $Url = "https://github.com/$Repo/releases/latest/download/$asset"
    } else {
        $tag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
        $Url = "https://github.com/$Repo/releases/download/$tag/$asset"
    }
}

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

# Download beside the target so the install is a rename on the same volume: an
# interrupted download never replaces a working binary with a partial one.
$temp = "$target.download"

Write-Host "Downloading $Url"
try {
    # Windows PowerShell on older builds still defaults to TLS 1.0/1.1, which
    # github.com refuses.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Url -OutFile $temp -UseBasicParsing
} catch {
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
    throw "Download failed: $($_.Exception.Message)`nURL: $Url"
}

# Some transports tag downloads with a mark of the web, which makes Windows warn
# on - or refuse - the first run.
Unblock-File -LiteralPath $temp -ErrorAction SilentlyContinue

try {
    Move-Item -LiteralPath $temp -Destination $target -Force
} catch {
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
    throw "Could not write ${target}: $($_.Exception.Message)`nIf Pockode is running, stop it and run this again."
}

$pathAdded = Add-UserPathEntry $InstallDir
if ($pathAdded) {
    Publish-EnvironmentChange
    Write-Host "Added $InstallDir to your PATH."
}

# Make the command work in the session that ran the installer, too.
if (-not (Split-PathValue $env:Path | Where-Object { Test-SamePath $_ $InstallDir })) {
    $env:Path = "$env:Path;$InstallDir"
}

try {
    $reported = & $target -version
    if ($LASTEXITCODE -ne 0) { throw "exit code $LASTEXITCODE" }
} catch {
    throw "$target was installed but does not run: $($_.Exception.Message)"
}

Write-Host ""
Write-Host "Installed $reported to $target"
if ($pathAdded) {
    Write-Host "Open a new terminal before 'pockode' resolves there."
}
Write-Host "Run 'pockode -auth-token YOUR_PASSWORD' from a project directory to get started."
Write-Host "To uninstall: & ([scriptblock]::Create((irm https://pockode.com/install.ps1))) -Uninstall"

} # end of the child scope opened after param()
