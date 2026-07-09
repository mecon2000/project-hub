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

# GPU-heavy actions declare serialize: true in their manifest — one at a time.
_serial_locks: dict[str, threading.Lock] = {}
_serial_guard = threading.Lock()


def _serial_lock(project: str, action: str) -> threading.Lock:
    key = f"{project}:{action}"
    with _serial_guard:
        return _serial_locks.setdefault(key, threading.Lock())


def _trim_segment(src: str, start: float, end: float, dest: str, log) -> str:
    """Precise re-encoded trim so the censor test hits the exact problem frames."""
    ffmpeg = os.path.join(VENV_BIN, "ffmpeg")
    dur = max(0.1, end - start)
    log.write(f"[hub] trimming segment {start:.1f}s–{end:.1f}s "
              f"({dur:.1f}s) from {os.path.basename(src)}\n")
    log.flush()
    cmd = [ffmpeg, "-v", "error", "-y", "-ss", str(start), "-i", src,
           "-t", str(dur), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
           "-c:a", "copy", dest]
    r = subprocess.run(cmd, stdout=log, stderr=log, timeout=1800)
    if r.returncode != 0:
        raise RuntimeError(f"segment trim failed (rc={r.returncode})")
    return dest


def _job_env() -> dict:
    env = dict(os.environ)
    env["PATH"] = VENV_BIN + os.pathsep + env.get("PATH", "")   # ffmpeg via static_ffmpeg
    env["HUB_JOB"] = "1"    # tools skip their own gallery-copy/phone-push under the hub
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
              sources: list[str], cwd: str | None = None,
              segment: dict | None = None) -> dict:
    """argv_builder(out_dir, sources) -> list[str] — called inside the job thread
    after the job dir exists (and after any segment trim), so scripts receive the
    real per-job output dir and the effective source paths."""
    job_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    job_dir = JOBS_DIR / job_id
    out_dir = job_dir / "out"
    out_dir.mkdir(parents=True)
    log_path = str(job_dir / "log.txt")

    proj = manifests.get(project_name) or {}
    serialize = bool(proj.get("actions", {}).get(action_name, {}).get("serialize"))

    job = {"id": job_id, "project": project_name, "action": action_name,
           "argv": argv_builder(str(out_dir), sources), "sources": sources,
           "status": "running", "started": time.time(), "log_path": log_path}
    store.insert_job(job)

    def _run():
        rc = -1
        try:
            with open(log_path, "w", buffering=1) as log:
                lock = _serial_lock(project_name, action_name) if serialize else None
                if lock and not lock.acquire(blocking=False):
                    log.write("[hub] waiting for an earlier job of this action "
                              "to finish (GPU serialization)...\n")
                    log.flush()
                    lock.acquire()
                try:
                    eff_sources = list(sources)
                    if segment and len(sources) == 1:
                        clip = str(job_dir / "segment.mp4")
                        _trim_segment(sources[0], float(segment["start"]),
                                      float(segment["end"]), clip, log)
                        eff_sources = [clip]
                    argv = argv_builder(str(out_dir), eff_sources)
                    log.write("$ " + " ".join(argv) + "\n\n")
                    log.flush()
                    proc = subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT,
                                            cwd=cwd or str(job_dir), env=_job_env())
                    rc = proc.wait()
                finally:
                    if lock:
                        lock.release()
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
