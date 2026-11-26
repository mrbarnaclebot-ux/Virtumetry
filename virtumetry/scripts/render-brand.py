# Renders the Virtumetry brand mark (UI-SPEC 13.1) into icon/splash/adaptive/favicon PNGs (13.4).
# Colours mirror src/design/tokens.ts (bg #060a0a, text #e7f2f2, primary #a2cccb).
# Geometry mirrors glyphs.brandMark in src/design/glyphs.ts.
# Run from virtumetry/: python scripts/render-brand.py   (stdlib + Pillow only, no network)
from pathlib import Path

from PIL import Image, ImageDraw

BG = (6, 10, 10)
BG_TOP = (16, 24, 26)  # #10181a
TEXT = (231, 242, 242)
PRIMARY = (162, 204, 203)
WHITE = (255, 255, 255)

ARMS = [((4, 5), (12, 14)), ((20, 5), (12, 14)), ((12, 14), (12, 21))]
TICKS = [((x, y), (x + 1.64, y + 1.46)) for x, y in ((18, 7.25), (16, 9.5), (14, 11.75))]
DOT = ((12, 14), 1.6)

SS = 4  # supersampling factor
OUT = Path(__file__).resolve().parent.parent / "assets" / "images"


def _line(d, a, b, width, color):
    d.line([a, b], fill=color, width=round(width))
    r = width / 2
    for x, y in (a, b):  # round caps
        d.ellipse([x - r, y - r, x + r, y + r], fill=color)


def draw_mark(img, box, colors, stroke_units=2.0):
    """Draw the 24-unit mark into img (already supersampled), box = fraction of canvas."""
    arm_c, tick_c = colors
    size = img.size[0]
    scale = size * box / 24
    off = (size - size * box) / 2
    p = lambda pt: (off + pt[0] * scale, off + pt[1] * scale)  # noqa: E731
    d = ImageDraw.Draw(img)
    for a, b in ARMS:
        _line(d, p(a), p(b), stroke_units * scale, arm_c)
    for a, b in TICKS:
        _line(d, p(a), p(b), 1.5 * scale, tick_c)
    (cx, cy), r = p(DOT[0]), DOT[1] * scale
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=tick_c)


def render(name, size, box, colors, mode, bg=None, stroke_units=2.0):
    big = size * SS
    if mode == "RGB" and isinstance(bg, tuple) and isinstance(bg[0], tuple):
        top, bottom = bg
        img = Image.new("RGB", (big, big))
        d = ImageDraw.Draw(img)
        for y in range(big):
            t = y / (big - 1)
            d.line([(0, y), (big, y)], fill=tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    elif mode == "RGB":
        img = Image.new("RGB", (big, big), bg)
    else:
        img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw_mark(img, box, colors, stroke_units)
    img.resize((size, size), Image.LANCZOS).save(OUT / name, optimize=True)


if __name__ == "__main__":
    render("icon.png", 1024, 0.58, (TEXT, PRIMARY), "RGB", bg=(BG_TOP, BG))
    render("splash-icon.png", 1024, 0.70, (TEXT, PRIMARY), "RGBA")
    render("android-icon-foreground.png", 1024, 0.40, (TEXT, PRIMARY), "RGBA")
    render("android-icon-monochrome.png", 1024, 0.40, (WHITE, WHITE), "RGBA")
    render("favicon.png", 64, 0.80, (TEXT, PRIMARY), "RGB", bg=BG, stroke_units=2.5)
    print("rendered to", OUT)
