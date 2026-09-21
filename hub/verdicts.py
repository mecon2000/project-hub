"""Verdict history: every good/bad/unsure vote, with an optional note and marked spot.

The sidecar keeps only the latest vote (what the gallery shows); this table keeps
all of them so any project can ask "how has this area/file been judged".
"""
import time

from flask import Blueprint, jsonify, request

from hub.jobs import store

bp = Blueprint("verdicts", __name__)

VERDICTS = ("good", "bad", "unsure")


def record(project: str, area: str | None, path: str, verdict: str,
           note: str = "", mark: dict | None = None) -> float:
    mark = mark or {}
    x, y = mark.get("x"), mark.get("y")
    if not (isinstance(x, (int, float)) and isinstance(y, (int, float))
            and 0 <= x <= 1 and 0 <= y <= 1):
        x = y = None
    at = time.time()
    with store._lock:
        store._db().execute(
            "INSERT INTO verdicts (project, area, path, verdict, note, mark_x, mark_y, at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (project, area, path, verdict, note or "", x, y, at))
        store._db().commit()
    return at


@bp.get("/api/p/<name>/verdicts")
def history(name):
    """?path=<file> → that file's history; ?area=<a> → latest verdict per file + counts."""
    path, area = request.args.get("path"), request.args.get("area")
    db = store._db()
    if path:
        rows = db.execute("SELECT * FROM verdicts WHERE project=? AND path=? ORDER BY at DESC",
                          (name, path)).fetchall()
        return jsonify([dict(r) for r in rows])
    rows = db.execute(
        "SELECT v.* FROM verdicts v JOIN (SELECT path, MAX(at) m FROM verdicts "
        "WHERE project=? AND area IS ? GROUP BY path) l ON v.path=l.path AND v.at=l.m "
        "WHERE v.project=? AND v.area IS ? ORDER BY v.at DESC",
        (name, area, name, area)).fetchall()
    latest = [dict(r) for r in rows]
    counts = {k: sum(1 for r in latest if r["verdict"] == k) for k in VERDICTS}
    return jsonify({"latest": latest, "counts": counts})
