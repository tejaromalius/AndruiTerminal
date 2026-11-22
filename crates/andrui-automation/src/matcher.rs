use axum::{
    extract::{Multipart, State},
    Json,
};
use image::GrayImage;
use serde::Serialize;
use std::collections::BinaryHeap;

use crate::error::ApiError;
use crate::state::AppState;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MatchResultItem {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub score: f64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MatchResponse {
    pub matches: Vec<MatchResultItem>,
}

#[derive(Clone, PartialEq)]
struct ScoredCandidate {
    item: MatchResultItem,
}

impl Eq for ScoredCandidate {}

impl PartialOrd for ScoredCandidate {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for ScoredCandidate {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        // Min-heap ordering: candidate with smallest score has highest priority so peek() is minimum
        other
            .item
            .score
            .partial_cmp(&self.item.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    }
}

fn decode_bounded_image(bytes: &[u8], label: &str) -> Result<GrayImage, ApiError> {
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(64 * 1024 * 1024);

    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes));
    reader.limits(limits);
    let reader = reader.with_guessed_format().map_err(|e| {
        ApiError::bad_request(
            "invalid_image",
            format!("Failed to read {} format: {}", label, e),
        )
    })?;

    let img = reader.decode().map_err(|e| {
        ApiError::bad_request(
            "invalid_image",
            format!("Failed to decode {}: {}", label, e),
        )
    })?;

    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return Err(ApiError::bad_request(
            "invalid_dimensions",
            format!("{} must have non-zero dimensions", label),
        ));
    }

    if w > 8192 || h > 8192 {
        return Err(ApiError::bad_request(
            "dimensions_too_large",
            format!("{} dimensions ({}x{}) cannot exceed 8192x8192", label, w, h),
        ));
    }

    Ok(img.to_luma8())
}

pub async fn run_template_match(
    State(_state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<MatchResponse>, ApiError> {
    let mut image_bytes: Option<Vec<u8>> = None;
    let mut template_bytes: Option<Vec<u8>> = None;
    let mut threshold: f64 = 0.8;
    let mut max_matches: usize = 10;

    while let Some(field) = multipart.next_field().await.map_err(|e| {
        ApiError::bad_request(
            "malformed_multipart",
            format!("Malformed multipart data: {}", e),
        )
    })? {
        let name = field.name().unwrap_or("").to_string();
        if name == "image" || name == "haystack" {
            let b = field.bytes().await.map_err(|e| {
                ApiError::bad_request(
                    "malformed_multipart",
                    format!("Failed to read image bytes: {}", e),
                )
            })?;
            image_bytes = Some(b.to_vec());
        } else if name == "template" || name == "needle" {
            let b = field.bytes().await.map_err(|e| {
                ApiError::bad_request(
                    "malformed_multipart",
                    format!("Failed to read template bytes: {}", e),
                )
            })?;
            template_bytes = Some(b.to_vec());
        } else if name == "threshold" {
            let txt = field.text().await.map_err(|e| {
                ApiError::bad_request(
                    "malformed_multipart",
                    format!("Failed to read threshold text: {}", e),
                )
            })?;
            let val = txt.trim().parse::<f64>().map_err(|_| {
                ApiError::bad_request("invalid_threshold", "Threshold must be a valid number")
            })?;
            if !val.is_finite() || val < 0.0 || val > 1.0 {
                return Err(ApiError::bad_request(
                    "invalid_threshold",
                    "Threshold must be a finite number between 0.0 and 1.0",
                ));
            }
            threshold = val;
        } else if name == "maxMatches" || name == "max_matches" {
            let txt = field.text().await.map_err(|e| {
                ApiError::bad_request(
                    "malformed_multipart",
                    format!("Failed to read maxMatches text: {}", e),
                )
            })?;
            if let Ok(val) = txt.trim().parse::<usize>() {
                max_matches = val.clamp(1, 100);
            }
        }
    }

    let img_raw = image_bytes.ok_or_else(|| {
        ApiError::bad_request("missing_image", "Multipart request must include 'image'")
    })?;

    let tpl_raw = template_bytes.ok_or_else(|| {
        ApiError::bad_request(
            "missing_template",
            "Multipart request must include 'template'",
        )
    })?;

    // Bounds on byte sizes (20MB)
    if img_raw.len() > 20 * 1024 * 1024 || tpl_raw.len() > 20 * 1024 * 1024 {
        return Err(ApiError::bad_request(
            "image_too_large",
            "Image size exceeds 20MB limit",
        ));
    }

    // Decode images with allocation and dimension limits
    let img_gray = decode_bounded_image(&img_raw, "source image")?;
    let tpl_gray = decode_bounded_image(&tpl_raw, "template image")?;

    let (img_w, img_h) = img_gray.dimensions();
    let (tpl_w, tpl_h) = tpl_gray.dimensions();

    if tpl_w > img_w || tpl_h > img_h {
        return Err(ApiError::bad_request(
            "invalid_dimensions",
            format!(
                "Template dimensions ({}x{}) cannot exceed source image dimensions ({}x{})",
                tpl_w, tpl_h, img_w, img_h
            ),
        ));
    }

    // Reject computation above defined pixel-comparison budget (50 million)
    let candidate_positions = ((img_w - tpl_w + 1) as u64) * ((img_h - tpl_h + 1) as u64);
    let patch_pixels = (tpl_w as u64) * (tpl_h as u64);
    let total_operations = candidate_positions * patch_pixels;
    const MAX_PIXEL_COMPARISONS: u64 = 50_000_000;

    if total_operations > MAX_PIXEL_COMPARISONS {
        return Err(ApiError::bad_request(
            "computation_budget_exceeded",
            format!(
                "Template matching computation exceeds budget ({} operations > {} maximum)",
                total_operations, MAX_PIXEL_COMPARISONS
            ),
        ));
    }

    // Move CPU-intensive matching work to spawn_blocking
    let matches = tokio::task::spawn_blocking(move || {
        match_template_zncc(&img_gray, &tpl_gray, threshold, max_matches)
    })
    .await
    .map_err(|e| {
        ApiError::internal(
            "matching_task_failed",
            format!("Matching blocking task error: {}", e),
        )
    })?;

    Ok(Json(MatchResponse { matches }))
}

/// Normalized template matching using Zero-mean Normalized Cross Correlation (ZNCC)
/// with integral images for fast patch statistics, bounded Top-K candidate pool,
/// and Non-Maximum Suppression (NMS).
pub fn match_template_zncc(
    img: &GrayImage,
    tpl: &GrayImage,
    threshold: f64,
    max_matches: usize,
) -> Vec<MatchResultItem> {
    let (img_w, img_h) = img.dimensions();
    let (tpl_w, tpl_h) = tpl.dimensions();

    let n_pixels = (tpl_w * tpl_h) as f64;

    // 1. Compute template statistics
    let mut sum_tpl = 0.0f64;
    let mut sumsq_tpl = 0.0f64;
    for y in 0..tpl_h {
        for x in 0..tpl_w {
            let p = tpl.get_pixel(x, y)[0] as f64;
            sum_tpl += p;
            sumsq_tpl += p * p;
        }
    }

    let mean_tpl = sum_tpl / n_pixels;
    let var_tpl = (sumsq_tpl / n_pixels) - (mean_tpl * mean_tpl);
    let is_uniform_tpl = var_tpl < 1e-7;
    let std_tpl = if is_uniform_tpl { 0.0 } else { var_tpl.sqrt() };

    // 2. Compute 2D Integral Images for sum and sum of squares
    let stride = (img_w + 1) as usize;
    let mut int_sum = vec![0.0f64; stride * (img_h + 1) as usize];
    let mut int_sq = vec![0.0f64; stride * (img_h + 1) as usize];

    for y in 0..img_h {
        let mut row_sum = 0.0f64;
        let mut row_sq = 0.0f64;
        for x in 0..img_w {
            let p = img.get_pixel(x, y)[0] as f64;
            row_sum += p;
            row_sq += p * p;

            let idx = ((y + 1) as usize) * stride + (x + 1) as usize;
            let above_idx = (y as usize) * stride + (x + 1) as usize;

            int_sum[idx] = int_sum[above_idx] + row_sum;
            int_sq[idx] = int_sq[above_idx] + row_sq;
        }
    }

    // Helper closure to query integral sum in rectangle [x, x + w) x [y, y + h)
    let query_box = |arr: &[f64], x: u32, y: u32, w: u32, h: u32| -> f64 {
        let x0 = x as usize;
        let y0 = y as usize;
        let x1 = (x + w) as usize;
        let y1 = (y + h) as usize;

        let d = arr[y1 * stride + x1];
        let b = arr[y0 * stride + x1];
        let c = arr[y1 * stride + x0];
        let a = arr[y0 * stride + x0];

        d - b - c + a
    };

    let max_x = img_w - tpl_w;
    let max_y = img_h - tpl_h;

    // Bounded Top-K candidate capacity
    let max_candidates = (max_matches * 100).clamp(200, 5000);
    let mut heap: BinaryHeap<ScoredCandidate> = BinaryHeap::with_capacity(max_candidates);

    for y in 0..=max_y {
        for x in 0..=max_x {
            let sum_patch = query_box(&int_sum, x, y, tpl_w, tpl_h);
            let sumsq_patch = query_box(&int_sq, x, y, tpl_w, tpl_h);

            let mean_patch = sum_patch / n_pixels;
            let var_patch = (sumsq_patch / n_pixels) - (mean_patch * mean_patch);

            let score = if is_uniform_tpl {
                let mut abs_diff = 0.0f64;
                for ty in 0..tpl_h {
                    for tx in 0..tpl_w {
                        let ip = img.get_pixel(x + tx, y + ty)[0] as f64;
                        let tp = tpl.get_pixel(tx, ty)[0] as f64;
                        abs_diff += (ip - tp).abs();
                    }
                }
                (1.0 - (abs_diff / (255.0 * n_pixels))).clamp(0.0, 1.0)
            } else if var_patch < 1e-7 {
                0.0
            } else {
                let std_patch = var_patch.sqrt();
                let mut dot = 0.0f64;
                for ty in 0..tpl_h {
                    for tx in 0..tpl_w {
                        let ip = img.get_pixel(x + tx, y + ty)[0] as f64;
                        let tp = tpl.get_pixel(tx, ty)[0] as f64;
                        dot += (tp - mean_tpl) * (ip - mean_patch);
                    }
                }
                let zncc = dot / (n_pixels * std_tpl * std_patch);
                zncc.clamp(0.0, 1.0)
            };

            if score >= threshold {
                let item = MatchResultItem {
                    x,
                    y,
                    width: tpl_w,
                    height: tpl_h,
                    score: (score * 1000.0).round() / 1000.0,
                };
                let cand = ScoredCandidate { item };

                if heap.len() < max_candidates {
                    heap.push(cand);
                } else if cand.item.score > heap.peek().unwrap().item.score {
                    heap.pop();
                    heap.push(cand);
                }
            }
        }
    }

    // 3. Extract and sort candidates descending
    let mut candidates: Vec<MatchResultItem> = heap.into_iter().map(|c| c.item).collect();
    candidates.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // 4. Non-Maximum Suppression (NMS)
    let mut selected: Vec<MatchResultItem> = Vec::new();
    let min_dist_x = (tpl_w / 2).max(1);
    let min_dist_y = (tpl_h / 2).max(1);

    for cand in candidates {
        if selected.len() >= max_matches {
            break;
        }

        let overlaps = selected.iter().any(|sel| {
            let dx = (cand.x as i64 - sel.x as i64).abs();
            let dy = (cand.y as i64 - sel.y as i64).abs();
            dx < min_dist_x as i64 && dy < min_dist_y as i64
        });

        if !overlaps {
            selected.push(cand);
        }
    }

    selected
}
