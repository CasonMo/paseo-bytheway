#!/usr/bin/env python3
"""Generate assets/icon.png — the ByTheWay brand icon (code-drawn, reproducible).

Requires Pillow in any Python 3 environment:
    python3 -m venv /tmp/icon-venv && /tmp/icon-venv/bin/pip install pillow
    /tmp/icon-venv/bin/python scripts/generate-icon.py

Design: rounded tile with an indigo→violet diagonal gradient; a white speech
bubble with a "btw" tail and a smaller side bubble (a chat "by the way" aside).
"""
from PIL import Image, ImageDraw, ImageFont

SS = 2048          # supersampled canvas
OUT = 512          # exported size
U = SS / 512       # scale factor from 512-based coordinates


def px(v: float) -> int:
    return int(round(v * U))


def gradient(size: int) -> Image.Image:
    corner = Image.new("RGB", (2, 2))
    corner.putpixel((0, 0), (79, 124, 247))    # #4F7CF7 top-left
    corner.putpixel((1, 0), (92, 108, 248))    # slight diagonal blend
    corner.putpixel((0, 1), (112, 100, 246))
    corner.putpixel((1, 1), (139, 92, 246))    # #8B5CF6 bottom-right
    return corner.resize((size, size), Image.BILINEAR)


def load_font(size: int) -> ImageFont.FreeTypeFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default(size)


def main() -> None:
    canvas = Image.new("RGBA", (SS, SS), (0, 0, 0, 0))

    # Rounded tile with gradient fill
    mask = Image.new("L", (SS, SS), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SS - 1, SS - 1], radius=px(114), fill=255)
    canvas.paste(gradient(SS), (0, 0), mask)

    draw = ImageDraw.Draw(canvas)
    white = (255, 255, 255, 255)

    # Main speech bubble + tail
    draw.rounded_rectangle([px(88), px(162), px(332), px(344)], radius=px(58), fill=white)
    draw.polygon(
        [(px(134), px(316)), (px(136), px(412)), (px(228), px(342))],
        fill=white,
    )

    # "btw" label, fitted into the bubble
    text_color = (90, 107, 242, 255)  # #5A6BF2
    font_size = px(118)
    font = load_font(font_size)
    while True:
        box = draw.textbbox((0, 0), "btw", font=font)
        width = box[2] - box[0]
        if width <= px(196) or font_size <= 40:
            break
        font_size -= 4
        font = load_font(font_size)
    draw.text((px(210), px(252)), "btw", font=font, fill=text_color, anchor="mm")

    # Smaller side bubble (the aside)
    draw.rounded_rectangle([px(336), px(110), px(454), px(212)], radius=px(34), fill=(255, 255, 255, 232))

    icon = canvas.resize((OUT, OUT), Image.LANCZOS)
    icon.save("assets/icon.png", "PNG", optimize=True)
    icon.resize((64, 64), Image.LANCZOS).save("/tmp/icon-preview-64.png", "PNG")
    print("written assets/icon.png", icon.size)


if __name__ == "__main__":
    main()
