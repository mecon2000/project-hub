"""APScheduler-backed schedules, persisted in our own `schedules` table.

Every schedule runs through the same job runner, so scheduled runs show up in
job history and notify exactly like manual ones. Also hosts the built-in
trash-purge job (>30 days, every project).
"""
import glob
import os
import time
import uuid

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from hub import actions as actions_mod
from hub import manifests
from hub.jobs import runner, store

_sched: BackgroundScheduler | None = None


def _run_schedule(sid: str) -> None:
    s = next((x for x in store.list_schedules() if x["id"] == sid), None)
    if not s or not s.get("enabled", 1):
        return
    proj = manifests.get(s["project"])
    if not proj:
        return
    sources = []
    if s.get("source_glob"):
        sources = sorted(glob.glob(os.path.expanduser(s["source_glob"])))[:50]
    try:
        actions_mod.build_argv(proj, s["action"], sources, s.get("params", {}),
                               s.get("flags", []), "/tmp")
    except actions_mod.ActionError as e:
        print(f"[scheduler] {sid}: invalid action config: {e}")
        return
    runner.start_job(
        s["project"], s["action"],
        lambda out: actions_mod.build_argv(proj, s["action"], sources,
                                           s.get("params", {}), s.get("flags", []), out),
        sources)


def _purge_trash() -> None:
    cutoff = time.time() - 30 * 86400
    for proj in manifests.all_projects().values():
        trash = proj.get("trash_dir")
        if not trash or not os.path.isdir(trash):
            continue
        for f in os.listdir(trash):
            p = os.path.join(trash, f)
            try:
                if os.path.isfile(p) and os.path.getmtime(p) < cutoff:
                    os.remove(p)
            except OSError:
                pass


def _register(s: dict) -> None:
    trigger = CronTrigger.from_crontab(s["cron"])
    _sched.add_job(_run_schedule, trigger, args=[s["id"]], id=s["id"],
                   replace_existing=True)


def start() -> None:
    global _sched
    if _sched:
        return
    # Generous misfire grace: WSL2 clocks drift/wake late, and APScheduler's
    # 1s default silently skips the run ("misfire") — fire late instead, once.
    _sched = BackgroundScheduler(job_defaults={"misfire_grace_time": 3600,
                                               "coalesce": True})
    _sched.start()
    _sched.add_job(_purge_trash, CronTrigger.from_crontab("30 4 * * *"),
                   id="_purge_trash", replace_existing=True)
    for s in store.list_schedules():
        if s.get("enabled", 1):
            try:
                _register(s)
            except Exception as e:
                print(f"[scheduler] bad schedule {s['id']}: {e}")


def upsert(s: dict) -> dict:
    s.setdefault("id", "sch-" + uuid.uuid4().hex[:8])
    CronTrigger.from_crontab(s["cron"])          # validate early
    store.upsert_schedule(s)
    if s.get("enabled", True):
        _register(s)
    elif _sched.get_job(s["id"]):
        _sched.remove_job(s["id"])
    return s


def delete(sid: str) -> None:
    store.delete_schedule(sid)
    if _sched and _sched.get_job(sid):
        _sched.remove_job(sid)


def list_all() -> list[dict]:
    out = []
    for s in store.list_schedules():
        job = _sched.get_job(s["id"]) if _sched else None
        s["next_run"] = job.next_run_time.isoformat() if job and job.next_run_time else None
        out.append(s)
    return out
