# Used by scripts/setup.sh. scripts/install.sh has its own rustc check.
# The pin is rust-toolchain.toml. The floor is the highest rust-version
# in src-tauri/Cargo.lock (tauri-build 2.7.4 and tauri-utils 2.10.2).

CRATE_RUST_FLOOR="1.90"

read_pinned_rustc() {
  local file="$1" line
  line=$(grep -E '^[[:space:]]*channel[[:space:]]*=' "$file" | head -n 1)
  line=${line#*=}
  line=${line//\"/}
  line=${line//\'/}
  line=${line//[[:space:]]/}
  printf '%s\n' "$line"
}

rustc_release() {
  local line
  line=$(rustc --version 2>/dev/null) || return 1
  printf '%s\n' "$line" | awk '{print $2}'
}

# True when $1 is a dotted version greater than or equal to $2.
version_ge() {
  local IFS=.
  local -a a b
  read -r -a a <<< "$1"
  read -r -a b <<< "$2"
  local i n=${#a[@]} x y
  if (( ${#b[@]} > n )); then n=${#b[@]}; fi
  for ((i = 0; i < n; i++)); do
    x=${a[i]:-0}
    y=${b[i]:-0}
    x=${x%%[^0-9]*}
    y=${y%%[^0-9]*}
    x=${x:-0}
    y=${y:-0}
    if ((10#$x > 10#$y)); then return 0; fi
    if ((10#$x < 10#$y)); then return 1; fi
  done
  return 0
}

# Install the pinned toolchain when rustup is present, then refuse a rustc
# that cannot build the crates. Expects info() and die().
require_rustc() {
  local root="$1" pin have need
  pin=$(read_pinned_rustc "$root/rust-toolchain.toml")
  if [[ -z "$pin" ]]; then
    die "rust-toolchain.toml has no channel. The crates need rustc ${CRATE_RUST_FLOOR} or newer."
  fi
  if command -v rustup >/dev/null 2>&1; then
    info "Installing Rust ${pin} from rust-toolchain.toml…"
    if ! rustup toolchain install "$pin" --profile minimal --component clippy,rustfmt; then
      die "rustup could not install Rust ${pin}. The crates need rustc ${CRATE_RUST_FLOOR} or newer (tauri-build 2.7.4 and tauri-utils 2.10.2). Fix the rustup error above, then run this again from the checkout."
    fi
    export RUSTUP_TOOLCHAIN="$pin"
    need="$pin"
  else
    need="$CRATE_RUST_FLOOR"
  fi
  if ! have=$(rustc_release); then
    die "rustc was not found. Install rustup from https://rustup.rs and run this again from the checkout. rust-toolchain.toml pins ${pin}. The crates need rustc ${CRATE_RUST_FLOOR} or newer."
  fi
  if ! version_ge "$have" "$need"; then
    die "rustc ${have} is too old. The crates in src-tauri/Cargo.lock need rustc ${CRATE_RUST_FLOOR} or newer (tauri-build 2.7.4 and tauri-utils 2.10.2 set rust-version ${CRATE_RUST_FLOOR}). This checkout pins ${pin} in rust-toolchain.toml. Install rustup from https://rustup.rs and run this again from the checkout so rustup selects that toolchain. Cargo exits 101 when rustc is older than a crate's rust-version."
  fi
  info "rustc ${have} meets the requirement (${need})."
}
