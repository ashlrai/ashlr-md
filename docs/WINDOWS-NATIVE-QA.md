# Original MD 0.5 Windows qualification

The owner approved this bounded manual Windows install, synthetic document probe, and uninstall job on 2026-11-02. It is not a release promotion, update, notarization, or Windows trust certification.

## Fixed inputs and evidence

The separate `native-qa-windows.yml` workflow uses a standard public `windows-2022` runner, with job-only `contents: read` and `actions: read`. The existing Linux job remains unchanged. No input selects arbitrary source, run, URL, installer or command. Original source is `721b976149ad402cac56205f28bf253603f76535`, release run is `41362219024`, and the original Windows ZIP artifact is `13105824003`.

Preparation reuses the reviewed bounded, fixed-repository metadata API and four-leg provenance checks. All four original ZIP digests are checked, but this job repeats only the Windows NSIS updater signature verification. The exact ZIP member is `release/bundle/nsis/Ashlr MD_0.5.0_x64-setup.exe`; its SHA-256 is `a9009b3dcde484bab7f5d334411a1b014ce20450d1cdf82c6853decb98af8ca6`. The installed `md-opener.exe` must match the original signed installer's embedded PE SHA-256 `9e1e16c40fd6109e0a1e88694c3113dc0ca61f42ee3e3dced2ccd550df902ff1`. That hash was obtained from the retained qualified original NSIS using pinned 7-Zip 26.05, not a rebuild. MSI is present but not exercised.

The preparation token exists only in its step, with no display or application process. The later worker receives an explicit environment allowlist and synthetic HOME, USERPROFILE, APPDATA, LOCALAPPDATA and temporary-directory environment values. Windows KnownFolder API consumers may still use the actual runner profile: the disposable hosted account, not environment variables alone, is the state-isolation boundary. Staging inherits the trusted disposable runner user's Windows ACL; POSIX mode bits are not represented as Windows access control, and this is not a hostile same-user sandbox. Reparse paths and existing staging are rejected. No credentials or personal documents are inputs.

## Installer and native probe

The original Tauri CLI 2.11.2 configuration has no Windows installer override; its default NSIS mode is current-user. The runner must have no existing Ashlr MD uninstall registration. `/S /NS /D=<owned path>` runs the normal silent installer without shortcuts or autorun. The final `/D=` path is deliberately unquoted as required by NSIS. No `/NCRC`, elevation, policy change, UAC or SmartScreen bypass is used. An unexpected prompt or security denial is a failure, not permission to suppress it.

Before installation, the machine WebView2 Runtime registry version must be present and nonzero, and the runner's existing `EDGEWEBDRIVER` binary must match its first three version components. Missing or mismatched dependencies fail before installation: there is no runtime or driver download fallback. Pinned `tauri-driver` 2.1.0 uses that explicit native driver. Actual hosted compatibility remains to be established; listing versions is not a native test pass.

The worker joins a non-inherited Windows Job Object with kill-on-close before spawning any installer, driver or application. A token-free supervisor bounds the entire worker at 300 seconds; worker exit or termination closes its final job handle and kills descendants. Nested-job assignment failures abort before installation. The Windows-only synthetic regression checks actual child and grandchild termination. Individual installer and WebDriver calls also have timeouts; no POSIX signal/alarm assumptions are used.

The application receives the real synthetic Markdown file through startup arguments. The same Linux-qualified read-only DOM script checks the exact heading and Unicode paragraph inside `article.reading-surface`, excluding only its heading-link button from a cloned heading. It does not inject document content or invoke private app internals. The file must remain unchanged. At most bounded synthetic DOM fields and an 8 KiB driver-log tail are printed on failure.

## Cleanup and limits

Uninstall runs in the worker's `finally` block and again if needed in an always-run cleanup step under a separate 90-second owned-job bound. `/S _?=<owned install path>` avoids the uninstaller's copy-and-relaunch behavior. Success requires the app executable and uninstall registration to be absent; the remaining uninstaller may then be removed with owned staging. Failed uninstall leaves evidence and fails the job rather than claiming cleanup. Abrupt runner loss is ultimately contained by disposal of the hosted VM, not a claimed successful uninstaller run.

Stable metadata must still identify 0.4. The app's read-only update check is permitted; no update dialog is accepted, feed changed, package promoted or provider action requested. This job does not establish MSI behavior, SmartScreen reputation, Authenticode trust, macOS behavior, file-association interactions, upgrade/rollback, or successful Windows execution before the actual run completes. Standard public-runner compute is free; no larger runner, paid service, artifact upload or cache is introduced.

## Sources

- [Tauri external WebDriver setup](https://v2.tauri.app/develop/tests/webdriver/manual-setup/)
- [Microsoft WebView2 WebDriver matching](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/webdriver)
- [Microsoft Runtime distribution and detection](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)
- [Original CLI 2.11.2 NSIS template](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.2/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)
- [NSIS command-line syntax](https://nsis.sourceforge.io/Docs/Chapter3.html)
- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
