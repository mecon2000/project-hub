"""Read-only SQLite views declared in manifests (canned queries + free text + raw SQL).

Connections open with file:...?mode=ro so nothing here can write. Canned/free-text
SQL comes from the manifest (trusted); raw SQL is a single-user power feature and
still can't write through the ro connection.
"""
import os
import sqlite3

from flask import Blueprint, jsonify, request

from hub import manifests

bp = Blueprint("dbviews", __name__)
ROW_LIMIT = 500


def _views(project: dict) -> dict[str, dict]:
    return {v["name"]: v for v in project.get("db_views", [])}


def _connect(view: dict) -> sqlite3.Connection:
    path = os.path.expanduser(view["sqlite"])
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def _run(view: dict, sql: str, params: dict) -> dict:
    mapped_view = view.get("file_mapping") == "photos_by_model_stem"
    fetch = 2000 if mapped_view else ROW_LIMIT   # deep fetch: on-disk jpgs are sparse
    conn = _connect(view)
    try:
        cur = conn.execute(sql, params)
        rows = cur.fetchmany(fetch)
        columns = [d[0] for d in cur.description] if cur.description else []
        rows = [list(r) for r in rows]
        truncated = len(rows) == fetch
        # map (model, filename) rows to on-disk processed jpgs; photos-first
        if mapped_view and "model" in columns and "filename" in columns:
            from hub import photo_index
            mi, fi = columns.index("model"), columns.index("filename")
            columns = columns + ["_path"]
            for r in rows:
                r.append(photo_index.resolve(r[mi], r[fi]))
            rows.sort(key=lambda r: r[-1] is None)
            rows = rows[:ROW_LIMIT]
        return {"columns": columns, "rows": rows, "truncated": truncated}
    finally:
        conn.close()


@bp.get("/api/p/<name>/db")
def list_views(name):
    proj = manifests.get(name)
    if not proj:
        return jsonify({"error": "no such project"}), 404
    out = []
    for v in proj.get("db_views", []):
        out.append({
            "name": v["name"],
            "label": v.get("label", v["name"]),
            "canned": [{"name": q["name"], "label": q.get("label", q["name"]),
                        "needs_text": ":q" in q["sql"]}
                       for q in v.get("canned_queries", [])],
            "free_text": bool(v.get("free_text")),
            "allow_raw_sql": v.get("allow_raw_sql", False),
        })
    return jsonify(out)


@bp.post("/api/p/<name>/db/<view_name>/query")
def run_query(name, view_name):
    proj = manifests.get(name)
    view = _views(proj or {}).get(view_name)
    if not view:
        return jsonify({"error": "no such view"}), 404
    body = request.json or {}
    text = str(body.get("q", ""))
    try:
        if body.get("sql"):
            if not view.get("allow_raw_sql"):
                return jsonify({"error": "raw sql disabled for this view"}), 403
            return jsonify(_run(view, str(body["sql"]), {}))
        if body.get("query"):
            canned = {q["name"]: q for q in view.get("canned_queries", [])}
            q = canned.get(body["query"])
            if not q:
                return jsonify({"error": "no such canned query"}), 404
            params = {"q": f"%{text.lower()}%"} if ":q" in q["sql"] else {}
            return jsonify(_run(view, q["sql"], params))
        ft = view.get("free_text")
        if ft and text:
            return jsonify(_run(view, ft["sql"], {"q": f"%{text.lower()}%"}))
        return jsonify({"error": "nothing to run"}), 400
    except sqlite3.Error as e:
        return jsonify({"error": str(e)}), 400
