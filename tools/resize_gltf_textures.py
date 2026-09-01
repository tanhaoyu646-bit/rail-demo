from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


def main() -> None:
    parser = argparse.ArgumentParser(description="Downsize external glTF textures in-place.")
    parser.add_argument("directory", type=Path)
    parser.add_argument("--max-size", type=int, default=1024)
    args = parser.parse_args()

    for path in sorted(args.directory.iterdir()):
        if path.suffix.lower() not in {".png", ".jpg", ".jpeg"}:
            continue
        with Image.open(path) as source:
            image = source.copy()
        image.thumbnail((args.max_size, args.max_size), Image.Resampling.LANCZOS)
        if path.suffix.lower() == ".png":
            image.save(path, optimize=True, compress_level=9)
        else:
            image.convert("RGB").save(path, quality=88, optimize=True, progressive=True)
        print(f"{path.name}: {image.width}x{image.height} {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
