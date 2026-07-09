#!/usr/bin/env bash
# Run the hub under the shared venv. Reloader must stay off (APScheduler double-start).
cd "$(dirname "$0")"
export PATH="$HOME/openclaw-venv/bin:$PATH"   # jobs need venv binaries (ffmpeg via static_ffmpeg)
exec "$HOME/openclaw-venv/bin/python" -m hub.app
