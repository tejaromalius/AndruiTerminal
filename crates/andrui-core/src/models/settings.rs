use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub adb_path: String,
    pub data_dir: String,
    pub default_timeout_ms: u64,
    pub allow_unsupported_flags: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            adb_path: "adb".to_string(),
            data_dir: "./data".to_string(),
            default_timeout_ms: 30_000,
            allow_unsupported_flags: false,
        }
    }
}
