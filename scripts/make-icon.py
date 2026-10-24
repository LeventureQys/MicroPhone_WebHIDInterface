"""一次性生成应用图标：深色圆角底 + 品牌琥珀色电平柱。

依赖 Pillow（构建机一次性使用，不进入运行时依赖）。产物：
  build/icon.ico  electron-builder 打包用（含 16–256 多尺寸）
  build/icon.png  512×512 预览
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"

BG = (23, 28, 38, 255)          # --panel #171c26
BORDER = (106, 74, 53, 255)     # 品牌描边 #6a4a35
BAR = (240, 166, 91, 255)       # --accent #f0a65b
SIZE = 512


def render(size: int) -> Image.Image:
    scale = size / SIZE
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    margin = int(28 * scale)
    radius = int(104 * scale)
    draw.rounded_rectangle(
        (margin, margin, size - margin, size - margin),
        radius=radius,
        fill=BG,
        outline=BORDER,
        width=max(1, int(10 * scale)),
    )

    heights = [120, 220, 330, 220, 120]
    bar_w = int(44 * scale)
    gap = int(24 * scale)
    total = len(heights) * bar_w + (len(heights) - 1) * gap
    x = (size - total) / 2
    for height in heights:
        h = int(height * scale)
        y0 = (size - h) / 2
        draw.rounded_rectangle(
            (x, y0, x + bar_w, y0 + h),
            radius=bar_w / 2,
            fill=BAR,
        )
        x += bar_w + gap

    return canvas


def main() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    base = render(SIZE)
    base.save(BUILD / "icon.png")
    base.save(
        BUILD / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("wrote", BUILD / "icon.ico", BUILD / "icon.png")


if __name__ == "__main__":
    main()
