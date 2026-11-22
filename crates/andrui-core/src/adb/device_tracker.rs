use std::sync::Arc;
use tokio::sync::RwLock;

use crate::adb::executor::AdbExecutor;
use crate::error::ApiResult;
use crate::models::Device;

#[derive(Debug, Clone)]
pub struct DeviceTracker {
    executor: AdbExecutor,
    last_devices: Arc<RwLock<Vec<Device>>>,
}

impl DeviceTracker {
    pub fn new(executor: AdbExecutor) -> Self {
        Self {
            executor,
            last_devices: Arc::new(RwLock::new(Vec::new())),
        }
    }

    pub async fn list_devices(&self) -> ApiResult<Vec<Device>> {
        let output = self
            .executor
            .execute(&["devices".to_string(), "-l".to_string()], None, None)
            .await?;

        let devices = Device::parse_adb_devices_l(&output.stdout);
        let mut last = self.last_devices.write().await;
        *last = devices.clone();
        Ok(devices)
    }

    pub async fn get_cached_devices(&self) -> Vec<Device> {
        self.last_devices.read().await.clone()
    }
}
