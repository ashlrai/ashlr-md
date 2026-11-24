# Shared by the PowerShell install and setup scripts.
# The pin is rust-toolchain.toml. The floor is the highest rust-version
# in src-tauri/Cargo.lock (tauri-build 2.7.4 and tauri-utils 2.10.2).

$script:CrateRustFloor = '1.90'

function Get-PinnedRustc {
    param([Parameter(Mandatory = $true)][string]$Root)
    $path = Join-Path $Root 'rust-toolchain.toml'
    foreach ($raw in Get-Content -LiteralPath $path) {
        $line = $raw.Trim()
        if ($line -match '^\s*channel\s*=\s*[''"]?([^''"\s]+)') {
            return $Matches[1].Trim()
        }
    }
    throw 'rust-toolchain.toml has no channel. The crates need rustc 1.90 or newer.'
}

function Test-VersionGe {
    param(
        [Parameter(Mandatory = $true)][string]$Have,
        [Parameter(Mandatory = $true)][string]$Need
    )
    $parts = {
        param($v)
        @($v.Split('.') | ForEach-Object {
            if ($_ -match '^(\d+)') { [int]$Matches[1] } else { 0 }
        })
    }
    $a = & $parts $Have
    $b = & $parts $Need
    $n = [Math]::Max($a.Count, $b.Count)
    for ($i = 0; $i -lt $n; $i++) {
        $x = if ($i -lt $a.Count) { $a[$i] } else { 0 }
        $y = if ($i -lt $b.Count) { $b[$i] } else { 0 }
        if ($x -gt $y) { return $true }
        if ($x -lt $y) { return $false }
    }
    return $true
}

function Get-RustcRelease {
    $line = & rustc --version 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $line) { return $null }
    return ($line -split '\s+', 3)[1]
}

# Install the pinned toolchain when rustup is present, then refuse a rustc
# that cannot build the crates.
function Assert-Rustc {
    param([Parameter(Mandatory = $true)][string]$Root)
    $pin = Get-PinnedRustc -Root $Root
    $rustup = Get-Command rustup -ErrorAction SilentlyContinue
    if ($rustup) {
        Write-Host "[ashlr-md] Installing Rust $pin from rust-toolchain.toml..."
        & rustup toolchain install $pin --profile minimal --component clippy,rustfmt
        if ($LASTEXITCODE -ne 0) {
            throw "rustup could not install Rust $pin. The crates need rustc $script:CrateRustFloor or newer (tauri-build 2.7.4 and tauri-utils 2.10.2). Fix the rustup error above, then run this again from the checkout."
        }
        $env:RUSTUP_TOOLCHAIN = $pin
        $need = $pin
    } else {
        $need = $script:CrateRustFloor
    }
    $have = Get-RustcRelease
    if (-not $have) {
        throw "rustc was not found. Install rustup from https://rustup.rs and run this again from the checkout. rust-toolchain.toml pins $pin. The crates need rustc $script:CrateRustFloor or newer."
    }
    if (-not (Test-VersionGe -Have $have -Need $need)) {
        throw "rustc $have is too old. The crates in src-tauri/Cargo.lock need rustc $script:CrateRustFloor or newer (tauri-build 2.7.4 and tauri-utils 2.10.2 set rust-version $script:CrateRustFloor). This checkout pins $pin in rust-toolchain.toml. Install rustup from https://rustup.rs and run this again from the checkout so rustup selects that toolchain. Cargo exits 101 when rustc is older than a crate's rust-version."
    }
    Write-Host "[ashlr-md] rustc $have meets the requirement ($need)."
}
