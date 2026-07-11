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


def _sweep_tombstones() -> None:
    """Retry-delete folders of items tombstoned by a locked remove (cheap, best-effort)."""
    for acct in sp_config.load_accounts().get("accounts", {}):
        for kind in ("posts", "stories"):
            base = sp_config.items_dir(acct, kind)
            if not base.exists():
                continue
            for p in base.glob("*/data.json"):
                try:
                    if json.loads(p.read_text()).get("status") == "removed":
                        shutil.rmtree(p.parent, ignore_errors=True)
                except Exception:  # noqa: BLE001
                    pass


@bp.get("/api/sp/queues")
def queues():
    _sweep_tombstones()
    out = []
    for acct_name, acct in sp_config.load_accounts().get("accounts", {}).items():
        if acct.get("active") is False:
            continue
        for kind in ("posts", "stories"):
            out.append(_lane(acct_name, kind))
    return jsonify(out)


REMOVE_REASONS = {
    "nsfw":             "Too NSFW for IG",
    "no_consent_photo": "No consent for THIS photo",
    "not_anon":         "Shows face — this model asked to be anon",
    "block_model":      "Don't post this model at all",
    "bad_photo":        "Weak photo (unflattering/boring)",
    "bad_crop":         "Bad crop (photo itself is fine)",
    "bad_caption":      "Bad caption/idea (photo itself is fine)",
    "other":            "Other / just don't want it",
}
# non-photo cards get their own reason sets — photo reasons make no sense there
REASONS_BY_SUBTYPE = {
    "shoutout": {"block_source": "Never suggest this account again",
                 "other": "Just remove (may be suggested again)"},
    "found":    {"block_source": "Never suggest this account again",
                 "other": "Just remove (may be suggested again)"},
    "quote":    {"block_quote": "Don't use this quote again",
                 "other": "Just remove"},
    "lyric":    {"block_song": "This song — never again",
                 "block_artist": "This ARTIST — never again",
                 "other": "Just remove"},
}
FEEDBACK_LOG = Path(os.path.expanduser(
    "~/.openclaw/workspace/shared/social-publisher/_state/removal_feedback.jsonl"))
CREATIVE_FEEDBACK = Path(os.path.expanduser(
    "~/.openclaw/workspace/shared/social-publisher/_state/creative_feedback.jsonl"))
BLOCKED_SOURCES = Path(os.path.expanduser(
    "~/.openclaw/workspace/shared/social-publisher/_state/blocked_sources.json"))


def _blocked_add(kind: str, value: str) -> None:
    try:
        data = json.loads(BLOCKED_SOURCES.read_text()) if BLOCKED_SOURCES.exists() else {}
    except ValueError:
        data = {}
    lst = data.setdefault(kind, [])
    if value and value not in lst:
        lst.append(value)
    BLOCKED_SOURCES.parent.mkdir(parents=True, exist_ok=True)
    BLOCKED_SOURCES.write_text(json.dumps(data, indent=2, ensure_ascii=False))


def _creative_feedback_add(d: dict, text: str) -> None:
    import time as _t
    CREATIVE_FEEDBACK.parent.mkdir(parents=True, exist_ok=True)
    rec = {"date": _t.strftime("%Y-%m-%d %H:%M:%S"),
           "subtype": d.get("subtype") or d.get("type"),
           "card": d.get("idea") or d.get("story_text") or d.get("caption", "")[:80],
           "feedback": text}
    with open(CREATIVE_FEEDBACK, "a") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def _log_feedback(d: dict, reason: str) -> None:
    import time as _t
    FEEDBACK_LOG.parent.mkdir(parents=True, exist_ok=True)
    rec = {"date": _t.strftime("%Y-%m-%d %H:%M:%S"), "id": d.get("id"),
           "model": d.get("model"), "reason": reason,
           "sources": d.get("source_photos", [])}
    with open(FEEDBACK_LOG, "a") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def _tag_photo_explicit(src_path: str) -> bool:
    """Write a photo-level boldness=explicit tag into the catalog DB (photo_tags),
    matched by filename stem. Best-effort — a removal must never fail on this."""
    import sqlite3
    try:
        stem = Path(src_path).stem.lower()
        db = os.path.expanduser("~/gitrep/photo-catalogging/data/photo-catalog.db")
        conn = sqlite3.connect(db, timeout=10)
        row = conn.execute(
            "SELECT id FROM photos WHERE LOWER(filename) LIKE ? LIMIT 1",
            (stem + ".%",)).fetchone()
        if not row:
            conn.close()
            return False
        exists = conn.execute(
            "SELECT 1 FROM photo_tags WHERE photo_id=? AND dimension='boldness'"
            " AND value='explicit'", (row[0],)).fetchone()
        if not exists:
            conn.execute(
                "INSERT INTO photo_tags (photo_id, dimension, value, source)"
                " VALUES (?, 'boldness', 'explicit', 'user_queue_removal')", (row[0],))
            conn.commit()
        conn.close()
        return True
    except Exception:  # noqa: BLE001
        return False


def _apply_removal_reason(d: dict, reason: str) -> tuple[bool, str]:
    """Feed the reason back into consent/DB state. Returns (burn_photo, note)."""
    from src import consent as sp_consent
    model = d.get("model")
    srcs = d.get("source_photos", [])
    if reason in ("nsfw", "no_consent_photo") and model and srcs:
        label = "too NSFW for IG" if reason == "nsfw" else "no consent for this photo"
        tagged = 0
        for s in srcs:
            sp_consent.set_photo_consent(model, s, approved=False,
                                         notes=f"{label} (queue removal)",
                                         source="hub queue removal")
            if reason == "nsfw" and _tag_photo_explicit(s):
                tagged += 1
        note = f"photo rejected in allowlist ({label})"
        if tagged:
            note += f" + tagged explicit in catalog DB"
        return True, note
    if reason == "not_anon" and model:
        # corrective double-write: the model's rule becomes anon_only (fixes a
        # face_ok mislabel + drops them from auto-refill), and THIS photo is
        # rejected outright (a face photo can never suit an anon-only model)
        sp_consent.set_consent(model, "anon_only", source="hub queue removal",
                               notes="asked to be anonymous (queue removal)")
        for s in srcs:
            sp_consent.set_photo_consent(model, s, approved=False,
                                         notes="shows face — model is anon_only (queue removal)",
                                         source="hub queue removal")
        return True, f"'{model}' set to anon_only + this photo rejected"
    if reason == "block_model" and model:
        sp_consent.set_consent(model, "no", source="hub queue removal",
                               notes="blocked via queue removal")
        return True, f"model '{model}' set to ig: no — leaving the pool"
    if reason in ("bad_crop", "bad_caption"):
        return False, "photo NOT burned — it may return with a different crop/caption"
    if reason == "block_source":
        h = d.get("mention") or d.get("shoutout") or ""
        _blocked_add("handles", h)
        return True, f"{h} won't be suggested again"
    if reason == "block_quote":
        _blocked_add("quotes", d.get("quote") or "")
        return True, "quote retired"
    if reason == "block_song":
        song = f"{d.get('artist', '?')} — {d.get('song', '?')}"
        _blocked_add("songs", song)
        return True, f"blocked: {song}"
    if reason == "block_artist":
        _blocked_add("artists", d.get("artist") or "")
        return True, f"blocked artist: {d.get('artist')}"
    return True, ""


@bp.post("/api/sp/remove")
def remove():
    body = request.json or {}
    d, p = _find(body.get("id", ""))
    if not d:
        abort(404)
    account, kind = d["account"], _kind_of(d)
    reason = body.get("reason") or "other"
    burn, note = _apply_removal_reason(d, reason)
    _log_feedback(d, reason)
    feedback = (body.get("feedback") or "").strip()
    if feedback:
        _creative_feedback_add(d, feedback)   # read by the ig-queue skill before writing new cards
        note = (note + "; " if note else "") + "feedback saved for the writer"
    if burn:
        refill.remember(account, d.get("source_photos", []))
    extra_removed = 0
    if reason == "block_model" and d.get("model"):
        # purge every other queued card of this model, burning their sources
        for acct in sp_config.load_accounts().get("accounts", {}):
            for k in ("posts", "stories"):
                base = sp_config.items_dir(acct, k)
                if not base.exists():
                    continue
                for dp in base.glob("*/data.json"):
                    try:
                        it = json.loads(dp.read_text())
                    except Exception:  # noqa: BLE001
                        continue
                    if it.get("model") == d["model"] and it.get("id") != d["id"] \
                            and it.get("status", "queued") == "queued":
                        refill.remember(acct, it.get("source_photos", []))
                        shutil.rmtree(dp.parent, ignore_errors=True)
                        extra_removed += 1
        if extra_removed:
            note += f"; {extra_removed} more queued card(s) of this model removed"
    folder = Path(p).parent
    shutil.rmtree(folder, ignore_errors=True)
    if folder.exists():
        # drvfs/9p lock (e.g. the card's image is being streamed) — tombstone the
        # item so it stays out of the queue; cleanup retries happen on later loads
        d["status"] = "removed"
        try:
            Path(p).write_text(json.dumps(d, indent=2, ensure_ascii=False))
        except OSError:
            pass
    try:
        refill.refill(account, kind)
    except Exception as e:  # noqa: BLE001
        return jsonify({**_lane(account, kind), "warning": f"refill failed: {e}",
                        **({"note": note} if note else {})})
    return jsonify({**_lane(account, kind), **({"note": note} if note else {})})


@bp.get("/api/sp/remove-reasons")
def remove_reasons():
    subtype = request.args.get("subtype", "")
    return jsonify(REASONS_BY_SUBTYPE.get(subtype, REMOVE_REASONS))


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


@bp.post("/api/sp/crop-options")
def crop_options():
    """Subject-aware crop options from the ORIGINAL photo (labeled overlay + montage)."""
    from src.refill import _ip, _last_json
    d, p = _find((request.json or {}).get("id", ""))
    if not d:
        abort(404)
    src = (d.get("source_photos") or [None])[0]
    if not src or not os.path.exists(src):
        return jsonify({"error": "this card has no original source photo on disk"}), 400
    outdir = Path(p).parent / "crop_opts"
    outdir.mkdir(exist_ok=True)
    r = _ip("options", "--source", src, "--outdir", str(outdir))
    if r.returncode != 0:
        return jsonify({"error": "crop options failed: " + (r.stderr or "")[-200:]}), 500
    j = _last_json(r)
    return jsonify({
        "id": d["id"],
        "options": j["options"],
        "overlay": "/file?path=" + quote(j["overlay"]),
        "montage": "/file?path=" + quote(j["montage"]),
    })


@bp.post("/api/sp/crop-apply")
def crop_apply():
    """Apply a chosen crop box (from crop-options) to the card's image, from the original."""
    from src.refill import _ip
    body = request.json or {}
    d, p = _find(body.get("id", ""))
    if not d:
        abort(404)
    src = (d.get("source_photos") or [None])[0]
    target = (d.get("image_paths") or [None])[0]
    box, fmt = body.get("box"), body.get("fmt")
    if not (src and target and isinstance(box, list) and len(box) == 4 and fmt):
        return jsonify({"error": "need box[4] + fmt from crop-options"}), 400
    r = _ip("apply", "--source", src, "--box", ",".join(str(int(v)) for v in box),
            "--format", str(fmt), "--out", target)
    if r.returncode != 0:
        return jsonify({"error": "crop apply failed: " + (r.stderr or "")[-200:]}), 500
    shutil.rmtree(Path(p).parent / "crop_opts", ignore_errors=True)
    return jsonify(_card(d, str(p)))


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
