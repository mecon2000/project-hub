"""Subprocess job execution with per-job output dirs (the find_output_after() fix).

Each job gets state/jobs/<id>/{out,log.txt}. On success, files from out/ are
moved into the project's output area and their final paths recorded on the job,
then ntfy fires with the first image attached and a click-through to the hub.
"""
import os
import shutil
import subprocess
import threading
import time
import uuid

from hub import manifests, notify
from hub.config import JOBS_DIR, VENV_BIN
from hub.jobs import store

MEDIA_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".webm", ".mov", ".mkv", ".json"}


def _job_env() -> dict:
    env = dict(os.environ)
    env["PATH"] = VENV_BIN + os.pathsep + env.get("PATH", "")   # ffmpeg via static_ffmpeg
    return env


def _move_no_meta(src: str, dest: str) -> None:
    """Move that survives drvfs/9p: rename if same fs, else copy bytes + remove.
    Never copies metadata (chmod/utime fail with EPERM on the Windows mounts)."""
    try:
        os.rename(src, dest)
    except OSError:
        shutil.copyfile(src, dest)
        os.remove(src)


def _collect_outputs(out_dir: str, project: dict, action: dict) -> list[str]:
    """Move produced files into the project's output area; return final paths."""
    produced = []
    for root, _dirs, files in os.walk(out_dir):
        for f in files:
            produced.append(os.path.join(root, f))
    if not produced:
        return []
    areas = project.get("content", {}).get("areas", {})
    area_name = action.get("output_area", "outputs" if "outputs" in areas else
                           ("output" if "output" in areas else None))
    if not area_name or area_name not in areas:
        return produced                       # no declared output area: leave in job dir
    dest_dir = areas[area_name]["abs_dir"]
    final = []
    for src in produced:
        dest = os.path.join(dest_dir, os.path.basename(src))
        if os.path.exists(dest):              # never clobber
            stem, ext = os.path.splitext(os.path.basename(src))
            dest = os.path.join(dest_dir, f"{stem}_{int(time.time())}{ext}")
        _move_no_meta(src, dest)
        final.append(dest)
    return final


def start_job(project_name: str, action_name: str, argv_builder,
              sources: list[str], cwd: str | None = None) -> dict:
    """argv_builder(out_dir: str) -> list[str] — called after the job dir exists,
    so scripts receive the real per-job output dir."""
    job_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    job_dir = JOBS_DIR / job_id
    out_dir = job_dir / "out"
    out_dir.mkdir(parents=True)
    log_path = str(job_dir / "log.txt")
    argv = argv_builder(str(out_dir))

    job = {"id": job_id, "project": project_name, "action": action_name,
           "argv": argv, "sources": sources, "status": "running",
           "started": time.time(), "log_path": log_path}
    store.insert_job(job)

    def _run():
        rc = -1
        try:
            with open(log_path, "w", buffering=1) as log:
                log.write("$ " + " ".join(argv) + "\n\n")
                proc = subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT,
                                        cwd=cwd or str(job_dir), env=_job_env())
                rc = proc.wait()
        except Exception as e:
            with open(log_path, "a") as log:
                log.write(f"\n[hub] runner error: {e}\n")
        outputs = []
        status = "done" if rc == 0 else "failed"
        try:
            proj = manifests.get(project_name) or {}
            action = proj.get("actions", {}).get(action_name, {})
            if rc == 0:
                outputs = _collect_outputs(str(out_dir), proj, action)
        except Exception as e:
            with open(log_path, "a") as log:
                log.write(f"\n[hub] output collection error: {e}\n")
        store.finish_job(job_id, status, rc, time.time(), outputs)
        try:
            notify.job_done(project_name, action_name, job_id, status, outputs)
        except Exception as e:
            with open(log_path, "a") as log:
                log.write(f"\n[hub] notify error: {e}\n")

    threading.Thread(target=_run, name=f"job-{job_id}", daemon=True).start()
    return job


def job_out_dir(job_id: str) -> str:
    return str(JOBS_DIR / job_id / "out")
