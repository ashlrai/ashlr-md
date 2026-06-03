# Homebrew Cask for Ashlr MD
#
# -----------------------------------------------------------------------
# STATUS: TEMPLATE — not yet submitted to homebrew-cask.
#
# Before using this cask:
#   1. Replace OWNER with the actual GitHub organization or username
#      (e.g. "ashlrai" or your personal handle).
#   2. After publishing a signed + notarized GitHub Release, update
#      `version` and `sha256` to match that release.
#   3. Verify the DMG filename matches what tauri-action produces
#      (typically "MD.Opener_<version>_aarch64.dmg" for Apple Silicon).
#   4. Run `brew audit --cask md-opener` and fix any warnings before
#      submitting to homebrew-cask.
# -----------------------------------------------------------------------
#
# To install from this local file during development:
#   brew install --cask ./docs/homebrew/md-opener.rb
#
# To install from your own tap (e.g. OWNER/homebrew-tap):
#   brew tap OWNER/tap
#   brew install --cask md-opener
# -----------------------------------------------------------------------

cask "md-opener" do
  # -----------------------------------------------------------------------
  # Release metadata
  # Update these two values for every new release.
  # -----------------------------------------------------------------------
  version "0.1.0"
  sha256  "REPLACE_WITH_SHA256_OF_DMG"   # shasum -a 256 <file>.dmg

  # -----------------------------------------------------------------------
  # Download URL
  # tauri-action names the artefact: MD.Opener_<version>_aarch64.dmg
  # Replace OWNER with your GitHub username / org.
  # -----------------------------------------------------------------------
  url "https://github.com/OWNER/md-opener/releases/download/v#{version}/MD.Opener_#{version}_aarch64.dmg",
      verified: "github.com/OWNER/md-opener/"

  name "Ashlr MD"
  desc "AI-native Markdown viewer, editor, and exporter"
  homepage "https://github.com/OWNER/md-opener"

  # -----------------------------------------------------------------------
  # Artifact stanza
  # Adjust the .app name if it differs from "Ashlr MD.app".
  # -----------------------------------------------------------------------
  app "Ashlr MD.app"

  # -----------------------------------------------------------------------
  # CLI tools bundled with the app (optional — remove if not shipping these
  # as part of the cask).
  # If Ashlr MD installs `mdopen` to ~/Library/Application Support, you can
  # expose it via a binary stanza instead:
  #   binary "#{appdir}/Ashlr MD.app/Contents/MacOS/mdopen"
  # -----------------------------------------------------------------------

  # -----------------------------------------------------------------------
  # File associations (informational — macOS registers these via the .app)
  # -----------------------------------------------------------------------

  # -----------------------------------------------------------------------
  # Zap stanza: what to remove on `brew uninstall --zap`
  # -----------------------------------------------------------------------
  zap trash: [
    "~/Library/Application Support/app.mdopener.desktop",
    "~/Library/Caches/app.mdopener.desktop",
    "~/Library/Preferences/app.mdopener.desktop.plist",
    "~/Library/Saved Application State/app.mdopener.desktop.savedState",
    "~/Library/WebKit/app.mdopener.desktop",
  ]

  # -----------------------------------------------------------------------
  # Caveats shown after installation
  # -----------------------------------------------------------------------
  caveats <<~EOS
    Ashlr MD was installed to your Applications folder.

    To open Markdown files with Ashlr MD by default, right-click any .md
    file in Finder → Get Info → Open with → Change All → select Ashlr MD.

    The `mdopen` CLI tool (if included) can be installed separately via:
      bun add -g @md-opener/cli    # (if published to npm)
      # or use the built-in CLI installer from the app's Settings panel.
  EOS
end
