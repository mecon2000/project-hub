"""Catalog corrections + LR shortlist for rediscovery triage (sanctioned ext #2).

The rediscovery inbox surfaces archive photos with sidecars carrying catalog ids.
When the DB's labels are wrong, the user corrects them from the lightbox and the
corrections flow back into the catalog (photo/set tags) and the consent allowlist
— slowly making the DB truthful. Camera-JPEG finds can be shortlisted for a
proper Lightroom edit session (Windows paths, batched).
"""
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

from flask import Blueprint, abort, jsonify, request

from hub import safepath

SP_REPO = os.path.expanduser("~/gitrep/social-publisher")
if SP_REPO not in sys.path:
    sys.path.insert(0, SP_REPO)

bp = Blueprint("catalog_triage", __name__)

CATALOG = os.path.expanduser("~/gitrep/photo-catalogging/data/photo-catalog.db")


def _sidecar_for(path: str) -> tuple[dict, str] | tuple[None, None]:
    for sc in (path + ".json", os.path.splitext(path)[0] + ".json"):
        if os.path.isfile(sc):
            try:
                return json.loads(Path(sc).read_text()), sc
            except ValueError:
                pass
    return None, None


def _db():
    return sqlite3.connect(CATALOG, timeout=10)


def _tag(conn, table: str, key_col: str, key_val: int, value: str) -> None:
    """Idempotent boldness tag write (photo_tags or tags)."""
    row = conn.execute(
        f"SELECT 1 FROM {table} WHERE {key_col}=? AND dimension='boldness' AND value=?",
        (key_val, value)).fetchone()
    if not row:
        conn.execute(
            f"INSERT INTO {table} ({key_col}, dimension, value, source)"
            " VALUES (?, 'boldness', ?, 'user_triage')", (key_val, value))


@bp.post("/api/catalog/correct")
def correct():
    body = request.json or {}
    path = safepath.resolve_safe(body.get("path", ""))
    action = body.get("action", "")
    sc, sc_path = _sidecar_for(path or "")
    if not sc:
        return jsonify({"error": "no sidecar with catalog ids for this file"}), 400
    pid, set_id, model = sc.get("catalog_photo_id"), sc.get("set_id"), sc.get("model")

    if action == "photo_nsfw" and pid:
        with _db() as c:
            c.execute("DELETE FROM photo_tags WHERE photo_id=? AND dimension='boldness'"
                      " AND value='safe' AND source='user_triage'", (pid,))
            _tag(c, "photo_tags", "photo_id", pid, "explicit")
        note = "photo tagged explicit in catalog"
    elif action == "photo_safe" and pid:
        with _db() as c:
            c.execute("DELETE FROM photo_tags WHERE photo_id=? AND dimension='boldness'"
                      " AND value='explicit'", (pid,))
            _tag(c, "photo_tags", "photo_id", pid, "safe")
        note = "photo marked SAFE (overrides set-level explicit)"
    elif action == "session_nsfw" and set_id:
        with _db() as c:
            sess = c.execute("SELECT session_id FROM sets WHERE id=?", (set_id,)).fetchone()
            if not sess:
                return jsonify({"error": "set has no session"}), 400
            sets = [r[0] for r in c.execute("SELECT id FROM sets WHERE session_id=?", (sess[0],))]
            for sid in sets:
                _tag(c, "tags", "set_id", sid, "explicit")
        note = f"whole session tagged explicit ({len(sets)} sets) — mark individual photos SAFE to re-allow"
    elif action in ("consent_per_photo", "consent_anon", "consent_no") and model:
        from src import consent as sp_consent
        rule = {"consent_per_photo": "per_photo", "consent_anon": "anon_only",
                "consent_no": "no"}[action]
        sp_consent.set_consent(model, rule, source="hub rediscovery triage")
        note = f"'{model}' consent set to {rule}"
    else:
        return jsonify({"error": f"unknown/incomplete action {action!r}"}), 400

    sc.setdefault("corrections", []).append(
        {"action": action, "at": time.strftime("%Y-%m-%d %H:%M")})
    Path(sc_path).write_text(json.dumps(sc, indent=2, ensure_ascii=False))
    return jsonify({"ok": True, "note": note})


