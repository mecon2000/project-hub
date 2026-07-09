"""Manifest action -> validated argv (generalizes batch-runner's build_command)."""
import os

from hub import safepath
from hub.config import PYTHON


class ActionError(ValueError):
    pass


def _validate_param(name: str, spec: dict, value):
    ptype = spec.get("type", "str")
    if ptype in ("float", "int"):
        try:
            value = float(value) if ptype == "float" else int(value)
        except (TypeError, ValueError):
            raise ActionError(f"param {name}: not a number: {value!r}")
        if "min" in spec and value < spec["min"]:
            raise ActionError(f"param {name}: {value} < min {spec['min']}")
        if "max" in spec and value > spec["max"]:
            raise ActionError(f"param {name}: {value} > max {spec['max']}")
    elif ptype == "choice":
        if value not in spec.get("options", []):
            raise ActionError(f"param {name}: {value!r} not in {spec.get('options')}")
    return str(value)


def build_argv(project: dict, action_name: str, sources: list[str],
               params: dict, flags: list[str], out_dir: str) -> list[str]:
    action = project["actions"].get(action_name)
    if not action:
        raise ActionError(f"unknown action {action_name!r}")
    if not os.path.isfile(action["script"]):
        raise ActionError(f"script missing: {action['script']}")

    safe_sources = []
    for s in sources:
        real = safepath.resolve_safe(s)
        if not real:
            raise ActionError(f"source outside allowed roots: {s}")
        safe_sources.append(real)

    argv = [os.path.expanduser(action.get("interpreter", PYTHON)), action["script"]]
    if safe_sources:
        argv.append(action.get("source_arg", "--source"))
        argv.extend(safe_sources)

    declared = action.get("params", {})
    for name, value in (params or {}).items():
        spec = declared.get(name)
        if spec is None:
            raise ActionError(f"undeclared param {name!r}")
        val = _validate_param(name, spec, value)
        argv.extend([spec.get("flag", f"--{name}"), val])

    declared_flags = set(action.get("flags", {}))
    for fl in flags or []:
        if fl not in declared_flags:
            raise ActionError(f"undeclared flag {fl!r}")
        argv.append(fl)

    if action.get("output_dir_arg"):
        argv.extend([action["output_dir_arg"], out_dir])
    return argv
