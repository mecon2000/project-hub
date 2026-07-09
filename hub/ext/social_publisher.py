"""social-publisher queue board, ported from social-publisher/src/web.py.

The ONE sanctioned project-specific module in the hub (plan §Phase 5 fallback).
It reuses social-publisher's own Python modules (config/ig_queue/captioner/refill)
so no queue logic is duplicated; only the HTTP layer lives here. Send goes to
ntfy (the Pushbullet retirement). Stage-only remains absolute: nothing here may
touch Instagram — see social-publisher/CLAUDE.md.
"""
import json
import os
import shutil
import sys
from pathlib import Path
from urllib.parse import quote

from flask import Blueprint, abort, jsonify, request

from hub import notify

SP_REPO = os.path.expanduser("~/gitrep/social-publisher")
if SP_REPO not in sys.path:
    sys.path.insert(0, SP_REPO)
from src import captioner, ig_queue, refill  # noqa: E402
from src import config as sp_config          # noqa: E402

bp = Blueprint("sp", __name__)


def _kind_of(item: dict) -> str:
    return "stories" if item.get("type") == "story" else "posts"


def _copy_text(item: dict) -> str:
    if item.get("type") == "story":
        bits = []
        if item.get("quote"):
            bits.append(f"“{item['quote']}” — {item.get('quote_author', '')}".strip())
        for key in ("story_text", "prompt"):
            if item.get(key):
                bits.append(item[key])
        if item.get("poll_options"):
            bits.append("Poll: " + " | ".join(item["poll_options"]))
        if item.get("countdown"):
            bits.append("Countdown: " + item["countdown"])
        if item.get("mention"):
            bits.append(f"credit {item['mention']}")
        return "\n".join(bits)
    return ig_queue.post_text(item, for_copy=True)


def _card(item: dict, data_path: str) -> dict:
    folder = Path(data_path).parent
    imgs = item.get("image_paths", [])
    return {
        "id": item.get("id"), "account": item.get("account"), "kind": _kind_of(item),
        "type": item.get("type"), "subtype": item.get("subtype"), "model": item.get("model"),
        "idea": item.get("idea"), "caption": item.get("caption"),
        "story_text": item.get("story_text"),
        "quote": item.get("quote"), "quote_author": item.get("quote_author"),
        "hashtags": item.get("hashtags", []),
        "consent": (item.get("consent_verified") or {}).get("rule"),
        "stickers": item.get("story_stickers", []), "poll_options": item.get("poll_options"),
        "prompt": item.get("prompt"), "countdown": item.get("countdown"),
        "mention": item.get("mention"),
        "images": [{"url": "/file?path=" + quote(p), "win": sp_config.win_path(p),
                    "name": Path(p).name}
                   for p in imgs if os.path.exists(p)],
        "folder_win": sp_config.win_path(folder),
        "copy_text": _copy_text(item),
    }


def _lane(account: str, kind: str) -> dict:
    base = sp_config.items_dir(account, kind)
    cards = []
    if base.exists():
        for p in sorted(base.glob("*/data.json")):
            try:
                d = json.loads(p.read_text())
                if d.get("status", "queued") != "queued":
                    continue
                cards.append(_card(d, str(p)))
            except Exception:  # noqa: BLE001
                pass
    return {"account": account, "kind": kind, "label": f"{account} · {kind}",
            "target": 8, "items": cards}


def _find(item_id: str):
    for acct in sp_config.load_accounts().get("accounts", {}):
        for kind in ("posts", "stories"):
            base = sp_config.items_dir(acct, kind)
            if not base.exists():
                continue
            for p in base.glob("*/data.json"):
                try:
                    d = json.loads(p.read_text())
                except Exception:  # noqa: BLE001
                    continue
                if d.get("id") == item_id:
                    return d, p
    return None, None


@bp.get("/api/sp/queues")
def queues():
    out = []
    for acct_name, acct in sp_config.load_accounts().get("accounts", {}).items():
        if acct.get("active") is False:
            continue
        for kind in ("posts", "stories"):
            out.append(_lane(acct_name, kind))
    return jsonify(out)


@bp.post("/api/sp/remove")
def remove():
    d, p = _find((request.json or {}).get("id", ""))
    if not d:
        abort(404)
    account, kind = d["account"], _kind_of(d)
    refill.remember(account, d.get("source_photos", []))
    shutil.rmtree(Path(p).parent, ignore_errors=True)
    try:
        refill.refill(account, kind)
    except Exception as e:  # noqa: BLE001
        return jsonify({**_lane(account, kind), "warning": f"refill failed: {e}"})
    return jsonify(_lane(account, kind))


@bp.post("/api/sp/edit")
def edit():
    body = request.json or {}
    d, p = _find(body.get("id", ""))
    if not d:
        abort(404)
    try:
        d["caption"] = captioner.regen_caption(d, body.get("instruction") or None)
    except Exception as e:  # noqa: BLE001
        msg = str(e) or "caption generation failed"
        if "timed out" in msg.lower():
            msg = "caption generation timed out — try again."
        return jsonify({"error": "caption edit failed: " + msg}), 400
    Path(p).write_text(json.dumps(d, indent=2, ensure_ascii=False))
    return jsonify(_card(d, str(p)))


@bp.post("/api/sp/send")
def send():
    """Send to phone — via ntfy now (Pushbullet retired for this flow)."""
    body = request.json or {}
    d, p = _find(body.get("id", ""))
    if not d:
        abort(404)
    to = body.get("to", "Me")
    title = f"FOR {to} — {d['account']} {str(d.get('type')).upper()}"
    text = _copy_text(d)
    imgs = [ip for ip in d.get("image_paths", []) if os.path.exists(ip)]
    notify.push("hub-jobs", title, text or "(see image)",
                attach_file=imgs[0] if imgs else None)
    return jsonify({"ok": True})
