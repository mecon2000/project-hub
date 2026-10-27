"""Review notes for areas with `annotate:` — Take One's review room, per item instead of per frame.

Every item (a group dir = one piece with several images, or a single file) gets a verdict and a
list of notes. A note is pinned to a spot on one of the item's images (x, y in 0..1) or is about
the whole item; it carries a snapshot with the pin drawn in, and a `done` flag the maker sets when
the next round answers it. Everything lives NEXT TO the item, so repo-backed content carries its
notes in git:
  <group>/notes.json             {verdict, notes: [{id, img, x, y, text, shot, done, at}], updated_at, sent_at}
  <group>/_notes/<id>.jpg        snapshot (the "_" dir is skipped by the scanner)
  <file>.notes.json / <file>.notes/<id>.jpg   for single files
"Send notes" stamps the area as sent and runs its `submit_action` (e.g. commit + push).

Manifest:
  areas.<a>.annotate:
    verdicts: [keep, drop]          # optional, default [keep, drop]
    more_like_this: true            # optional: a "More like this" toggle per item (notes.json "more": true)
    submit_action: send-notes       # optional, an action of the same project (no sources)
    hint: "..."                     # optional, shown with the Send bar
"""
import base64
import json
import os
import time

from flask import Blueprint, jsonify, request

from hub import actions as actions_mod
from hub import manifests, safepath
from hub.jobs import runner

bp = Blueprint("annotations", __name__)


def notes_path(item: str) -> str:
    return os.path.join(item, "notes.json") if os.path.isdir(item) else item + ".notes.json"


def shots_dir(item: str) -> str:
    return os.path.join(item, "_notes") if os.path.isdir(item) else item + ".notes"


def read_notes(item: str) -> dict | None:
    p = notes_path(item)
    if not os.path.isfile(p):
        return None
    try:
        with open(p) as f:
            d = json.load(f)
    except (OSError, ValueError):
        return None
    d.setdefault("notes", [])
    return d


def _write(item: str, d: dict) -> None:
    d["item"] = os.path.basename(item.rstrip(os.sep))
    d["updated_at"] = time.time()
    tmp = notes_path(item) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
    os.replace(tmp, notes_path(item))


def _area(proj: dict, area: str) -> dict | None:
    a = proj.get("content", {}).get("areas", {}).get(area)
    return a if a and a.get("annotate") else None


def _cfg(area: dict) -> dict:
    return area["annotate"] if isinstance(area["annotate"], dict) else {}


def _num(v):
    return round(float(v), 4) if isinstance(v, (int, float)) and 0 <= v <= 1 else None


@bp.post("/api/p/<name>/notes")
def edit(name):
    """op: verdict {verdict} | more {more} | add {img, x, y, text, shot} | update {id, text?, done?} | delete {id}"""
    proj = manifests.get(name)
    if not proj:
        return jsonify({"error": "no such project"}), 404
    b = request.json or {}
    area = _area(proj, b.get("area", ""))
    if not area:
        return jsonify({"error": "this area does not take notes"}), 400
    item = safepath.resolve_safe(b.get("path", ""))
    if not item or not item.startswith(area["abs_dir"] + os.sep) or not os.path.exists(item):
        return jsonify({"error": "bad path"}), 400
    d = read_notes(item) or {"notes": []}
    op = b.get("op", "")
    if op == "verdict":
        v = b.get("verdict") or ""
        allowed = _cfg(area).get("verdicts", ["keep", "drop"])
        if v and v not in allowed:
            return jsonify({"error": f"verdict must be one of {allowed}"}), 400
        d["verdict"] = v
    elif op == "more":                               # "more like this": ask for new variations of this item
        if not _cfg(area).get("more_like_this"):
            return jsonify({"error": "this area does not take 'more like this' requests"}), 400
        d["more"] = bool(b.get("more"))
    elif op == "add":
        text = str(b.get("text") or "").strip()[:4000]
        if not text:
            return jsonify({"error": "empty note"}), 400
        nid = format(int(time.time() * 1000), "x")
        x, y = _num(b.get("x")), _num(b.get("y"))
        n = {"id": nid, "img": os.path.basename(str(b.get("img") or "")) or None,
             "x": x if y is not None else None, "y": y if x is not None else None,
             "text": text, "done": False, "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
        shot = b.get("shot")
        if isinstance(shot, str) and shot.startswith("data:image/jpeg;base64,"):
            os.makedirs(shots_dir(item), exist_ok=True)
            with open(os.path.join(shots_dir(item), nid + ".jpg"), "wb") as f:
                f.write(base64.b64decode(shot.split(",", 1)[1]))
            n["shot"] = os.path.relpath(os.path.join(shots_dir(item), nid + ".jpg"), os.path.dirname(notes_path(item)))
        d["notes"].append(n)
    elif op in ("update", "delete"):
        n = next((n for n in d["notes"] if n.get("id") == b.get("id")), None)
        if not n:
            return jsonify({"error": "no such note"}), 404
        if op == "delete":
            d["notes"].remove(n)
            if n.get("shot"):                          # snapshot goes too (it is ours, not content)
                sp = os.path.join(os.path.dirname(notes_path(item)), n["shot"])
                if os.path.isfile(sp) and safepath.resolve_safe(sp):
                    os.remove(sp)
        else:
            if isinstance(b.get("text"), str) and b["text"].strip():
                n["text"] = b["text"].strip()[:4000]
            if isinstance(b.get("done"), bool):
                n["done"] = b["done"]
    else:
        return jsonify({"error": "op must be verdict, more, add, update or delete"}), 400
    _write(item, d)
    return jsonify({"ok": True, "notes": d})


@bp.post("/api/p/<name>/notes/submit")
def submit(name):
    proj = manifests.get(name)
    if not proj:
        return jsonify({"error": "no such project"}), 404
    area = _area(proj, (request.json or {}).get("area", ""))
    if not area:
        return jsonify({"error": "this area does not take notes"}), 400
    now, sent = time.time(), 0
    for root, dirs, files in os.walk(area["abs_dir"]):
        dirs[:] = [d for d in dirs if not d.startswith((".", "_")) and not d.endswith(".notes")]
        for f in files:
            if f != "notes.json" and not f.endswith(".notes.json"):
                continue
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
    action = _cfg(area).get("submit_action")
    if not action:
        return jsonify({"ok": True, "sent": sent, "job": None})
    try:
        actions_mod.build_argv(proj, action, [], {}, [], "/tmp")
    except actions_mod.ActionError as e:
        return jsonify({"error": str(e)}), 400
    job = runner.start_job(name, action,
                           lambda out, srcs: actions_mod.build_argv(proj, action, [], {}, [], out), [])
    return jsonify({"ok": True, "sent": sent, "job": job["id"]})
