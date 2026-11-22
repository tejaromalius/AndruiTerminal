pub mod actions;
pub mod adb;
pub mod capabilities;
pub mod compact;
pub mod config;
pub mod error;
pub mod events;
pub mod helper;
pub mod hierarchy;
pub mod marks;
pub mod matcher;
pub mod ocr;
pub mod recorder;
pub mod replay;
pub mod screenshot;
pub mod session;
pub mod state;

pub use config::ExtensionsConfig;
pub use state::AppState;

use axum::{
    extract::DefaultBodyLimit,
    routing::{delete, get, post},
    Router,
};

/// Public router entrypoint for the AndruiTerminal automation extension.
/// Paths are full `/api/v1/automation/...` so root can merge router directly.
pub fn router(config: ExtensionsConfig) -> Router {
    let state = AppState::new(config);
    router_with_state(state)
}

/// Router builder with pre-configured state (useful for tests and companion sharing).
pub fn router_with_state(state: AppState) -> Router {
    Router::new()
        // Capabilities
        .route(
            "/api/v1/automation/capabilities",
            get(capabilities::get_capabilities),
        )
        // Helper session lifecycle
        .route(
            "/api/v1/automation/sessions",
            post(session::create_session).get(session::list_sessions),
        )
        .route(
            "/api/v1/automation/sessions/{id}",
            get(session::get_session).delete(session::delete_session),
        )
        // Helper APK status, confirmed install, and functional checks
        .route(
            "/api/v1/automation/helper/status",
            get(helper::get_helper_status),
        )
        .route(
            "/api/v1/automation/helper/install",
            post(helper::install_helper),
        )
        .route(
            "/api/v1/automation/helper/uninstall",
            post(helper::uninstall_helper),
        )
        .route(
            "/api/v1/automation/helper/checks",
            get(helper::run_helper_checks),
        )
        // Live hierarchy & fallback dump
        .route(
            "/api/v1/automation/hierarchy",
            get(hierarchy::get_hierarchy),
        )
        // Semantic actions
        .route("/api/v1/automation/actions", post(actions::execute_action))
        // Accessibility events WebSocket stream
        .route("/api/v1/automation/events", get(events::stream_events))
        // Screenshot binary PNG
        .route(
            "/api/v1/automation/screenshot",
            get(screenshot::get_screenshot),
        )
        // OCR via host Tesseract with explicit 25MiB limit to support documented 20MB images
        .route(
            "/api/v1/automation/ocr",
            post(ocr::run_ocr).layer(DefaultBodyLimit::max(25 * 1024 * 1024)),
        )
        // Normalized template matching with explicit 25MiB limit to support documented 20MB images
        .route(
            "/api/v1/automation/match",
            post(matcher::run_template_match).layer(DefaultBodyLimit::max(25 * 1024 * 1024)),
        )
        // Action recording
        .route(
            "/api/v1/automation/recordings/start",
            post(recorder::start_recording),
        )
        .route(
            "/api/v1/automation/recordings/{id}/stop",
            post(recorder::stop_recording),
        )
        .route(
            "/api/v1/automation/recordings",
            get(recorder::list_recordings),
        )
        .route(
            "/api/v1/automation/recordings/{id}",
            get(recorder::get_recording),
        )
        // Replay & WebSocket step stream
        .route("/api/v1/automation/replay", post(replay::start_replay))
        .route(
            "/api/v1/automation/replays/{id}",
            delete(replay::cancel_replay),
        )
        .route(
            "/api/v1/automation/replays/{id}/events",
            get(replay::stream_replay_events),
        )
        .with_state(state)
}

/// Cleanup all active automation sessions and persistent replays.
/// Call this from companion shutdown handlers to ensure all active replays are cancelled,
/// and all owned adb forwards and child processes terminate.
pub async fn cleanup_all_sessions(state: &AppState) {
    // 1. Cancel all persistent replays on shutdown
    {
        let replays = state.active_replays.read().await;
        for sender in replays.values() {
            let _ = sender.send(true);
        }
    }

    // 2. Stop all active sessions
    let session_ids: Vec<String> = {
        let sessions = state.sessions.read().await;
        sessions.keys().cloned().collect()
    };

    for id in session_ids {
        let _ = session::stop_session_internal(state, &id).await;
    }
}
