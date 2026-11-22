use clap::{Parser, Subcommand};
use std::{net::SocketAddr, path::PathBuf};
use tracing_subscriber::{
    fmt::writer::BoxMakeWriter, layer::SubscriberExt, util::SubscriberInitExt,
};

mod mcp;
mod workflow_cli;

use andrui_core::{
    adb::{device_tracker::DeviceTracker, executor::AdbExecutor},
    files::service::FileService,
    jobs::manager::JobManager,
    security::session::SessionStore,
    server::{native::run_native_server, state::AppState},
    shell::manager::ShellManager,
    storage::{artifacts::ArtifactStore, db::Database},
    workflows::runner::WorkflowRunner,
};

/// Printed once at server start, so it lands at the top of `journalctl --user -u andrui-terminal`.
const BOOT_BANNER: &str = concat!(
    r"
    \         /
     \  ___  /
      .'     '.
     |  o   o  |     AndruiTerminal v",
    env!("CARGO_PKG_VERSION"),
    r"
     |  > _    |     Local Android workbench. Phone not included.
      '-------'
"
);

#[derive(Parser, Debug)]
#[command(
    name = "andrui-terminal",
    version,
    about = "Android workstation application server"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Run the application server
    Serve {
        /// Socket address to bind (e.g. 127.0.0.1:8080 or 0.0.0.0:8080)
        #[arg(long, default_value = "127.0.0.1:8080")]
        bind: SocketAddr,

        /// Path to official adb executable
        #[arg(long, default_value = "adb")]
        adb: PathBuf,

        /// Optional pinned scrcpy server jar
        #[arg(long)]
        scrcpy_server: Option<PathBuf>,

        /// Optional built Andrui automation helper APK
        #[arg(long)]
        helper_apk: Option<PathBuf>,

        /// Path to data directory for SQLite storage and artifacts
        #[arg(long, default_value = "./data")]
        data_dir: PathBuf,

        /// Path to compiled frontend assets (e.g. web/dist)
        #[arg(long)]
        web_dir: Option<PathBuf>,
    },
    /// Run a saved workflow through the local server and print JSON or JUnit results
    Workflow {
        id: String,
        #[arg(long, required = true, value_delimiter = ',')]
        devices: Vec<String>,
        #[arg(long, default_value = "http://127.0.0.1:19801")]
        server: String,
        #[arg(long)]
        confirmed: bool,
        #[arg(long)]
        junit: bool,
    },
    /// Run a Model Context Protocol server on stdio that forwards to a running server
    Mcp {
        /// Base URL of the running AndruiTerminal server
        #[arg(long, default_value = "http://127.0.0.1:19801")]
        server: String,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    // MCP uses stdout for JSON-RPC, so its logs go to stderr without colors.
    let is_mcp = matches!(
        cli.command,
        Commands::Mcp { .. } | Commands::Workflow { .. }
    );
    let writer = if is_mcp {
        BoxMakeWriter::new(std::io::stderr)
    } else {
        BoxMakeWriter::new(std::io::stdout)
    };
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,andrui_terminal=debug,andrui_core=debug".into()),
        )
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(writer)
                .with_ansi(!is_mcp),
        )
        .init();

    match cli.command {
        Commands::Serve {
            bind,
            adb,
            data_dir,
            helper_apk,
            scrcpy_server,
            web_dir,
        } => {
            if !bind.ip().is_loopback() {
                eprintln!(
                    "Error: Binding to non-loopback address {} is disallowed. AndruiTerminal is a local-only workstation and requires a loopback address (127.0.0.1 or ::1).",
                    bind
                );
                std::process::exit(1);
            }
            println!("{BOOT_BANNER}");
            tracing::info!("Starting AndruiTerminal on {}", bind);
            tokio::fs::create_dir_all(&data_dir).await?;
            let db_path = data_dir.join("andrui.db");
            let db = Database::new(&db_path)?;
            let mut settings = db.get_settings()?;
            settings.adb_path = adb.to_string_lossy().into_owned();
            settings.data_dir = data_dir.to_string_lossy().into_owned();
            db.save_settings(&settings)?;
            let artifact_store = ArtifactStore::new(&data_dir);
            artifact_store.init().await?;

            let adb_executor = AdbExecutor::new(&adb);
            let device_tracker = DeviceTracker::new(adb_executor.clone());
            let job_manager = JobManager::new(adb_executor.clone(), db.clone())
                .with_artifacts(artifact_store.clone());
            let shell_manager = ShellManager::new(adb.clone());
            let file_service = FileService::new(adb_executor.clone());
            job_manager.set_default_timeout_ms(settings.default_timeout_ms);
            let session_store = SessionStore::new();

            let automation =
                andrui_core::automation::AppState::new(andrui_core::automation::ExtensionsConfig {
                    adb_path: adb.clone(),
                    data_dir: data_dir.clone(),
                    helper_apk,
                });
            let job_manager = job_manager
                .with_device_locks(automation.device_startup_locks.clone())
                .with_automation(automation.clone());
            let workflow_runner = WorkflowRunner::new(job_manager.clone(), db.clone());
            let media = andrui_core::media::AppState {
                config: andrui_core::media::MediaConfig {
                    adb_path: adb.clone(),
                    data_dir: data_dir.clone(),
                    scrcpy_server,
                },
                sessions: andrui_core::media::session::create_session_store(),
            };
            let approvals = andrui_core::approvals::ApprovalStore::persistent(db.clone())?;
            let state = AppState {
                emulators: andrui_core::emulators::EmulatorManager::discover(),
                media: Some(media.clone()),
                automation: Some(automation.clone()),
                mode: "native".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
                adb_executor,
                device_tracker,
                discovery: andrui_core::adb::discovery::DeviceDiscovery::start(),
                job_manager,
                db_snapshots: andrui_core::inspect::database::DbSnapshotStore::new(&data_dir),
                artifact_store,
                db,
                shell_manager,
                file_service,
                workflow_runner,
                session_store,
                approvals,
                web_dir,
            };

            let emulators = state.emulators.clone();
            let result = run_native_server(bind, state).await;
            emulators.cleanup().await;
            andrui_core::automation::cleanup_all_sessions(&automation).await;
            media.cleanup_all_sessions().await;
            result?;
        }
        Commands::Mcp { server } => mcp::run(&server).await?,
        Commands::Workflow {
            id,
            devices,
            server,
            confirmed,
            junit,
        } => {
            let success = workflow_cli::run(&server, &id, devices, confirmed, junit)
                .await
                .map_err(std::io::Error::other)?;
            if !success {
                std::process::exit(1);
            }
        }
    }

    Ok(())
}
