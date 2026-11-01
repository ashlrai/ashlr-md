# Releasing Ashlr MD

Complete runbook for cutting a release, managing artifacts, and updating
downstream distribution channels (Homebrew, winget, AUR).

---

## 1. Pre-release Checklist

Before tagging, complete every item:

- [ ] All CI checks passing on `main`.
- [ ] Update `version` in **`src-tauri/tauri.conf.json`** (e.g. `"0.2.0"`).
- [ ] Update `version` in **`src-tauri/Cargo.toml`** `[package]` section to match.
- [ ] Update `version` in **`package.json`** to match.
- [ ] Update **`CHANGELOG.md`**: add a section headed `## [X.Y.Z]`, an em dash and the
  date (`YYYY-MM-DD`), like the earlier releases' headings.
- [ ] Run `./scripts/generate-icons.sh` if `src-tauri/icons/icon.svg` changed.
- [ ] Commit all changes:
  ```bash
  git add src-tauri/tauri.conf.json src-tauri/Cargo.toml package.json CHANGELOG.md
  git commit -m "chore: release vX.Y.Z"
  ```

---

## 2. Cutting the Tag

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

This triggers `.github/workflows/release.yml`, which fans out across the full
build matrix and **uploads each platform's bundles as workflow artifacts**.

> **The workflow does NOT create the GitHub Release.** `release.yml` is
> build-only: it does not call the Release API or publish `latest.json`.
> A maintainer assembles and
> publishes the Release manually from the uploaded artifacts (see §4). Until
> that manual step is done, **no release exists and the updater sees nothing.**

> A pre-release tag is not automatically marked as a pre-release by this
> build-only workflow. Set the Release status explicitly when publishing.

---

## 3. What the Workflow Produces

The Tauri bundler names each file after `productName` (`Ashlr MD`), space
included, and the workflow uploads them under those names. The release
publishes them under the names in the last column, which the install guide,
the Homebrew cask, the winget manifest and the AUR PKGBUILD download (see §4,
step 4).

| Platform | Runner | Bundler output | Publish as |
|---|---|---|---|
| macOS arm64 | `macos-15` | `Ashlr MD_X.Y.Z_aarch64.dmg` | `Ashlr_MD_X.Y.Z_aarch64.dmg` |
| macOS x86_64 | `macos-15-intel` | `Ashlr MD_X.Y.Z_x64.dmg` | `Ashlr_MD_X.Y.Z_x64.dmg` |
| Linux x86_64 | `ubuntu-22.04` | `Ashlr MD_X.Y.Z_amd64.deb` | `Ashlr_MD_X.Y.Z_amd64.deb` |
| Linux x86_64 | `ubuntu-22.04` | `Ashlr MD-X.Y.Z-1.x86_64.rpm` | `Ashlr_MD_X.Y.Z_x86_64.rpm` |
| Linux x86_64 | `ubuntu-22.04` | `Ashlr MD_X.Y.Z_amd64.AppImage` | `Ashlr_MD_X.Y.Z_amd64.AppImage` |
| Windows x86_64 | `windows-latest` | `Ashlr MD_X.Y.Z_x64-setup.exe` (NSIS) | `Ashlr_MD_X.Y.Z_x64-setup.exe` |
| Windows x86_64 | `windows-latest` | `Ashlr MD_X.Y.Z_x64_en-US.msi` | `Ashlr_MD_X.Y.Z_x64_en-US.msi` |

The updater needs a signed artifact for each target, in addition to installer
bundles: macOS uses the `.app.tar.gz` archive and its `.sig` (not the DMG),
Linux uses the AppImage and its `.sig`, and Windows uses one selected signed
installer and its `.sig`. The two macOS archives must be distinguished by
architecture when staged. The workflow does **not** produce `latest.json`
or manifest fragments: the pinned `tauri-action` is called without a release ID
or tag name. Artifact upload runs even after failure and warns on missing files;
a successful upload does not prove the inventory is complete.

### Sidecar binaries per platform

| Binary | macOS | Linux | Windows |
|---|---|---|---|
| `mdopen` | yes | yes | yes (`.exe`) |
| `mdopener-mcp` | yes | yes | yes (`.exe`) |
| `mdopener-afm` (Swift) | yes | no | no |
| `mdopener-setdefault` (Swift) | yes | no | no |

> **macOS AFM sidecar risk:** `mdopener-afm` requires Xcode 26 / Swift 6.2+
> (macOS 26 SDK). The workflow selects the latest available Xcode via
> `maxim-lobanov/setup-xcode@v1`. Until GitHub-hosted runners carry Xcode 26,
> this sidecar may build against an older SDK or fail. See the comment block
> in `.github/workflows/release.yml` (the "Select latest Xcode" step) for
> mitigation steps. All other bundle artifacts are unaffected.

---

The release jobs use GitHub's native `macos-15` (ARM64) and
`macos-15-intel` (x86_64) runners, as listed in the
[official image architecture table](https://github.com/actions/runner-images#available-images).
This replaces [retired `macos-13`](https://github.blog/changelog/2025-09-19-github-actions-macos-13-runner-image-is-closing-down/)
and [`macos-14`, retiring November 2, 2026](https://github.blog/changelog/2026-10-01-github-actions-macos-14-runner-image-retirement/).
The prerequisite `ci.yml` macOS full-suite job also uses `macos-15`.

Both [ARM64](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-arm64-Readme.md#xcode)
and [Intel](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-Readme.md#xcode)
images include Xcode 26 and the macOS 26 SDK; the release workflow selects the
latest Xcode before building the host-native Rust and Swift sidecars. A successful
native build is still required; these runner selections do not certify signing or
runtime support.

## 4. Assembling & Publishing the GitHub Release

Because `release.yml` only uploads artifacts (see §2), a maintainer must
assemble and independently validate the release before publishing. Do not publish
if required evidence is missing. The local helper is a candidate, not yet
qualified on four actual artifacts from one eligible run. It does not publish.

1. Obtain the original, unmodified ZIP for each of the four workflow artifacts
   from the completed release run. Keep them in one directory, named
   `bundle-macos-15.zip`, `bundle-macos-15-intel.zip`,
   `bundle-ubuntu-22.04.zip` and `bundle-windows-latest.zip`. Do not substitute
   extracted files or ZIPs from another run. The helper queries GitHub's public
   API itself, binds the reviewed full SHA to the peeled tag and release run,
   checks the push event, successful full-CI gate, all four native jobs and
   their build/upload steps, and an exact-SHA manual CI run with successful
   Linux and macOS full-suite jobs. It compares each original ZIP's SHA-256 to
   the live API's artifact digest before privately and safely extracting it.
   GitHub API errors, expired/missing artifacts, mismatches or incomplete data
   stop assembly. Artifact metadata does not identify the producing job/attempt:
   **only release run attempt 1 is supported**. A rerun requires a separately
   designed job-bound proof; do not retag or bump a release just to pass this.

   On Linux x86-64, install Python 3.11+, Cargo, and the pinned Python dependency
   in an isolated environment:

   ```bash
   python3 -m venv /path/to/release-venv
   /path/to/release-venv/bin/pip install --require-hashes --only-binary=:all: -r scripts/release-assembly-requirements.txt
   ```

   Download the official [7-Zip 26.05 Linux x64 release](https://github.com/ip7z/7zip/releases/tag/26.05),
   verify its archive SHA-256 is
   `22cf82fcc6eb7474f1d5bb4f02c0f8ebd573a718089d6833dc30f8350a3b232e`,
   extract `7zz` into a local tools directory, and set `ASHLR_MD_7ZZ` to its
   absolute path. The helper checks the executable's SHA-256 too. Then run
   from this checkout, substituting the reviewed values and actual intended
   publication time. The output directory must not exist; its parent must be
   a trusted directory that already exists:

   ```bash
   /path/to/release-venv/bin/python scripts/assemble-updater.py /path/to/original-zips /path/to/new-output \
     --tag vX.Y.Z --source-sha <reviewed-full-sha> --run-id <release-run-id> \
     --pub-date YYYY-MM-DDTHH:MM:SSZ
   ```

   It verifies each staged updater signature using the public key fetched from
   the exact source SHA before inspecting payloads. It checks the Linux AppImage's
   embedded app ELF architecture, but not an embedded app version: Linux version
   evidence is the source-bound CI run and artifact provenance, not runtime
   version proof. `provenance.json` records run/SHA, artifact IDs and ZIP digests,
   and selected entry hashes. It supports stable three-component versions, thin
   macOS archives and the Windows NSIS `.exe` (not MSI). It does not stage DMGs,
   debs, RPMs or MSI installers, prove native OS signing/notarization, or exercise
   an app. Successful helper tests or output alone do not establish release readiness.

2. Match the exact source version in `src-tauri/tauri.conf.json`, `Cargo.toml`
   and `package.json`. Require exactly one updater pair per platform: macOS
   ARM `darwin-aarch64` and Intel `darwin-x86_64` `.app.tar.gz` archives,
   Linux `linux-x86_64` AppImage, and Windows `windows-x86_64` one explicitly
   selected `.exe` or `.msi` (the helper supports only NSIS `.exe`). Each
   needs its matching `.sig`. Reject missing,
   duplicate, wrong-version or wrong-platform assets. Inspect the actual
   artifact inventory rather than assuming names or manifest fragments.
3. Verify **each updater signature cryptographically** against the configured
   public key in `src-tauri/tauri.conf.json` using a trusted Tauri-compatible
   verifier. The helper preserves signature bytes and uses Tauri’s strict
   base64 decoding; it does not trim a trailing newline. The public v0.4.0
   Windows `.sig` observed during compatibility testing had none. A present
   `.sig` or a successful build is not verification. If a
   verifier is unavailable or any signature fails, stop; do not fabricate or
   reuse signatures. Never read or expose the private signing key for assembly.
4. Copy (do not rebuild or re-sign) assets to unique release names, including
   architecture-qualified macOS archives. Check hashes before and after each
   rename. Rename installers to the “Publish as” names in §3; preserve matching
   `.sig` files. Reject name collisions and check the intended download URLs.
5. Construct one `latest.json` with the source `version`, a truthful publication
   date and one entry for each of the four Tauri platform keys. Each entry's
   `signature` is the **contents** of its matching `.sig` file, not a URL;
   `url` points to the exact staged updater asset. Independently validate its
   version, platform set, signatures and URLs against the staged inventory.
6. Only with separate release authorization, create the GitHub Release for the
   tag, explicitly set pre-release status as appropriate, add the matching
   changelog notes, attach the validated staged assets and manifest, and publish.
   Verify the downloaded assets and manifest after publication.

Updater signatures are not Apple Developer ID signing/notarization or Windows
Authenticode. Verify those independently, along with native install, update and
UI behavior on each OS/architecture. The full CI suite covers Linux and macOS,
not Windows; successful CI is not evidence of Windows UI qualification. No
publication or platform qualification follows from assembling a manifest alone.

---

## 5. Post-release: Update the Homebrew Cask

The canonical cask template lives at `packaging/homebrew/ashlr-md.rb`.
The tap repo is **github.com/ashlrai/homebrew-ashlr-md**; create it if it
doesn't exist yet; place the cask at `Casks/ashlr-md.rb` in that repo.

```bash
# 1. Download the new DMG and compute its SHA-256
curl -L \
  "https://github.com/ashlrai/ashlr-md/releases/download/vX.Y.Z/Ashlr_MD_X.Y.Z_aarch64.dmg" \
  -o Ashlr_MD_X.Y.Z_aarch64.dmg
shasum -a 256 Ashlr_MD_X.Y.Z_aarch64.dmg

# 2. Clone the tap repo and update the cask
git clone https://github.com/ashlrai/homebrew-ashlr-md.git
cd homebrew-ashlr-md

# Edit Casks/ashlr-md.rb:
#   version "X.Y.Z"
#   sha256  "<output of shasum above>"

# 3. Commit and push
git add Casks/ashlr-md.rb
git commit -m "Cask update: ashlr-md X.Y.Z"
git push
```

Users install / upgrade with:
```bash
brew tap ashlrai/ashlr-md
brew install --cask ashlr-md
# upgrade:
brew upgrade --cask ashlr-md
```

---

## 6. Post-release: Update the winget Manifest

The manifest templates live at `packaging/winget/`.

```bash
# 1. Download the NSIS installer and compute its SHA-256
curl -L \
  "https://github.com/ashlrai/ashlr-md/releases/download/vX.Y.Z/Ashlr_MD_X.Y.Z_x64-setup.exe" \
  -o Ashlr_MD_X.Y.Z_x64-setup.exe

# macOS/Linux:
shasum -a 256 Ashlr_MD_X.Y.Z_x64-setup.exe
# Windows PowerShell:
# Get-FileHash "Ashlr_MD_X.Y.Z_x64-setup.exe" -Algorithm SHA256

# 2. Copy the three manifests to a versioned folder
mkdir -p manifests/a/ashlrai/AshlrMD/X.Y.Z
cp packaging/winget/ashlrai.AshlrMD.*.yaml \
   manifests/a/ashlrai/AshlrMD/X.Y.Z/

# 3. Replace <VERSION> and <SHA256_NSIS_EXE> in all three files

# 4. Validate locally (requires winget CLI or winget-create)
winget validate --manifest manifests/a/ashlrai/AshlrMD/X.Y.Z/

# 5. Fork https://github.com/microsoft/winget-pkgs and submit a PR
#    adding the three manifests under manifests/a/ashlrai/AshlrMD/X.Y.Z/
```

---

## 7. Post-release: Update the AUR Package

The PKGBUILD template lives at `packaging/linux/aur/PKGBUILD`.

```bash
# 1. Compute SHA-256 of the .deb
shasum -a 256 Ashlr_MD_X.Y.Z_amd64.deb

# 2. Update packaging/linux/aur/PKGBUILD:
#    pkgver=X.Y.Z
#    sha256sums=('<output of shasum above>')

# 3. Clone your AUR repo (first time: create the package at aur.archlinux.org)
git clone ssh://aur@aur.archlinux.org/ashlr-md.git aur-ashlr-md
cp packaging/linux/aur/PKGBUILD aur-ashlr-md/

# 4. Regenerate .SRCINFO (required by AUR)
cd aur-ashlr-md
makepkg --printsrcinfo > .SRCINFO

# 5. Test the build locally
makepkg -si

# 6. Push to AUR
git add PKGBUILD .SRCINFO
git commit -m "Update to X.Y.Z"
git push
```

---

## 8. GitHub Secrets Reference

| Secret | Used by | Required? |
|---|---|---|
| `GITHUB_TOKEN` | Read-only (build/artifacts); release is published manually, see §4 | Auto-provided |
| `TAURI_SIGNING_PRIVATE_KEY` | Updater `.sig` files | Yes (all legs) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Updater `.sig` files | Yes (all legs) |
| `APPLE_CERTIFICATE` | macOS code signing | Optional (unsigned DMG works) |
| `APPLE_CERTIFICATE_PASSWORD` | macOS code signing | Optional |
| `APPLE_SIGNING_IDENTITY` | macOS code signing | Optional |
| `APPLE_ID` | macOS notarization | Optional |
| `APPLE_PASSWORD` | macOS notarization | Optional |
| `APPLE_TEAM_ID` | macOS notarization | Optional |

### Generate the Tauri updater keypair (one-time)

```bash
bun run tauri signer generate -w ~/.tauri/ashlr-md.key
# → prints public key (add to tauri.conf.json `plugins.updater.pubkey`)
# → writes private key to ~/.tauri/ashlr-md.key
#   base64-encode and add as TAURI_SIGNING_PRIVATE_KEY secret
```

The updater pubkey is already set in `tauri.conf.json`; the private key must
be in `TAURI_SIGNING_PRIVATE_KEY` before the first real release.

---

## 9. Icon Generation

The canonical icon source is `src-tauri/icons/icon.svg`.

```bash
bun install            # if not already installed
./scripts/generate-icons.sh
git add src-tauri/icons/
git commit -m "chore: regenerate app icons"
```

---

## 10. Release Checklist Summary

- [ ] `src-tauri/tauri.conf.json` version bumped
- [ ] `src-tauri/Cargo.toml` version bumped
- [ ] `package.json` version bumped
- [ ] `CHANGELOG.md` updated
- [ ] Icons regenerated (if SVG changed)
- [ ] Version bump commit on `main`
- [ ] Tag `vX.Y.Z` pushed; workflow fires
- [ ] All four workflow legs green
- [ ] CI artifacts downloaded and renamed, `latest.json` assembled, Release published (§4)
- [ ] Homebrew tap cask updated (version + sha256)
- [ ] winget manifest PR submitted to `microsoft/winget-pkgs`
- [ ] AUR PKGBUILD updated and pushed
