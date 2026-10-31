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

> **The workflow does NOT create the GitHub Release.** The org disables
> `GITHUB_TOKEN` write access, so `release.yml` is build-only: it never calls
> the Release API and never publishes `latest.json`. A maintainer assembles and
> publishes the Release manually from the uploaded artifacts (see §4). Until
> that manual step is done, **no release exists and the updater sees nothing.**

> **Pre-release tags:** any tag containing a hyphen (`v0.2.0-beta.1`) sets
> `prerelease: true` automatically. Use this for testing the pipeline without
> shipping to stable update channels.

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

Each bundle comes with its updater `.sig` file where the updater signs it.

Each leg uploads a platform-specific entry to the Tauri updater manifest.
After all four legs complete, `latest.json` in the release contains aggregated
entries for every platform; this is what `tauri-plugin-updater` polls.

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

Because `release.yml` only uploads artifacts (see §2), you assemble the Release
yourself with your own credentials:

1. Open the completed workflow run at **github.com/ashlrai/ashlr-md/actions**
   and **download every leg's uploaded artifacts** (the `.dmg`/`.deb`/
   `.AppImage`/`.exe`/`.msi` bundles, their `.sig` files, and each leg's updater
   manifest fragment).
2. **Assemble `latest.json`** by merging the per-platform updater entries from
   every leg into one manifest (`version`, `pub_date`, and a `platforms` map of
   `{ signature, url }` per target). The `url` of each entry must point at the
   renamed asset you upload in step 5.
3. Create a new Release at **github.com/ashlrai/ashlr-md/releases/new** for the
   `vX.Y.Z` tag (mark it pre-release for hyphenated tags). Paste the matching
   `CHANGELOG.md` section as the notes.
4. **Rename each bundle to its "Publish as" name in §3** (the space in
   `Ashlr MD` becomes `_`, and the `.rpm` becomes `Ashlr_MD_X.Y.Z_x86_64.rpm`),
   and each `.sig` to match. Uploaded as built, GitHub turns the space into a
   `.` (`Ashlr.MD_X.Y.Z_amd64.deb`), and every download link in the docs and
   packaging templates 404s.
5. Attach all renamed bundles **and** the assembled `latest.json` as release
   assets, then **Publish**.

Publishing makes `latest.json` live at the updater endpoint; existing installs
prompt to update on next launch. (If you later automate this, a PAT with
`contents:write` in the workflow would let `tauri-action` create the Release
directly and this manual step goes away.)

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
