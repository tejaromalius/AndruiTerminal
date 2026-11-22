use crate::adb::executor::AdbExecutor;
use crate::error::{ApiError, ApiResult};
use crate::models::{FileEntry, FileListing};

#[derive(Clone)]
pub struct FileService {
    executor: AdbExecutor,
}

impl FileService {
    pub fn new(executor: AdbExecutor) -> Self {
        Self { executor }
    }

    pub async fn list_files(&self, device_id: &str, path: Option<&str>) -> ApiResult<FileListing> {
        let target_path = path.unwrap_or("/sdcard");
        if !target_path.starts_with('/') || target_path.contains('\0') {
            return Err(ApiError::bad_request(
                "INVALID_PATH",
                "An absolute device path is required",
            ));
        }
        let quoted_path = format!("'{}'", target_path.replace('\'', "'\"'\"'"));
        // Run ls -la <path> on device
        let args = vec![
            "-s".to_string(),
            device_id.to_string(),
            "shell".to_string(),
            "ls".to_string(),
            "-la".to_string(),
            "--".to_string(),
            quoted_path,
        ];

        let output = self.executor.execute(&args, None, None).await?;
        if output.exit_code != 0 {
            return Err(ApiError::bad_request(
                "FILE_LIST_FAILED",
                format!("Failed to list directory: {}", output.stderr.trim()),
            ));
        }

        let entries = parse_ls_output(&output.stdout, target_path);
        Ok(FileListing {
            path: target_path.to_string(),
            entries,
        })
    }
}

pub fn parse_ls_output(output: &str, base_path: &str) -> Vec<FileEntry> {
    let mut entries = Vec::new();
    let normalized_base = base_path.trim_end_matches('/');

    static LS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let parser = LS.get_or_init(|| {
        regex::Regex::new(r"^(\S+)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$").unwrap()
    });
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("total ") {
            continue;
        }

        let Some(parts) = parser.captures(trimmed) else {
            continue;
        };
        let mode_str = parts.get(1).unwrap().as_str();
        let is_dir = mode_str.starts_with('d');
        let size = parts.get(2).and_then(|v| v.as_str().parse().ok());
        let modified = Some(format!("{} {}", &parts[3], &parts[4]));
        let raw_name = parts.get(5).unwrap().as_str();
        let name = if mode_str.starts_with('l') {
            raw_name
                .split_once(" -> ")
                .map(|(name, _)| name)
                .unwrap_or(raw_name)
        } else {
            raw_name
        };

        if name == "." || name == ".." || name.is_empty() {
            continue;
        }

        let full_path = if normalized_base.is_empty() {
            format!("/{}", name)
        } else {
            format!("{}/{}", normalized_base, name)
        };

        entries.push(FileEntry {
            name: name.to_string(),
            path: full_path,
            directory: is_dir,
            size,
            mode: Some(mode_str.to_string()),
            modified,
        });
    }

    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_ls_output() {
        let sample = r#"total 24
drwxr-xr-x  6 root root  4096 2024-01-01 12:00 .
drwxr-xr-x 25 root root  4096 2024-01-01 12:00 ..
drwxrwxr-x  2 u0_a123 u0_a123 4096 2024-01-01 12:00 Download
-rw-rw-r--  1 u0_a123 u0_a123 1024 2024-01-01 12:00 test.txt
lrwxrwxrwx  1 root root    11 2024-01-01 12:00 link -> /data
"#;
        let entries = parse_ls_output(sample, "/sdcard");
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].name, "Download");
        assert!(entries[0].directory);
        assert_eq!(entries[0].path, "/sdcard/Download");

        assert_eq!(entries[1].name, "test.txt");
        assert!(!entries[1].directory);
        assert_eq!(entries[1].path, "/sdcard/test.txt");
        assert_eq!(entries[1].size, Some(1024));
        assert_eq!(entries[2].name, "link");
        let spaced = parse_ls_output(
            "-rw-r--r-- 1 shell shell 42 2024-01-01 12:00 my file.txt",
            "/sdcard",
        );
        assert_eq!(spaced[0].name, "my file.txt");
    }
}
