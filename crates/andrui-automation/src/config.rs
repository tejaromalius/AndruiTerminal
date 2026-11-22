use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct ExtensionsConfig {
    pub adb_path: PathBuf,
    pub data_dir: PathBuf,
    pub helper_apk: Option<PathBuf>,
}
