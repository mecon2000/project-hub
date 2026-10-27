"""APScheduler-backed schedules, persisted in our own `schedules` table.

Every schedule runs through the same job runner, so scheduled runs show up in
job history and notify exactly like manual ones. Also hosts the built-in
trash-purge job (>30 days, every project).

Manifests may also declare `schedules: [{id, cron, action, label?, enabled?}]`.
Those live in the manifest (not the table), are re-synced every minute so a
pulled manifest change takes effect without a restart, are shown read-only in
the Schedules tab, and never overlap a run of the same action still in flight.
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
_mf_cron: dict[str, str] = {}      # manifest schedule id -> cron it was registered with


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
        lambda out, srcs: actions_mod.build_argv(proj, s["action"], srcs,
                                                 s.get("params", {}), s.get("flags", []), out),
        sources)


def _run_manifest_schedule(project: str, sid: str) -> None:
    proj = manifests.get(project) or {}
    s = next((x for x in proj.get("schedules", []) if str(x.get("id")) == sid), None)
    if not s or s.get("enabled", True) is False or runner.is_active(project, s["action"]):
        return
    try:
        actions_mod.build_argv(proj, s["action"], [], s.get("params", {}), s.get("flags", []), "/tmp")
    except actions_mod.ActionError as e:
        print(f"[scheduler] {project}/{sid}: invalid action config: {e}")
        return
    runner.start_job(project, s["action"],
                     lambda out, srcs: actions_mod.build_argv(proj, s["action"], srcs, s.get("params", {}),
                                                              s.get("flags", []), out), [])


def _manifest_schedules() -> list[dict]:
    out = []
    for name, proj in sorted(manifests.all_projects().items()):
        for s in proj.get("schedules", []) or []:
            if isinstance(s, dict) and s.get("id") and s.get("cron") and s.get("action"):
                out.append({**s, "id": f"mf:{name}:{s['id']}", "project": name,
                            "local_id": str(s["id"]), "readonly": True,
                            "enabled": 1 if s.get("enabled", True) is not False else 0})
    return out


def _sync_manifest_schedules() -> None:
    wanted = {}
    for s in _manifest_schedules():
        if s["enabled"]:
            wanted[s["id"]] = s
    for job in _sched.get_jobs():
        if job.id.startswith("mf:") and job.id not in wanted:
            _sched.remove_job(job.id)
    for jid, s in wanted.items():
        try:
            trig = CronTrigger.from_crontab(s["cron"])
        except Exception as e:
            print(f"[scheduler] bad manifest schedule {jid}: {e}")
            continue
        if _sched.get_job(jid) and _mf_cron.get(jid) == s["cron"]:
            continue                                    # unchanged: keep its next_run
        _sched.add_job(_run_manifest_schedule, trig, args=[s["project"], s["local_id"]], id=jid,
                       replace_existing=True, misfire_grace_time=60)
        _mf_cron[jid] = s["cron"]


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
    _sync_manifest_schedules()
    _sched.add_job(_sync_manifest_schedules, "interval", seconds=60, id="_sync_manifest",
                   replace_existing=True)
    for s in store.list_schedules():
        if s.get("enabled", 1):
            try:
                _register(s)
            except Exception as e:
                print(f"[scheduler] bad schedule {s['id']}: {e}")


def upsert(s: dict) -> dict:
    if str(s.get("id", "")).startswith("mf:"):
        raise ValueError("this schedule comes from the project manifest - change it there")
    s.setdefault("id", "sch-" + uuid.uuid4().hex[:8])
    CronTrigger.from_crontab(s["cron"])          # validate early
    store.upsert_schedule(s)
    if s.get("enabled", True):
        _register(s)
    elif _sched.get_job(s["id"]):
        _sched.remove_job(s["id"])
    return s


def delete(sid: str) -> None:
    if sid.startswith("mf:"):
        return                                      # manifest-owned
    store.delete_schedule(sid)
    if _sched and _sched.get_job(sid):
        _sched.remove_job(sid)


def list_all() -> list[dict]:
    out = []
    for s in store.list_schedules() + _manifest_schedules():
        job = _sched.get_job(s["id"]) if _sched else None
        s["next_run"] = job.next_run_time.isoformat() if job and job.next_run_time else None
        out.append(s)
    return out
