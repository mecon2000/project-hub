"""Best-of-N picks for areas with `pick: true` (+ group_by: dir): one variant per group wins.

Each pick is stored with the rejected siblings, so it reads as N-1 pairwise preferences
for anything that later learns taste. The chosen file's sidecar gets `picked: true`.
"""
import json
import os
import time

from flask import Blueprint, jsonify, request

from hub import manifests, safepath
from hub.curation import _sidecar_update
from hub.jobs import store

bp = Blueprint("picks", __name__)


@bp.post("/api/p/<name>/pick")
def pick(name):
    if not manifests.get(name):
        return jsonify({"error": "no such project"}), 404
    body = request.json or {}
    group = safepath.resolve_safe(body.get("group", ""))
    chosen = safepath.resolve_safe(body.get("chosen", ""))
    if not group or not os.path.isdir(group) or not chosen or not os.path.isfile(chosen) \
            or os.path.dirname(chosen) != group.rstrip(os.sep):
        return jsonify({"error": "chosen must be a file inside the group"}), 400
    rejected = [p for p in (safepath.resolve_safe(m) for m in body.get("members", []))
                if p and p != chosen and os.path.dirname(p) == group.rstrip(os.sep)]
    with store._lock:
        store._db().execute(
            "INSERT INTO picks (project, area, group_path, chosen, rejected, at) VALUES (?,?,?,?,?,?)",
            (name, body.get("area"), group, chosen, json.dumps(rejected), time.time()))
        store._db().commit()
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    _sidecar_update(chosen, {"picked": True, "picked_at": stamp})
    for r in rejected:
        _sidecar_update(r, {"picked": False, "picked_at": stamp})
    return jsonify({"ok": True, "chosen": chosen, "rejected": len(rejected)})


@bp.get("/api/p/<name>/picks")
def history(name):
    rows = store._db().execute(
        "SELECT * FROM picks WHERE project=? AND (? IS NULL OR area=?) ORDER BY at DESC",
        (name, request.args.get("area"), request.args.get("area"))).fetchall()
    return jsonify([{**dict(r), "rejected": json.loads(r["rejected"])} for r in rows])
