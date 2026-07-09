"""Thumbnail generation with an mtime-keyed cache on ext4.

Photos: Pillow, 480px long edge. Videos: ffmpeg frame grab at ~1s.
ffmpeg/ffprobe come from the venv (static_ffmpeg), located explicitly.
"""
import hashlib
import os
import subprocess

from PIL import Image

from hub.config import THUMB_CACHE, VENV_BIN

FFMPEG = os.path.join(VENV_BIN, "ffmpeg")
FFPROBE = os.path.join(VENV_BIN, "ffprobe")
THUMB_EDGE = 480


def thumb_for(path: str, kind: str) -> str | None:
    """Return path of a cached thumbnail jpeg, creating it if needed."""
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return None
    key = hashlib.sha1(f"{path}:{mtime}".encode()).hexdigest()
    out = str(THUMB_CACHE / f"{key}.jpg")
    if os.path.isfile(out):
        return out
    try:
        if kind == "photo":
            with Image.open(path) as im:
                im = im.convert("RGB")
                im.thumbnail((THUMB_EDGE, THUMB_EDGE))
                im.save(out, "JPEG", quality=80)
        elif kind == "video":
            subprocess.run(
                [FFMPEG, "-v", "error", "-ss", "1", "-i", path, "-frames:v", "1",
                 "-vf", f"scale='min({THUMB_EDGE},iw)':-2", "-y", out],
                check=True, timeout=60, capture_output=True)
        else:
            return None
    except Exception:
        try:
            os.remove(out)
        except OSError:
            pass
        return None
    return out if os.path.isfile(out) else None


def video_duration(path: str) -> float | None:
    try:
        r = subprocess.run(
            [FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", path],
            capture_output=True, text=True, timeout=30)
        return float(r.stdout.strip())
    except Exception:
        return None
