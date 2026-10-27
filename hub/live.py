"""Cheap change-detection so an open page can refresh itself.

GET /api/p/<name>/version -> {"areas": [...], "media": "<n>:<newest mtime>", "notes": "<newest mtime>"}
The page polls this; when `areas` or `media` moves it reloads the project and re-renders
(new rounds, new renders). Walking the area trees is opt-in per project (`live: true` in the
manifest) because some areas are big photo pools on slow Windows mounts; without it only the
area list is compared. `notes` (sidecar notes.json) moves on the viewer's own clicks too,
so the page only follows it when it did not write recently itself.
"""
import os

from flask import Blueprint, jsonify

from hub import manifests
from hub.media.scanner import kind_of

bp = Blueprint("live", __name__)

_SIDECARS = {"notes.json", "meta.json"}


def _scan(base: str, trash: str | None) -> tuple[int, float, float]:
    n, newest, notes = 0, 0.0, 0.0
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if not d.startswith((".", "_")) and d != "trash"
                   and (not trash or os.path.join(root, d) != trash)]
        for f in files:
            sidecar = f in _SIDECARS
            if not sidecar and not kind_of(f):
                continue
            try:
                m = os.stat(os.path.join(root, f)).st_mtime
            except OSError:
                continue
            if sidecar:
                notes = max(notes, m)
            else:
                n += 1
                newest = max(newest, m)
    return n, newest, notes


@bp.get("/api/p/<name>/version")
def version(name):
    proj = manifests.get(name)
    if not proj:
        return jsonify({"error": f"no project {name}"}), 404
    areas = {a: v for a, v in proj.get("content", {}).get("areas", {}).items() if v.get("listed", True)}
    n, newest, notes = 0, 0.0, 0.0
    for v in (areas.values() if proj.get("live") else []):
        if os.path.isdir(v["abs_dir"]):
            a_n, a_new, a_notes = _scan(v["abs_dir"], proj.get("trash_dir"))
            n, newest, notes = n + a_n, max(newest, a_new), max(notes, a_notes)
    return jsonify({"areas": list(areas), "media": f"{n}:{newest:.0f}", "notes": f"{notes:.0f}"})
