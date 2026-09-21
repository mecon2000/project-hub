"""Curation votes: fav / good / bad / blacklist-model.

fav mirrors batch-runner's like flow (copy into shared/favorites + favorites.json
entry with a full reconstruction command + git hash) so favorites made in either
UI are interchangeable. For hub-run outputs the command is the job's exact argv.
good/bad live in JSON sidecars (the hub-native convention). blacklist-model
appends to the shared blacklisted_models.json both UIs honor.
"""
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

from flask import Blueprint, jsonify, request

from hub import manifests, safepath, verdicts
from hub.jobs import store

bp = Blueprint("curation", __name__)

FAVORITES_DIR = Path(os.path.expanduser("~/.openclaw/workspace/shared/favorites"))
FAVORITES_JSON = FAVORITES_DIR / "favorites.json"
GROUP_VOTE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".mp4", ".mov"}
BLACKLIST_JSON = Path(os.path.expanduser("~/.openclaw/workspace/shared/blacklisted_models.json"))


def _sidecar_update(path: str, patch: dict) -> None:
    sc_path = path + ".json"
    alt = os.path.splitext(path)[0] + ".json"
    if os.path.isfile(alt) and not os.path.isfile(sc_path):
        sc_path = alt
    try:
        sidecar = json.loads(Path(sc_path).read_text()) if os.path.isfile(sc_path) else {}
    except ValueError:
        sidecar = {}
    sidecar.update(patch)
    Path(sc_path).write_text(json.dumps(sidecar, indent=2, ensure_ascii=False))


def _git_hash(project: dict) -> str | None:
    try:
        repo_dir = os.path.dirname(project.get("manifest_path", ""))
        return subprocess.check_output(
            ["git", "-C", repo_dir, "rev-parse", "--short", "HEAD"],
            text=True, timeout=5).strip()
    except Exception:
        return None


def _copy_into_favorites(src: Path, name: str | None = None) -> str:
    FAVORITES_DIR.mkdir(parents=True, exist_ok=True)
    fav_name = name or src.name
    if (FAVORITES_DIR / fav_name).exists():
        stem, suf = os.path.splitext(fav_name)
        fav_name = f"{stem}_{int(time.time())}{suf}"
    shutil.copyfile(src, FAVORITES_DIR / fav_name)   # copyfile: drvfs rejects copy2 metadata
    return fav_name


def _append(entry: dict) -> dict:
    try:
        data = json.loads(FAVORITES_JSON.read_text()) if FAVORITES_JSON.exists() else {"favorites": []}
    except ValueError:
        data = {"favorites": []}
    data.setdefault("favorites", []).append(entry)
    FAVORITES_JSON.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    return entry


def _build_entry(project: dict, path: str, fav_name: str) -> dict:
    job = store.find_by_output(path)
    src = Path(path)
    sidecar = {}
    for sc in (path + ".json", os.path.splitext(path)[0] + ".json"):
        if os.path.isfile(sc):
            try:
                sidecar = json.loads(Path(sc).read_text())
            except ValueError:
                pass
            break
    entry = {
        "file": fav_name,
        "source": ((job.get("sources") or [None])[0] if job else None)
                  or sidecar.get("original_path"),
        "model": sidecar.get("model"),
        "style": None,
        "tool": (job or {}).get("action"),
        "score": None,
        "git_commit": _git_hash(project),
        "favorited_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "command": " ".join((job or {}).get("argv", [])) or None,
        "job_id": (job or {}).get("id"),
        "project": project.get("name"),
    }
    stem = src.stem
    if not entry["model"] and "__" in stem and not stem.split("__")[0][:1].isdigit():
        entry["model"] = stem.split("__")[0].replace("_", " ").strip()
    return entry


def _fav(project: dict, path: str) -> dict:
    fav_name = _copy_into_favorites(Path(path))
    entry = _append(_build_entry(project, path, fav_name))
    _sidecar_update(path, {"fav": True, "fav_at": entry["favorited_at"], "fav_file": fav_name})
    return entry


def _fav_group(project: dict, group_dir: str, members: list) -> dict:
    """ONE favorites entry for a set that only works as a set.

    Writing one entry per frame would put eight near-identical photos in the
    favourites folder and, worse, give that style eight times its true weight —
    auto_gen_tick and mine_taste both count one vote per entry, so a single
    favourited reel would outvote seven separately favourited images.
    """
    cover = members[0]
    label = os.path.basename(group_dir.rstrip(os.sep))
    if label in ("finals", "final"):                      # <set>/finals -> name it <set>
        label = os.path.basename(os.path.dirname(group_dir.rstrip(os.sep)))
    fav_name = _copy_into_favorites(Path(cover), f"{label}{Path(cover).suffix}")
    entry = _build_entry(project, cover, fav_name)
    entry.update({"kind": "group", "group": label, "count": len(members),
                  "members": [os.path.basename(m) for m in members],
                  "group_dir": group_dir})
    _append(entry)
    stamp = entry["favorited_at"]
    for m in members:                                     # mark each frame, no extra votes
        _sidecar_update(m, {"fav": True, "fav_at": stamp, "fav_group": label})
    return entry


@bp.post("/api/p/<name>/vote")
def vote(name):
    proj = manifests.get(name)
    if not proj:
        return jsonify({"error": "no such project"}), 404
    body = request.json or {}
    path = safepath.resolve_safe(body.get("path", ""))
    v = body.get("vote", "")
    if v not in ("fav", "blacklist-model") + verdicts.VERDICTS:
        return jsonify({"error": f"unknown vote {v!r}"}), 400
    if v == "blacklist-model":
        model = (body.get("model") or "").strip()
        if not model:
            return jsonify({"error": "blacklist-model needs a model name"}), 400
        try:
            data = json.loads(BLACKLIST_JSON.read_text()) if BLACKLIST_JSON.exists() \
                and BLACKLIST_JSON.stat().st_size else {}
        except ValueError:
            data = {}
        if not isinstance(data, dict):
            data = {"models": data}
        bl = data.setdefault("models", [])
        if model not in bl:
            bl.append(model)
            BLACKLIST_JSON.write_text(json.dumps(data, indent=2, ensure_ascii=False))
        return jsonify({"ok": True, "blacklisted": model})
    # A grouped area (group_by: dir) votes on a directory: apply to every member,
    # so favouriting a set that was authored as a unit keeps the unit intact.
    if path and os.path.isdir(path):
        members = sorted(
            os.path.join(path, f) for f in os.listdir(path)
            if os.path.isfile(os.path.join(path, f))
            and os.path.splitext(f)[1].lower() in GROUP_VOTE_EXTS)
        if not members:
            return jsonify({"error": "no votable files in that group"}), 400
        if v == "fav":
            return jsonify({"ok": True, "count": len(members),
                            "entry": _fav_group(proj, path, members)})
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        verdicts.record(name, body.get("area"), path, v, body.get("note", ""))
        for m in members:
            _sidecar_update(m, {"vote": v, "voted_at": stamp, "vote_note": body.get("note", "")})
        return jsonify({"ok": True, "vote": v, "count": len(members)})
    if not path or not os.path.isfile(path):
        return jsonify({"error": "bad path"}), 400
    if v == "fav":
        return jsonify({"ok": True, "entry": _fav(proj, path)})
    verdicts.record(name, body.get("area"), path, v, body.get("note", ""), body.get("mark"))
    _sidecar_update(path, {"vote": v, "voted_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                           "vote_note": body.get("note", ""), "vote_mark": body.get("mark")})
    return jsonify({"ok": True, "vote": v})
