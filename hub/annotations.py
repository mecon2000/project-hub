"""Notes on review items for areas with `annotate:` in their manifest.

Each item (a group dir, or a single file) gets a verdict, a free-text note and any number
of numbered pins (x, y in 0..1 of a chosen image, each with its own text). They live in a
JSON file NEXT TO the item — `<group>/notes.json` or `<file>.notes.json` — so a project that
keeps its content in a repo carries its notes with it. "Send" stamps every note in the area
as sent and runs the area's `submit_action` (e.g. a script that commits and pushes them).

Manifest:
  areas.<a>.annotate:
    verdicts: [keep, drop]          # optional, default [keep, drop]
    submit_action: send-notes       # optional, an action of the same project (no sources)
    hint: "..."                     # optional, shown above the board
"""
import json
import os
import time

from flask import Blueprint, jsonify, request

from hub import actions as actions_mod
from hub import manifests, safepath
from hub.jobs import runner

bp = Blueprint("annotations", __name__)


def notes_path(item_path: str) -> str:
    return os.path.join(item_path, "notes.json") if os.path.isdir(item_path) else item_path + ".notes.json"


def read_notes(item_path: str) -> dict | None:
    p = notes_path(item_path)
    if not os.path.isfile(p):
        return None
    try:
        with open(p) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _write(item_path: str, data: dict) -> None:
    tmp = notes_path(item_path) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, notes_path(item_path))


def _area(proj: dict, area: str) -> dict | None:
    a = proj.get("content", {}).get("areas", {}).get(area)
    return a if a and a.get("annotate") else None


def _clean_pins(pins) -> list:
    out = []
    for p in pins if isinstance(pins, list) else []:
        try:
            x, y = float(p.get("x")), float(p.get("y"))
        except (TypeError, ValueError, AttributeError):
            continue
        if not (0 <= x <= 1 and 0 <= y <= 1):
            continue
        out.append({"img": os.path.basename(str(p.get("img") or "")), "x": round(x, 4), "y": round(y, 4),
                    "text": str(p.get("text") or "")[:2000]})
    return out[:40]


@bp.post("/api/p/<name>/notes")
def save(name):
    proj = manifests.get(name)
    if not proj:
        return jsonify({"error": "no such project"}), 404
    body = request.json or {}
    area = _area(proj, body.get("area", ""))
    if not area:
        return jsonify({"error": "this area does not take notes"}), 400
    path = safepath.resolve_safe(body.get("path", ""))
    if not path or not path.startswith(area["abs_dir"] + os.sep):
        return jsonify({"error": "bad path"}), 400
    cur = read_notes(path) or {}
    verdicts = (area["annotate"] or {}).get("verdicts", ["keep", "drop"]) \
        if isinstance(area["annotate"], dict) else ["keep", "drop"]
    if "verdict" in body:
        v = body.get("verdict") or ""
        if v and v not in verdicts:
            return jsonify({"error": f"verdict must be one of {verdicts}"}), 400
        cur["verdict"] = v
    if "note" in body:
        cur["note"] = str(body.get("note") or "")[:8000]
    if "pins" in body:
        cur["pins"] = _clean_pins(body.get("pins"))
    cur["item"] = os.path.basename(path.rstrip(os.sep))
    cur["updated_at"] = time.time()
    _write(path, cur)
    return jsonify({"ok": True, "notes": cur})


@bp.post("/api/p/<name>/notes/submit")
def submit(name):
    proj = manifests.get(name)
    if not proj:
        return jsonify({"error": "no such project"}), 404
    body = request.json or {}
    area_name = body.get("area", "")
    area = _area(proj, area_name)
    if not area:
        return jsonify({"error": "this area does not take notes"}), 400
    now, sent = time.time(), 0
    for root, dirs, files in os.walk(area["abs_dir"]):
        dirs[:] = [d for d in dirs if not d.startswith((".", "_"))]
        for f in files:
            if f == "notes.json" or f.endswith(".notes.json"):
                p = os.path.join(root, f)
                try:
                    with open(p) as fh:
                        d = json.load(fh)
                except (OSError, ValueError):
                    continue
                if d.get("sent_at", 0) < d.get("updated_at", 0):
                    d["sent_at"] = now
                    with open(p, "w") as fh:
                        json.dump(d, fh, indent=2, ensure_ascii=False)
                    sent += 1
    cfg = area["annotate"] if isinstance(area["annotate"], dict) else {}
    action = cfg.get("submit_action")
    if not action:
        return jsonify({"ok": True, "sent": sent, "job": None})
    try:
        actions_mod.build_argv(proj, action, [], {}, [], "/tmp")
    except actions_mod.ActionError as e:
        return jsonify({"error": str(e)}), 400
    job = runner.start_job(name, action,
                           lambda out, srcs: actions_mod.build_argv(proj, action, [], {}, [], out), [])
    return jsonify({"ok": True, "sent": sent, "job": job["id"]})
