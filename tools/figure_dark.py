"""Makes a dark-background version of a white-background figure (a paper figure screenshot).

White becomes transparent; coloured marks keep their exact colours; black/grey text and lines turn
light. Anti-aliased edges are un-blended from white using the solid colour next to them, so edges
stay clean (no white fringes) on a dark page.

Optional 4th argument, lift (0-1, default 0): brightens the darkest colours (OKLab lightness below
0.62), so dark labels stay readable on a dark page. Every pixel of a colour moves the same way, so
legend labels still match the marks they describe.

Usage (needs Pillow and NumPy):
    python3 tools/figure_dark.py images/gr3_lrg.jpg images/gr3_dark.webp 1200 0.7
"""
import sys
import numpy as np
from PIL import Image

src, dst, width = sys.argv[1], sys.argv[2], int(sys.argv[3])
lift = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0
im = Image.open(src).convert("RGB")
if im.width > width:
    im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
c = np.asarray(im).astype(np.float32) / 255.0
H, W, _ = c.shape

ink = (1 - c).max(-1)          # how far from white each pixel is

# For each pixel, the "solid" colour of the mark it belongs to: the inkiest pixel within 2px.
R = 2
pad = np.pad(c, ((R, R), (R, R), (0, 0)), mode="edge")
pad_ink = np.pad(ink, R, mode="edge")
best_ink = np.full((H, W), -1.0, np.float32)
F = np.ones_like(c)
for dy in range(2 * R + 1):
    for dx in range(2 * R + 1):
        k = pad_ink[dy:dy + H, dx:dx + W]
        better = k > best_ink
        best_ink = np.where(better, k, best_ink)
        F = np.where(better[..., None], pad[dy:dy + H, dx:dx + W], F)

# Pixel = a * F + (1 - a) * white  ->  solve for a (least squares over the channels).
d = 1 - F
a = ((1 - c) * d).sum(-1) / np.maximum((d * d).sum(-1), 1e-4)
a = np.clip(a, 0, 1)
a = np.clip((a - 0.06) / 0.94, 0, 1)          # drop JPEG noise in the white background
a = np.where(best_ink < 0.08, 0, a)           # nothing but background nearby

# Neutral marks (black/grey text, axes, the divider): light ink, as opaque as the mark was dark.
F_chroma = F.max(-1) - F.min(-1)
neutral = np.clip((0.10 - F_chroma) / 0.05, 0, 1)[..., None]
light = np.array([0.93, 0.90, 0.91], np.float32)
F_dark = (1 - F.mean(-1))[..., None]
def lift_dark(rgb, amount, floor=0.62):
    """Raises OKLab lightness below `floor` towards it, keeping hue and chroma."""
    lin = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    M1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929],
                   [0.2119034982, 0.6806995451, 0.1073969566],
                   [0.0883024619, 0.2817188376, 0.6299787005]], np.float32)
    M2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468],
                   [1.9779984951, -2.4285922050, 0.4505937099],
                   [0.0259040371, 0.7827717662, -0.8086757660]], np.float32)
    lab = np.cbrt(lin @ M1.T) @ M2.T
    L = lab[..., 0]
    lab[..., 0] = np.where(L < floor, L + (floor - L) * amount, L)
    lms = (lab @ np.linalg.inv(M2).T) ** 3
    lin = np.clip(lms @ np.linalg.inv(M1).T, 0, 1)
    return np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055)

if lift > 0:
    F = lift_dark(F, lift)
rgb = F * (1 - neutral) + light * neutral
alpha = a[..., None] * ((1 - neutral) + neutral * np.clip(F_dark * 1.5, 0, 1))

out = np.dstack([rgb, alpha])
result = Image.fromarray((out * 255 + 0.5).astype(np.uint8), "RGBA")
if dst.lower().endswith(".webp"):
    result.save(dst, lossless=True, method=6)
else:
    result.save(dst, optimize=True)
