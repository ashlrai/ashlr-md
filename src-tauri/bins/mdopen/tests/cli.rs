//! Process-level checks of the `mdopen` binary's informational flags.

use std::process::Command;

/// The app version the sidecar ships with.
fn app_version() -> String {
    let conf: serde_json::Value =
        serde_json::from_str(include_str!("../../../tauri.conf.json")).unwrap();
    conf["version"].as_str().unwrap().to_string()
}

#[test]
fn version_prints_the_app_version_and_exits_0() {
    for flag in ["--version", "-V"] {
        let out = Command::new(env!("CARGO_BIN_EXE_mdopen"))
            .arg(flag)
            .output()
            .unwrap();
        assert!(out.status.success(), "{flag}: {out:?}");
        let stdout = String::from_utf8(out.stdout).unwrap();
        assert_eq!(stdout.trim(), format!("mdopen {}", app_version()), "{flag}");
        assert_eq!(
            env!("CARGO_PKG_VERSION"),
            app_version(),
            "crate version drifted from the app"
        );
    }
}

#[test]
fn help_exits_0() {
    let out = Command::new(env!("CARGO_BIN_EXE_mdopen"))
        .arg("--help")
        .output()
        .unwrap();
    assert!(out.status.success());
    assert!(String::from_utf8(out.stdout).unwrap().contains("--version"));
}
