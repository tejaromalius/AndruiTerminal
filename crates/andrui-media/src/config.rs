use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const PINNED_SCRCPY_SERVER_SHA256: &str =
    "a0f70b20aa4998fbf658c94118cd6c8dab6abbb0647a3bdab344d70bc1ebcbb8";
pub const SCRCPY_PROVENANCE_URL: &str =
    "https://github.com/Genymobile/scrcpy/releases/download/v3.3.1/scrcpy-server-v3.3.1";

pub fn verify_file_sha256(path: &Path, expected_hex: &str) -> bool {
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let result = hasher.finalize();
    let calculated = format!("{:x}", result);
    calculated.eq_ignore_ascii_case(expected_hex)
}

#[derive(Clone, Debug)]
pub struct MediaConfig {
    pub adb_path: PathBuf,
    pub data_dir: PathBuf,
    pub scrcpy_server: Option<PathBuf>,
}

impl MediaConfig {
    pub fn new(adb_path: PathBuf, data_dir: PathBuf, scrcpy_server: Option<PathBuf>) -> Self {
        Self {
            adb_path,
            data_dir,
            scrcpy_server,
        }
    }

    /// Resolve scrcpy server jar location, validating that the file exists and matches the pinned SHA-256.
    pub fn find_scrcpy_server(&self) -> Option<PathBuf> {
        let candidates = [
            self.scrcpy_server.clone(),
            Some(self.data_dir.join("scrcpy-server-v3.3.1")),
            Some(self.data_dir.join("scrcpy-server.jar")),
            std::env::var("SCRCPY_SERVER_PATH").ok().map(PathBuf::from),
            Some(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("assets")
                    .join("scrcpy-server-v3.3.1"),
            ),
        ];

        candidates.into_iter().flatten().find(|candidate| {
            candidate.exists() && verify_file_sha256(candidate, PINNED_SCRCPY_SERVER_SHA256)
        })
    }
}
