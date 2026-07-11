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

from hub import manifests, safepath
from hub.jobs import store

bp = Blueprint("curation", __name__)

FAVORITES_DIR = Path(os.path.expanduser("~/.openclaw/workspace/shared/favorites"))
FAVORITES_JSON = FAVORITES_DIR / "favorites.json"
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


def _fav(project: dict, path: str) -> dict:
    FAVORITES_DIR.mkdir(parents=True, exist_ok=True)
    src = Path(path)
    fav_name = src.name
    if (FAVORITES_DIR / fav_name).exists():
        fav_name = f"{src.stem}_{int(time.time())}{src.suffix}"
    shutil.copyfile(src, FAVORITES_DIR / fav_name)   # copyfile: drvfs rejects copy2 metadata

    job = store.find_by_output(path)
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
    try:
        data = json.loads(FAVORITES_JSON.read_text()) if FAVORITES_JSON.exists() else {"favorites": []}
    except ValueError:
        data = {"favorites": []}
    data.setdefault("favorites", []).append(entry)
    FAVORITES_JSON.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    _sidecar_update(path, {"fav": True, "fav_at": entry["favorited_at"], "fav_file": fav_name})
    return entry


@bp.post("/api/p/<name>/vote")
def vote(name):
    proj = manifests.get(name)
    if not proj:
        return jsonify({"error": "no such project"}), 404
    body = request.json or {}
    path = safepath.resolve_safe(body.get("path", ""))
    v = body.get("vote", "")
    if v not in ("fav", "good", "bad", "blacklist-model"):
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
    if not path or not os.path.isfile(path):
        return jsonify({"error": "bad path"}), 400
    if v == "fav":
        return jsonify({"ok": True, "entry": _fav(proj, path)})
    _sidecar_update(path, {"vote": v, "voted_at": time.strftime("%Y-%m-%d %H:%M:%S")})
    return jsonify({"ok": True, "vote": v})
