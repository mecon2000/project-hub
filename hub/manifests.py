"""Discover, validate and hot-reload project manifests.

One `hub-project.yaml` per repo (glob ~/gitrep/*/hub-project.yaml) plus
projects/*.yaml here for repo-less projects. Reload is mtime-based per file,
checked on every access — dropping a manifest makes the project appear on the
next request, no restart.

`actions_from_registry: <path>` converts a manipulating-photos tool_registry.json
unmodified into hub actions (presets/artifacts become choice params).
"""
import glob
import json
import os
import time

import yaml

from hub.config import MANIFEST_GLOBS

_cache: dict[str, dict] = {}      # manifest path -> {"mtime", "regmtime", "project"}
_last_scan = 0.0
_SCAN_INTERVAL = 2.0


def _expand(p: str) -> str:
    return os.path.realpath(os.path.expanduser(p))


def _registry_to_actions(reg_path: str, script_base: str) -> dict:
    """Map tool_registry.json entries to hub action dicts (schema superset)."""
    with open(reg_path) as f:
        registry = json.load(f)
    actions = {}
    for name, tool in registry.items():
        if not isinstance(tool, dict) or "script" not in tool:
            continue
        params = dict(tool.get("params", {}))
        if tool.get("presets"):
            params["preset"] = {
                "type": "choice",
                "options": list(tool["presets"]),
                "flag": tool.get("preset_flag", "--preset"),
                "description": tool.get("presets_description", "Preset"),
            }
        if tool.get("artifacts"):
            params["artifact"] = {
                "type": "choice",
                "options": list(tool["artifacts"]),
                "flag": tool.get("artifact_flag", "--artifact"),
                "description": tool.get("artifacts_description", "Artifact"),
            }
        flags = {}
        for fl in tool.get("flags", []):
            flags[fl] = tool.get("flag_descriptions", {}).get(fl, fl)
        actions[name] = {
            "label": tool.get("label", name),
            "script": os.path.join(script_base, tool["script"]),
            "source_arg": "--source",
            "output_dir_arg": tool.get("output_dir_arg", "--local-output-dir"),
            "params": params,
            "flags": flags,
            "cost_estimate_usd": tool.get("cost_estimate_usd"),
            "wall_time_estimate_sec": tool.get("wall_time_estimate_sec"),
            "from_registry": True,
        }
    return actions


def _load_one(path: str) -> dict | None:
    with open(path) as f:
        proj = yaml.safe_load(f)
    if not isinstance(proj, dict) or "name" not in proj:
        return None
    proj.setdefault("label", proj["name"])
    proj["manifest_path"] = path

    content = proj.setdefault("content", {})
    root = _expand(content.get("root", "")) if content.get("root") else ""
    for area in content.setdefault("areas", {}).values():
        d = area.get("dir", "")
        area["abs_dir"] = _expand(d) if os.path.isabs(os.path.expanduser(d)) \
            else os.path.join(root, d)
        os.makedirs(area["abs_dir"], exist_ok=True)
    # implicit trash area for delete=move-to-trash
    if root:
        trash = os.path.join(root, "trash")
        os.makedirs(trash, exist_ok=True)
        proj["trash_dir"] = trash

    proj.setdefault("actions", {})
    if proj.get("actions_from_registry"):
        reg = _expand(proj["actions_from_registry"])
        base = _expand(proj.get("script_base", os.path.dirname(reg)))
        proj["_registry_path"] = reg
        proj["actions"] = {**_registry_to_actions(reg, base), **proj["actions"]}
    for act in proj["actions"].values():
        act.setdefault("params", {})
        act.setdefault("flags", {})
        if "script" in act:
            act["script"] = _expand(act["script"])
    return proj


def all_projects(force: bool = False) -> dict[str, dict]:
    """name -> project dict, hot-reloaded on manifest/registry mtime changes."""
    global _last_scan
    now = time.time()
    if not force and now - _last_scan < _SCAN_INTERVAL and _cache:
        return {c["project"]["name"]: c["project"] for c in _cache.values()}
    _last_scan = now

    found = []
    for g in MANIFEST_GLOBS:
        found.extend(glob.glob(g))
    for stale in set(_cache) - set(found):
        del _cache[stale]
    for path in found:
        try:
            mtime = os.path.getmtime(path)
            entry = _cache.get(path)
            regmtime = 0.0
            if entry and entry["project"].get("_registry_path"):
                try:
                    regmtime = os.path.getmtime(entry["project"]["_registry_path"])
                except OSError:
                    pass
            if entry and entry["mtime"] == mtime and entry.get("regmtime", 0.0) == regmtime:
                continue
            proj = _load_one(path)
            if proj:
                regmtime = 0.0
                if proj.get("_registry_path"):
                    try:
                        regmtime = os.path.getmtime(proj["_registry_path"])
                    except OSError:
                        pass
                _cache[path] = {"mtime": mtime, "regmtime": regmtime, "project": proj}
        except Exception as e:                      # bad manifest must not kill the hub
            print(f"[manifests] failed to load {path}: {e}")
    return {c["project"]["name"]: c["project"] for c in _cache.values()}


def get(name: str) -> dict | None:
    return all_projects().get(name)
