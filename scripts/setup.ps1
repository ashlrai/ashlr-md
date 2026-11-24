# One-command dev setup. Safe to run again. Asks no questions.
# Windows, from a checkout:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1
# macOS and Linux can use bash scripts/setup.sh, or this script under pwsh.

$ErrorActionPreference = 'Stop'

if ($PSScriptRoot) {
    . (Join-Path $PSScriptRoot 'rustc-version.ps1')
} else {
    throw 'Run scripts/setup.ps1 from a checkout: pwsh -File scripts/setup.ps1'
}

function Test-AshlrWindows {
    if ($PSVersionTable.PSEdition -eq 'Desktop') { return $true }
    return [bool]$IsWindows
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $repo

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is not installed.' }

if (-not (Get-Command rustup -ErrorAction SilentlyContinue)) {
    $cargoBin = Join-Path $HOME '.cargo/bin/rustup'
    if (Test-Path -LiteralPath $cargoBin) {
        $env:PATH = "$(Split-Path -Parent $cargoBin)$([IO.Path]::PathSeparator)$env:PATH"
    } else {
        Write-Host '[ashlr-md] Installing rustup (non-interactive)...'
        if (Test-AshlrWindows) {
            $init = Join-Path ([System.IO.Path]::GetTempPath()) 'rustup-init.exe'
            Invoke-WebRequest -Uri 'https://win.rustup.rs/x86_64' -OutFile $init -UseBasicParsing
            & $init -y --default-toolchain none
            if ($LASTEXITCODE -ne 0) { throw 'rustup-init failed' }
        } else {
            & curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none
            if ($LASTEXITCODE -ne 0) { throw 'rustup-init failed' }
        }
        $env:PATH = "$(Join-Path $HOME '.cargo/bin')$([IO.Path]::PathSeparator)$env:PATH"
    }
}

Assert-Rustc -Root $repo

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    $bunCmd = Join-Path $HOME '.bun/bin/bun'
    if (Test-Path -LiteralPath $bunCmd) {
        $env:PATH = "$(Split-Path -Parent $bunCmd)$([IO.Path]::PathSeparator)$env:PATH"
    } else {
        Write-Host '[ashlr-md] Installing Bun (non-interactive)...'
        if (Test-AshlrWindows) {
            $bunInstaller = Join-Path ([System.IO.Path]::GetTempPath()) 'ashlr-bun-install.ps1'
            Invoke-WebRequest -Uri 'https://bun.sh/install.ps1' -OutFile $bunInstaller -UseBasicParsing
            & $bunInstaller
            if ($LASTEXITCODE -ne 0) { throw 'Bun install failed' }
        } else {
            & curl --proto '=https' --tlsv1.2 -fsSL https://bun.sh/install | bash
            if ($LASTEXITCODE -ne 0) { throw 'Bun install failed' }
        }
        $env:PATH = "$(Join-Path $HOME '.bun/bin')$([IO.Path]::PathSeparator)$env:PATH"
    }
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw "Bun was not found after install. Add $(Join-Path $HOME '.bun/bin') to PATH and run scripts/setup.ps1 again."
}

Write-Host '[ashlr-md] Installing JS dependencies (bun install)...'
& bun install --frozen-lockfile --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw 'bun install failed' }

Write-Host '[ashlr-md] Smoke test...'
if (-not (Test-Path -LiteralPath (Join-Path $repo 'node_modules'))) {
    throw 'smoke: node_modules is missing after bun install.'
}
& cargo metadata --manifest-path (Join-Path $repo 'src-tauri/Cargo.toml') --format-version 1 --no-deps | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'smoke: cargo metadata failed' }
Write-Host '[ashlr-md] Setup complete. Smoke checks passed.'
Write-Host 'Next: SKIP_APP_BUILD=1 bash scripts/install.sh on macOS and Linux. On Windows, scripts/install.ps1 installs the latest release.'
Write-Host 'Discord: https://discord.gg/jBQrSU6XeD (The Dev Shack)'
