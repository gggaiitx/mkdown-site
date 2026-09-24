# 码克应用图标源图生成：1024x1024，浅蓝圆角方 + 深蓝 M + 亮蓝光标块
from PIL import Image, ImageDraw

S = 1024
K = S / 102.0  # 与 Welcome.vue 内联 SVG 同一套坐标，等比放大

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角方底板
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=230, fill=(230, 241, 251, 255))  # #E6F1FB

# M 字标（圆头折线）
pts = [(27 * K, 72 * K), (27 * K, 32 * K), (42 * K, 50 * K), (57 * K, 32 * K), (57 * K, 72 * K)]
W = round(7 * K)
d.line(pts, fill=(12, 68, 124, 255), width=W, joint="curve")  # #0C447C
r = W / 2
for p in (pts[0], pts[-1]):  # 圆头端帽
    d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=(12, 68, 124, 255))

# 光标块（输入光标，呼应"码字"）
d.rounded_rectangle(
    [63 * K, 60 * K, 74 * K, 74 * K], radius=round(2.5 * K), fill=(55, 138, 221, 255)  # #378ADD
)

img.save("repro/app-icon.png")
print("ok", img.size)
