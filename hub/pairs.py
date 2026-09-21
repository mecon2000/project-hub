"""Counterpart lookup for areas with `compare_with: <other area>`.

Pairs match by filename stem (extension may differ), so a stage's output area can be
compared against its input area without either side knowing about the other.
"""
import os

from flask import Blueprint, jsonify, request

from hub import manifests, safepath

bp = Blueprint("pairs", __name__)


@bp.get("/api/p/<name>/counterpart")
def counterpart(name):
    proj = manifests.get(name)
    if not proj:
        return jsonify({"error": "no such project"}), 404
    areas = proj.get("content", {}).get("areas", {})
    area = areas.get(request.args.get("area", ""))
    other = areas.get((area or {}).get("compare_with", ""))
    path = safepath.resolve_safe(request.args.get("path", ""))
    if not other or not path:
        return jsonify({"path": None})
    stem = os.path.splitext(os.path.basename(path))[0]
    try:
        names = sorted(os.listdir(other["abs_dir"]))
    except OSError:
        return jsonify({"path": None})
    for n in names:
        if os.path.splitext(n)[0] == stem:
            return jsonify({"path": os.path.join(other["abs_dir"], n),
                            "label": area["compare_with"]})
    return jsonify({"path": None})
