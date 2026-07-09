"""SSE log tailing for the Jobs tab."""
import time

from hub.jobs import store


def sse_tail(job_id: str):
    """Generator yielding SSE events: existing log, then live tail until finished."""
    job = store.get_job(job_id)
    if not job:
        yield "event: gone\ndata: no such job\n\n"
        return
    path = job["log_path"]
    pos = 0
    idle = 0.0
    while True:
        try:
            with open(path) as f:
                f.seek(pos)
                chunk = f.read()
                pos = f.tell()
        except OSError:
            chunk = ""
        if chunk:
            idle = 0.0
            for line in chunk.splitlines():
                yield f"data: {line}\n\n"
        job = store.get_job(job_id)
        if job and job["status"] != "running" and not chunk:
            yield f"event: done\ndata: {job['status']}\n\n"
            return
        time.sleep(0.5)
        idle += 0.5
        if idle > 3600:                      # safety: never tail forever
            yield "event: done\ndata: timeout\n\n"
            return
