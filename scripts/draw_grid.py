#!/usr/bin/env python3
"""
draw_grid.py — overlay a pixel-coordinate grid on an image (debug/annotation aid).

Usage:
    python3 scripts/draw_grid.py <input.png> [output.png]
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"


def main():
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else src.replace(".png", "-grid.png")
    img = Image.open(src).convert("RGB")
    w, h = img.size
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT, 22)

    for x in range(0, w, 50):
        strong = x % 100 == 0
        color = (230, 80, 80, 255) if strong else (180, 180, 180, 255)
        width = 2 if strong else 1
        d.line([(x, 0), (x, h)], fill=color, width=width)
        if strong:
            d.text((x + 3, 4), str(x), fill=(230, 40, 40), font=font)
            d.text((x + 3, h - 30), str(x), fill=(230, 40, 40), font=font)
    for y in range(0, h, 50):
        strong = y % 100 == 0
        color = (80, 140, 230, 255) if strong else (180, 180, 180, 255)
        width = 2 if strong else 1
        d.line([(0, y), (w, y)], fill=color, width=width)
        if strong:
            d.text((4, y + 3), str(y), fill=(40, 100, 230), font=font)
    img.save(out, "PNG")
    print(f"grid -> {out} ({w}x{h})")


if __name__ == "__main__":
    main()
