# -*- coding: utf-8 -*-
"""生成 MkDown 应用图标：32x32.png / 128x128.png / 128x128@2x.png / icon.png / icon.ico"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = r"D:\WWW\MkDown\src-tauri\icons"
os.makedirs(OUT, exist_ok=True)

def make(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = size // 5  # 圆角
    # 背景圆角矩形（深青蓝渐变模拟：纯色 + 顶部高光）
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=(30, 64, 94, 255))
    d.rounded_rectangle([0, 0, size - 1, size // 2], radius=r, fill=(43, 84, 122, 255))
    d.rectangle([0, size // 3, size - 1, size // 2], fill=(43, 84, 122, 255))
    # "M" 字标
    font = None
    for cand in (r"C:\Windows\Fonts\segoeuib.ttf", r"C:\Windows\Fonts\arialbd.ttf", "arial.ttf"):
        try:
            font = ImageFont.truetype(cand, int(size * 0.62))
            break
        except OSError:
            continue
    if font is None:
        font = ImageFont.load_default()
    text = "M"
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (size - tw) / 2 - bbox[0]
    y = (size - th) / 2 - bbox[1] - size * 0.03
    d.text((x, y), text, font=font, fill=(255, 255, 255, 255))
    # 底部小横条（代表下行/预览）
    bar_y = int(size * 0.78)
    d.rounded_rectangle([size * 0.22, bar_y, size * 0.78, bar_y + size * 0.07], radius=size * 0.035, fill=(120, 200, 255, 255))
    return img

base = make(512)
base.save(os.path.join(OUT, "icon.png"))
for name, s in [("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256)]:
    base.resize((s, s), Image.LANCZOS).save(os.path.join(OUT, name))
base.save(
    os.path.join(OUT, "icon.ico"),
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("icons generated:", os.listdir(OUT))
