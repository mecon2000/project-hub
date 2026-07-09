"""ntfy client: job-completion pushes with image attachment + hub deep link."""
import os
from urllib.parse import quote

import requests

from hub import manifests
from hub.config import HUB_PUBLIC_URL, NTFY_URL

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif"}


def _topic(project_name: str) -> str:
    proj = manifests.get(project_name) or {}
    return proj.get("notify", {}).get("topic", "hub-jobs")


def push(topic: str, title: str, message: str, click: str | None = None,
         attach_file: str | None = None, priority: str | None = None) -> None:
    headers = {"Title": title.encode("utf-8", "ignore")}
    if click:
        headers["Click"] = click
    if priority:
        headers["Priority"] = priority
    url = f"{NTFY_URL}/{topic}"
    if attach_file and os.path.isfile(attach_file):
        headers["Filename"] = os.path.basename(attach_file)
        headers["Message"] = message.encode("utf-8", "ignore")
        with open(attach_file, "rb") as f:
            requests.put(url, data=f, headers=headers, timeout=30)
    else:
        requests.post(url, data=message.encode("utf-8"), headers=headers, timeout=15)


def job_done(project_name: str, action_name: str, job_id: str,
             status: str, outputs: list[str]) -> None:
    proj = manifests.get(project_name) or {}
    if proj.get("notify", {}).get("enabled", True) is False:
        return
    ok = status == "done"
    title = f"{proj.get('label', project_name)}: {action_name} {'✓' if ok else 'FAILED'}"
    n_media = len([o for o in outputs if os.path.splitext(o)[1].lower() != ".json"])
    message = (f"{n_media} output(s)" if ok else "job failed — tap to see the log")
    click = (f"{HUB_PUBLIC_URL}/#p={quote(project_name)}&job={job_id}")
    attach = None
    if ok and proj.get("notify", {}).get("attach", True):
        attach = next((o for o in outputs
                       if os.path.splitext(o)[1].lower() in IMAGE_EXT), None)
    push(_topic(project_name), title, message, click,
         attach_file=attach, priority=None if ok else "high")
