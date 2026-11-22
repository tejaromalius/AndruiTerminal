#!/usr/bin/env python3
"""
Generate complete production variants and sizes for AndruiTerminal "The Bugdroid Shell" logo.
Outputs both badge (squircle) and transparent glyph variants across all standard sizes into
design/brand/png/, and the icons the web app loads into web/public/ (favicon.ico, logos/*.png).
The SVG masters are hand-written and live in web/public/logos/.
"""

import shutil
from pathlib import Path
from PIL import Image, ImageDraw

BRAND_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = BRAND_DIR / "png"
PUBLIC_DIR = BRAND_DIR.parent.parent / "web" / "public"
# Badge PNG sizes referenced by web/index.html
WEB_PNG_SIZES = (32, 256)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

MASTER_SIZE = 2048  # High supersampling factor for razor-sharp antialiasing

def draw_bugdroid_shell(with_background=True):
    scale = MASTER_SIZE / 512.0
    img = Image.new("RGBA", (MASTER_SIZE, MASTER_SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 1. Background Squircle
    if with_background:
        draw.rounded_rectangle(
            [32 * scale, 32 * scale, 480 * scale, 480 * scale],
            radius=104 * scale,
            fill=(17, 23, 34, 255),
            outline=(56, 189, 248, 120),
            width=int(round(3 * scale))
        )
        # Subtle grid lines
        grid_col = (56, 189, 248, 18)
        for y in [170, 256, 342]:
            draw.line([(80 * scale, y * scale), (432 * scale, y * scale)], fill=grid_col, width=int(round(1.5 * scale)))
        for x in [170, 256, 342]:
            draw.line([(x * scale, 80 * scale), (x * scale, 432 * scale)], fill=grid_col, width=int(round(1.5 * scale)))

    # 2. Antennae
    draw.line([(192 * scale, 168 * scale), (152 * scale, 104 * scale)], fill=(61, 220, 132, 255), width=int(round(16 * scale)))
    draw.line([(320 * scale, 168 * scale), (360 * scale, 104 * scale)], fill=(61, 220, 132, 255), width=int(round(16 * scale)))
    
    # Antenna Node Tips
    node_r = 6 * scale
    for cx, cy in [(152, 104), (360, 104)]:
        draw.ellipse([(cx * scale - node_r, cy * scale - node_r), (cx * scale + node_r, cy * scale + node_r)], fill=(56, 189, 248, 255))

    # 3. Bugdroid Head Dome (Semi-circle)
    draw.pieslice([(124 * scale, 124 * scale), (388 * scale, 388 * scale)], start=180, end=360, fill=(61, 220, 132, 255))

    # 4. Optic Sensor Eyes
    for cx in [196, 316]:
        outer_r = 14 * scale
        inner_r = 6 * scale
        draw.ellipse([(cx * scale - outer_r, 208 * scale - outer_r), (cx * scale + outer_r, 208 * scale + outer_r)], fill=(15, 23, 42, 255))
        draw.ellipse([(cx * scale - inner_r, 208 * scale - inner_r), (cx * scale + inner_r, 208 * scale + inner_r)], fill=(56, 189, 248, 255))

    # 5. Terminal Screen Visor Deck
    draw.rounded_rectangle(
        [124 * scale, 272 * scale, 388 * scale, 396 * scale],
        radius=20 * scale,
        fill=(13, 20, 31, 255),
        outline=(30, 41, 59, 255),
        width=int(round(3 * scale))
    )
    # Screen inner highlight rim
    draw.rounded_rectangle(
        [126 * scale, 274 * scale, 386 * scale, 394 * scale],
        radius=18 * scale,
        fill=None,
        outline=(16, 185, 129, 65),
        width=int(round(1.5 * scale))
    )

    # 6. Terminal Window Header Controls
    colors = [(248, 113, 113), (251, 191, 36), (52, 211, 153)]
    dot_r = 4.5 * scale
    for i, col in enumerate(colors):
        cx = 150 + i * 14
        draw.ellipse([(cx * scale - dot_r, 294 * scale - dot_r), (cx * scale + dot_r, 294 * scale + dot_r)], fill=col)
    draw.line([(196 * scale, 294 * scale), (370 * scale, 294 * scale)], fill=(30, 41, 59, 255), width=int(round(2 * scale)))

    # 7. Terminal Prompt Chevron '>'
    prompt_w = int(round(8 * scale))
    draw.line([(166 * scale, 332 * scale), (194 * scale, 350 * scale)], fill=(61, 220, 132, 255), width=prompt_w)
    draw.line([(194 * scale, 350 * scale), (166 * scale, 368 * scale)], fill=(61, 220, 132, 255), width=prompt_w)

    # 8. Blinking Cursor Block '_'
    draw.rounded_rectangle([214 * scale, 358 * scale, 242 * scale, 367 * scale], radius=3 * scale, fill=(56, 189, 248, 255))

    # 9. PTY Output Stream Indicators
    draw.rounded_rectangle([254 * scale, 345 * scale, 300 * scale, 349 * scale], radius=2 * scale, fill=(61, 220, 132, 180))
    draw.rounded_rectangle([308 * scale, 345 * scale, 332 * scale, 349 * scale], radius=2 * scale, fill=(56, 189, 248, 150))
    draw.rounded_rectangle([254 * scale, 357 * scale, 332 * scale, 361 * scale], radius=2 * scale, fill=(148, 163, 184, 120))

    return img

def main():
    print(f"Generating master renders at {MASTER_SIZE}x{MASTER_SIZE}...")
    master_badge = draw_bugdroid_shell(with_background=True)
    master_glyph = draw_bugdroid_shell(with_background=False)

    # Badge sizes
    badge_sizes = [16, 32, 48, 64, 128, 256, 512, 1024]
    rendered_ico_images = []

    for size in badge_sizes:
        resized = master_badge.resize((size, size), Image.Resampling.LANCZOS)
        out_path = OUTPUT_DIR / f"andrui-terminal-{size}x{size}.png"
        resized.save(out_path)
        print(f"  ✓ Saved {out_path} ({size}x{size})")

        if size in (16, 32, 48):
            rendered_ico_images.append(resized)

    # Glyph sizes
    glyph_sizes = [32, 64, 128, 256, 512]
    for size in glyph_sizes:
        resized = master_glyph.resize((size, size), Image.Resampling.LANCZOS)
        out_path = OUTPUT_DIR / f"andrui-terminal-glyph-{size}x{size}.png"
        resized.save(out_path)
        print(f"  ✓ Saved {out_path} ({size}x{size})")

    # Multi-size favicon.ico; each size uses its own downscaled render.
    ico_path = PUBLIC_DIR / "favicon.ico"
    # Pillow drops sizes larger than the base image, so save from the largest.
    rendered_ico_images[-1].save(ico_path, format="ICO", sizes=[(16, 16), (32, 32), (48, 48)],
                                 append_images=rendered_ico_images[:-1])
    print(f"  ✓ Generated {ico_path} (16, 32, 48)")

    for size in WEB_PNG_SIZES:
        name = f"andrui-terminal-{size}x{size}.png"
        shutil.copyfile(OUTPUT_DIR / name, PUBLIC_DIR / "logos" / name)
        print(f"  ✓ Copied {name} to {PUBLIC_DIR / 'logos'}")

    print("All variant sizes generated successfully!")

if __name__ == "__main__":
    main()
