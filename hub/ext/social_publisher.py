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
        "mention": item.get("mention"), "look_for": item.get("look_for"),
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
            "target": 16, "items": cards}


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


@bp.get("/api/sp/accounts")
def accounts():
    return jsonify([a for a, v in sp_config.load_accounts().get("accounts", {}).items()
                    if v.get("active") is not False])


CONSENT_ALLOWLIST = Path(os.path.expanduser(
    "~/.openclaw/workspace/shared/data/consent_allowlist.yaml"))
BLACKLIST = Path(os.path.expanduser(
    "~/.openclaw/workspace/shared/blacklisted_models.json"))


def _consent_status(model: str) -> tuple[str, str | None, str | None]:
    """-> (status, ig_rule, notes); status: blacklisted|confirmed|per_photo|unknown."""
    if not model:
        return "unknown", None, None
    key = model.lower().strip()
    try:
        bl = json.loads(BLACKLIST.read_text()).get("models", []) if BLACKLIST.exists() \
            and BLACKLIST.stat().st_size else []
    except ValueError:
        bl = []
    for entry in bl:
        if key in str(entry).lower():
            return "blacklisted", None, str(entry)
    try:
        import yaml
        models = yaml.safe_load(CONSENT_ALLOWLIST.read_text()).get("models", {})
    except Exception:  # noqa: BLE001
        return "unknown", None, "allowlist unreadable"
    for name, m in models.items():
        if name.lower().strip() == key:
            rule = m.get("ig")
            notes = m.get("constraints") or m.get("notes")
            if not m.get("confirmed"):
                return "unknown", rule, notes
            if rule in ("no",):
                return "blacklisted", rule, notes or "consent rule is 'no'"
            if rule == "per_photo":
                return "per_photo", rule, notes
            return "confirmed", rule, notes
    return "unknown", None, None


def _guess_model(path: str) -> str:
    parts = Path(path).parts
    if "_photos" in parts:
        return parts[parts.index("_photos") + 1]
    stem = Path(path).stem
    if "__" in stem:
        first = stem.split("__")[0].replace("_", " ").strip()
        if first and not first[0].isdigit():
            return first
    return ""


@bp.post("/api/sp/queue-image")
def queue_image():
    """Hand-queue a photo from any hub gallery as a post/story item.

    Bypasses the /ig-queue consent+SFW gate on purpose — the created card has NO
    consent badge and an empty caption, so it visibly demands review in the Queue
    tab before the user posts it. Source photo gets a queued_to_sp sidecar tag."""
    from hub import safepath
    import time as _time

    body = request.json or {}
    src = safepath.resolve_safe(body.get("path", ""))
    account = body.get("account", "")
    itype = body.get("type", "post")
    if not src or not os.path.isfile(src):
        return jsonify({"error": "bad path"}), 400
    if account not in sp_config.load_accounts().get("accounts", {}):
        return jsonify({"error": f"unknown account {account!r}"}), 400
    if itype not in ("post", "story"):
        return jsonify({"error": "type must be post or story"}), 400

    model = _guess_model(src)
    status, rule, notes = _consent_status(model)
    if status == "blacklisted":
        return jsonify({"error": f"'{model}' is blacklisted / consent='no' — not queueing.",
                        "notes": notes}), 403
    if status in ("unknown", "per_photo") and not body.get("confirm"):
        return jsonify({"needs_confirm": True, "model": model or "(unknown model)",
                        "status": status, "rule": rule, "notes": notes}), 409

    kind = "posts" if itype == "post" else "stories"
    stamp = _time.strftime("%Y%m%d-%H%M%S")
    item_id = f"{stamp}-manual-{Path(src).stem[:24]}"
    folder = sp_config.items_dir(account, kind) / f"manual__{stamp}__{Path(src).stem[:40]}"
    folder.mkdir(parents=True, exist_ok=True)
    dest_img = folder / Path(src).name
    shutil.copyfile(src, dest_img)

    item = {
        "id": item_id, "account": account, "type": itype, "subtype": "manual",
        "status": "queued", "model": model,
        "caption": "", "hashtags": [],
        "image_paths": [str(dest_img)], "source_photos": [src],
        "consent_verified": ({"rule": rule, "source": "allowlist via hub"}
                             if status == "confirmed" else None),
        "consent_note": notes if status in ("per_photo", "unknown") else None,
        "created_by": f"hub queue-image (consent: {status})",
    }
    (folder / "data.json").write_text(json.dumps(item, indent=2, ensure_ascii=False))

    # tag the source photo's sidecar (tag, don't move — provenance stays intact)
    sidecar_path = src + ".json"
    alt = os.path.splitext(src)[0] + ".json"
    if os.path.isfile(alt) and not os.path.isfile(sidecar_path):
        sidecar_path = alt
    try:
        sidecar = json.loads(Path(sidecar_path).read_text()) if os.path.isfile(sidecar_path) else {}
    except ValueError:
        sidecar = {}
    sidecar.setdefault("queued_to_sp", []).append(
        {"account": account, "type": itype, "date": stamp, "item_id": item_id})
    Path(sidecar_path).write_text(json.dumps(sidecar, indent=2, ensure_ascii=False))

    return jsonify({"ok": True, "card": _card(item, str(folder / "data.json"))})


@bp.post("/api/sp/posted")
def posted():
    """User confirms they published this item manually — status=posted + cadence record
    (so posting caps and the weekly report count it exactly like dispatched items)."""
    from src import cadence
    d, p = _find((request.json or {}).get("id", ""))
    if not d:
        abort(404)
    d["_path"] = str(p)
    try:
        cadence.record_dispatch(d)
    except Exception as e:  # noqa: BLE001
        pass
    d.pop("_path", None)
    d["status"] = "posted"
    d["posted_at"] = __import__("time").strftime("%Y-%m-%d %H:%M:%S")
    Path(p).write_text(json.dumps(d, indent=2, ensure_ascii=False))
    return jsonify(_lane(d["account"], _kind_of(d)))


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
