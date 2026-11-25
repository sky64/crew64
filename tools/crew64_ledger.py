#!/usr/bin/env python3
"""crew64 ledger: the log crew64-map reads (decision 0010).

The orchestrator records one event per step of a plan's task; crew64-map folds
the log into one row per task. Writing happens only when features.build_map is
on for a trusted repository, so the orchestrator calls `record` at every step
without checking the switch itself.

Usage:
    python3 -I tools/crew64_ledger.py record --plan <path> --task <n> --event <name> [--field key=value ...]
    python3 -I tools/crew64_ledger.py show [--plan <path>] [--json]
    python3 -I tools/crew64_ledger.py path

Log: $CREW64_STATE_DIR, else $XDG_STATE_HOME/crew64, else ~/.local/state/crew64;
then <main checkout basename>-<first 12 hex of sha256(realpath)>; then one
<plan basename>.jsonl per plan, one JSON object per line, append-only. The same
directory holds repo.json, the repository's effective settings as
crew64_config.py resolved them, so the panel never reads .claude/crew64.json.
"""

import argparse
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import crew64_config  # noqa: E402  tools/crew64_config.py, the single config reader

LOG_VERSION = 1
LEDGER_VERSION = "1"
EVENTS = (
    "planned", "dispatched", "native_started", "review", "escalated",
    "committed", "pr_opened", "merged", "abandoned",
)
# Fields an event sets on its task; later events overwrite earlier ones.
SETS = {
    "planned": ("title", "tier", "rung", "mode", "vendor", "model", "deps"),
    "dispatched": ("worktree", "branch", "dispatch", "agent", "model"),
    "native_started": ("worktree", "branch", "model"),
    "pr_opened": ("pr", "pr_url"),
}
# Known fields and their types: a string field keeps its text as given (a title
# "5" stays "5"), an integer field must be an integer, deps a list of task
# numbers. Unknown fields parse as JSON when they parse, else as strings.
STR_FIELDS = (
    "title", "tier", "mode", "vendor", "model", "worktree", "branch", "dispatch", "agent",
    "pr_url", "sha", "verdict", "reason", "token_source", "plan_branch", "plan_commit",
)
INT_FIELDS = ("rung", "pr", "cycle", "tokens_in", "tokens_out")
INT_TEXT = re.compile(r"-?[0-9]+")
GITHUB_URL = re.compile(r"(?:github\.com[:/])([^/\s]+)/([^/\s]+?)(?:\.git)?/?$")


class LedgerError(Exception):
    """A refusal that must stop the command with a message (exit 1)."""


def state_root(env=None) -> Path:
    env = os.environ if env is None else env
    if env.get("CREW64_STATE_DIR"):
        return Path(env["CREW64_STATE_DIR"])
    if env.get("XDG_STATE_HOME"):
        return Path(env["XDG_STATE_HOME"]) / "crew64"
    return Path.home() / ".local" / "state" / "crew64"


def repo_dir(root: str, env=None) -> Path:
    real = os.path.realpath(root)
    digest = hashlib.sha256(real.encode()).hexdigest()[:12]
    return state_root(env) / f"{os.path.basename(real)}-{digest}"


def plan_log(directory: Path, plan: str) -> Path:
    return directory / f"{Path(plan).stem}.jsonl"


def _no_symlink(path: Path) -> None:
    if path.is_symlink():
        raise LedgerError(f"{path} is a symlink; refusing to write through it")


def _ensure_dir(directory: Path) -> None:
    _no_symlink(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    _no_symlink(directory)


def github_name(root: str):
    try:
        url = subprocess.run(
            ["git", "-C", root, "remote", "get-url", "origin"],
            capture_output=True, text=True, check=False, timeout=5,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    match = GITHUB_URL.search(url)
    return f"{match.group(1)}/{match.group(2)}" if match else None


def repo_settings(root: str, cfg) -> dict:
    return {
        "v": 1,
        "build_map": crew64_config.feature(cfg, "build_map") is True,
        "review_cycles": crew64_config.limit(cfg, "review_cycles"),
        "this_host": crew64_config.this_host(cfg),
        "repo_root": os.path.realpath(root),
        "github": github_name(root),
        "ledger_version": LEDGER_VERSION,
    }


def _write_repo_json(directory: Path, settings: dict) -> None:
    target = directory / "repo.json"
    _no_symlink(target)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".repo.", suffix=".tmp")
    with os.fdopen(fd, "w") as fh:
        fh.write(json.dumps(settings, indent=2) + "\n")
    os.replace(tmp, target)


def _parse_value(text: str):
    try:
        return json.loads(text)
    except ValueError:
        return text


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _field_ok(key: str, value) -> bool:
    if key in STR_FIELDS:
        return isinstance(value, str)
    if key in INT_FIELDS:
        return _is_int(value)
    if key == "deps":
        return isinstance(value, list) and all(_is_int(n) for n in value)
    return True


def parse_fields(pairs) -> dict:
    fields = {}
    for pair in pairs or []:
        key, sep, text = pair.partition("=")
        if not sep or not key:
            raise ValueError(f"--field needs key=value, got {pair!r}")
        if key in ("v", "ts", "plan", "task", "event"):
            raise ValueError(f"--field cannot set the reserved key {key!r}")
        if key in STR_FIELDS:
            value = text
        elif key in INT_FIELDS:
            if not INT_TEXT.fullmatch(text):
                raise ValueError(f"--field {key} must be an integer, got {text!r}")
            value = int(text)
        else:
            value = _parse_value(text)
        if not _field_ok(key, value):
            raise ValueError(f"--field {key} must be a list of task numbers, got {text!r}")
        fields[key] = value
    return fields


def append_event(path: Path, event: dict) -> None:
    """Append one line under an exclusive lock. A short write (disk full, file
    size limit) is cut back to the size before the append and reported, so a
    partial line never survives to swallow the next event (Codex, task 2)."""
    _no_symlink(path)
    line = (json.dumps(event, separators=(",", ":")) + "\n").encode()
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        before = os.fstat(fd).st_size
        try:
            written = os.write(fd, line)
        except OSError:
            written = -1
        if written != len(line):
            os.ftruncate(fd, before)
            raise LedgerError(f"short write to {path} ({written} of {len(line)} bytes); event not recorded")
    finally:
        os.close(fd)


def record(cwd: str, plan: str, task: int, event: str, fields: dict) -> bool:
    """Append one event; False when the switch is off (nothing written)."""
    root = crew64_config.trusted_root(cwd)
    cfg = crew64_config.load_config(root)
    if not root or crew64_config.feature(cfg, "build_map") is not True:
        return False
    directory = repo_dir(root)
    _ensure_dir(directory)
    entry = {"v": LOG_VERSION, "ts": datetime.now(timezone.utc).isoformat(timespec="microseconds"),
             "plan": plan, "task": task, "event": event}
    entry.update(fields)
    append_event(plan_log(directory, plan), entry)
    _write_repo_json(directory, repo_settings(root, cfg))
    return True


def _new_task(n: int) -> dict:
    return {
        "task": n, "title": None, "tier": None, "rung": None, "mode": None, "model": None, "model_source": None,
        "worktree": None, "branch": None, "dispatch": None, "reviews": 0, "escalations": 0,
        "tokens_in": None, "tokens_out": None, "pr": None, "pr_url": None,
        "merged": False, "abandoned": False, "last_event": None, "last_ts": None,
    }


def _apply(task: dict, ev: dict) -> None:
    kind = ev["event"]
    for key in SETS.get(kind, ()):
        if key in ev and key in task:
            task[key] = ev[key]
    # Where the model came from: "planned" (the plan's intent) or "launch" (a
    # dispatched or native_started event named it). Only "launch" is a fact.
    if "model" in ev:
        if kind == "planned":
            task["model_source"] = "planned"
        elif kind in ("dispatched", "native_started"):
            task["model_source"] = "launch"
    if kind == "review":
        task["reviews"] += 1
    elif kind == "escalated":
        task["escalations"] += 1
    elif kind == "committed":
        for key in ("tokens_in", "tokens_out"):
            if isinstance(ev.get(key), int):
                task[key] = (task[key] or 0) + ev[key]
    elif kind == "merged":
        task["merged"] = True
    elif kind == "abandoned":
        task["abandoned"] = True
    task["last_event"] = kind
    task["last_ts"] = ev.get("ts")


def _valid(ev) -> bool:
    if not isinstance(ev, dict):
        return False
    if ev.get("v") != LOG_VERSION or not isinstance(ev.get("ts"), str) or not isinstance(ev.get("plan"), str):
        return False
    if not _is_int(ev.get("task")) or ev.get("event") not in EVENTS:
        return False
    return all(_field_ok(key, value) for key, value in ev.items())


def fold_file(path: Path):
    """(plan path, tasks sorted by number, last ts, skipped line count)."""
    tasks, plan, last_ts, skipped = {}, None, "", 0
    with open(path, "rb") as fh:
        for raw in fh:
            try:
                ev = json.loads(raw)
            except ValueError:
                skipped += 1
                continue
            if not _valid(ev):
                skipped += 1
                continue
            plan = ev["plan"]
            task = tasks.setdefault(ev["task"], _new_task(ev["task"]))
            _apply(task, ev)
            last_ts = max(last_ts, str(ev.get("ts", "")))
    return plan, [tasks[n] for n in sorted(tasks)], last_ts, skipped


def show(cwd: str, plan_filter=None) -> dict:
    root = crew64_config.trusted_root(cwd) or crew64_config.candidate_root(cwd)
    result = {"repo": None, "plans": [], "skipped_lines": 0}
    if not root:
        return result
    directory = repo_dir(root)
    if (directory / "repo.json").is_file():
        try:
            result["repo"] = json.loads((directory / "repo.json").read_text())
        except ValueError:
            result["repo"] = None
    if not directory.is_dir():
        return result
    for log in directory.glob("*.jsonl"):
        plan, tasks, last_ts, skipped = fold_file(log)
        result["skipped_lines"] += skipped
        if plan is None or (plan_filter and plan != plan_filter):
            continue
        result["plans"].append({"plan": plan, "last_ts": last_ts, "tasks": tasks})
    result["plans"].sort(key=lambda p: p["last_ts"], reverse=True)
    return result


def _cell(value) -> str:
    return "—" if value is None else str(value)


def format_text(data: dict) -> str:
    lines = []
    for plan in data["plans"]:
        lines.append(f"{plan['plan']}  (last {plan['last_ts']})")
        for t in plan["tasks"]:
            state = "merged" if t["merged"] else "abandoned" if t["abandoned"] else t["last_event"]
            tokens = "—" if t["tokens_in"] is None else f"{t['tokens_in']}/{t['tokens_out'] or 0}"
            lines.append(
                f"  {t['task']:>2} {_cell(t['title'])[:40]:<40} {_cell(t['tier']):<8} r{_cell(t['rung'])} "
                f"{_cell(t['model'])[:20]:<20} reviews {t['reviews']} esc {t['escalations']} tokens {tokens} {state}"
            )
    if data["skipped_lines"]:
        lines.append(f"skipped {data['skipped_lines']} unreadable line(s)")
    return "\n".join(lines) if lines else "no crew64 ledger for this repository"


def cli(argv) -> int:
    parser = argparse.ArgumentParser(prog="crew64_ledger.py")
    sub = parser.add_subparsers(dest="cmd", required=True)
    rec = sub.add_parser("record")
    rec.add_argument("--plan", required=True)
    rec.add_argument("--task", required=True, type=int)
    rec.add_argument("--event", required=True, choices=EVENTS)
    rec.add_argument("--field", action="append")
    sh = sub.add_parser("show")
    sh.add_argument("--plan")
    sh.add_argument("--json", action="store_true")
    sub.add_parser("path")
    args = parser.parse_args(argv)
    cwd = os.getcwd()
    try:
        if args.cmd == "record":
            try:
                fields = parse_fields(args.field)
            except ValueError as err:
                parser.error(str(err))
            record(cwd, args.plan, args.task, args.event, fields)
            return 0
        if args.cmd == "show":
            data = show(cwd, args.plan)
            print(json.dumps(data, indent=2) if args.json else format_text(data))
            return 0
        root = crew64_config.trusted_root(cwd) or crew64_config.candidate_root(cwd)
        if not root:
            print("crew64_ledger: not inside a git repository", file=sys.stderr)
            return 1
        print(repo_dir(root))
        return 0
    except (LedgerError, OSError) as err:
        print(f"crew64_ledger: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(cli(sys.argv[1:]))
