"""Shell out to the local `claude` CLI (subscription, not API).

Lifted from social-publisher/src/captioner.py: scrub ANTHROPIC_* env vars so the
CLI uses the logged-in subscription, run in a temp cwd so no project context
leaks in, extract an answer tag if requested.
"""
import os
import re
import shutil
import subprocess
import tempfile

CLAUDE = os.path.expanduser("~/.local/bin/claude")


def run_claude(prompt: str, system_prompt: str = "", timeout: int = 120,
               tag: str | None = None) -> str | None:
    exe = CLAUDE if os.path.isfile(CLAUDE) else shutil.which("claude")
    if not exe:
        return None
    env = {k: v for k, v in os.environ.items() if not k.startswith("ANTHROPIC_")}
    cmd = [exe, "-p", prompt, "--output-format", "text"]
    if system_prompt:
        cmd[3:3] = ["--system-prompt", system_prompt]
    try:
        with tempfile.TemporaryDirectory() as tmp:
            r = subprocess.run(cmd, cwd=tmp, env=env, capture_output=True,
                               text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None
    if r.returncode != 0:
        return None
    out = r.stdout.strip()
    if tag:
        m = re.search(rf"<{tag}>(.*?)</{tag}>", out, re.DOTALL)
        return m.group(1).strip() if m else None
    return out or None
