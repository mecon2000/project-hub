"""Low-res video preview proxies (480p) with an mtime-keyed cache on ext4.

Big source videos (hundreds of MB on the drvfs mount) stream badly to a phone;
the lightbox plays these proxies by default with an "original" toggle. Generation
runs in a background thread, deduped per key; nvenc is used when it works
(it does on this box), libx264 veryfast otherwise.
"""
import hashlib
import os
import subprocess
import threading

from hub.config import STATE_DIR
from hub.media.thumbs import FFMPEG

PREVIEW_CACHE = STATE_DIR / "preview-cache"
PREVIEW_CACHE.mkdir(exist_ok=True)

_inflight: dict[str, str] = {}          # key -> "preparing" | "failed: <err>"
_lock = threading.Lock()
_nvenc_ok: bool | None = None


def _nvenc_available() -> bool:
    global _nvenc_ok
    if _nvenc_ok is None:
        try:
            r = subprocess.run(
                [FFMPEG, "-v", "error", "-f", "lavfi",
                 "-i", "testsrc=duration=0.2:size=320x240:rate=10",
                 "-c:v", "h264_nvenc", "-f", "null", "-"],
                capture_output=True, timeout=30)
            _nvenc_ok = r.returncode == 0
        except Exception:
            _nvenc_ok = False
    return _nvenc_ok


def _key(path: str) -> str | None:
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return None
    return hashlib.sha1(f"prev:{path}:{mtime}".encode()).hexdigest()


def _transcode(path: str, key: str) -> None:
    out = str(PREVIEW_CACHE / f"{key}.mp4")
    tmp = out + ".part.mp4"
    if _nvenc_available():
        vcodec = ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "32"]
    else:
        vcodec = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "28"]
    cmd = [FFMPEG, "-v", "error", "-y", "-i", path,
           "-vf", "scale=-2:'min(480,ih)'",
           *vcodec, "-c:a", "aac", "-b:a", "96k",
           "-movflags", "+faststart", tmp]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
        if r.returncode == 0 and os.path.isfile(tmp):
            os.replace(tmp, out)
            with _lock:
                _inflight.pop(key, None)
        else:
            raise RuntimeError((r.stderr or "").strip()[-300:] or f"rc={r.returncode}")
    except Exception as e:
        with _lock:
            _inflight[key] = f"failed: {e}"
        try:
            os.remove(tmp)
        except OSError:
            pass


def get_or_start(path: str) -> tuple[str, str]:
    """-> ("ready", proxy_path) | ("preparing", "") | ("failed", err)"""
    key = _key(path)
    if not key:
        return "failed", "source missing"
    out = str(PREVIEW_CACHE / f"{key}.mp4")
    if os.path.isfile(out):
        return "ready", out
    with _lock:
        state = _inflight.get(key)
        if state == "preparing":
            return "preparing", ""
        if state and state.startswith("failed"):
            _inflight.pop(key)          # allow retry on next request
            return "failed", state
        _inflight[key] = "preparing"
    threading.Thread(target=_transcode, args=(path, key),
                     name=f"preview-{key[:8]}", daemon=True).start()
    return "preparing", ""
