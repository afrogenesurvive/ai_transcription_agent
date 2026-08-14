#!/usr/bin/env python3
"""
annotate_screenshots.py — draw UI-doc annotations (numbered callouts) on screenshots.

Reads a JSON manifest describing, per output image, the source file and a list of
callouts. Each callout may combine any of: a highlight box, a leader line/arrow to a
target point, a numbered badge (circle), and an optional short text bubble.

Usage:
    python3 scripts/annotate_screenshots.py [path/to/manifest.json]

The manifest is JSON with this shape:

{
  "style": {
    "accent": "#2F6FED",
    "highlight_fill_alpha": 0.18,
    "border_width": 3,
    "arrow_color": "#E03131",
    "arrow_width": 5,
    "badge_bg": "#2F6FED",
    "badge_fg": "#FFFFFF",
    "badge_radius": 22,
    "bubble_bg": "#FFFFFF",
    "bubble_border": "#2F6FED",
    "bubble_text_color": "#1F2328",
    "font_size": 26,
    "bubble_font_size": 24
  },
  "images": [
    {
      "source": "docs/screenshots/user-guide/raw/01.png",
      "output": "docs/screenshots/user-guide/01-interface.png",
      "callouts": [
        {"type": "highlight", "n": 1, "box": [x, y, w, h]},
        {"type": "callout", "n": 2, "target": [tx, ty], "badge": [bx, by]},
        {"type": "callout", "n": 3, "target": [tx, ty], "box": [x, y, w, h],
         "text": "Short bubble text"}
      ]
    }
  ]
}

Callout fields:
  type:
    "highlight" — draw a rounded-rect highlight only. Requires "box".
    "callout"   — draw a badge (circle + number) with an optional leader line to
                  "target", optional "box" highlight, and optional "text" bubble.
  n       — callout number (also shown on the badge).
  box     — [x, y, w, h] highlight rectangle in source-image pixels.
  target  — [x, y] point the leader line points to (tip of arrow).
  badge   — [x, y] badge center. If omitted for a "callout" with no "target", the
            badge is centered on the box; if there is a target, the badge is placed
            a fixed offset from the target.
  text    — optional short bubble text attached to the badge (auto-sized).
  text_at — optional bubble anchor (defaults near the badge).

Coordinates are in the SOURCE image's pixel space (the downscaled raw images).
"""

import json
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------- font helpers

_FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/SFNS.ttf",
]


def _load_font(size):
    for path in _FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def _parse_color(spec):
    """Accept '#RRGGBB' or '#RRGGBBAA'."""
    spec = spec.strip().lstrip("#")
    if len(spec) == 6:
        r, g, b = (int(spec[i : i + 2], 16) for i in (0, 2, 4))
        return (r, g, b, 255)
    if len(spec) == 8:
        r, g, b, a = (int(spec[i : i + 2], 16) for i in (0, 2, 4, 6))
        return (r, g, b, a)
    raise ValueError(f"bad color spec: {spec}")


# ---------------------------------------------------------------- draw helpers

def _rounded_rect(draw, box, radius, fill=None, outline=None, width=1):
    x, y, w, h = box
    r = min(radius, w // 2, h // 2)
    draw.rounded_rectangle(
        [x, y, x + w, y + h], radius=r, fill=fill, outline=outline, width=width
    )


def _arrow_head(draw, tip, angle, size, color, width):
    """Draw a filled arrowhead pointing at 'tip' (angle = direction in radians)."""
    pts = [
        tip,
        (
            tip[0] - size * math.cos(angle - math.radians(28)),
            tip[1] - size * math.sin(angle - math.radians(28)),
        ),
        (
            tip[0] - size * math.cos(angle + math.radians(28)),
            tip[1] - size * math.sin(angle + math.radians(28)),
        ),
    ]
    draw.polygon(pts, fill=color)


def _draw_arrow(draw, start, end, color, width):
    sx, sy = start
    ex, ey = end
    # shorten the line so the head lands exactly at the target
    dx, dy = ex - sx, ey - sy
    length = math.hypot(dx, dy)
    if length == 0:
        return
    angle = math.atan2(dy, dx)
    head_len = max(width * 3.5, 14)
    bx = ex - head_len * math.cos(angle)
    by = ey - head_len * math.sin(angle)
    draw.line([sx, sy, bx, by], fill=color, width=width)
    _arrow_head(draw, (ex, ey), angle, head_len * 1.7, color, width)


def _text_size(draw, text, font):
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def _draw_bubble(draw, image, anchor, text, pointer_to, style):
    """Draw a rounded-rect speech bubble with a small pointer to pointer_to."""
    font = _load_font(style["bubble_font_size"])
    pad_x, pad_y = 16, 12
    tw, th = _text_size(draw, text, font)
    bw = tw + 2 * pad_x
    bh = th + 2 * pad_y
    ax, ay = anchor

    # place bubble so it stays within the image, offset from the pointer target
    x = ax
    y = ay
    if pointer_to and pointer_to[1] < ay:
        pass  # bubble is below the pointer
    # keep inside bounds
    if x + bw > image.width - 8:
        x = image.width - 8 - bw
    if x < 8:
        x = 8
    if y + bh > image.height - 8:
        y = image.height - 8 - bh
    if y < 8:
        y = 8

    bg = _parse_color(style["bubble_bg"])
    border = _parse_color(style["bubble_border"])
    text_color = _parse_color(style["bubble_text_color"])

    # pointer triangle toward pointer_to
    ptr = pointer_to if pointer_to else (ax, ay)
    cx = x + bw / 2
    # draw pointer from bubble edge to target
    tri = []
    if ptr[1] >= y + bh:  # pointer below bubble
        tip = (ptr[0], ptr[1])
        tri = [
            (cx - 12, y + bh),
            (cx + 12, y + bh),
            (ptr[0], ptr[1]),
        ]
    else:
        tip = (ptr[0], ptr[1])
        tri = [
            (cx - 12, y),
            (cx + 12, y),
            (ptr[0], ptr[1]),
        ]
    if tri:
        draw.polygon(tri, fill=bg)
        # outline the two outer edges
        draw.line([tri[0], tri[2]], fill=border, width=2)
        draw.line([tri[1], tri[2]], fill=border, width=2)

    _rounded_rect(draw, (x, y, bw, bh), radius=14, fill=bg, outline=border, width=2)
    draw.text((x + pad_x, y + pad_y), text, font=font, fill=text_color)


def _draw_badge(draw, center, n, style):
    bg = _parse_color(style["badge_bg"])
    fg = _parse_color(style["badge_fg"])
    r = style["badge_radius"]
    cx, cy = center
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=bg, outline=fg, width=2)
    font = _load_font(style["font_size"])
    text = str(n)
    tw, th = _text_size(draw, text, font)
    draw.text((cx - tw / 2, cy - th / 2 - 2), text, font=font, fill=fg)


# ---------------------------------------------------------------- main renderer

def render_image(entry, style):
    src = entry["source"]
    if not os.path.exists(src):
        print(f"  !! missing source: {src}")
        return False
    img = Image.open(src).convert("RGB")
    draw = ImageDraw.Draw(img, "RGBA")

    for co in entry.get("callouts", []):
        ctype = co.get("type", "callout")
        n = co.get("n")

        if ctype == "highlight":
            box = co["box"]
            fill = _parse_color(style["accent"])[:3] + (
                int(255 * style.get("highlight_fill_alpha", 0.18)),
            )
            border = _parse_color(style.get("highlight_border", style["accent"]))[:3] + (255,)
            _rounded_rect(
                draw, box, radius=style.get("highlight_radius", 8),
                fill=fill, outline=border, width=style.get("border_width", 3),
            )
            if n is not None:
                cx, cy = box[0] + box[2] // 2, box[1] + box[3] // 2
                _draw_badge(draw, (cx, cy), n, style)
            continue

        # "callout"
        box = co.get("box")
        target = co.get("target")
        badge = co.get("badge")
        text = co.get("text")

        if box:
            fill = _parse_color(style["accent"])[:3] + (
                int(255 * style.get("highlight_fill_alpha", 0.18)),
            )
            border = _parse_color(style.get("highlight_border", style["accent"]))[:3] + (255,)
            _rounded_rect(
                draw, box, radius=style.get("highlight_radius", 8),
                fill=fill, outline=border, width=style.get("border_width", 3),
            )

        if badge is None:
            if target:
                # default badge offset up-right from target
                badge = (target[0] + 40, target[1] - 40)
            elif box:
                badge = (box[0] + box[2] // 2, box[1] + box[3] // 2)
            else:
                badge = None

        if target and badge:
            _draw_arrow(
                draw, badge, target,
                _parse_color(style.get("arrow_color", "#E03131"))[:3] + (255,),
                style.get("arrow_width", 5),
            )
        if badge and n is not None:
            _draw_badge(draw, badge, n, style)
        if text:
            text_anchor = co.get("text_at")
            if text_anchor is None and badge:
                text_anchor = (badge[0] + style["badge_radius"] + 10, badge[1])
            elif text_anchor is None and target:
                text_anchor = (target[0] + 40, target[1] - 40)
            if text_anchor is None:
                text_anchor = (30, 30)
            _draw_bubble(draw, img, text_anchor, text, target, style)

    out = entry["output"]
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    img.save(out, "PNG", optimize=True)
    print(f"  -> {out}")
    return True


def main():
    manifest_path = sys.argv[1] if len(sys.argv) > 1 else "scripts/user_guide_manifest.json"
    with open(manifest_path) as fh:
        manifest = json.load(fh)
    style = manifest.get("style", {})
    style.setdefault("accent", "#2F6FED")
    style.setdefault("highlight_fill_alpha", 0.18)
    style.setdefault("border_width", 3)
    style.setdefault("arrow_color", "#E03131")
    style.setdefault("arrow_width", 5)
    style.setdefault("badge_bg", "#2F6FED")
    style.setdefault("badge_fg", "#FFFFFF")
    style.setdefault("badge_radius", 22)
    style.setdefault("bubble_bg", "#FFFFFF")
    style.setdefault("bubble_border", "#2F6FED")
    style.setdefault("bubble_text_color", "#1F2328")
    style.setdefault("font_size", 26)
    style.setdefault("bubble_font_size", 24)

    for entry in manifest.get("images", []):
        render_image(entry, style)
    print("done.")


if __name__ == "__main__":
    main()
