#!/usr/bin/env python3
"""Scratchpad demo tool: grayscale-blend an image. Exists to smoke-test the hub."""
import argparse
import os

from PIL import Image, ImageOps


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--source", nargs="+", required=True)
    p.add_argument("--strength", type=float, default=1.0, help="0=untouched, 1=full grayscale")
    p.add_argument("--mode", choices=["luma", "average"], default="luma")
    p.add_argument("--keep-exif", action="store_true")
    p.add_argument("--output-dir", required=True)
    args = p.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)
    for src in args.source:
        print(f"processing {src} (strength={args.strength}, mode={args.mode})")
        with Image.open(src) as im:
            exif = im.info.get("exif") if args.keep_exif else None
            rgb = im.convert("RGB")
            if args.mode == "luma":
                gray = ImageOps.grayscale(rgb).convert("RGB")
            else:
                px = rgb.split()
                gray = Image.merge("RGB", [Image.blend(Image.blend(px[0], px[1], 0.5), px[2], 0.33)] * 3)
            out = Image.blend(rgb, gray, max(0.0, min(1.0, args.strength)))
            stem, _ = os.path.splitext(os.path.basename(src))
            dest = os.path.join(args.output_dir, f"{stem}_gray.jpg")
            kwargs = {"exif": exif} if exif else {}
            out.save(dest, "JPEG", quality=92, **kwargs)
            print(f"wrote {dest}")
    print("done")


if __name__ == "__main__":
    main()
