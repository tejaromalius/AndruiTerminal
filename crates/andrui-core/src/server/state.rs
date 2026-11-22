use std::path::PathBuf;

use crate::adb::device_tracker::DeviceTracker;
use crate::adb::discovery::DeviceDiscovery;
use crate::adb::executor::AdbExecutor;
use crate::approvals::ApprovalStore;
use crate::files::service::FileService;
use crate::jobs::manager::JobManager;
use crate::security::session::SessionStore;
use crate::shell::manager::ShellManager;
use crate::storage::artifacts::ArtifactStore;
use crate::storage::db::Database;
use crate::workflows::runner::WorkflowRunner;

#[derive(Clone)]
pub struct AppState {
    pub emulators: crate::emulators::EmulatorManager,
    pub media: Option<andrui_media::AppState>,
    pub automation: Option<andrui_automation::AppState>,
    pub mode: String,
    pub version: String,
    pub adb_executor: AdbExecutor,
    pub device_tracker: DeviceTracker,
    pub discovery: DeviceDiscovery,
    pub job_manager: JobManager,
    pub artifact_store: ArtifactStore,
    pub db_snapshots: crate::inspect::database::DbSnapshotStore,
    pub db: Database,
    pub shell_manager: ShellManager,
    pub file_service: FileService,
    pub workflow_runner: WorkflowRunner,
    pub session_store: SessionStore,
    pub approvals: ApprovalStore,
    pub web_dir: Option<PathBuf>,
}
