"""List media items in a project's content areas, with JSON sidecars."""
import fnmatch
import json
import os
import re

PHOTO_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
VIDEO_EXT = {".mp4", ".webm", ".mov", ".mkv", ".avi"}


def kind_of(path: str) -> str | None:
    ext = os.path.splitext(path)[1].lower()
    if ext in PHOTO_EXT:
        return "photo"
    if ext in VIDEO_EXT:
        return "video"
    return None




_IS_VIDEO = re.compile(r"\.(mp4|mov|m4v|webm)$", re.I)


def _natural(s: str):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", s)]


def _roots(area: dict) -> list:
    """the directories an area shows: its dir, or (include: <glob>) the matching sub-directories of it,
    or (latest: true) only the last of those in natural order (round-9 after round-10 is not a thing)"""
    base = area["abs_dir"]
    pat = area.get("include")
    if not pat:
        return [base]
    try:
        subs = sorted((d for d in os.listdir(base) if fnmatch.fnmatch(d, pat)
                       and os.path.isdir(os.path.join(base, d))), key=_natural)
    except OSError:
        return []
    if area.get("latest"):
        subs = subs[-1:]
    return [os.path.join(base, d) for d in subs]


def _verdict_ok(area: dict, path: str) -> bool:
    """verdicts_in / verdicts_not: show only items whose notes.json verdict is (not) one of these"""
    vin, vnot = area.get("verdicts_in"), area.get("verdicts_not")
    if not vin and not vnot:
        return True
    from hub.annotations import read_notes
    v = (read_notes(path) or {}).get("verdict") or ""
    return (not vin or v in vin) and (not vnot or v not in vnot)


def latest_root(area: dict) -> str | None:
    """the directory a `latest: true` area currently shows (for pings and page titles)"""
    r = _roots(area)
    return r[-1] if r else None


def _group_by_dir(items: list, base: str, depth: int = 1) -> list:
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
        # Key on the TOP-level directory, not the immediate parent: a set stored as
        # <set>/x.mp4 + <set>/frames/*.jpg is one thing the user made, and keying on
        # the parent split it into two cards with the same name.
        parts = rel.split(os.sep)
        if len(parts) < depth:                 # shallower than a set: keep it as a loose item
            loose.append(it)
            continue
        rel = os.sep.join(parts[:depth])
        # Name the group after its top-level directory, so a set stored as
        # <set>/finals/*.jpg presents as one card called <set> rather than
        # "<set>/finals". Auxiliary subdirectories are excluded by prefixing them
        # with "_", which os.walk already skips above.
        label = rel
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
    # Video first, then stills by name: a rendered candidate should open on the video,
    # with the frames that made it available behind it.
    for g in groups.values():
        g["members"].sort(key=lambda p: (0 if _IS_VIDEO.search(p) else 1, p))
        g["cover"] = g["members"][0]
    return loose + list(groups.values())


def list_area(project: dict, area_name: str, offset: int = 0, limit: int = 60) -> dict:
    area = project.get("content", {}).get("areas", {}).get(area_name)
    if not area:
        return {"items": [], "total": 0}
    wanted = set(area.get("media", ["photo", "video"]))
    items = []
    base = area["abs_dir"]
    trash = project.get("trash_dir")
    for top in _roots(area):
        for root, dirs, files in os.walk(top):
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
        items = _group_by_dir(items, base, 2 if area.get("include") else 1)
        items = [it for it in items if it["kind"] != "group" or _verdict_ok(area, it["path"])]

    if area.get("sort") == "name":         # numbered sets (review rounds) read in their own order
        items.sort(key=lambda x: _natural(x["name"]))
    else:
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
        if area.get("annotate"):           # review boards: group meta.json + the item's notes
            from hub.annotations import read_notes
            if it["kind"] == "group":
                mp = os.path.join(it["path"], "meta.json")
                if os.path.isfile(mp):
                    try:
                        with open(mp) as f:
                            it["meta"] = json.load(f)
                    except (OSError, ValueError):
                        pass
            n = read_notes(it["path"])
            if n:
                it["notes"] = n
    return {"items": page, "total": total}
