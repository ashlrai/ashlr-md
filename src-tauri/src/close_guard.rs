//! Ask before a window with unsaved edits closes.
//!
//! The window reports whether any tab holds unsaved edits
//! ([`close_guard_set_unsaved`]). A close request (the title-bar button,
//! Alt+F4, ⌘W) while it does is held: the window is sent
//! [`CLOSE_REQUEST_EVENT`] with a request id, acknowledges it at once
//! ([`close_guard_ack`]), asks the user (save all, close without saving,
//! cancel) and answers with [`close_guard_resolve`].
//!
//! It fails safe: a window that never said it had unsaved edits closes as
//! before, and one that does not acknowledge a request within [`ACK_TIMEOUT`]
//! (a hung or crashed page, an old frontend without the guard) is closed
//! anyway, so the guard can never leave a window that will not close. The
//! frontend keeps a copy of unsaved text for the next launch, so even that
//! close keeps the edits.
//!
//! Rust holds the close (not a JavaScript `onCloseRequested` listener),
//! because a listener that throws or never returns would leave the window
//! unable to close.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tauri::{Emitter, Manager, Runtime, State, Window, WindowEvent};

/// How long the window has to acknowledge a close request before it is
/// closed without asking.
pub const ACK_TIMEOUT: Duration = Duration::from_millis(1500);

/// The event a held close request sends to the window, with its id.
pub const CLOSE_REQUEST_EVENT: &str = "close-guard://request";

#[derive(Default)]
struct GuardState {
    unsaved: bool,
    next_id: u64,
    pending: Option<Pending>,
    /// A close was allowed: later requests pass (the window is going away).
    closing: bool,
}

struct Pending {
    id: u64,
    acked: bool,
}

/// What to do with a close request.
#[derive(Debug, PartialEq, Eq)]
pub enum OnClose {
    /// Let the window close.
    Close,
    /// Hold the close and ask the window, which must acknowledge this id.
    Ask(u64),
    /// Hold the close: an earlier request is waiting for its acknowledgement,
    /// and closes the window if none comes.
    Wait,
}

/// The close guard's state, shared with the acknowledgement timer threads.
#[derive(Default, Clone)]
pub struct CloseGuard(Arc<Mutex<GuardState>>);

impl CloseGuard {
    fn lock(&self) -> MutexGuard<'_, GuardState> {
        // Every field is valid after any single update: a panic elsewhere
        // must not stop the window closing.
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The window has (or no longer has) unsaved edits.
    pub fn set_unsaved(&self, unsaved: bool) {
        self.lock().unsaved = unsaved;
    }

    /// A close was requested.
    pub fn request(&self) -> OnClose {
        let mut s = self.lock();
        if s.closing || !s.unsaved {
            return OnClose::Close;
        }
        if matches!(&s.pending, Some(p) if !p.acked) {
            return OnClose::Wait;
        }
        // No request in flight, or one the window is already asking about
        // (asked again so a window whose prompt went away still answers).
        s.next_id += 1;
        let id = s.next_id;
        s.pending = Some(Pending { id, acked: false });
        OnClose::Ask(id)
    }

    /// The window acknowledged request `id`. False when it is not the one
    /// pending (answered, or already closed by the timer).
    pub fn ack(&self, id: u64) -> bool {
        let mut s = self.lock();
        match &mut s.pending {
            Some(p) if p.id == id => {
                p.acked = true;
                true
            }
            _ => false,
        }
    }

    /// The acknowledgement window of request `id` ran out: true when it was
    /// never acknowledged, and the window must now close.
    pub fn expire(&self, id: u64) -> bool {
        let mut s = self.lock();
        if matches!(&s.pending, Some(p) if p.id == id && !p.acked) {
            s.pending = None;
            s.closing = true;
            return true;
        }
        false
    }

    /// The window answered request `id`: true when the window must close now.
    /// An answer to a request that is no longer pending changes nothing.
    pub fn resolve(&self, id: u64, close: bool) -> bool {
        let mut s = self.lock();
        if !matches!(&s.pending, Some(p) if p.id == id) {
            return false;
        }
        s.pending = None;
        if close {
            s.closing = true;
        }
        close
    }
}

/// Handle a close request: true when the close must be held. `ask` sends
/// the request to the window (false when it could not be sent, and the
/// window closes); `destroy` closes the window, run when no
/// acknowledgement arrives within `timeout`.
pub fn handle_close_request(
    guard: &CloseGuard,
    ask: impl FnOnce(u64) -> bool,
    destroy: impl FnOnce() + Send + 'static,
    timeout: Duration,
) -> bool {
    match guard.request() {
        OnClose::Close => false,
        OnClose::Wait => true,
        OnClose::Ask(id) => {
            if !ask(id) {
                guard.expire(id);
                return false;
            }
            let guard = guard.clone();
            let spawned = std::thread::Builder::new()
                .name("close-guard".into())
                .spawn(move || {
                    std::thread::sleep(timeout);
                    if guard.expire(id) {
                        destroy();
                    }
                });
            if spawned.is_err() {
                // No timer, no hold: a window that cannot be closed is worse.
                return false;
            }
            true
        }
    }
}

/// The builder's window-event hook.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    let Some(guard) = window.try_state::<CloseGuard>() else {
        return;
    };
    let guard = guard.inner().clone();
    let target = window.clone();
    let doomed = window.clone();
    let hold = handle_close_request(
        &guard,
        |id| target.emit(CLOSE_REQUEST_EVENT, id).is_ok(),
        move || {
            if let Err(e) = doomed.destroy() {
                eprintln!("[close-guard] could not close the window: {e}");
            }
        },
        ACK_TIMEOUT,
    );
    if hold {
        api.prevent_close();
    }
}

/// The window has (or no longer has) unsaved edits.
#[tauri::command]
pub fn close_guard_set_unsaved(guard: State<'_, CloseGuard>, unsaved: bool) {
    guard.set_unsaved(unsaved);
}

/// The window is asking the user about close request `id`.
#[tauri::command]
pub fn close_guard_ack(guard: State<'_, CloseGuard>, id: u64) -> bool {
    guard.ack(id)
}

/// The user's answer to close request `id`: close the window, or keep it.
#[tauri::command]
pub fn close_guard_resolve<R: Runtime>(
    window: Window<R>,
    guard: State<'_, CloseGuard>,
    id: u64,
    close: bool,
) -> Result<(), String> {
    if guard.resolve(id, close) {
        window.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;

    const SHORT: Duration = Duration::from_millis(20);

    #[test]
    fn a_window_without_unsaved_edits_closes() {
        let g = CloseGuard::default();
        assert_eq!(g.request(), OnClose::Close);
        g.set_unsaved(true);
        g.set_unsaved(false);
        assert_eq!(g.request(), OnClose::Close);
    }

    #[test]
    fn unsaved_edits_hold_the_close_until_the_window_answers() {
        let g = CloseGuard::default();
        g.set_unsaved(true);
        let OnClose::Ask(id) = g.request() else {
            panic!("expected Ask")
        };
        assert!(g.ack(id));
        // Cancel keeps the window, and a later close asks again.
        assert!(!g.resolve(id, false));
        let OnClose::Ask(id2) = g.request() else {
            panic!("expected Ask")
        };
        assert_ne!(id, id2);
        assert!(g.ack(id2));
        assert!(g.resolve(id2, true));
        // Closing now: nothing more is held.
        assert_eq!(g.request(), OnClose::Close);
    }

    #[test]
    fn an_unacknowledged_request_expires_and_closes() {
        let g = CloseGuard::default();
        g.set_unsaved(true);
        let OnClose::Ask(id) = g.request() else {
            panic!("expected Ask")
        };
        // A second click while waiting does not start a second request.
        assert_eq!(g.request(), OnClose::Wait);
        assert!(g.expire(id));
        assert!(!g.ack(id), "too late to acknowledge");
        assert_eq!(g.request(), OnClose::Close);
    }

    #[test]
    fn an_acknowledged_request_does_not_expire() {
        let g = CloseGuard::default();
        g.set_unsaved(true);
        let OnClose::Ask(id) = g.request() else {
            panic!("expected Ask")
        };
        assert!(g.ack(id));
        assert!(!g.expire(id));
        // Clicking close again while the prompt is up asks again, with a
        // new acknowledgement window (a prompt that went away closes).
        let OnClose::Ask(id2) = g.request() else {
            panic!("expected Ask")
        };
        assert!(!g.resolve(id, true), "a stale answer changes nothing");
        assert!(g.expire(id2));
    }

    #[test]
    fn a_stale_or_unknown_answer_changes_nothing() {
        let g = CloseGuard::default();
        assert!(!g.resolve(7, true));
        assert!(!g.ack(7));
        g.set_unsaved(true);
        assert!(matches!(g.request(), OnClose::Ask(_)));
    }

    #[test]
    fn a_poisoned_lock_still_answers() {
        let g = CloseGuard::default();
        g.set_unsaved(true);
        let g2 = g.clone();
        let _ = std::thread::spawn(move || {
            let _held = g2.0.lock().unwrap();
            panic!("poison");
        })
        .join();
        assert!(matches!(g.request(), OnClose::Ask(_)));
    }

    #[test]
    fn handle_close_request_closes_when_the_window_cannot_be_asked() {
        let g = CloseGuard::default();
        g.set_unsaved(true);
        let destroyed = Arc::new(AtomicUsize::new(0));
        let d = destroyed.clone();
        let hold = handle_close_request(
            &g,
            |_| false,
            move || {
                d.fetch_add(1, Ordering::SeqCst);
            },
            SHORT,
        );
        assert!(!hold, "the close goes ahead");
        std::thread::sleep(SHORT * 3);
        assert_eq!(destroyed.load(Ordering::SeqCst), 0, "no second close");
        assert_eq!(g.request(), OnClose::Close);
    }

    #[test]
    fn handle_close_request_destroys_a_window_that_never_acknowledges() {
        let g = CloseGuard::default();
        g.set_unsaved(true);
        let (tx, rx) = mpsc::channel();
        let hold = handle_close_request(&g, |_| true, move || tx.send(()).unwrap(), SHORT);
        assert!(hold);
        rx.recv_timeout(Duration::from_secs(5))
            .expect("the window is closed after the timeout");
    }

    #[test]
    fn handle_close_request_waits_for_an_acknowledged_answer() {
        let g = CloseGuard::default();
        g.set_unsaved(true);
        let (tx, rx) = mpsc::channel();
        let asked = Arc::new(Mutex::new(None));
        let a = asked.clone();
        let hold = handle_close_request(
            &g,
            move |id| {
                *a.lock().unwrap() = Some(id);
                true
            },
            move || tx.send(()).unwrap(),
            SHORT,
        );
        assert!(hold);
        let id = asked.lock().unwrap().expect("asked");
        assert!(g.ack(id));
        assert!(
            rx.recv_timeout(SHORT * 5).is_err(),
            "an acknowledged request is not closed by the timer"
        );
        assert!(g.resolve(id, true));
    }

    #[test]
    fn handle_close_request_passes_a_clean_window() {
        let g = CloseGuard::default();
        let hold = handle_close_request(
            &g,
            |_| panic!("a clean window is not asked"),
            || panic!("nor destroyed"),
            SHORT,
        );
        assert!(!hold);
    }
}
