pub mod adb;
pub mod config;
pub mod error;
pub mod protocol;
pub mod routes;
pub mod session;

pub use config::MediaConfig;
pub use error::MediaError;
pub use routes::{
    build_screen_router, build_screen_router_with_state, cleanup_all_sessions, router_with_state,
    screen_router_with_state, AppState,
};
pub use session::{
    CreateSessionRequest, CreateSessionResponse, ScreenSession, SessionCapabilities, SessionStore,
};

use axum::Router;

/// Public integration router routing full `/api/v1/screen/...`
pub fn router(config: MediaConfig) -> Router {
    Router::new().nest("/api/v1/screen", routes::build_screen_router(config))
}

/// Un-nested router providing `/capture`, `/screenshot`, `/capabilities`, `/sessions`, etc.
pub fn screen_router(config: MediaConfig) -> Router {
    routes::build_screen_router(config)
}
