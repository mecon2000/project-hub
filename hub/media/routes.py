"""Media + action + job API blueprint. Every file path goes through safepath."""
import os
import shutil
import time

from flask import Blueprint, Response, jsonify, request, send_file

from hub import actions as actions_mod
from hub import manifests, safepath
from hub.jobs import runner, store, stream
from hub.media import scanner, thumbs

bp = Blueprint("media", __name__)


def _project_or_404(name):
    proj = manifests.get(name)
    if not proj:
        return None, (jsonify({"error": f"no project {name}"}), 404)
    return proj, None


@bp.get("/api/projects")
def projects():
    out = []
    for name, p in sorted(manifests.all_projects().items()):
        out.append({
            "name": name,
            "label": p.get("label", name),
            "areas": {a: {"media": v.get("media", []),
                          "hidden": v.get("hidden_by_default", False)}
                      for a, v in p.get("content", {}).get("areas", {}).items()},
            "actions": {an: {"label": av.get("label", an),
                             "params": av.get("params", {}),
                             "flags": av.get("flags", {}),
                             "supports_segment": av.get("supports_segment", False),
                             "wall_time_estimate_sec": av.get("wall_time_estimate_sec"),
                             "cost_estimate_usd": av.get("cost_estimate_usd")}
                        for an, av in p.get("actions", {}).items()},
            "has_db_views": bool(p.get("db_views")),
            "manifest_path": p.get("manifest_path"),
        })
    return jsonify(out)


@bp.get("/api/p/<name>/media")
def media(name):
    proj, err = _project_or_404(name)
    if err:
        return err
    area = request.args.get("area", "")
    offset = request.args.get("offset", 0, type=int)
    limit = min(request.args.get("limit", 60, type=int), 200)
    return jsonify(scanner.list_area(proj, area, offset, limit))


@bp.get("/thumb")
def thumb():
    path = safepath.resolve_safe(request.args.get("path", ""))
    if not path:
        return "forbidden", 403
    kind = scanner.kind_of(path)
    t = thumbs.thumb_for(path, kind or "")
    if not t:
        return "no thumb", 404
    return send_file(t, mimetype="image/jpeg", max_age=86400)


@bp.get("/file")
def file_serve():
    path = safepath.resolve_safe(request.args.get("path", ""))
    if not path or not os.path.isfile(path):
        return "forbidden", 403
    return send_file(path, conditional=True)   # Range support for <video>


@bp.post("/api/p/<name>/delete")
def delete(name):
    proj, err = _project_or_404(name)
    if err:
        return err
    path = safepath.resolve_safe((request.json or {}).get("path", ""))
    if not path or not os.path.isfile(path):
        return jsonify({"error": "bad path"}), 400
    trash = proj.get("trash_dir")
    if not trash:
        return jsonify({"error": "project has no trash dir (no content.root)"}), 400
    dest = os.path.join(trash, f"{int(time.time())}__{os.path.basename(path)}")
    shutil.move(path, dest)
    for sc in (path + ".json", os.path.splitext(path)[0] + ".json"):
        if os.path.isfile(sc):
            shutil.move(sc, dest + ".sidecar.json")
            break
    return jsonify({"ok": True, "trashed_to": dest})


@bp.post("/api/p/<name>/action/<action_name>")
def run_action(name, action_name):
    proj, err = _project_or_404(name)
    if err:
        return err
    body = request.json or {}
    sources = body.get("sources", [])
    params = body.get("params", {})
    flags = body.get("flags", [])
    try:
        # validate now (with a placeholder) so errors return 400, not a failed job
        actions_mod.build_argv(proj, action_name, sources, params, flags, "/tmp")
    except actions_mod.ActionError as e:
        return jsonify({"error": str(e)}), 400
    started = runner.start_job(
        name, action_name,
        lambda out: actions_mod.build_argv(proj, action_name, sources, params, flags, out),
        sources)
    return jsonify({"job": started["id"]})


@bp.get("/api/jobs")
def jobs():
    project = request.args.get("project")
    return jsonify(store.list_jobs(project, limit=request.args.get("limit", 50, type=int)))


@bp.get("/api/jobs/<job_id>")
def job(job_id):
    j = store.get_job(job_id)
    return (jsonify(j), 200) if j else (jsonify({"error": "no such job"}), 404)


@bp.get("/api/jobs/<job_id>/log")
def job_log(job_id):
    j = store.get_job(job_id)
    if not j:
        return "no such job", 404
    try:
        with open(j["log_path"]) as f:
            return Response(f.read(), mimetype="text/plain")
    except OSError:
        return "", 200


@bp.get("/api/jobs/<job_id>/log/stream")
def job_log_stream(job_id):
    return Response(stream.sse_tail(job_id), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
