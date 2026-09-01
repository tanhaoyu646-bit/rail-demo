from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np


def order_points(points: np.ndarray) -> np.ndarray:
    ordered = np.zeros((4, 2), dtype=np.float32)
    sums = points.sum(axis=1)
    diffs = np.diff(points, axis=1).reshape(-1)
    ordered[0] = points[np.argmin(sums)]
    ordered[2] = points[np.argmax(sums)]
    ordered[1] = points[np.argmin(diffs)]
    ordered[3] = points[np.argmax(diffs)]
    return ordered


def straighten(source: Path, destination: Path) -> None:
    image = cv2.imread(str(source), cv2.IMREAD_UNCHANGED)
    if image is None:
        raise RuntimeError(f"Cannot read {source}")
    if image.ndim == 2:
        image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGRA)
    elif image.shape[2] == 3:
        image = cv2.cvtColor(image, cv2.COLOR_BGR2BGRA)

    alpha = image[:, :, 3]
    if np.count_nonzero(alpha > 16) < alpha.size * 0.2:
        gray = cv2.cvtColor(image[:, :, :3], cv2.COLOR_BGR2GRAY)
        mask = np.where(gray > 12, 255, 0).astype(np.uint8)
    else:
        mask = np.where(alpha > 16, 255, 0).astype(np.uint8)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        raise RuntimeError(f"No foreground in {source}")
    contour = max(contours, key=cv2.contourArea)
    box = order_points(cv2.boxPoints(cv2.minAreaRect(contour)).astype(np.float32))
    tl, tr, br, bl = box
    width = max(1, int(max(np.linalg.norm(br - bl), np.linalg.norm(tr - tl))))
    height = max(1, int(max(np.linalg.norm(tr - br), np.linalg.norm(tl - bl))))
    target = np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(box, target)
    warped = cv2.warpPerspective(image, matrix, (width, height), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT)
    if warped.shape[1] > warped.shape[0]:
        warped = cv2.rotate(warped, cv2.ROTATE_90_COUNTERCLOCKWISE)

    margin = 28
    canvas = np.zeros((640, 480, 4), dtype=np.uint8)
    scale = min((canvas.shape[1] - margin * 2) / warped.shape[1], (canvas.shape[0] - margin * 2) / warped.shape[0])
    resized = cv2.resize(warped, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    y = (canvas.shape[0] - resized.shape[0]) // 2
    x = (canvas.shape[1] - resized.shape[1]) // 2
    canvas[y:y + resized.shape[0], x:x + resized.shape[1]] = resized
    destination.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(destination), canvas, [cv2.IMWRITE_PNG_COMPRESSION, 9])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_dir", type=Path)
    parser.add_argument("destination_dir", type=Path)
    args = parser.parse_args()
    for source in sorted(args.source_dir.glob("*.png")):
        if not (source.name.startswith("book-") or source.name.startswith("certificate-")):
            continue
        destination = args.destination_dir / source.name
        straighten(source, destination)
        print(destination)


if __name__ == "__main__":
    main()
