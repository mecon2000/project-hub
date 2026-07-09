# project-hub

One manifest-driven web UI for all of Ron's local media projects, served on the tailnet.
Full plan: `~/.claude/plans/i-have-claude-code-enchanted-sun.md`.

## Non-negotiables
- **Generic engine only** — zero project-specific code in this repo, ever. Project behavior
  comes from `hub-project.yaml` manifests (glob `~/gitrep/*/hub-project.yaml` +
  `projects/*.yaml` here for repo-less ones).
- **No module over ~400 lines.** Split before it grows.
- **No symlinks** in content trees; one real location per file.
- Delete = move to the project's `trash/`, never `rm`.
- Reloader stays OFF (APScheduler double-fires under it).
- All file-serving endpoints go through `hub/safepath.py` boundary checks.
- Runtime state (`state/`: hub.db, thumb-cache, job dirs) lives HERE on ext4 —
  never on the drvfs mounts (SQLite WAL corrupts on 9p).

## Key paths
- Venv: `~/openclaw-venv` — ffmpeg/ffprobe come from `static_ffmpeg` inside it;
  job subprocesses get `~/openclaw-venv/bin` prepended to PATH.
- Content root: `~/.openclaw/workspace/shared/` = `D:\OpenClaw\shared\` (drvfs/9p mount!).
  Source photos: `~/.openclaw/workspace/_photos/` = `I:\Dropbox\_Photos` (READ-ONLY mount).
- Photo catalog (read-only SQLite): `~/gitrep/photo-catalogging/data/photo-catalog.db`.
- ntfy: `~/bin/ntfy`, config `~/.config/ntfy/server.yml`, listens 127.0.0.1:8093.
- `claude` CLI: `~/.local/bin/claude` (LLM actions shell out to it, env-scrubbed —
  see `hub/llm.py`, lifted from social-publisher's captioner).
- Hub port: 127.0.0.1:8700, exposed via `tailscale serve`.

## Working on this repo (for Claude sessions)
- Subagents don't auto-downgrade models: delegate mechanical work (scaffolding,
  repetitive manifests, batch verification, wide exploration) to explicitly cheaper
  models (sonnet/haiku); keep architecture-bearing code (runner, safepath, manifests,
  scheduler) in the main session.
- Reuse patterns from sibling repos instead of reinventing: token auth hook +
  path-boundary check (`social-publisher/src/web.py`), claude-CLI subprocess
  (`social-publisher/src/captioner.py`), registry semantics
  (`manipulating-photos/manipulating-photos-with-ui/tool_registry.json`).
