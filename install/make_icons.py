"""Generate the application icons (PNG, ICO, ICNS) from the Kavot mark.

The mark in frontend/src/assets/kavot-mark.svg is made of straight segments only,
so it is redrawn here with Pillow instead of requiring an SVG renderer.

Usage: python install/make_icons.py [output_dir]   (default: install/build/icons)
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

ACCENT = "#1f8a5b"
LIGHT = "#7fd6a8"
# Polygons of the 32x36 SVG viewBox ("M3 3h7v12L20 3h9L16 18l13 15h-9L10 21v12H3V3Z").
LETTER = [(3, 3), (10, 3), (10, 15), (20, 3), (29, 3), (16, 18), (29, 33), (20, 33), (10, 21), (10, 33), (3, 33)]
DIAMOND = [(27, 17), (30, 20), (27, 23), (24, 20)]


def render(size: int) -> Image.Image:
    """A rounded accent tile with the mark in white, drawn 4x larger then downsampled."""
    scale = 4
    canvas = size * scale
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, canvas - 1, canvas - 1), radius=int(canvas * 0.22), fill=ACCENT)
    # Fit the 32x36 mark into 60% of the tile, centred.
    unit = canvas * 0.6 / 36
    left = (canvas - 32 * unit) / 2
    top = (canvas - 36 * unit) / 2
    place = lambda points: [(left + x * unit, top + y * unit) for x, y in points]
    draw.polygon(place(LETTER), fill="white")
    draw.polygon(place(DIAMOND), fill=LIGHT)
    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "build" / "icons"
    out.mkdir(parents=True, exist_ok=True)
    big = render(1024)
    big.save(out / "kavot.png")
    render(256).save(out / "kavot-256.png")
    big.save(out / "kavot.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    big.save(out / "kavot.icns")
    print(f"Icons written to {out}")


if __name__ == "__main__":
    main()
