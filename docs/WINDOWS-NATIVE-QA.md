# Original MD 0.5 Windows qualification

The owner approved this bounded manual Windows install, synthetic document probe, and uninstall job on 2026-11-02. It is not a release promotion, update, notarization, or Windows trust certification.

## Fixed inputs and evidence

The separate `native-qa-windows.yml` workflow uses a standard public `windows-2022` runner, with job-only `contents: read` and `actions: read`. The existing Linux job remains unchanged. No input selects arbitrary source, run, URL, installer or command. Original source is `721b976149ad402cac56205f28bf253603f76535`, release run is `41362219024`, and the original Windows ZIP artifact is `13105824003`.

Preparation reuses the reviewed bounded, fixed-repository metadata API and four-leg provenance checks. All four original ZIP digests are checked, but this job repeats only the Windows NSIS updater signature verification. The exact ZIP member is `release/bundle/nsis/Ashlr MD_0.5.0_x64-setup.exe`; its SHA-256 is `a9009b3dcde484bab7f5d334411a1b014ce20450d1cdf82c6853decb98af8ca6`. The installed `md-opener.exe` must match the original signed installer's embedded PE SHA-256 `9e1e16c40fd6109e0a1e88694c3113dc0ca61f42ee3e3dced2ccd550df902ff1`. That hash was obtained from the retained qualified original NSIS using pinned 7-Zip 26.05, not a rebuild. MSI is present but not exercised.

The preparation token exists only in its step, with no display or application process. The later worker receives an explicit environment allowlist and synthetic HOME, USERPROFILE, APPDATA, LOCALAPPDATA and temporary-directory environment values. Windows KnownFolder API consumers may still use the actual runner profile: the disposable hosted account, not environment variables alone, is the state-isolation boundary. Staging inherits the trusted disposable runner user's Windows ACL; POSIX mode bits are not represented as Windows access control, and this is not a hostile same-user sandbox. Reparse paths and existing staging are rejected. No credentials or personal documents are inputs.

## Installer and native probe

The original Tauri CLI 2.11.2 configuration has no Windows installer override; its default NSIS mode is current-user. The runner must have no existing Ashlr MD uninstall registration. `/S /NS /D=<owned path>` runs the normal silent installer without shortcuts or autorun. The final `/D=` path is deliberately unquoted as required by NSIS. No `/NCRC`, elevation, policy change, UAC or SmartScreen bypass is used. An unexpected prompt or security denial is a failure, not permission to suppress it.

Before installation, the machine WebView2 Runtime registry version must be present and nonzero, and the selected EdgeDriver must match its first three version components. The existing `EDGEWEBDRIVER` is preferred; only the fixed, verified compatibility fallback below may replace it for this probe. Missing or otherwise mismatched dependencies fail before installation; there is no runtime download. Pinned `tauri-driver` 2.1.0 uses that explicit native driver. Actual hosted compatibility remains to be established; listing versions is not a native test pass.

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

## Pinned compatibility fallback

The observed hosted machine has WebView2 `131.0.2903.86` while its bundled
EdgeDriver is `156.0.4314.42`. The token-free preflight may download only
`https://msedgedriver.microsoft.com/131.0.2903.86/edgedriver_win64.zip`, and only
for the `131.0.2903` runtime build. It does not install or update WebView2.
The archive SHA-256 is
`16ad3ea073e26f0000d1315e0a851eeb44b2754c66d47652e265cce5dea662af`;
the extracted executable SHA-256 is
`c34a6b22814a18599f2a67bef922ba879ae44158f216d4d2df797d293f545665`.
These identify independently retrieved official bytes, not an official checksum feed.
Before executing even `--version`, Windows must validate the executable's
Authenticode status, exact Microsoft Corporation signer and code-signing EKU.
The download has no proxy, redirects, artifact token or dynamic version lookup;
archive inventory, sizes and digests are checked before exclusive extraction.
A separate exclusively created runner-temporary directory is cleaned by the
always-run cleanup step, including after a partial download. The native worker
never downloads a driver: it rechecks the retained digest, signature and version.
An unsupported runtime fails closed. This does not establish the application's
Authenticode reputation or relax SmartScreen, UAC, certificate or TLS settings.

Signature verification allows up to 90 seconds within the unchanged two-minute
preflight step. Fixed stage markers distinguish shell startup, trust-check entry
and trust-check return. Diagnostics include only those markers, elapsed time,
a recognized signature status (otherwise `unknown`), and signer/EKU match booleans;
never raw PowerShell output or certificate contents. A timeout remains failure, not evidence of an invalid signature
or permission to execute. Certificate/revocation checks are not disabled.
While the pinned archive downloads, a best-effort `Get-AuthenticodeSignature`
on the runner's bundled Microsoft driver runs concurrently with no captured
output; it only warms cold machine CTL/chain caches so the pinned check is
usually local, is never consulted, and is always terminated before provisioning
returns. The pinned driver's own full verification and its bound are unchanged.

## Failure diagnostics

A failed exact-content check now additionally reports only bounded synthetic
window state: title (128 characters), location origin/path (256, no query or
fragment), ready state, Tauri-presence and root booleans, body text (512), and
article/frame counts capped at 100. The unchanged content oracle still decides
success; diagnostic observations cannot make a wrong document pass.
Tauri driver 2.1.0 maps `tauri:options.args` to Edge `ms:edgeOptions.args`, which
Microsoft documents as application arguments when launching WebView2. Original
721b source buffers CLI paths at setup and drains them after frontend mount.
These contracts do not prove the cause of the observed empty heading/paragraph.
Cleanup errors report only the failed owned relative path and file-type,
read-only/reparse flags. As in merged #640, owned regular files and directories
may have only their DOS read-only bit cleared after WinError 5 from removal, then
that same removal is retried once. Other attributes remain unchanged. This covers
shell-folder parents and metadata files such as desktop.ini without guessing each
successive folder name. The helper itself requires one of the two fixed, selected
artifact/driver staging roots and validates its canonical nonreparse identity.
Root itself, escaping paths, reparse targets/ancestors, other errors and special
file types cannot trigger attribute changes. No ACL/security-policy change occurs.
A failed retry remains a failed cleanup. Tests cover the complete synthetic shell
folder chain as an example, regular-file cleanup, and root/containment negatives.

Before creating a WebDriver session, the probe verifies that the original installer
left no running instance of the exact installed executable inside its owned job.
This mandatory guard uses `QueryInformationJobObject` (complete list, maximum 256)
and `QueryFullProcessImageNameW` with limited-query handles, not PowerShell/CIM.
Windows case-insensitive image comparison is applied only to the qualified installed
path; handles are closed and incomplete/failed inspection remains a failure.
Before artifact preparation, a token-free optional CIM self-query checks availability
with the unchanged 20-second budget. Only timeout/exit/launch/shape failure classes
are reported, never captured output. Unavailable argv diagnostics do not block the
original DOM scenario. If available, the later query selects one verified owned PID,
rechecks identity/job membership after querying, and parses its command line with
the Windows API. No unsupported remote-memory/PEB inspection is used.
Only the argument count and exact/prefixed/quoted synthetic-fixture match booleans
are printed. Raw arguments, process environment and unrelated processes are never
logged. A missing or ambiguous observation is reported as unavailable, not proof
that the app received its file. The exact startup content oracle remains unchanged;
no second launch, UI bypass or application IPC injection substitutes for it.

## Distinct real Open-file UI scenario

Run 41404877693 passed installation, original PE identity, native window launch,
uninstall and staging cleanup, but the startup fixture was not opened. The optional
CIM query timed out, so delivery of the CLI argument remains unproven. This failure
must not be relabeled as a successful CLI startup test.

The bounded additional scenario uses the original app's visible **Open a file**
button (`src/components/Welcome.tsx` at original 721b) through standard WebDriver
Element Click. Its original `src/lib/openFile.ts` handler opens the real Tauri native
Markdown picker. No script invokes an app API or changes the document store.
Built-in .NET UI Automation then selects only the verified owned app PID's unique
modal `#32770` dialog among immediate desktop children, not desktop descendants.
Within that dialog it requires the unique enabled filename Edit control identified
by automation ID 1148 (or its ComboBox parent), writable ValuePattern and exact path
readback, followed by the unique enabled Button ID 1 and InvokePattern. These
native control IDs/patterns are expectations to qualify, not already observed proof;
missing or ambiguous controls fail closed without another input technique.

Assembly availability is checked token-free before artifact preparation. No tool,
service, UIAccess permission, Developer Mode, input-injection fallback or execution
policy change is added. The helper receives only the owned PID/app and canonical
synthetic fixture/ready paths. Its complete subprocess lifetime is bounded at 60
seconds, including startup, with a 30-second readiness ceiling and 25-second dialog
polling window. The unchanged 300-second worker ceiling still applies to the whole
scenario; timeouts kill the helper, and existing owned-Job cleanup/uninstall remains.
No private desktop text, full tree, raw argv or provider error is logged.

After real UI selection, the unchanged exact heading/Unicode DOM oracle and fixture
integrity assertion must pass. Logs and the temporary `scenario-results.json`
separately distinguish failed CLI startup from a passed real-Open UI scenario. A job
that passes this added scenario does not establish CLI correctness or release readiness.

References: [WebDriver Element Click](https://www.w3.org/TR/webdriver/#element-click),
[Microsoft UIA file dialogs](https://learn.microsoft.com/en-us/windows/apps/dev-tools/winapp-cli/ui-automation#file-dialog-interaction),
[ValuePattern](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.valuepattern.setvalue),
[InvokePattern](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/invoke-a-control-using-ui-automation).
