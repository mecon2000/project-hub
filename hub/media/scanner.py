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


def _group_by_dir(items: list, base: str) -> list:
    """Collapse files into one entry per containing directory.

    For a set that is authored as a unit — a reel, a contact sheet — listing every
    frame separately buries everything else in the gallery and makes "fav" mean the
    single frame the user happened to click. One entry per directory keeps the unit
    intact; `members` carries the frames so a vote can be applied to all of them.

    Files sitting directly in the area root keep their own entry: an ungrouped photo
    is not a group of one.
    """
    groups: dict = {}
    loose: list = []
    for it in items:
        rel = os.path.relpath(os.path.dirname(it["path"]), base)
        if rel in (".", ""):
            loose.append(it)
            continue
        # Name the group after its top-level directory, so a set stored as
        # <set>/finals/*.jpg presents as one card called <set> rather than
        # "<set>/finals". Auxiliary subdirectories are excluded by prefixing them
        # with "_", which os.walk already skips above.
        label = rel.split(os.sep)[0]
        g = groups.get(rel)
        if g is None:
            g = groups[rel] = {"name": label, "path": os.path.dirname(it["path"]),
                               "kind": "group", "size": 0, "mtime": 0.0,
                               "count": 0, "members": [], "cover": None}
        g["count"] += 1
        g["size"] += it["size"]
        g["members"].append(it["path"])
        if it["mtime"] > g["mtime"]:
            g["mtime"] = it["mtime"]
        # cover = first frame by name, so it is stable as the group grows
        if g["cover"] is None or it["path"] < g["cover"]:
            g["cover"] = it["path"]
    return loose + list(groups.values())


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
    if area.get("group_by") == "dir":
        items = _group_by_dir(items, base)

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
