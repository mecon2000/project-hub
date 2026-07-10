"""List media items in a project's content areas, with JSON sidecars."""
import json
import os

PHOTO_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
VIDEO_EXT = {".mp4", ".webm", ".mov", ".mkv", ".avi"}


def kind_of(path: str) -> str | None:
    ext = os.path.splitext(path)[1].lower()
    if ext in PHOTO_EXT:
        return "photo"
    if ext in VIDEO_EXT:
        return "video"
    return None


def list_area(project: dict, area_name: str, offset: int = 0, limit: int = 60) -> dict:
    area = project.get("content", {}).get("areas", {}).get(area_name)
    if not area:
        return {"items": [], "total": 0}
    wanted = set(area.get("media", ["photo", "video"]))
    items = []
    base = area["abs_dir"]
    trash = project.get("trash_dir")
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if not d.startswith((".", "_")) and d != "trash"
                   and (not trash or os.path.join(root, d) != trash)]
        for f in files:
            path = os.path.join(root, f)
            kind = kind_of(path)
            if kind not in wanted:
                continue
            try:
                st = os.stat(path)
            except OSError:
                continue
            items.append({
                "name": os.path.relpath(path, base),
                "path": path,
                "kind": kind,
                "size": st.st_size,
                "mtime": st.st_mtime,
            })
    items.sort(key=lambda x: x["mtime"], reverse=True)
    total = len(items)
    page = items[offset:offset + limit]
    for it in page:
        sidecar = it["path"] + ".json"
        alt = os.path.splitext(it["path"])[0] + ".json"
        for sc in (sidecar, alt):
            if os.path.isfile(sc):
                try:
                    with open(sc) as f:
                        it["sidecar"] = json.load(f)
                except (OSError, ValueError):
                    pass
                break
    return {"items": page, "total": total}
