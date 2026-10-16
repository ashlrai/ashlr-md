# Homebrew Cask — Ashlr MD
#
# TAP REPOSITORY
#   This file belongs in the tap repo:  github.com/ashlrai/homebrew-ashlr-md
#   Create that repo and put this file at:
#     Casks/ashlr-md.rb
#
# HOW THE INSTALL COMMAND RESOLVES
#   brew install --cask ashlrai/ashlr-md/ashlr-md
#   └── tap:    ashlrai/ashlr-md          → clones github.com/ashlrai/homebrew-ashlr-md
#   └── cask:   ashlr-md                  → reads Casks/ashlr-md.rb from that tap
#
# AFTER EACH RELEASE
#   1. Download the new .dmg from the GitHub Release.
#   2. Compute the sha256:
#        shasum -a 256 "Ashlr_MD_<VERSION>_aarch64.dmg"
#   3. Update `version` and `sha256` below.
#   4. Commit + push to the tap repo — Homebrew picks up the change automatically.
#
# AUDIT BEFORE PUBLISHING
#   brew audit --cask --online ashlrai/ashlr-md/ashlr-md
#
# LOCAL TESTING (before pushing to the tap)
#   brew install --cask ./packaging/homebrew/ashlr-md.rb
# ---------------------------------------------------------------------------

cask "ashlr-md" do
  # -------------------------------------------------------------------------
  # Release metadata — update both values for every new release.
  # -------------------------------------------------------------------------
  version "<VERSION>"        # e.g. "0.2.0"
  sha256  "<SHA256>"         # shasum -a 256 "Ashlr_MD_<VERSION>_aarch64.dmg"

  # -------------------------------------------------------------------------
  # Download URL
  # tauri-action produces the artifact name (productName "Ashlr MD", space -> _):
  #   Ashlr_MD_<version>_aarch64.dmg     (Apple Silicon / arm64)
  #   Ashlr_MD_<version>_x64.dmg         (Intel / x86_64)
  #
  # This cask targets Apple Silicon (aarch64). For a universal cask that
  # serves both architectures, use an `on_arm` / `on_intel` block:
  #
  #   on_arm do
  #     url "https://github.com/ashlrai/ashlr-md/releases/download/v#{version}/Ashlr_MD_#{version}_aarch64.dmg"
  #     sha256 "<SHA256_ARM64>"
  #   end
  #   on_intel do
  #     url "https://github.com/ashlrai/ashlr-md/releases/download/v#{version}/Ashlr_MD_#{version}_x64.dmg"
  #     sha256 "<SHA256_X64>"
  #   end
  # -------------------------------------------------------------------------
  url "https://github.com/ashlrai/ashlr-md/releases/download/v#{version}/Ashlr_MD_#{version}_aarch64.dmg",
      verified: "github.com/ashlrai/ashlr-md/"

  name "Ashlr MD"
  desc "AI-native Markdown viewer, editor, and exporter"
  homepage "https://github.com/ashlrai/ashlr-md"

  # -------------------------------------------------------------------------
  # Artifact
  # -------------------------------------------------------------------------
  app "Ashlr MD.app"

  # -------------------------------------------------------------------------
  # Bundled CLI binary (sidecar shipped inside the .app)
  # The sidecars ship in Contents/Resources (tauri.macos.conf.json).
  # -------------------------------------------------------------------------
  # binary "#{appdir}/Ashlr MD.app/Contents/Resources/mdopen"

  # -------------------------------------------------------------------------
  # Zap stanza — what `brew uninstall --zap ashlr-md` removes
  # Bundle ID: app.mdopener.desktop  (from tauri.conf.json `identifier`)
  # -------------------------------------------------------------------------
  zap trash: [
    "~/Library/Application Support/app.mdopener.desktop",
    "~/Library/Caches/app.mdopener.desktop",
    "~/Library/Preferences/app.mdopener.desktop.plist",
    "~/Library/Saved Application State/app.mdopener.desktop.savedState",
    "~/Library/WebKit/app.mdopener.desktop",
  ]

  # -------------------------------------------------------------------------
  # Post-install message
  # -------------------------------------------------------------------------
  caveats <<~EOS
    Ashlr MD has been installed to your Applications folder.

    To make Ashlr MD the default app for .md files:
      Right-click any .md file in Finder → Get Info → Open with →
      Change All… → select "Ashlr MD".

    The mdopen CLI sidecar ships inside the app bundle. You can symlink
    it to a directory on your PATH:
      ln -sf "/Applications/Ashlr MD.app/Contents/Resources/mdopen" \
             /usr/local/bin/mdopen
  EOS
end
