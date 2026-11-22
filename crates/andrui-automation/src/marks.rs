//! Set-of-Marks overlay: draws a numbered box on each compact-hierarchy node so a vision
//! model can refer to elements by number. Digits use a built-in 3x5 bitmap font.

use std::io::Cursor;

use image::{ImageFormat, Rgba, RgbaImage};

use crate::compact::CompactNode;

const BORDER: i32 = 2;
const SCALE: i32 = 3;
const WHITE: Rgba<u8> = Rgba([255, 255, 255, 255]);
/// High-contrast colours cycled per node.
const PALETTE: [Rgba<u8>; 6] = [
    Rgba([230, 25, 75, 255]),
    Rgba([0, 130, 200, 255]),
    Rgba([60, 180, 75, 255]),
    Rgba([245, 130, 48, 255]),
    Rgba([145, 30, 180, 255]),
    Rgba([0, 128, 128, 255]),
];

/// Rows top to bottom, 3 bits each (MSB = left column).
const DIGITS: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111],
    [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b111, 0b001, 0b111, 0b100, 0b111],
    [0b111, 0b001, 0b111, 0b001, 0b111],
    [0b101, 0b101, 0b111, 0b001, 0b001],
    [0b111, 0b100, 0b111, 0b001, 0b111],
    [0b111, 0b100, 0b111, 0b101, 0b111],
    [0b111, 0b001, 0b001, 0b001, 0b001],
    [0b111, 0b101, 0b111, 0b101, 0b111],
    [0b111, 0b101, 0b111, 0b001, 0b111],
];

pub fn color_for(id: usize) -> Rgba<u8> {
    PALETTE[id % PALETTE.len()]
}

/// Fills `[x0, x1) x [y0, y1)`, clipped to the image.
fn fill(img: &mut RgbaImage, x0: i32, y0: i32, x1: i32, y1: i32, color: Rgba<u8>) {
    let (w, h) = (img.width() as i32, img.height() as i32);
    for y in y0.max(0)..y1.min(h) {
        for x in x0.max(0)..x1.min(w) {
            img.put_pixel(x as u32, y as u32, color);
        }
    }
}

fn draw_label(img: &mut RgbaImage, x: i32, y: i32, number: usize, color: Rgba<u8>) {
    let digits: Vec<usize> = number
        .to_string()
        .bytes()
        .map(|b| (b - b'0') as usize)
        .collect();
    let advance = 4 * SCALE;
    let width = digits.len() as i32 * advance + SCALE;
    let height = 7 * SCALE;
    // Keep the label on screen when the node touches the right/bottom edge.
    let x = x.min(img.width() as i32 - width).max(0);
    let y = y.min(img.height() as i32 - height).max(0);
    fill(img, x, y, x + width, y + height, color);
    for (i, digit) in digits.iter().enumerate() {
        let left = x + SCALE + i as i32 * advance;
        for (row, bits) in DIGITS[*digit].iter().enumerate() {
            for col in 0..3 {
                if bits & (0b100 >> col) != 0 {
                    let px = left + col * SCALE;
                    let py = y + SCALE + row as i32 * SCALE;
                    fill(img, px, py, px + SCALE, py + SCALE, WHITE);
                }
            }
        }
    }
}

/// Returns a PNG with each node outlined and labelled with its `id`.
pub fn draw_marks(png: &[u8], nodes: &[CompactNode]) -> Result<Vec<u8>, String> {
    let mut img = image::load_from_memory(png)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    for node in nodes {
        let [l, t, r, b] = node.bounds;
        let color = color_for(node.id);
        fill(&mut img, l, t, r, t + BORDER, color);
        fill(&mut img, l, b - BORDER, r, b, color);
        fill(&mut img, l, t, l + BORDER, b, color);
        fill(&mut img, r - BORDER, t, r, b, color);
    }
    // Labels after all boxes so outlines never cover a number.
    for node in nodes {
        draw_label(
            &mut img,
            node.bounds[0],
            node.bounds[1],
            node.id,
            color_for(node.id),
        );
    }
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: usize, bounds: [i32; 4]) -> CompactNode {
        CompactNode {
            id,
            class: "Button".to_string(),
            text: None,
            desc: None,
            hint: None,
            resource_id: None,
            bounds,
            center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
            flags: vec!["click"],
            window_type: None,
        }
    }

    fn blank_png(w: u32, h: u32) -> Vec<u8> {
        let img = RgbaImage::from_pixel(w, h, Rgba([0, 0, 0, 255]));
        let mut out = Cursor::new(Vec::new());
        img.write_to(&mut out, ImageFormat::Png).unwrap();
        out.into_inner()
    }

    #[test]
    fn draws_boxes_and_labels() {
        let nodes = [node(0, [20, 40, 180, 120]), node(12, [190, 190, 200, 200])];
        let png = draw_marks(&blank_png(200, 200), &nodes).unwrap();
        let img = image::load_from_memory(&png).unwrap().to_rgba8();
        // Box edges in the node's colour, interior untouched.
        assert_eq!(*img.get_pixel(100, 40), color_for(0));
        assert_eq!(*img.get_pixel(179, 80), color_for(0));
        assert_eq!(*img.get_pixel(100, 80), Rgba([0, 0, 0, 255]));
        // Label for node 0: background at its corner, white digit pixels inside.
        assert_eq!(*img.get_pixel(20, 40), color_for(0));
        assert_eq!(*img.get_pixel(20 + SCALE as u32, 40 + SCALE as u32), WHITE);
        // Two-digit label clamped inside the right/bottom edges.
        let (label_w, label_h) = ((2 * 4 * SCALE + SCALE) as u32, (7 * SCALE) as u32);
        assert_eq!(*img.get_pixel(200 - label_w, 200 - label_h), color_for(12));
    }

    #[test]
    fn clips_out_of_range_bounds_and_rejects_bad_png() {
        let nodes = [node(3, [-50, -50, 500, 500])];
        assert!(draw_marks(&blank_png(10, 10), &nodes).is_ok());
        assert!(draw_marks(b"not a png", &nodes).is_err());
    }

    #[test]
    fn digit_glyphs_are_distinct() {
        for (i, a) in DIGITS.iter().enumerate() {
            for b in &DIGITS[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }
}
