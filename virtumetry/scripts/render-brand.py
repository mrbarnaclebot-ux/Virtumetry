# Renders the Virtumetry brand mark (UI-SPEC 13.1) into icon/splash/adaptive/favicon PNGs (13.4),
# plus the template tab-icon fallbacks (stack + gear) used by NativeTabs.
# Colours mirror src/design/tokens.ts (bg #060a0a, text #e7f2f2, primary #a2cccb, secondary #3e4a71).
# Geometry mirrors glyphs.brandMark in src/design/glyphs.ts (24-unit grid).
# Run from virtumetry/: python scripts/render-brand.py   (stdlib + Pillow only, no network)
import math
from pathlib import Path

from PIL import Image, ImageDraw

BG = (6, 10, 10)
SECONDARY = (62, 74, 113)
TEXT = (231, 242, 242)
PRIMARY = (162, 204, 203)
WHITE = (255, 255, 255)
BLACK = (0, 0, 0)

ARMS = [((12, 14), (3.77, 9.25)), ((12, 14), (20.23, 9.25)), ((12, 14), (12, 23.5))]  # edges run to the outline: a solid corner
# A room corner (three edges) inside its fine isometric outline: reads as a scanned room, never as a letter.
OUTLINE = [((12.0, 4.5), (3.77, 9.25)), ((3.77, 9.25), (3.77, 18.75)), ((3.77, 18.75), (12.0, 23.5)), ((12.0, 23.5), (20.23, 18.75)), ((20.23, 18.75), (20.23, 9.25)), ((20.23, 9.25), (12.0, 4.5))]  # outline edges
DOT = ((12, 14), 1.6)
CENTER = (12, 14)  # middle of the outline (4.5..23.5)

SS = 4  # supersampling factor
OUT = Path(__file__).resolve().parent.parent / "assets" / "images"


def _line(d, a, b, width, color):
    r = width / 2
    dx, dy = b[0] - a[0], b[1] - a[1]
    n = math.hypot(dx, dy) or 1
    ox, oy = -dy / n * r, dx / n * r  # exact stroke body (Pillow's wide line overshoots round caps)
    d.polygon([(a[0] + ox, a[1] + oy), (b[0] + ox, b[1] + oy), (b[0] - ox, b[1] - oy), (a[0] - ox, a[1] - oy)], fill=color)
    for x, y in (a, b):  # round caps
        d.ellipse([x - r, y - r, x + r, y + r], fill=color)


def draw_mark(img, box, colors, stroke=1.6, tick=1.1):
    """Draw the 24-unit mark into img (supersampled), centred; box = 24 units as a fraction of the canvas."""
    arm_c, tick_c = colors
    size = img.size[0]
    scale = size * box / 24
    p = lambda pt: (size / 2 + (pt[0] - CENTER[0]) * scale, size / 2 + (pt[1] - CENTER[1]) * scale)  # noqa: E731
    d = ImageDraw.Draw(img)
    for a, b in OUTLINE:
        _line(d, p(a), p(b), tick * scale, tick_c)
    for a, b in ARMS:
        _line(d, p(a), p(b), stroke * scale, arm_c)
    (cx, cy), r = p(DOT[0]), DOT[1] * scale
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=tick_c)


def vignette(big):
    """Near-black tile whose corners lean very slightly toward secondary (no glow, no gradient light source)."""
    edge = tuple(round(BG[i] + (SECONDARY[i] - BG[i]) * 0.16) for i in range(3))
    mask = Image.radial_gradient("L").resize((big, big), Image.BICUBIC)  # 0 centre → 255 edge
    return Image.composite(Image.new("RGB", (big, big), edge), Image.new("RGB", (big, big), BG), mask)


def render(name, size, box, colors, mode, bg=None, **kw):
    big = size * SS
    if bg == "vignette":
        img = vignette(big)
    elif mode == "RGB":
        img = Image.new("RGB", (big, big), bg)
    else:
        img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw_mark(img, box, colors, **kw)
    img.resize((size, size), Image.LANCZOS).save(OUT / name, optimize=True)


# Tab icons: template images (only alpha matters), 24-grid, 1.75 stroke like the in-app glyphs.
def _poly(d, pts, w):
    d.line(pts, fill=BLACK, width=w, joint="curve")
    r = w / 2
    for x, y in (pts[0], pts[-1]):  # round caps
        d.ellipse([x - r, y - r, x + r, y + r], fill=BLACK)


def _stack(d, p, w):
    _poly(d, [p(q) for q in ((12, 3.5), (21, 8), (12, 12.5), (3, 8), (12, 3.5))], w)
    for y in (12.25, 16.5):
        _poly(d, [p((3, y)), p((12, y + 4.5)), p((21, y))], w)


def _gear(d, p, w):
    pts = []
    for i in range(8):
        a = i * math.pi / 4
        for r, da in ((6.9, -0.26), (9, -0.15), (9, 0.15), (6.9, 0.26)):
            pts.append(p((12 + r * math.cos(a + da), 12 + r * math.sin(a + da))))
    _poly(d, pts + pts[:1], w)
    (cx, cy), r = p((12, 12)), 3 * w / 1.75
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=BLACK, width=w)


def render_tab(name, draw):
    for suffix, scale in (("", 1), ("@2x", 2), ("@3x", 3)):
        size = 25 * scale
        big = size * SS
        img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
        k = big / 24
        w = round(1.75 * k)

        def p(q, k=k):
            return (q[0] * k, q[1] * k)

        d = ImageDraw.Draw(img)
        draw(d, p, w)
        img.resize((size, size), Image.LANCZOS).save(OUT / "tabIcons" / f"{name}{suffix}.png", optimize=True)


if __name__ == "__main__":
    # Visible mark ≈ 18.6 of 24 units; box 0.80 → mark ≈ 62% of the tile.
    render("icon.png", 1024, 0.80, (TEXT, PRIMARY), "RGB", bg="vignette")
    render("splash-icon.png", 1024, 0.80, (TEXT, PRIMARY), "RGBA")
    render("android-icon-foreground.png", 1024, 0.52, (TEXT, PRIMARY), "RGBA")
    render("android-icon-monochrome.png", 1024, 0.52, (WHITE, WHITE), "RGBA")
    render("favicon.png", 64, 0.92, (TEXT, PRIMARY), "RGB", bg=BG, stroke=2.2, tick=1.6)
    render_tab("library", _stack)
    render_tab("settings", _gear)
    print("rendered to", OUT)
