use std::net::SocketAddr;
use tower_http::services::{ServeDir, ServeFile};

use crate::error::{ApiError, ApiResult};
use crate::server::router::create_router;
use crate::server::state::AppState;

pub async fn run_native_server(bind_addr: SocketAddr, state: AppState) -> ApiResult<()> {
    if !bind_addr.ip().is_loopback() {
        return Err(ApiError::bad_request(
            "NON_LOOPBACK_BIND_REJECTED",
            format!(
                "Binding to non-loopback address {} is disallowed. AndruiTerminal is a local-only workstation and requires a loopback address (127.0.0.1 or ::1).",
                bind_addr
            ),
        ));
    }

    let mut router = create_router(state.clone());

    if let Some(ref web_dir) = state.web_dir {
        if web_dir.exists() {
            let index_file = web_dir.join("index.html");
            let serve_dir = ServeDir::new(web_dir).not_found_service(ServeFile::new(index_file));
            router = router.fallback_service(serve_dir);
        }
    }

    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .map_err(|e| {
            ApiError::internal(
                "BIND_FAILED",
                format!("Failed to bind TCP listener to {}: {}", bind_addr, e),
            )
        })?;

    tracing::info!("Native server listening on http://{}", bind_addr);

    let auto_rev_state = state.clone();
    let auto_rev_port = listener
        .local_addr()
        .map(|a| a.port())
        .unwrap_or(bind_addr.port());
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            interval.tick().await;
            let Ok(targets) = auto_rev_state
                .db
                .read_value::<Vec<String>>(crate::server::router::AUTO_REVERSE_DB_KEY)
            else {
                continue;
            };
            if targets.is_empty() {
                continue;
            }
            let Ok(devices) = auto_rev_state.device_tracker.list_devices().await else {
                continue;
            };
            for dev in devices {
                if dev.state != "device" || !targets.iter().any(|id| id == &dev.id) {
                    continue;
                }
                if let Ok(false) = crate::server::router::is_host_reverse_active(
                    &auto_rev_state.adb_executor,
                    &dev.id,
                    auto_rev_port,
                )
                .await
                {
                    let _ = crate::server::router::set_host_reverse(
                        &auto_rev_state.adb_executor,
                        &dev.id,
                        auto_rev_port,
                        true,
                    )
                    .await;
                }
            }
        }
    });

    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(super::shutdown_signal())
    .await
    .map_err(|e| ApiError::internal("SERVER_ERROR", format!("Server error: {}", e)))?;

    Ok(())
}
