# Releasing Ashlr MD

This document covers the full release pipeline: icon generation, GitHub Secrets
configuration, the auto-updater, and the Homebrew cask.

---

## 1. Generate the App Icon

The canonical source is `src-tauri/icons/icon.svg`.
The helper script delegates to Tauri's built-in icon generator:

```bash
# Install deps if you haven't already
bun install

# Run the icon generator (reads icon.svg → writes all PNGs, .icns, .ico)
./scripts/generate-icons.sh
```

The script will:
1. Rasterise `icon.svg` → `src-tauri/icons/icon-source.png` (1024 × 1024) using
   `rsvg-convert` if available, or `sips` on macOS as a fallback.
2. Call `bun run tauri icon src-tauri/icons/icon-source.png` which generates
   every required size automatically.

To install `rsvg-convert` (best quality SVG renderer):

```bash
brew install librsvg
```

After regenerating, commit the updated icons:

```bash
git add src-tauri/icons/
git commit -m "chore: regenerate app icons"
```

---

## 2. Required GitHub Repository Secrets

Add these secrets under **Settings → Secrets and variables → Actions** in your
GitHub repository.

### Always Required

| Secret | Description |
|--------|-------------|
| _(none — `GITHUB_TOKEN` is automatic)_ | GitHub provides this automatically for release creation |

### Tauri Auto-Updater Signing (needed before shipping updates)

| Secret | Description |
|--------|-------------|
| `TAURI_SIGNING_PRIVATE_KEY` | Base64-encoded Tauri updater private key (see §4) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the updater private key (can be empty string if you chose no password) |

### Apple Code Signing (macOS — optional, requires Apple Developer account)

> **Note:** Code signing and notarization require an **Apple Developer Program**
> membership ($99/year). Without these secrets the workflow still runs and
> produces a working (unsigned) DMG — perfect for forks and pre-release testing.

| Secret | Description |
|--------|-------------|
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` Developer ID Application certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the `.p12` file |
| `APPLE_SIGNING_IDENTITY` | Full certificate name, e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | Apple ID email used for notarization (e.g. `you@example.com`) |
| `APPLE_PASSWORD` | App-specific password generated at appleid.apple.com |
| `APPLE_TEAM_ID` | 10-character Apple Team ID from developer.apple.com |

#### How to export the certificate as base64

```bash
# Export from Keychain Access as a .p12, then:
base64 -i DeveloperIDApplication.p12 | pbcopy
# Paste as the value of APPLE_CERTIFICATE
```

---

## 3. Triggering a Release

The release workflow fires on any tag matching `v*`.

```bash
# Bump the version in src-tauri/tauri.conf.json and package.json first, then:
git tag v0.1.0
git push origin v0.1.0
```

The workflow will:
1. Compile the `mdopen` and `mdopener-mcp` sidecar binaries.
2. Build the Tauri app (signed + notarized if secrets are present).
3. Create a **draft** GitHub Release with the DMG attached.
4. Review the draft, add release notes, then click **Publish**.

### Testing the workflow (unsigned, no Apple account needed)

Push a pre-release tag on a fork or feature branch:

```bash
git tag v0.1.0-test
git push origin v0.1.0-test
```

Because the tag contains a hyphen, `tauri-action` sets `prerelease: true`.
The workflow will build without signing secrets — verify the DMG is produced
correctly before wiring up your Apple credentials.

---

## 4. Auto-Updater Integration

> **All changes in this section must be made manually.**
> The code snippets below are provided for reference — do NOT edit the config
> files directly from this document.
> These require the `TAURI_SIGNING_PRIVATE_KEY` secret to be set before
> enabling in production.

### 4a. Generate the Tauri updater signing keypair

Run once per project (keep the private key safe — loss means you can't ship
signed updates):

```bash
bun run tauri signer generate -w ~/.tauri/md-opener.key
```

This prints a **public key** and writes a **private key** file.

- Add the **private key** (the file content) as `TAURI_SIGNING_PRIVATE_KEY` in
  GitHub Secrets (base64-encode it first if the CLI instructs you to).
- Add the **public key** to `tauri.conf.json` (see below).

### 4b. tauri.conf.json additions

Add the following inside the top-level JSON object. Replace `YOUR_PUBLIC_KEY`
with the output of `bun run tauri signer generate`:

```jsonc
// Inside tauri.conf.json → top-level:
{
  // ... existing config ...

  "bundle": {
    // ... existing bundle config ...
    "createUpdaterArtifacts": true   // <-- add this line
  },

  "plugins": {
    // ... existing plugins (deep-link, etc.) ...
    "updater": {
      "active": true,
      "pubkey": "YOUR_PUBLIC_KEY_HERE",
      "endpoints": [
        "https://github.com/OWNER/md-opener/releases/latest/download/latest.json"
      ],
      "dialog": true,
      "windows": {
        "installMode": "passive"
      }
    }
  }
}
```

> Replace `OWNER/md-opener` with your actual GitHub org/user and repo name.

### 4c. Cargo.toml addition

In `src-tauri/Cargo.toml`, add to `[dependencies]`:

```toml
tauri-plugin-updater = "2"
```

### 4d. lib.rs addition

In `src-tauri/src/lib.rs`, register the updater plugin in the builder chain:

```rust
tauri::Builder::default()
    // ... existing plugins ...
    .plugin(tauri_plugin_updater::Builder::new().build())
    // ...
```

### 4e. JS/TS package addition

```bash
bun add @tauri-apps/plugin-updater
```

Then import and use in your frontend where you want to offer update checks:

```ts
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export async function checkForUpdates() {
  const update = await check();
  if (update?.available) {
    await update.downloadAndInstall();
    await relaunch();
  }
}
```

---

## 5. Homebrew Cask

A cask template is at `docs/homebrew/md-opener.rb`.

Once a signed, notarized release is published:
1. Update `version`, `sha256`, and the `url` in the cask file.
2. Submit a PR to [homebrew-cask](https://github.com/Homebrew/homebrew-cask)
   or maintain your own tap (`homebrew-tap` repo).

To get the SHA256 of a published DMG:

```bash
curl -L https://github.com/OWNER/md-opener/releases/download/vX.Y.Z/MD.Opener_X.Y.Z_aarch64.dmg \
  | shasum -a 256
```

---

## 6. Checklist for Each Release

- [ ] Update `version` in `src-tauri/tauri.conf.json`
- [ ] Update `version` in `package.json`
- [ ] Update `CHANGELOG.md`
- [ ] Run `./scripts/generate-icons.sh` if the icon changed
- [ ] Commit everything, tag `vX.Y.Z`, push
- [ ] Wait for the release workflow to complete
- [ ] Review and publish the draft GitHub Release
- [ ] Update `docs/homebrew/md-opener.rb` with new version + SHA256
