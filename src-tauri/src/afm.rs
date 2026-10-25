//! Apple Foundation Models bridge — spawns and communicates with the
//! `mdopener-afm` Swift sidecar via stdin/stdout JSON-Lines.
//!
//! **Platform availability: macOS only.**
//!
//! The AFM sidecar is a macOS-exclusive binary that requires Apple Silicon
//! and macOS 26+.  On Windows and Linux all public entry-points compile to
//! stubs that return `Ok(None)` / a clear unavailability error, so the
//! provider chain falls through to Ollama or cloud AI without any platform-
//! specific build machinery.
//!
//! The macOS implementation uses a long-lived sidecar process: it is spawned
//! lazily on the first call and kept alive.  Requests are serialised through
//! a Mutex so the sidecar only ever sees one request at a time, matching its
//! simple single-threaded request loop.
//!
//! Event protocol (JS listens on the same channels as ai.rs):
//!   "ai://delta"  { requestId: String, delta: String }
//!   "ai://done"   { requestId: String }
//!   "ai://error"  { requestId: String, error: String }

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

// `Emitter` (app.emit) is only used by the macOS streaming path.
#[cfg(target_os = "macos")]
use tauri::Emitter;

// ---------------------------------------------------------------------------
// Re-use the DeltaPayload / DonePayload / ErrorPayload types from ai.rs.
// They are not pub there, so we redefine the identical shapes here.
// Only the macOS streaming path emits them, so they exist only there.
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
#[derive(Clone, Serialize)]
struct DeltaPayload {
    #[serde(rename = "requestId")]
    request_id: String,
    delta: String,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Serialize)]
struct DonePayload {
    #[serde(rename = "requestId")]
    request_id: String,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Serialize)]
struct ErrorPayload {
    #[serde(rename = "requestId")]
    request_id: String,
    error: String,
}

// ---------------------------------------------------------------------------
// Message wire type (mirrors ai.rs::Msg and TypeScript AIMessage)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AfmMsg {
    pub role: String,
    pub content: String,
}

// ---------------------------------------------------------------------------
// Managed state — one definition used on all platforms so lib.rs can always
// call `app.manage(AfmState::default())` without cfg guards at the call site.
// ---------------------------------------------------------------------------

/// Tauri managed state for the AFM sidecar.
///
/// On non-macOS platforms the inner `Option` is always `None`; the mutex is
/// still present so the type is uniform across platforms.
///
/// The field is read only by the macOS sidecar code. It cannot be cfg-gated
/// without splitting the type (lib.rs manages `AfmState` on every platform),
/// so the unread-field lint is allowed off macOS only.
pub struct AfmState(
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub  std::sync::Mutex<Option<AfmStateInner>>,
);

impl Default for AfmState {
    fn default() -> Self {
        AfmState(std::sync::Mutex::new(None))
    }
}

// ---------------------------------------------------------------------------
// macOS-only internals
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod macos {
    //! macOS-only implementation: sidecar types, discovery, initialisation,
    //! and streaming generation.

    use std::io::{BufRead, BufReader, Write};
    use std::path::PathBuf;
    use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

    use serde::{Deserialize, Serialize};
    use tauri::{AppHandle, Emitter, Manager};

    use super::{AfmMsg, AfmState, DeltaPayload, DonePayload};

    // -----------------------------------------------------------------------
    // JSON-Lines types exchanged with the Swift sidecar
    // -----------------------------------------------------------------------

    /// The first line the sidecar writes on startup.
    #[derive(Deserialize)]
    pub(super) struct SidecarInit {
        pub available: bool,
        pub reason: Option<String>,
        pub model: Option<String>,
    }

    /// A request we write to the sidecar's stdin (one JSON line).
    #[derive(Serialize)]
    pub(super) struct SidecarRequest<'a> {
        pub id: &'a str,
        pub messages: &'a [AfmMsg],
        pub stream: bool,
    }

    /// Lines the sidecar writes per request.
    #[derive(Deserialize)]
    #[allow(dead_code)]
    pub(super) struct SidecarLine {
        pub id: Option<String>,
        pub delta: Option<String>,
        pub done: Option<bool>,
        pub error: Option<String>,
        // Fields present only in the init line — ignored after startup.
        pub available: Option<bool>,
        pub reason: Option<String>,
        pub model: Option<String>,
    }

    // -----------------------------------------------------------------------
    // Live sidecar process handle
    // -----------------------------------------------------------------------

    pub(crate) struct SidecarProcess {
        pub stdin: ChildStdin,
        pub stdout: BufReader<ChildStdout>,
        pub _child: Child, // kept alive; dropped when the app exits
        pub model_name: String,
    }

    // -----------------------------------------------------------------------
    // Inner state variant (macOS only)
    // -----------------------------------------------------------------------

    pub enum AfmStateInner {
        Available(SidecarProcess),
        Unavailable(String), // human-readable reason
    }

    // -----------------------------------------------------------------------
    // Sidecar binary discovery
    // -----------------------------------------------------------------------

    /// Find the `mdopener-afm` binary.
    ///
    /// Search order:
    ///   1. Next to the app bundle resources (production Tauri bundle).
    ///   2. `src-tauri/target/release/mdopener-afm` relative to the binary
    ///      (works for `tauri dev` which puts the Tauri binary in target/debug).
    ///   3. The same directory as the running Tauri binary (fallback).
    pub(super) fn find_sidecar_binary(app: &AppHandle) -> Option<PathBuf> {
        // 1. Tauri resource directory (production bundle).
        if let Ok(res_dir) = app.path().resource_dir() {
            let candidate = res_dir.join("mdopener-afm");
            if candidate.exists() {
                return Some(candidate);
            }
        }

        // 2. Relative to the running binary: go up to target/ root.
        if let Ok(exe) = std::env::current_exe() {
            if let Some(target_dir) = exe.parent().and_then(|p| p.parent()) {
                let candidate = target_dir.join("release").join("mdopener-afm");
                if candidate.exists() {
                    return Some(candidate);
                }
                // Same profile directory (release running from release/).
                if let Some(same_dir) = exe.parent() {
                    let candidate2 = same_dir.join("mdopener-afm");
                    if candidate2.exists() {
                        return Some(candidate2);
                    }
                }
            }
        }

        None
    }

    // -----------------------------------------------------------------------
    // Lazy sidecar initialisation
    // -----------------------------------------------------------------------

    /// Initialise the sidecar if not already done.
    /// Returns `Ok(model_name)` if available, `Err(reason)` if not.
    pub(super) fn ensure_sidecar(app: &AppHandle) -> Result<String, String> {
        let state = app.state::<AfmState>();
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;

        match &*guard {
            Some(AfmStateInner::Available(proc)) => return Ok(proc.model_name.clone()),
            Some(AfmStateInner::Unavailable(reason)) => return Err(reason.clone()),
            None => {} // fall through to init
        }

        // First call — spawn the sidecar.
        let bin = find_sidecar_binary(app).ok_or_else(|| {
            "mdopener-afm binary not found \
             (run src-tauri/bins/mdopener-afm/build.sh first)"
                .to_string()
        })?;

        let mut child = Command::new(&bin)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit()) // forward Swift stderr to Tauri's stderr
            .spawn()
            .map_err(|e| format!("Failed to spawn mdopener-afm: {e}"))?;

        let stdin = child.stdin.take().ok_or("sidecar has no stdin")?;
        let stdout_raw = child.stdout.take().ok_or("sidecar has no stdout")?;
        let mut stdout = BufReader::new(stdout_raw);

        // Read the mandatory init line.
        let mut init_line = String::new();
        stdout
            .read_line(&mut init_line)
            .map_err(|e| format!("Failed to read sidecar init line: {e}"))?;

        let init: SidecarInit = serde_json::from_str(init_line.trim())
            .map_err(|e| format!("Failed to parse sidecar init JSON: {e} (got: {init_line:?})"))?;

        if !init.available {
            let reason = init
                .reason
                .unwrap_or_else(|| "Apple Foundation Models unavailable".to_string());
            *guard = Some(AfmStateInner::Unavailable(reason.clone()));
            // Kill the sidecar (it may have already exited, but be tidy).
            let _ = child.wait();
            return Err(reason);
        }

        let model_name = init
            .model
            .unwrap_or_else(|| "Apple Foundation Models".to_string());

        *guard = Some(AfmStateInner::Available(SidecarProcess {
            stdin,
            stdout,
            _child: child,
            model_name: model_name.clone(),
        }));

        Ok(model_name)
    }

    // -----------------------------------------------------------------------
    // Streaming generation
    // -----------------------------------------------------------------------

    pub(super) async fn do_generate(
        app: AppHandle,
        messages: Vec<AfmMsg>,
        request_id: String,
    ) -> Result<(), String> {
        // Ensure the sidecar is running; this may block briefly on first call.
        ensure_sidecar(&app)?;

        let state = app.state::<AfmState>();
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;

        let proc = match &mut *guard {
            Some(AfmStateInner::Available(p)) => p,
            Some(AfmStateInner::Unavailable(r)) => {
                return Err(format!("Apple Foundation Models unavailable: {r}"))
            }
            None => return Err("afm sidecar not initialised".to_string()),
        };

        // Serialise the request as a single JSON line.
        let req = SidecarRequest {
            id: &request_id,
            messages: &messages,
            stream: true,
        };
        let mut req_line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
        req_line.push('\n');

        proc.stdin
            .write_all(req_line.as_bytes())
            .map_err(|e| format!("Failed to write to sidecar stdin: {e}"))?;
        proc.stdin
            .flush()
            .map_err(|e| format!("Failed to flush sidecar stdin: {e}"))?;

        // Read response lines until we see done=true or error.
        loop {
            let mut line = String::new();
            let n = proc
                .stdout
                .read_line(&mut line)
                .map_err(|e| format!("Failed to read from sidecar stdout: {e}"))?;

            if n == 0 {
                // Sidecar closed stdout unexpectedly.
                return Err("mdopener-afm sidecar closed stdout unexpectedly".to_string());
            }

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let parsed: SidecarLine = serde_json::from_str(trimmed).map_err(|e| {
                format!("Failed to parse sidecar response: {e} (line: {trimmed:?})")
            })?;

            // Only process lines belonging to this request.
            if parsed.id.as_deref() != Some(&request_id) {
                // Shouldn't happen (single-request serialisation), but skip safely.
                continue;
            }

            if let Some(delta) = parsed.delta {
                if !delta.is_empty() {
                    let _ = app.emit(
                        "ai://delta",
                        DeltaPayload {
                            request_id: request_id.clone(),
                            delta,
                        },
                    );
                }
            }

            if parsed.done == Some(true) {
                let _ = app.emit("ai://done", DonePayload { request_id });
                return Ok(());
            }

            if let Some(err) = parsed.error {
                return Err(err);
            }
        }
    }
} // mod macos

// ---------------------------------------------------------------------------
// AfmStateInner — visible to lib.rs manage() call on all platforms.
// On non-macOS, this is an empty uninhabited-style enum (never constructed).
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
pub use macos::AfmStateInner;

/// Stub `AfmStateInner` for non-macOS targets.
/// Never instantiated; present so `AfmState` compiles uniformly everywhere.
#[cfg(not(target_os = "macos"))]
pub enum AfmStateInner {
    // No variants — this enum is uninhabited on non-macOS.
    // The Mutex<Option<AfmStateInner>> in AfmState always holds None.
}

// ---------------------------------------------------------------------------
// Tauri commands — public API
// ---------------------------------------------------------------------------

/// Probe Apple Foundation Models availability.
///
/// Returns `Some(model_name)` if available, `None` if not.
/// On non-macOS this always returns `Ok(None)` so the provider chain falls
/// through to Ollama / cloud AI without error.
#[tauri::command]
pub async fn afm_detect(app: AppHandle) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        match macos::ensure_sidecar(&app) {
            Ok(name) => Ok(Some(name)),
            Err(reason) => {
                eprintln!("[afm] not available: {reason}");
                Ok(None) // provider chain falls through
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Suppress unused-variable warning; AppHandle is needed for the
        // macOS branch and must be present in the function signature.
        let _ = app;
        Ok(None) // AFM is macOS-only
    }
}

/// Stream a generation from Apple Foundation Models.
///
/// Results arrive via "ai://delta" / "ai://done" / "ai://error" Tauri events,
/// exactly matching the protocol used by `ai_generate` in ai.rs.
///
/// Returns `Ok(())` immediately after spawning the streaming task.
/// On non-macOS this always returns a clear `Err` explaining unavailability
/// so the caller can fall through to the next provider.
#[tauri::command]
pub async fn afm_generate(
    app: AppHandle,
    messages: Vec<AfmMsg>,
    request_id: String,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn(async move {
            if let Err(e) = macos::do_generate(app.clone(), messages, request_id.clone()).await {
                let _ = app.emit(
                    "ai://error",
                    ErrorPayload {
                        request_id,
                        error: e,
                    },
                );
            }
        });
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Suppress unused-variable warnings for the non-macOS stub.
        let _ = (app, messages, request_id);
        Err(
            "Apple Foundation Models are not available on this platform. \
             Use Ollama or a cloud AI provider instead."
                .to_string(),
        )
    }
}
