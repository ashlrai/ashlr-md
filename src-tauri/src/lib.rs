//! Ashlr MD — Tauri application entry point.

mod activity;
mod afm;
mod agent_setup;
mod ai;
mod cli_install;
mod deep_link;
mod default_handler;
mod document;
mod embed;
mod export;
mod file_handler;
mod ipc;
mod run;
mod search;
mod secrets;
mod watcher;

use std::sync::Mutex;

/// File paths opened before the frontend was ready, buffered for it to drain.
#[derive(Default)]
pub struct PendingFiles(pub Mutex<Vec<String>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .manage(PendingFiles::default())
        .manage(watcher::FileWatcher::default())
        .manage(ipc::DocMirror::default())
        .manage(ipc::RecentMirror::default())
        .manage(ipc::ReviewState::default())
        .manage(afm::AfmState::default())
        .manage(activity::ActivityWatcher::default())
        .manage(embed::EmbedState::default())
        .invoke_handler(tauri::generate_handler![
            document::read_markdown_file,
            document::write_markdown_file,
            document::resolve_wikilink,
            document::filter_existing,
            export::write_file_bytes,
            file_handler::take_pending_files,
            watcher::watch_file,
            watcher::unwatch_file,
            ai::ai_detect_ollama,
            ai::ai_generate,
            afm::afm_detect,
            afm::afm_generate,
            ipc::mcp_sync_state,
            ipc::set_review_verdict,
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
