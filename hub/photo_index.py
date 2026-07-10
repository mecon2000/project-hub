"""Filename-stem index of ~/.openclaw/workspace/_photos/<Model>/**/*.jpg.

Maps catalog rows (model name + original filename, e.g. BLD_2531.CR3) to the
processed jpg on disk (same stem, .jpg). Walk takes ~4s over the 9p mount for
~24k files; cached to state/photo-index.json and refreshed in the background
when older than 6h.
"""
import json
import os
import threading
import time

from hub.config import STATE_DIR

PHOTOS_ROOT = os.path.expanduser("~/.openclaw/workspace/_photos")
CACHE = STATE_DIR / "photo-index.json"
MAX_AGE = 6 * 3600

_index: dict[str, dict[str, str]] | None = None
_lock = threading.Lock()
_building = False


def _build() -> dict[str, dict[str, str]]:
    idx: dict[str, dict[str, str]] = {}
    for model in os.listdir(PHOTOS_ROOT):
        mdir = os.path.join(PHOTOS_ROOT, model)
        if not os.path.isdir(mdir):
            continue
        stems = {}
        for root, dirs, files in os.walk(mdir):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for f in files:
                if f.lower().endswith((".jpg", ".jpeg")):
                    stems.setdefault(os.path.splitext(f)[0].lower(), os.path.join(root, f))
        if stems:
            idx[model.lower()] = stems
    return idx


def _refresh_async() -> None:
    global _index, _building
    with _lock:
        if _building:
            return
        _building = True

    def _run():
        global _index, _building
        try:
            idx = _build()
            CACHE.write_text(json.dumps(idx))
            with _lock:
                _index = idx
        finally:
            with _lock:
                _building = False

    threading.Thread(target=_run, name="photo-index", daemon=True).start()


def _ensure() -> dict | None:
    global _index
    if _index is None and CACHE.exists():
        try:
            _index = json.loads(CACHE.read_text())
        except ValueError:
            pass
    stale = not CACHE.exists() or time.time() - CACHE.stat().st_mtime > MAX_AGE
    if stale:
        _refresh_async()
    return _index


def resolve(model: str | None, filename: str | None) -> str | None:
    """(model, original filename incl. .CR3/.CR2) -> processed jpg path, or None.

    Model names differ between catalog and folders ("Nastia" vs "Nastia Tsoy"),
    so after an exact-key miss, try folders whose name contains the catalog name
    or vice versa."""
    idx = _ensure()
    if not idx or not model or not filename:
        return None
    stem = os.path.splitext(str(filename))[0].lower()
    key = str(model).lower().strip()
    hit = idx.get(key, {}).get(stem)
    if hit:
        return hit
    for folder, stems in idx.items():
        if (key in folder or folder in key) and stem in stems:
            return stems[stem]
    return None


def ready() -> bool:
    return _ensure() is not None
