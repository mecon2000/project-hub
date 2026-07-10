"""Job history in SQLite (state/hub.db, ext4). Single writer behind a lock."""
import json
import sqlite3
import threading

from hub.config import HUB_DB

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    action TEXT NOT NULL,
    argv TEXT NOT NULL,
    sources TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,              -- running | done | failed
    rc INTEGER,
    started REAL NOT NULL,
    finished REAL,
    outputs TEXT NOT NULL DEFAULT '[]',
    log_path TEXT
);
CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL DEFAULT '',
    cron TEXT NOT NULL,
    project TEXT NOT NULL,
    action TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    flags TEXT NOT NULL DEFAULT '[]',
    source_glob TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1
);
"""


def _db() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(HUB_DB, check_same_thread=False)
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.row_factory = sqlite3.Row
        _conn.executescript(_SCHEMA)
    return _conn


def _rowdict(row) -> dict:
    d = dict(row)
    for k in ("argv", "sources", "outputs", "params", "flags"):
        if k in d and isinstance(d[k], str):
            try:
                d[k] = json.loads(d[k])
            except ValueError:
                pass
    return d


def insert_job(job: dict) -> None:
    with _lock:
        _db().execute(
            "INSERT INTO jobs (id,project,action,argv,sources,status,started,log_path)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (job["id"], job["project"], job["action"], json.dumps(job["argv"]),
             json.dumps(job["sources"]), job["status"], job["started"], job["log_path"]))
        _db().commit()


def finish_job(job_id: str, status: str, rc: int, finished: float, outputs: list[str]) -> None:
    with _lock:
        _db().execute("UPDATE jobs SET status=?, rc=?, finished=?, outputs=? WHERE id=?",
                      (status, rc, finished, json.dumps(outputs), job_id))
        _db().commit()


def get_job(job_id: str) -> dict | None:
    row = _db().execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    return _rowdict(row) if row else None


def list_jobs(project: str | None = None, limit: int = 50) -> list[dict]:
    with _lock:
        if project:
            rows = _db().execute(
                "SELECT * FROM jobs WHERE project=? ORDER BY started DESC LIMIT ?",
                (project, limit)).fetchall()
        else:
            rows = _db().execute(
                "SELECT * FROM jobs ORDER BY started DESC LIMIT ?", (limit,)).fetchall()
    return [_rowdict(r) for r in rows]


def find_by_output(path: str) -> dict | None:
    """Job whose recorded outputs include this file (provenance for favorites)."""
    with _lock:
        row = _db().execute(
            "SELECT * FROM jobs WHERE outputs LIKE ? ORDER BY started DESC LIMIT 1",
            (f'%"{path}"%',)).fetchone()
    return _rowdict(row) if row else None


def upsert_schedule(s: dict) -> None:
    with _lock:
        _db().execute(
            "INSERT INTO schedules (id,label,cron,project,action,params,flags,source_glob,enabled)"
            " VALUES (?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(id) DO UPDATE SET label=excluded.label, cron=excluded.cron,"
            " project=excluded.project, action=excluded.action, params=excluded.params,"
            " flags=excluded.flags, source_glob=excluded.source_glob, enabled=excluded.enabled",
            (s["id"], s.get("label", ""), s["cron"], s["project"], s["action"],
             json.dumps(s.get("params", {})), json.dumps(s.get("flags", [])),
             s.get("source_glob", ""), 1 if s.get("enabled", True) else 0))
        _db().commit()


def delete_schedule(sid: str) -> None:
    with _lock:
        _db().execute("DELETE FROM schedules WHERE id=?", (sid,))
        _db().commit()


def list_schedules() -> list[dict]:
    with _lock:
        rows = _db().execute("SELECT * FROM schedules ORDER BY id").fetchall()
    return [_rowdict(r) for r in rows]
