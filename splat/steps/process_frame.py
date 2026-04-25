"""Segment people then inpaint, per-frame, via fal.ai. Caches each step on disk."""
import argparse
import io
import json
import os
import sys
import time
from pathlib import Path

import fal_client
import requests
from dotenv import load_dotenv
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT.parent / ".env")
os.environ["FAL_KEY"] = os.environ["FAL_KEY"]

WORK = ROOT / "work"
FRAMES = WORK / "frames"
MASKS = WORK / "masks"
CLEAN = WORK / "clean"
META = WORK / "meta"
for d in (MASKS, CLEAN, META):
    d.mkdir(parents=True, exist_ok=True)

SEG_MODEL = "fal-ai/evf-sam"  # text-prompted SAM, returns mask
INPAINT_MODEL = "fal-ai/lama"  # image + mask -> inpainted image
PROMPT = "person"
MASK_DILATE_PX = 8


def download(url: str) -> bytes:
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    return r.content


def segment(frame_path: Path, mask_path: Path) -> dict:
    if mask_path.exists():
        return {"cached": True}
    image_url = fal_client.upload_file(str(frame_path))
    result = fal_client.subscribe(
        SEG_MODEL,
        arguments={
            "image_url": image_url,
            "prompt": PROMPT,
            "mask_only": True,
            "fill_holes": True,
        },
    )
    # Find mask URL in result
    mask_url = None
    for key in ("image", "mask", "output"):
        v = result.get(key)
        if isinstance(v, dict) and v.get("url"):
            mask_url = v["url"]
            break
    if mask_url is None and isinstance(result, dict):
        # search nested
        for v in result.values():
            if isinstance(v, dict) and isinstance(v.get("url"), str):
                mask_url = v["url"]
                break
    if mask_url is None:
        raise RuntimeError(f"could not locate mask URL in result: {json.dumps(result)[:400]}")
    mask_path.write_bytes(download(mask_url))
    return {"cached": False, "image_url": image_url, "mask_url": mask_url, "raw": result}


def dilate_mask(mask_path: Path, out_path: Path, px: int = MASK_DILATE_PX):
    img = Image.open(mask_path).convert("L")
    # Threshold then dilate via MaxFilter
    img = img.point(lambda v: 255 if v > 32 else 0)
    if px > 0:
        # MaxFilter kernel must be odd
        k = 2 * px + 1
        img = img.filter(ImageFilter.MaxFilter(k))
    img.save(out_path)


def inpaint(frame_path: Path, mask_path: Path, out_path: Path) -> dict:
    if out_path.exists():
        return {"cached": True}
    image_url = fal_client.upload_file(str(frame_path))
    mask_url = fal_client.upload_file(str(mask_path))
    result = fal_client.subscribe(
        INPAINT_MODEL,
        arguments={"image_url": image_url, "mask_image_url": mask_url},
    )
    out_url = None
    for key in ("image", "output", "result"):
        v = result.get(key)
        if isinstance(v, dict) and v.get("url"):
            out_url = v["url"]
            break
    if out_url is None:
        for v in result.values():
            if isinstance(v, dict) and isinstance(v.get("url"), str):
                out_url = v["url"]
                break
    if out_url is None:
        raise RuntimeError(f"could not locate inpainted URL: {json.dumps(result)[:400]}")
    out_path.write_bytes(download(out_url))
    return {"cached": False, "out_url": out_url}


def process_one(frame_path: Path) -> dict:
    stem = frame_path.stem
    raw_mask = MASKS / f"{stem}_raw.png"
    mask = MASKS / f"{stem}.png"
    clean = CLEAN / f"{stem}.jpg"

    t0 = time.time()
    seg_info = segment(frame_path, raw_mask)
    t1 = time.time()
    dilate_mask(raw_mask, mask)
    t2 = time.time()
    paint_info = inpaint(frame_path, mask, clean)
    t3 = time.time()

    return {
        "frame": frame_path.name,
        "seg_s": round(t1 - t0, 2),
        "dilate_s": round(t2 - t1, 2),
        "inpaint_s": round(t3 - t2, 2),
        "seg_cached": seg_info.get("cached"),
        "inpaint_cached": paint_info.get("cached"),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="process only first N frames (0 = all)")
    ap.add_argument("--start", type=int, default=0, help="skip first N frames")
    args = ap.parse_args()

    frames = sorted(FRAMES.glob("frame_*.jpg"))
    if args.start:
        frames = frames[args.start:]
    if args.limit:
        frames = frames[: args.limit]
    print(f"processing {len(frames)} frames", flush=True)

    log = []
    for i, fp in enumerate(frames, 1):
        try:
            info = process_one(fp)
        except Exception as e:
            info = {"frame": fp.name, "error": str(e)}
            print(f"[{i}/{len(frames)}] {fp.name} ERROR: {e}", flush=True)
            log.append(info)
            (META / "process_log.json").write_text(json.dumps(log, indent=2))
            raise
        log.append(info)
        print(f"[{i}/{len(frames)}] {fp.name} seg={info['seg_s']}s paint={info['inpaint_s']}s", flush=True)
        (META / "process_log.json").write_text(json.dumps(log, indent=2))

    print("done")


if __name__ == "__main__":
    main()
