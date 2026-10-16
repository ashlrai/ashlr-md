//! The packaging templates (Homebrew cask, AUR PKGBUILD, winget manifest,
//! .desktop entry) must name the files the Tauri bundler really produces, or
//! every download 404s. Tauri names release assets
//! `<productName with spaces as _>_<version>_<arch>.<ext>` and installs the
//! Linux binary under the app crate's Cargo package name.

fn conf(text: &str) -> serde_json::Value {
    serde_json::from_str(text).unwrap()
}

/// `Ashlr_MD` for productName `Ashlr MD`.
fn asset_prefix() -> String {
    let c = conf(include_str!("../../../tauri.conf.json"));
    c["productName"].as_str().unwrap().replace(' ', "_")
}

/// The app crate's package name, which is the Linux binary name (`md-opener`).
fn app_binary() -> String {
    let manifest = include_str!("../../../Cargo.toml");
    let pkg = manifest.split("[package]").nth(1).unwrap();
    let line = pkg
        .lines()
        .find(|l| l.trim_start().starts_with("name"))
        .unwrap();
    line.split('"').nth(1).unwrap().to_string()
}

const CASK: &str = include_str!("../../../../packaging/homebrew/ashlr-md.rb");
const PKGBUILD: &str = include_str!("../../../../packaging/linux/aur/PKGBUILD");
const WINGET: &str = include_str!("../../../../packaging/winget/ashlrai.AshlrMD.installer.yaml");
const DESKTOP: &str = include_str!("../../../../packaging/linux/app.mdopener.desktop.desktop");

#[test]
fn templates_download_the_real_asset_names() {
    let p = asset_prefix();
    assert_eq!(p, "Ashlr_MD");
    let cask_url = format!("/{p}_#{{version}}_aarch64.dmg\"");
    assert!(
        CASK.contains(&format!(
            "url \"https://github.com/ashlrai/ashlr-md/releases/download/v#{{version}}{cask_url}"
        )),
        "cask url"
    );
    assert!(
        PKGBUILD.contains(&format!("/v${{pkgver}}/{p}_${{pkgver}}_amd64.deb\"")),
        "PKGBUILD source"
    );
    assert!(
        WINGET.contains(&format!("/v<VERSION>/{p}_<VERSION>_x64-setup.exe\"")),
        "winget InstallerUrl"
    );
    for (name, text) in [("cask", CASK), ("PKGBUILD", PKGBUILD), ("winget", WINGET)] {
        // Tauri never emits a `.` in place of the space, nor a lowercase deb.
        assert!(
            !text.contains("Ashlr.MD_"),
            "{name} still names Ashlr.MD_ assets"
        );
        assert!(
            !text.contains("ashlr-md_"),
            "{name} still names ashlr-md_ assets"
        );
    }
}

#[test]
fn templates_point_at_the_installed_binaries() {
    let bin = app_binary();
    assert_eq!(bin, "md-opener");
    assert!(
        PKGBUILD.contains(&format!("chmod +x \"${{pkgdir}}/usr/bin/{bin}\"")),
        "PKGBUILD chmod"
    );
    assert!(
        DESKTOP.contains(&format!("\nExec={bin} %F\n")),
        "desktop Exec"
    );
    assert!(DESKTOP.contains(&format!("\nIcon={bin}\n")), "desktop Icon");

    // macOS sidecars are bundle resources (Contents/Resources), not MacOS/.
    let mac = conf(include_str!("../../../tauri.macos.conf.json"));
    assert!(mac["bundle"]["resources"]
        .get("target/release/mdopen")
        .is_some());
    assert!(
        CASK.contains("\"/Applications/Ashlr MD.app/Contents/Resources/mdopen\""),
        "cask caveat"
    );
    assert!(
        !CASK.contains("Contents/MacOS/mdopen"),
        "cask still uses Contents/MacOS/mdopen"
    );
}
