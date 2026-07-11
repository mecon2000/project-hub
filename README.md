# project-hub — the content machine

One phone bookmark → every local media project. Runs on the always-on Win11 PC
(WSL2), reachable only over Tailscale. This file is the for-humans map; the
"Wiring" tab in the UI shows live state.

- **URL:** https://desktop-ddrctuq.tail4fbebb.ts.net (phone needs the Tailscale VPN on)
- **Notifications:** self-hosted ntfy, topic `hub-jobs`
- **Plan & history:** `~/.claude/plans/i-have-claude-code-enchanted-sun.md`

## 1. Bird's eye

```mermaid
flowchart LR
    subgraph Phone["📱 OnePlus (anywhere)"]
        TSAPP[Tailscale VPN]
        NTFYAPP[ntfy app]
        BROWSER[hub bookmark]
    end

    subgraph PC["🖥️ Win11 PC — WSL2 (always on)"]
        TS[tailscaled + tailscale serve]
        HUB["project-hub (Flask :8700)\nsystemd: project-hub.service"]
        NTFY["ntfy server :8093\nsystemd: ntfy.service"]
        JOBS["job runner\n(subprocess per job)"]
        SCHED["APScheduler\n(schedules in hub.db)"]
        TOOLS["tool scripts\n(photo/video/refill/censor…)"]
    end

    subgraph Stores["💾 data"]
        SHARED["D:\\OpenClaw\\shared\n(= ~/.openclaw/workspace/shared, 9p mount)"]
        PHOTOS["I:\\Dropbox\\_photos\n(read-only mount, ~24k jpgs)"]
        CATALOG["photo-catalog.db\n(130k photos, ext4)"]
        STATE["project-hub/state\n(jobs, thumbs, hub.db — ext4!)"]
    end

    BROWSER -->|https 443| TS --> HUB
    NTFYAPP -->|https 8093| TS --> NTFY
    HUB --> JOBS --> TOOLS
    SCHED --> JOBS
    JOBS -->|"ntfy on done"| NTFY --> NTFYAPP
    TOOLS <--> SHARED
    TOOLS --> PHOTOS
    HUB <--> CATALOG
    HUB <--> STATE
```

**Rule of thumb for what lives where:** repos hold code + a `hub-project.yaml`
manifest; `shared/` holds media (visible from Windows Explorer); `state/` holds
regenerable runtime data on ext4 (SQLite corrupts on the 9p mounts); the catalog
DB is the photo brain.

## 2. Projects = manifests

```mermaid
flowchart TD
    GLOB["glob: ~/gitrep/*/hub-project.yaml\n+ project-hub/projects/*.yaml"] --> M[manifest loader, hot-reload]
    M --> P1["photo-tools\n(11 registry tools + auto-gen)"]
    M --> P2["vids-to-censor\n(fox/blur/mosaic, segment picker)"]
    M --> P3["stills-to-video\n(WAN/Kling animate)"]
    M --> P4["social-publisher\n(IG queue board — custom view)"]
    M --> P5["photo-catalog\n(DB views + thumbnails)"]
    M --> P6["hub-utils\n(one-shot reminders)"]
```

Drop a `hub-project.yaml` in any repo → new project appears on refresh.
Manifest declares: content areas (gallery folders), actions (script + params →
auto-built forms), db views, notify topic. No hub code per project (single
sanctioned exception: `hub/ext/social_publisher.py`).

## 3. The IG content machine (daily loop)

```mermaid
flowchart TD
    subgraph Sources
        PH["_photos/<Model>/…"]
        CAND["shared/candidates\n(refresh Sun+Wed 03:00)"]
    end

    subgraph Gates["🚦 gates (every candidate)"]
        ALLOW["consent allowlist\nface_ok models (106) + per-photo rejections"]
        SFW["SFW filter\nphoto-level explicit + set-level + LR keywords"]
        LEDGER["seen-ledger\n(never re-suggest a used/burned photo)"]
    end

    REFILL["refill (07:00 top-up to 16)\nweighted-random model → shuffled candidates\n→ smart 4:5 crop → LLM caption"]
    QUEUE["Queue tab\n(lanes × subtype, filters)"]
    DISPATCH["dispatcher (*/20, 8-23)\nposting windows + cadence caps + stagger"]
    YOU["📱 you: paste caption, publish on IG\n(ALWAYS manual — stage-only rule)"]
    RECORDS["cadence records + weekly report (Sun 20:00)"]

    PH --> REFILL
    CAND -.->|auto-gen sources| REFILL
    Gates --> REFILL --> QUEUE
    QUEUE -->|"📣 time to post (ntfy)"| DISPATCH --> YOU --> RECORDS

    subgraph Review["review actions on each card"]
        CROP["Crop — re-cut from ORIGINAL"]
        EDIT["Edit — LLM caption rewrite"]
        POSTED["Posted ✓ → cadence"]
        REMOVE["Remove + reason"]
    end
    QUEUE --- Review
```

## 4. Remove-with-reason: every removal teaches the system

```mermaid
flowchart LR
    R[Remove card] --> WHY{why?}
    WHY -->|too NSFW| A1["allowlist: photo rejected\n+ catalog DB: photo tagged explicit"]
    WHY -->|no consent for photo| A2["allowlist: photo rejected"]
    WHY -->|shows face, model is anon| A3["model → anon_only\n+ photo rejected"]
    WHY -->|block model| A4["model → ig: no\n+ purge their queued cards"]
    WHY -->|weak photo| A5["seen-ledger: burned"]
    WHY -->|bad crop / caption| A6["NOT burned — may return\n(hint: Crop / Edit buttons)"]
    A1 & A2 & A3 & A4 & A5 & A6 --> LOG["removal_feedback.jsonl\n(audit + replay if DB rebuilt)"]
```

## 5. Schedules (all visible/editable in the Schedules tab)

| When | What |
|---|---|
| every 20 min, 8–23 | posting dispatcher (notifies only when something is due) |
| 07:00 / 07:15 | top up RW1 posts / stories lanes to 16 |
| 03:00 Sun+Wed | refresh candidates pool |
| 20:00 Sun | weekly content report |
| 04:30 daily | purge >30-day trash |
| *(disabled)* | auto-gen (weighted by favorites, $1/day cap) |
| *(disabled)* | nightly auto-censor of vids-to-censor/input |

## 6. Ops crib sheet

- Everything auto-starts (systemd user units + linger). Reboot needs nothing.
- Backend code changed → `systemctl --user restart project-hub.service`.
  Manifests / tool scripts / registry → nothing (hot-reload / fresh subprocess).
- Logs: Jobs tab (per job), `journalctl --user -u project-hub`.
- Key backups to care about (small, priceless): `shared/data/consent_allowlist.yaml`,
  `photo-catalogging/data/photo-catalog.db`, `shared/favorites/favorites.json`,
  `shared/social-publisher/_state/*` — see "Ideas" below, backups are not automated yet.
