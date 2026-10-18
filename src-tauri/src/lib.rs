//! Ashlr MD — Tauri application entry point.

mod activity;
mod afm;
mod agent_setup;
mod ai;
mod base_urls;
mod cli_install;
mod deep_link;
mod default_handler;
mod doc_read;
mod document;
mod embed;
mod export;
mod export_path;
mod file_handler;
mod ipc;
mod phantom_refs;
mod run;
mod search;
mod secrets;
mod task_list;
mod watcher;

use std::sync::Mutex;

/// File paths opened before the frontend was ready, buffered for it to drain.
///
/// The window drains it on mount ([`file_handler::take_pending_files`]),
/// registers its `file-opened` listener, then says so and drains it once
/// more ([`file_handler::pending_files_listening`]); files opened after that
/// reach it through the live `file-opened` event only, so they are not
/// queued. Buffering used to stop at the first drain, so a file opened
/// between that drain and the listener being registered was lost.
#[derive(Default)]
pub struct PendingFiles(Mutex<PendingBuf>);

#[derive(Default)]
struct PendingBuf {
    files: Vec<String>,
    listening: bool,
}

impl PendingFiles {
    /// Buffer `paths` for the window, unless its `file-opened` listener is
    /// registered (then the event sent with them is what opens them).
    pub fn queue(&self, paths: impl IntoIterator<Item = String>) {
        let mut buf = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if !buf.listening {
            buf.files.extend(paths);
        }
    }

    /// The buffered paths, emptied. Later paths are still buffered until
    /// [`PendingFiles::listening`].
    pub fn take(&self) -> Vec<String> {
        let mut buf = self.0.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut buf.files)
    }

    /// The window's listener is registered: the paths buffered since the last
    /// [`PendingFiles::take`], emptied; from now on nothing is queued.
    pub fn listening(&self) -> Vec<String> {
        let mut buf = self.0.lock().unwrap_or_else(|e| e.into_inner());
        buf.listening = true;
        std::mem::take(&mut buf.files)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be the first plugin. A second launch (file manager open,
        // `xdg-open mdopener://…`) forwards its argv here and exits instead of
        // starting a rival process that would take over ~/.mdopener/ipc-port.
        // The `deep-link` feature routes mdopener:// URLs to `on_open_url`.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            file_handler::handle_second_instance(app, &argv, &cwd);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .manage(PendingFiles::default())
        .manage(deep_link::LinkViewModes::default())
        .manage(deep_link::LinkExports::default())
        .manage(watcher::FileWatcher::default())
        .manage(ipc::DocMirror::default())
        .manage(ipc::RecentMirror::default())
        .manage(ipc::ReviewState::default())
        .manage(ipc::VaultMirror::default())
        .manage(ipc::PendingEdits::default())
        .manage(ipc::PendingStreamEdits::default())
        .manage(ipc::PendingStreamEditsApply::default())
        .manage(ipc::SessionStore::default())
        .manage(afm::AfmState::default())
        .manage(activity::ActivityWatcher::default())
        .manage(embed::EmbedState::default())
        .invoke_handler(tauri::generate_handler![
            document::read_markdown_file,
            document::write_markdown_file,
            document::resolve_wikilink,
            document::detect_vault_root,
            document::open_in_obsidian,
            document::read_image_data_url,
            document::filter_existing,
            document::apply_file_patch,
            document::save_pasted_image,
            document::save_pasted_image_to_downloads,
            export::write_file_bytes,
            file_handler::take_pending_files,
            file_handler::pending_files_listening,
            deep_link::take_link_view_mode,
            deep_link::take_link_export,
            watcher::watch_file,
            watcher::unwatch_file,
            ai::ai_detect_ollama,
            ai::ai_generate,
            afm::afm_detect,
            afm::afm_generate,
            ipc::mcp_sync_state,
            ipc::mcp_sync_vault,
            ipc::mcp_edit_result,
            ipc::mcp_stream_edit_preview,
            ipc::mcp_stream_edit_apply_result,
            ipc::set_review_verdict,
            ipc::mcp_persist_session,
            ipc::mcp_load_session,
            cli_install::install_cli,
            run::run_shell,
            secrets::set_ai_key,
            secrets::get_ai_key,
            secrets::delete_ai_key,
            search::search_files,
            embed::embed_available,
            embed::embed_index,
            embed::embed_search,
            embed::embed_status,
            default_handler::is_default_md_handler,
            default_handler::default_handler_status,
            default_handler::set_default_md_handler,
            default_handler::open_default_apps_help,
            agent_setup::detect_agent_clis,
            agent_setup::connect_claude_code,
            agent_setup::connect_cursor,
            agent_setup::connect_codex,
            agent_setup::install_claude_hook,
            agent_setup::mcp_command_string,
            activity::watch_directory,
            activity::unwatch_directory,
            activity::list_markdown_files,
            activity::scan_markdown_files,
        ])
        .setup(|app| {
            file_handler::buffer_cli_args(app.handle());
            // Register the mdopener:// deep-link handler.
            deep_link::setup(app.handle());
            // Start the loopback IPC server for the MCP binary.
            match ipc::start(app.handle().clone()) {
                Ok(port) => eprintln!("[ipc] listening on 127.0.0.1:{port}"),
                Err(e) => eprintln!("[ipc] server failed to start: {e}"),
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Ashlr MD")
        .run(|_app_handle, event| match event {
            // macOS delivers Finder "open file" hand-offs via RunEvent::Opened.
            // Windows/Linux pass the path as argv instead (see buffer_cli_args),
            // and RunEvent::Opened doesn't exist there — so gate this arm.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => {
                file_handler::handle_opened(_app_handle, urls);
            }
            tauri::RunEvent::Exit => {
                // Remove the IPC port file so the MCP binary knows the app exited.
                ipc::remove_port_file();
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::PendingFiles;

    /// Paths opened while the app ran used to pile up in the buffer, which
    /// the window drains only at startup.
    #[test]
    fn pending_files_queue_only_until_the_window_listens() {
        let p = PendingFiles::default();
        p.queue(["/a.md".to_string()]);
        p.queue(["/b.md".to_string(), "/c.md".to_string()]);
        assert_eq!(p.take(), ["/a.md", "/b.md", "/c.md"]);
        assert!(p.listening().is_empty());
        p.queue(["/d.md".to_string()]);
        assert!(p.take().is_empty());
        assert!(p.listening().is_empty());
    }

    /// A file opened after the window drained the buffer but before its
    /// `file-opened` listener was registered was neither buffered nor heard.
    #[test]
    fn pending_files_keep_what_opens_before_the_listener_is_registered() {
        let p = PendingFiles::default();
        p.queue(["/a.md".to_string()]);
        assert_eq!(p.take(), ["/a.md"]);
        p.queue(["/b.md".to_string()]);
        assert_eq!(p.listening(), ["/b.md"]);
        p.queue(["/c.md".to_string()]);
        assert!(p.listening().is_empty());
    }
}
