# One-command Windows install. From PowerShell:
#   irm https://raw.githubusercontent.com/ashlrai/ashlr-md/main/scripts/install.ps1 | iex
# Downloads the latest GitHub release installer and, on Windows, runs it
# silently. On any other OS it only resolves the URL and checks that the
# download answers, so the command can be checked without a Windows machine.
$ErrorActionPreference = 'Stop'

function Test-AshlrWindows {
  if ($PSVersionTable.PSEdition -eq 'Desktop') { return $true }
  return ($IsWindows -eq $true)
}

function Get-AshlrReleaseInstaller {
  param(
    [string]$Repo = 'ashlrai/ashlr-md'
  )
  if ($Repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
    throw "ASHLR_GITHUB_REPO must look like owner/name."
  }
  $api = "https://api.github.com/repos/$Repo/releases/latest"
  $headers = @{
    Accept = 'application/vnd.github+json'
    'User-Agent' = 'ashlr-md-install'
  }
  if ($env:GITHUB_TOKEN) {
    $headers.Authorization = "Bearer $($env:GITHUB_TOKEN)"
  }
  $release = Invoke-RestMethod -Uri $api -Headers $headers
  $assets = @($release.assets)
  $exe = @($assets | Where-Object { $_.name -like '*_x64-setup.exe' })
  $msi = @($assets | Where-Object { $_.name -like '*_x64_en-US.msi' })
  if ($exe.Count -eq 1) {
    $chosen = $exe[0]
  } elseif ($msi.Count -eq 1) {
    $chosen = $msi[0]
  } else {
    throw "The latest release has no single Windows installer. Found $($exe.Count) setup.exe and $($msi.Count) msi assets."
  }
  $url = [string]$chosen.browser_download_url
  if ($url -notlike 'https://*') {
    throw "Refusing a non-HTTPS download URL."
  }
  [pscustomobject]@{
    Tag = [string]$release.tag_name
    Name = [string]$chosen.name
    Url = $url
  }
}

function Test-AshlrDownloadUrl {
  param([Parameter(Mandatory = $true)][string]$Url)
  if ($Url -notlike 'https://*') {
    throw "Refusing a non-HTTPS download URL."
  }
  try {
    $head = Invoke-WebRequest -Uri $Url -Method Head -MaximumRedirection 5
    if ($head.StatusCode -eq 200) { return }
  } catch {
    # Some hosts reject HEAD. A one-byte GET still proves the URL resolves.
  }
  $probe = Invoke-WebRequest -Uri $Url -Headers @{ Range = 'bytes=0-0' } -MaximumRedirection 5
  if ($probe.StatusCode -ne 200 -and $probe.StatusCode -ne 206) {
    throw "Download URL returned HTTP $($probe.StatusCode)."
  }
}

function Install-AshlrRelease {
  param($Installer)
  $dest = Join-Path ([System.IO.Path]::GetTempPath()) $Installer.Name
  Write-Host "Downloading $($Installer.Name) from $($Installer.Tag)..."
  Invoke-WebRequest -Uri $Installer.Url -OutFile $dest
  if ($Installer.Name -like '*.msi') {
    $proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', $dest, '/qn', '/norestart') -Wait -PassThru
  } else {
    $proc = Start-Process -FilePath $dest -ArgumentList '/S' -Wait -PassThru
  }
  if ($null -eq $proc.ExitCode -or $proc.ExitCode -ne 0) {
    throw "The installer exited $($proc.ExitCode)."
  }
  Write-Host "Installation complete."
}

if ($MyInvocation.InvocationName -eq '.') { return }

$repo = if ($env:ASHLR_GITHUB_REPO) { $env:ASHLR_GITHUB_REPO } else { 'ashlrai/ashlr-md' }
$installer = Get-AshlrReleaseInstaller -Repo $repo
Write-Host "release $($installer.Tag) $($installer.Name)"
Write-Host $installer.Url
if (Test-AshlrWindows) {
  Install-AshlrRelease -Installer $installer
} else {
  Test-AshlrDownloadUrl -Url $installer.Url
  Write-Host "Download URL resolved. Silent install runs on Windows: the setup.exe uses /S, and the msi uses msiexec /qn."
}
