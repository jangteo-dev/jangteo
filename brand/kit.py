import os, json, base64
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from mark import mark, INK, PAPER, GOLD, RED, BLUE

OUT = "jangteo-brand-kit"
for d in ["logo", "social", "coin", "favicon", "web"]:
    os.makedirs(f"{OUT}/{d}", exist_ok=True)

fonts = {"hahmlet": TTFont("hahmlet700.ttf"), "gowun": TTFont("gowun.ttf")}

def text_path(txt, font, size, x, y, fill, tracking=0):
    """Text as outlines, so no SVG depends on an installed font."""
    f = fonts[font]
    gs = f.getGlyphSet(); cmap = f.getBestCmap(); upm = f["head"].unitsPerEm
    s = size / upm; out = []; cx = x
    for ch in txt:
        g = cmap.get(ord(ch))
        if g is None: continue
        pen = SVGPathPen(gs)
        gs[g].draw(TransformPen(pen, (s, 0, 0, -s, cx, y)))
        out.append(pen.getCommands())
        cx += gs[g].width * s + tracking
    return f'<path fill="{fill}" d="{" ".join(out)}"/>', cx - x - tracking

def svg(inner, w, h, bg=None):
    b = f'<rect width="{w}" height="{h}" fill="{bg}"/>' if bg else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">{b}{inner}</svg>'

def m(x, y, size, **kw):
    return f'<g transform="translate({x} {y}) scale({size/512})">{mark(**kw)}</g>'

def write(path, s):
    open(f"{OUT}/{path}", "w").write(s)

# ---- marks
write("logo/jangteo-mark.svg", svg(mark(), 512, 512))
write("logo/jangteo-mark-transparent-dark.svg", svg(mark(bg=False), 512, 512))  # on dark backgrounds
write("logo/jangteo-mark-transparent-light.svg", svg(mark(bg=False, fg_paper=INK), 512, 512))  # on light backgrounds

# ---- lockups: mark + 장터 + Jangteo
def lockup(dark):
    fg = PAPER if dark else INK; sub = "#b4b9c2" if dark else "#4a5163"
    ko, wko = text_path("장터", "hahmlet", 150, 250, 172, fg, 4)
    en, wen = text_path("Jangteo", "hahmlet", 78, 250 + wko + 26, 184, sub, 1)
    w = int(250 + wko + 26 + wen + 30)
    inner = m(10, 10, 210, bg=True) + ko + en
    return svg(inner, w, 230, None), w
for dark in (False, True):
    s, w = lockup(dark)
    write(f"logo/jangteo-lockup-{'dark' if dark else 'light'}.svg", s)

# stacked (mark over wordmark), for square spaces
def stacked(dark):
    fg = PAPER if dark else INK
    ko, wko = text_path("장터", "hahmlet", 150, 0, 0, fg, 4)
    ko, wko = text_path("장터", "hahmlet", 150, (600 - wko) / 2, 560, fg, 4)
    en, wen = text_path("JANGTEO", "gowun", 44, 0, 0, fg, 14)
    en, wen = text_path("JANGTEO", "gowun", 44, (600 - wen) / 2, 630, "#b4b9c2" if dark else "#4a5163", 14)
    return svg(m(150, 40, 300) + ko + en, 600, 670, INK if dark else "#f5f6f3")
write("logo/jangteo-stacked-light.svg", stacked(False))
write("logo/jangteo-stacked-dark.svg", stacked(True))

# ---- social avatars (circle-safe: the mark sits inside the crop circle)
avatar = svg(f'<rect width="400" height="400" fill="{INK}"/>' + m(40, 34, 320, bg=False), 400, 400)
write("social/x-avatar-400.svg", avatar)
write("social/discord-icon-512.svg", svg(f'<rect width="512" height="512" fill="{INK}"/>' + m(51, 44, 410, bg=False), 512, 512))

# ---- banners: ink field, dancheong band, lockup, a gallery of Tal masks
tals = json.load(open("tals.json"))
def banner(w, h, masks_n, tag_en, tag_ko, scale=1.0):
    inner = [f'<rect width="{w}" height="{h}" fill="{INK}"/>']
    # dancheong band along the bottom
    band = h - 34 * scale
    cols = [RED, GOLD, "#3e7f6b", BLUE, PAPER]
    x = 0; i = 0
    while x < w:
        inner.append(f'<rect x="{x}" y="{band}" width="{40*scale}" height="{34*scale}" fill="{cols[i % 5]}" opacity=".9"/>'); x += 40 * scale; i += 1
    inner.append(f'<rect x="0" y="{band-6*scale}" width="{w}" height="{6*scale}" fill="{GOLD}"/>')
    # lockup left
    ms = 150 * scale; lx = 70 * scale; ly = (band - ms) / 2 - 58 * scale
    inner.append(m(lx, ly, ms, bg=False))
    ko, wko = text_path("장터", "hahmlet", 120 * scale, lx + ms + 24 * scale, ly + ms * 0.66, PAPER, 3)
    en, wen = text_path("Jangteo", "hahmlet", 60 * scale, lx + ms + 36 * scale + wko, ly + ms * 0.66 + 10 * scale, "#b4b9c2", 1)
    inner += [ko, en]
    t1, _ = text_path(tag_en, "gowun", 34 * scale, lx + 6 * scale, ly + ms + 58 * scale, PAPER, 0.5)
    t2, _ = text_path(tag_ko, "gowun", 30 * scale, lx + 6 * scale, ly + ms + 104 * scale, GOLD, 0.5)
    inner += [t1, t2]
    # Tal gallery on the right
    size = 190 * scale; gap = 22 * scale
    x0 = w - 60 * scale - masks_n * size - (masks_n - 1) * gap
    for k in range(masks_n):
        tx = x0 + k * (size + gap); ty = (band - size) / 2 + (18 * scale if k % 2 else -18 * scale)
        inner.append(f'<rect x="{tx-8*scale}" y="{ty-8*scale}" width="{size+16*scale}" height="{size+16*scale}" fill="{PAPER}" rx="{3*scale}"/>')
        # each mask as its own image, so its <style> and ids stay isolated
        b64 = base64.b64encode(tals[k].encode()).decode()
        inner.append(f'<image x="{tx}" y="{ty}" width="{size}" height="{size}" href="data:image/svg+xml;base64,{b64}"/>')
    return svg("".join(inner), w, h)
write("social/x-banner-1500x500.svg", banner(1500, 500, 3, "Korean crypto markets on GIWA", "GIWA 위의 한국식 장터"))
write("social/discord-banner-960x540.svg", banner(960, 540, 2, "Korean crypto markets on GIWA", "GIWA 위의 한국식 장터", 0.72))
write("web/og-image-1200x630.svg", banner(1200, 630, 2, "Korean crypto markets on GIWA", "GIWA 위의 한국식 장터", 0.95))

# ---- coin icon: minted gold rim, ink face, the gate in the middle
def coin(size=512, ring=True):
    c = size / 2
    inner = [f'<circle cx="{c}" cy="{c}" r="{c}" fill="{GOLD}"/>',
             f'<circle cx="{c}" cy="{c}" r="{c*0.9}" fill="#b8841a"/>',
             f'<circle cx="{c}" cy="{c}" r="{c*0.86}" fill="{INK}"/>']
    if ring:
        # 36 milled dots around the rim, like a stamped coin
        import math
        for k in range(36):
            a = 2 * math.pi * k / 36
            inner.append(f'<circle cx="{c + c*0.95*math.cos(a):.1f}" cy="{c + c*0.95*math.sin(a):.1f}" r="{c*0.018:.1f}" fill="#8f6512"/>')
    inner.append(m(c - c * 0.66, c - c * 0.70, c * 1.32, bg=False))
    return svg("".join(inner), size, size)
write("coin/jangteo-coin.svg", coin())
write("coin/jangteo-coin-flat.svg", coin(ring=False))

# ---- favicon
write("favicon/favicon.svg", svg(mark(), 512, 512))
print("svg ok")
