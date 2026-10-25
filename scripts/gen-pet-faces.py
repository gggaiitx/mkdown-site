"""码猫表情图归一化：四张原图 → 同一画布、同一基准线。

为什么必须归一：四张图分别 569x752 / 652x805 / 1024x1024(白底) / 572x758，
角色比例和画布留白都不一样。直接交叉淡化会在切换瞬间"跳一下"，
所以统一到「头顶到脚底等高 + 底边对齐 + 水平居中」。

原始参考图放在 vibe_images/（22MB，不入库）。产物在 src/assets/mascot/。
用法：python scripts/gen-pet-faces.py
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "src" / "assets" / "mascot"
PREVIEW_DIR = ROOT / "repro" / "pet-frames"

SOURCES = {
    "idle": ROOT / "vibe_images" / "mascot" / "focus.png",
    "happy": ROOT / "vibe_images" / "mkdown-m-cat-3d-happy-v1_1792902398281_a9ec1207.png",
    "greet": ROOT / "vibe_images" / "mascot" / "greet.png",
    "sleepy": ROOT / "vibe_images" / "mascot" / "sleepy.png",
}

CANVAS_W = 240
CONTENT_H = 288          # 角色（头顶到脚底）在画布里的高度（greet 举手那张最宽，按它定）
BOTTOM_PAD = 2           # 脚底离画布底边的留白（几乎贴边）


def strip_white_bg(im: Image.Image, tol: int = 26) -> Image.Image:
    """把「从四边连通过来的白色」变透明。

    只抠连到画布边缘的白，猫身上的白色胸毛（被描边围住）不会动。
    用 PIL 的 floodfill（C 实现），比在 100 万像素上跑 Python BFS 快两个数量级。
    """
    rgb = im.convert("RGB")
    w, h = rgb.size
    sentinel = (255, 0, 255)
    for xy in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        if rgb.getpixel(xy) != sentinel:
            ImageDraw.floodfill(rgb, xy, sentinel, thresh=tol)
    a = np.array(rgb)
    is_bg = (a[..., 0] == 255) & (a[..., 1] == 0) & (a[..., 2] == 255)
    rgba = np.array(im.convert("RGBA"))
    rgba[is_bg, 3] = 0
    return Image.fromarray(rgba, "RGBA")


def prep(name: str, path: Path) -> Image.Image:
    im = Image.open(path).convert("RGBA")
    alpha = np.array(im)[..., 3]
    # 已经有透明背景的图不用抠；alpha 全满说明是白底
    if (alpha < 16).mean() < 0.02:
        im = strip_white_bg(im)
    return im


def crop_to_alpha(im: Image.Image, pad: int = 2) -> Image.Image:
    a = np.array(im)[..., 3]
    ys, xs = np.where(a > 16)
    box = (max(xs.min() - pad, 0), max(ys.min() - pad, 0), min(xs.max() + pad + 1, im.width), min(ys.max() + pad + 1, im.height))
    return im.crop(box)


def build() -> dict[str, Image.Image]:
    croped = {k: crop_to_alpha(prep(k, p)) for k, p in SOURCES.items()}

    # 画布高度 = 内容高 + 上下留白
    canvas_h = CONTENT_H + BOTTOM_PAD + 4
    out: dict[str, Image.Image] = {}
    for name, im in croped.items():
        scale = CONTENT_H / im.height
        w = max(round(im.width * scale), 1)
        resized = im.resize((w, CONTENT_H), Image.LANCZOS)
        if w > CANVAS_W:
            raise SystemExit(f"{name} 缩放后宽 {w}px 超过画布 {CANVAS_W}px，调大 CANVAS_W")
        canvas = Image.new("RGBA", (CANVAS_W, canvas_h), (0, 0, 0, 0))
        canvas.alpha_composite(resized, ((CANVAS_W - w) // 2, 4))
        out[name] = canvas
    return out


def _fur(arr, cx, y, rx):
    """在 y 这一行取毛发色中位数（跳过深色描边和条纹）。"""
    band = arr[max(y - 2, 0): y + 3, max(cx - rx, 0): cx + rx, :3].reshape(-1, 3)
    alpha = arr[max(y - 2, 0): y + 3, max(cx - rx, 0): cx + rx, 3].reshape(-1)
    lum = band @ np.array([0.299, 0.587, 0.114])
    ok = (alpha > 0.9) & (lum > 0.55)
    if ok.sum() < 6:
        ok = alpha > 0.9
    return np.median(band[ok], axis=0)


def build_eyes(canvas: Image.Image, eyes):
    """闭眼覆盖层（与表情图同画布）。眼皮 = 上下毛发色渐变 + 一道 ∩ 形笑眼弧。

    直接覆盖而不是把眼睛压扁——压扁会把毛发拉成竖条，小尺寸下看着像糊了一团。
    """
    w, h = canvas.size
    arr = np.asarray(canvas, dtype=np.float64) / 255.0
    gy, gx = np.mgrid[0:h, 0:w]
    out = np.zeros((h, w, 4))
    for (cx, cy, rx, ry) in eyes:
        top = _fur(arr, cx, int(cy - ry - 9), int(rx * 1.5)) * 0.985
        bot = _fur(arr, cx, int(cy + ry + 9), int(rx * 1.5)) * 0.985
        # 椭圆要盖住整只眼（含眼线），边缘留宽过渡才不生硬
        # 检测到的是"深色连通域"，浅蓝的眼白和眼线比它外扩 2~3px，椭圆按 +7 给
        d = np.sqrt(((gx - cx) / (rx + 7.0)) ** 2 + ((gy - cy) / (ry + 7.0)) ** 2)
        k = np.clip((d - 0.60) / 0.40, 0, 1)
        m = 1.0 - k * k * (3 - 2 * k)
        t = np.clip((gy - (cy - ry)) / (2 * ry), 0, 1)[..., None]
        col = top * (1 - t) + bot * t
        out[..., :3] = np.where(m[..., None] > 0, col, out[..., :3])
        out[..., 3] = np.maximum(out[..., 3], m)

    img = Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8), "RGBA")
    d = ImageDraw.Draw(img)
    lw = max(3, round(w * 0.017))
    for (cx, cy, rx, ry) in eyes:
        d.arc([cx - rx, cy - ry * 0.05, cx + rx, cy + ry * 1.65],
              188, 352, fill=(56, 64, 76, 255), width=lw)
    return img


def save(faces: dict[str, Image.Image]):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, im in faces.items():
        dst = OUT_DIR / f"pet-face-{name}.webp"
        im.save(dst, "WEBP", quality=92, method=6, alpha_quality=100)
        print(f"  {dst.name}: {im.size[0]}x{im.size[1]}  {dst.stat().st_size / 1024:.0f} KB")

    # 眨眼层：坐标按归一化后的 idle 图换算（原图 569x752 的眼睛 168/340，缩放系数 0.394）
    eyes = build_eyes(faces["idle"], [(74, 87, 16.5, 16.5), (142, 87, 17.0, 16.5)])
    dst = OUT_DIR / "pet-eyes.png"
    eyes.save(dst, "PNG", optimize=True)
    print(f"  {dst.name}: {eyes.size[0]}x{eyes.size[1]}  {dst.stat().st_size / 1024:.0f} KB")

    # 四联对照：切换时头/脚是否对齐，一眼能看出来
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    pad = 10
    w, h = faces["idle"].size
    board = Image.new("RGBA", (w * 4 + pad * 5, h + pad * 2), (246, 247, 250, 255))
    for i, (name, im) in enumerate(faces.items()):
        board.alpha_composite(im, (pad + i * (w + pad), pad))
    d = ImageDraw.Draw(board)
    d.line([(0, pad + h - BOTTOM_PAD), (board.width, pad + h - BOTTOM_PAD)], fill=(255, 60, 60, 255), width=1)
    board.save(PREVIEW_DIR / "faces-board.png")
    print("  preview → repro/pet-frames/faces-board.png")


if __name__ == "__main__":
    save(build())
