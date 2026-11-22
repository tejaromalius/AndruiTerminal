use axum::{
    extract::{Multipart, State},
    Json,
};
use serde::Serialize;
use std::io::Write;
use std::time::Duration;
use tempfile::{Builder, TempDir};
use tokio::process::Command;

use crate::error::ApiError;
use crate::state::AppState;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OcrRegion {
    pub text: String,
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
    pub confidence: f32,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OcrResponse {
    pub text: String,
    pub regions: Vec<OcrRegion>,
}

pub async fn run_ocr(
    State(_state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<OcrResponse>, ApiError> {
    // 1. Verify Tesseract executable availability
    let check = Command::new("tesseract").arg("--version").output().await;
    if check.is_err() || !check.as_ref().unwrap().status.success() {
        return Err(ApiError::service_unavailable(
            "tesseract_unavailable",
            "Tesseract OCR executable not found in host PATH. Install tesseract-ocr to enable OCR capabilities.",
        ));
    }

    let mut image_bytes: Option<Vec<u8>> = None;
    let mut language: String = "eng".to_string();

    // 2. Read multipart fields
    while let Some(field) = multipart.next_field().await.map_err(|e| {
        ApiError::bad_request(
            "malformed_multipart",
            format!("Malformed multipart data: {}", e),
        )
    })? {
        let name = field.name().unwrap_or("").to_string();
        if name == "image" || name == "file" || field.file_name().is_some() {
            let bytes = field.bytes().await.map_err(|e| {
                ApiError::bad_request(
                    "malformed_multipart",
                    format!("Failed to read image bytes: {}", e),
                )
            })?;
            image_bytes = Some(bytes.to_vec());
        } else if name == "language" || name == "lang" {
            let txt = field.text().await.map_err(|e| {
                ApiError::bad_request(
                    "malformed_multipart",
                    format!("Failed to read language text: {}", e),
                )
            })?;
            let trimmed = txt.trim().to_string();
            if !trimmed.is_empty() {
                language = trimmed;
            }
        }
    }

    let bytes = image_bytes.ok_or_else(|| {
        ApiError::bad_request(
            "missing_image",
            "Multipart request must include an 'image' field",
        )
    })?;

    if bytes.is_empty() {
        return Err(ApiError::bad_request(
            "empty_image",
            "Provided image bytes are empty",
        ));
    }

    // 3. Write image to scoped temporary file
    let mut temp_image = Builder::new()
        .prefix("andrui_ocr_")
        .suffix(".png")
        .tempfile()
        .map_err(|e| {
            ApiError::internal(
                "temp_file_failed",
                format!("Failed to create temp image: {}", e),
            )
        })?;

    temp_image.write_all(&bytes).map_err(|e| {
        ApiError::internal(
            "temp_write_failed",
            format!("Failed to write temp image: {}", e),
        )
    })?;

    let temp_image_path = temp_image.path().to_path_buf();

    // 4. Temporary directory for tesseract TSV output
    let temp_dir = TempDir::new().map_err(|e| {
        ApiError::internal(
            "temp_dir_failed",
            format!("Failed to create temp output dir: {}", e),
        )
    })?;
    let out_base = temp_dir.path().join("ocr_result");

    // 5. Run tesseract with timeout
    let tesseract_run = Command::new("tesseract")
        .arg(&temp_image_path)
        .arg(&out_base)
        .arg("-l")
        .arg(&language)
        .arg("tsv")
        .output();

    let output = match tokio::time::timeout(Duration::from_secs(15), tesseract_run).await {
        Ok(res) => res.map_err(|e| {
            ApiError::internal(
                "tesseract_exec_error",
                format!("Failed to run tesseract: {}", e),
            )
        })?,
        Err(_) => {
            return Err(ApiError::timeout(
                "ocr_timeout",
                "Tesseract execution timed out after 15 seconds",
            ));
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ApiError::bad_request(
            "tesseract_failed",
            format!(
                "Tesseract failed with status {}: {}",
                output.status,
                stderr.trim()
            ),
        ));
    }

    // 6. Read and parse TSV output
    let tsv_path = temp_dir.path().join("ocr_result.tsv");
    let tsv_content = tokio::fs::read_to_string(&tsv_path).await.map_err(|e| {
        ApiError::internal(
            "tsv_read_failed",
            format!(
                "Failed to read tesseract TSV output at {:?}: {}",
                tsv_path, e
            ),
        )
    })?;

    let (full_text, regions) = parse_tesseract_tsv(&tsv_content);

    Ok(Json(OcrResponse {
        text: full_text,
        regions,
    }))
}

/// Parse TSV format from Tesseract:
/// Header: level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext
pub fn parse_tesseract_tsv(tsv: &str) -> (String, Vec<OcrRegion>) {
    let mut regions = Vec::new();
    let mut words = Vec::new();

    let mut lines = tsv.lines();
    let header = lines.next();
    if header.is_none() {
        return (String::new(), regions);
    }

    for line in lines {
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() < 12 {
            continue;
        }

        let level = cols[0].trim();
        // Level 5 corresponds to individual words
        if level == "5" {
            let left: i32 = cols[6].parse().unwrap_or(0);
            let top: i32 = cols[7].parse().unwrap_or(0);
            let width: i32 = cols[8].parse().unwrap_or(0);
            let height: i32 = cols[9].parse().unwrap_or(0);
            let conf: f32 = cols[10].parse().unwrap_or(-1.0);
            let text = cols[11].trim().to_string();

            if !text.is_empty() && conf >= 0.0 {
                words.push(text.clone());
                regions.push(OcrRegion {
                    text,
                    left,
                    top,
                    width,
                    height,
                    confidence: conf,
                });
            }
        }
    }

    let full_text = words.join(" ");
    (full_text, regions)
}
