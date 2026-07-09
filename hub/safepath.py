"""Path-boundary checks for every file-serving/mutating endpoint.

Lifted from social-publisher/src/web.py: realpath + segment-boundary prefix test.
Allowed roots are the resolved content dirs of loaded manifests plus the hub's
own jobs dir; anything else is rejected.
"""
import os

_extra_roots: list[str] = []


def register_root(path: str) -> None:
    real = os.path.realpath(os.path.expanduser(path))
    if real not in _extra_roots:
        _extra_roots.append(real)


def allowed_roots() -> list[str]:
    from hub import manifests
    roots = list(_extra_roots)
    for proj in manifests.all_projects().values():
        for area in proj.get("content", {}).get("areas", {}).values():
            roots.append(area["abs_dir"])
    return roots


def resolve_safe(path: str) -> str | None:
    """Return the realpath if it sits under an allowed root, else None."""
    if not path:
        return None
    real = os.path.realpath(os.path.expanduser(path))
    for base in allowed_roots():
        if real == base or real.startswith(base + os.sep):
            return real
    return None
