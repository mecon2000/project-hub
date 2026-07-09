"""Central paths + env. Mirrors social-publisher's config style (env from ~/sol/.env)."""
import os
from pathlib import Path

HUB_ROOT = Path(__file__).resolve().parent.parent          # ~/gitrep/project-hub
STATE_DIR = HUB_ROOT / "state"                             # ext4 ONLY — never drvfs
JOBS_DIR = STATE_DIR / "jobs"
THUMB_CACHE = STATE_DIR / "thumb-cache"
HUB_DB = STATE_DIR / "hub.db"

GITREP = Path.home() / "gitrep"
MANIFEST_GLOBS = [
    str(GITREP / "*" / "hub-project.yaml"),
    str(HUB_ROOT / "projects" / "*.yaml"),
]

VENV_BIN = str(Path.home() / "openclaw-venv" / "bin")
PYTHON = str(Path.home() / "openclaw-venv" / "bin" / "python")

NTFY_URL = "http://127.0.0.1:8093"
HUB_PUBLIC_URL = "https://desktop-ddrctuq.tail4fbebb.ts.net"
HUB_PORT = 8700

ENV_FILE = Path.home() / "sol" / ".env"


def get_env(key: str, default: str = "") -> str:
    """Env var, falling back to ~/sol/.env (KEY=value lines)."""
    if key in os.environ:
        return os.environ[key]
    try:
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line.startswith(f"{key}="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return default


API_TOKEN = get_env("HUB_API_TOKEN")   # empty = auth disabled (tailnet is the perimeter)

for d in (STATE_DIR, JOBS_DIR, THUMB_CACHE):
    d.mkdir(parents=True, exist_ok=True)
