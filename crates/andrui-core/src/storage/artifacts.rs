use std::path::{Path, PathBuf};
use tokio::fs;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::models::Artifact;

#[derive(Clone)]
pub struct ArtifactStore {
    base_dir: PathBuf,
}

impl ArtifactStore {
    pub fn new(data_dir: impl AsRef<Path>) -> Self {
        Self {
            base_dir: data_dir.as_ref().join("artifacts"),
        }
    }

    /// Application data directory that contains the artifacts directory.
    pub fn data_dir(&self) -> PathBuf {
        self.base_dir
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| self.base_dir.clone())
    }

    pub async fn init(&self) -> ApiResult<()> {
        fs::create_dir_all(&self.base_dir).await.map_err(|e| {
            ApiError::internal(
                "ARTIFACT_DIR_FAILED",
                format!("Failed to create artifacts directory: {}", e),
            )
        })?;
        Ok(())
    }

    fn validate_id(&self, id: &str) -> ApiResult<PathBuf> {
        if Uuid::parse_str(id).is_err() {
            return Err(ApiError::bad_request(
                "INVALID_ID",
                "Invalid artifact identifier",
            ));
        }
        Ok(self.base_dir.join(id))
    }

    pub async fn save_artifact(
        &self,
        name: &str,
        content_type: &str,
        data: &[u8],
    ) -> ApiResult<Artifact> {
        self.init().await?;
        let id = Uuid::new_v4().to_string();
        let directory = self.validate_id(&id)?;
        fs::create_dir(&directory)
            .await
            .map_err(|e| ApiError::internal("ARTIFACT_WRITE_FAILED", e.to_string()))?;
        let clean_name = sanitize_name(name);
        let target_path = directory.join(&clean_name);

        fs::write(&target_path, data).await.map_err(|e| {
            ApiError::internal(
                "ARTIFACT_WRITE_FAILED",
                format!("Failed to write artifact file: {}", e),
            )
        })?;

        Ok(Artifact {
            id,
            name: clean_name,
            size: data.len() as u64,
            content_type: content_type.to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
        })
    }

    pub async fn path_for(&self, id: &str) -> ApiResult<PathBuf> {
        let directory = self.validate_id(id)?;
        if directory.is_file() {
            return Ok(directory);
        }
        let mut entries = fs::read_dir(&directory)
            .await
            .map_err(|_| ApiError::not_found("ARTIFACT_NOT_FOUND", "Artifact file not found"))?;
        entries
            .next_entry()
            .await
            .map_err(|e| ApiError::internal("ARTIFACT_READ_FAILED", e.to_string()))?
            .map(|e| e.path())
            .ok_or_else(|| ApiError::not_found("ARTIFACT_NOT_FOUND", "Artifact file not found"))
    }
    pub async fn create_upload(&self, name: &str) -> ApiResult<(String, String, fs::File)> {
        self.init().await?;
        let id = Uuid::new_v4().to_string();
        let dir = self.validate_id(&id)?;
        fs::create_dir(&dir)
            .await
            .map_err(|e| ApiError::internal("ARTIFACT_WRITE_FAILED", e.to_string()))?;
        let name = sanitize_name(name);
        let file = fs::File::create(dir.join(&name))
            .await
            .map_err(|e| ApiError::internal("ARTIFACT_WRITE_FAILED", e.to_string()))?;
        Ok((id, name, file))
    }
    pub async fn read_artifact(&self, id: &str) -> ApiResult<Vec<u8>> {
        let file_path = self.path_for(id).await?;
        if !file_path.exists() {
            return Err(ApiError::not_found(
                "ARTIFACT_NOT_FOUND",
                "Artifact file not found",
            ));
        }

        fs::read(&file_path).await.map_err(|e| {
            ApiError::internal(
                "ARTIFACT_READ_FAILED",
                format!("Failed to read artifact: {}", e),
            )
        })
    }

    pub async fn delete_artifact_file(&self, id: &str) -> ApiResult<()> {
        let file_path = self.path_for(id).await?;
        if file_path.exists() {
            fs::remove_file(&file_path)
                .await
                .map_err(|e| ApiError::internal("ARTIFACT_DELETE_FAILED", e.to_string()))?;
            let dir = self.validate_id(id)?;
            if dir.is_dir() {
                let _ = fs::remove_dir(dir).await;
            }
        }
        Ok(())
    }
}

fn sanitize_name(name: &str) -> String {
    let name = Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("artifact.bin");
    let clean: String = name
        .chars()
        .filter(|c| !c.is_control() && *c != '\"' && *c != '\\')
        .collect();
    if clean.is_empty() || clean == "." || clean == ".." {
        "artifact.bin".into()
    } else {
        clean
    }
}
