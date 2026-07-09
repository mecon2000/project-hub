"""Pages + hub-level APIs: static SPA shell, schedules CRUD, wiring info."""
import os
import subprocess

from flask import Blueprint, jsonify, request, send_from_directory

from hub import manifests, scheduler
from hub.config import HUB_PORT, HUB_PUBLIC_URL, HUB_ROOT, NTFY_URL

bp = Blueprint("views", __name__)
WEB = str(HUB_ROOT / "web")


@bp.get("/")
def index():
    return send_from_directory(WEB, "index.html", max_age=0)


@bp.get("/api/schedules")
def schedules_list():
    return jsonify(scheduler.list_all())


@bp.post("/api/schedules")
def schedules_upsert():
    try:
        return jsonify(scheduler.upsert(request.json or {}))
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@bp.delete("/api/schedules/<sid>")
def schedules_delete(sid):
    scheduler.delete(sid)
    return jsonify({"ok": True})


@bp.get("/api/wiring")
def wiring():
    """The 'how this is wired' page — for future-Ron."""
    def _unit(name):
        try:
            r = subprocess.run(["systemctl", "--user", "is-active", name],
                               capture_output=True, text=True, timeout=5)
            return r.stdout.strip()
        except Exception:
            return "unknown"

    return jsonify({
        "hub_url": HUB_PUBLIC_URL,
        "hub_port": HUB_PORT,
        "ntfy_url_local": NTFY_URL,
        "ntfy_url_public": HUB_PUBLIC_URL + ":8093",
        "ntfy_topic": "hub-jobs",
        "services": {
            "project-hub.service": _unit("project-hub.service"),
            "ntfy.service": _unit("ntfy.service"),
        },
        "projects": {n: p.get("manifest_path")
                     for n, p in manifests.all_projects().items()},
        "howto": [
            "Add a project: drop hub-project.yaml at the root of any repo under ~/gitrep "
            "(or a yaml in project-hub/projects/). It appears in the dropdown on refresh.",
            "Content lives in ~/.openclaw/workspace/shared/<project>/ = D:\\OpenClaw\\shared.",
            "Hub engine changed? systemctl --user restart project-hub. "
            "Manifests/scripts/registry changed? Nothing — hot-reloaded / fresh subprocess.",
            "Phone: Tailscale VPN on; ntfy app subscribed to topic hub-jobs at " +
            HUB_PUBLIC_URL + ":8093.",
            "Full plan: ~/.claude/plans/i-have-claude-code-enchanted-sun.md",
        ],
    })
