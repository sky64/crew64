#!/usr/bin/env python3
"""Token ledger from the agent session logs already on disk (issue #36, slice 1).

    python3 -I tools/token_ledger.py [options]

Standard library only. Read-only: every log is opened for reading, nothing is
cached or written beside it. No message body, prompt or tool input is ever
printed; only counts, ids, paths and model names.
"""
import argparse
import collections
import dataclasses
import datetime as dt
import itertools
import json
import os
import re
import shlex
import shutil
import statistics
import subprocess
import sys

try:  # Python 3.14+; on 3.13 the zstd CLI is used instead.
    from compression import zstd as _pyzstd
except ImportError:
    _pyzstd = None

KINDS = ("input", "cache_read", "cache_creation", "output")
ROLES = ("orchestrator", "worker", "other")
AGENTS = ("claude", "codex", "dsh")
ORCA_PROGRAMS = frozenset({"orca", "orca-ide", "orca-dev"})
LAUNCH_WORDS = ["orchestration", "worker-start"]
LAUNCH_HINT = "worker"  # cheap pre-check; every launch command contains it
HELP_FLAG = "--help"
SHELL_OPERATOR_CHARS = "();<>|&\n"
SHELL_WHITESPACE = " \t\r"
SHELLS = frozenset({"bash", "sh", "zsh"})
SHELL_SCRIPT_FLAGS = frozenset({"-c", "-lc"})
HEREDOC = re.compile(r"(?<!<)<<(?!<)(-?)[ \t]*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\2")
ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=")
ORCA_LINE = "You are working inside Orca"
WORKER_LINE = "You are a dispatched worker"
ORCA_LINE_MAX_OFFSET = 120  # a real dispatch prompt opens with the Orca line
WORKER_LINE_MAX_GAP = 100
SYNTHETIC_MODEL = "<synthetic>"
DSH_FILE = "session.v4.jsonl.zstd"
COST_LABEL = "Claude Code estimate, not a bill"
MTIME_MARGIN_SECONDS = 86400
ORCA_TIMEOUT_SECONDS = 60
UNKNOWN = "(unknown)"
PCT_DIGITS = 1

EPILOG = """\
Roles (first rule that holds): orchestrator = the session executed an Orca
launch (rule below); worker = a user turn is an Orca dispatch prompt
(it opens with "You are working inside Orca" and says "You are a dispatched
worker" within the first lines; a prompt that only quotes the phrase later in
other text does not count); other. A subagent file takes the role and task of
its parent session. task = last path component of the session cwd.

Launch rule: only shell tool calls are read (Claude: tool_use "Bash",
input.command; Codex: event_msg item_completed with item type
"CommandExecution", command [bash, -lc, script]; dsh: tool/call "bash",
arguments.command). Here-document bodies are dropped, backslash-newline is
joined, and the script is split quote-aware (shlex) into simple commands at
shell operators and newlines; words from one starting with "#" are a comment.
A simple command is a launch when, after any VAR=value words, its program is
orca, orca-ide or orca-dev by basename, its next words are "orchestration
worker-start", and it has no --help. Text in other tools' arguments or in a
quoted argument of another program is not a launch, and neither is a command
that cannot be tokenized.

Date range (UTC days, both ends inclusive):
  Claude and dsh are filtered per call, by the call's own timestamp.
  Codex is filtered per session, by the day the session started, because its
  token counts are cumulative per session and cannot be split by day.

Claude Code: one line is written per content block with the same usage, so each
message.id is counted once (highest output_tokens; across all files, so a
resumed session does not repeat it). <synthetic> calls are skipped. Context of
a call = input + cache read + cache creation. Cost figures are Claude Code's
own estimate, not a bill. Wall time = last minus first counted call.

Codex: token_count carries cumulative totals. Each one is mapped as below and
its growth over the previous one is credited to the model of the latest
turn_context, so a session that switches model gets one row per model and
those rows add up to the mapping of the last cumulative record. A mapped
counter that goes down (not seen in the logs checked) adds nothing for that
kind and is counted in meta counter_decreases. In Codex,
input_tokens includes cached_input_tokens (total_tokens = input + output), so:
input = input_tokens - cached_input_tokens - cache_write_input_tokens (never
below 0), cache_read = cached_input_tokens, cache_creation =
cache_write_input_tokens (never non-zero in the logs checked; whether it is
inside input_tokens is unverified), output = output_tokens (it includes
reasoning tokens). Calls = token_count events whose cumulative total changed.
Wall time = first to last record. review_passes = dispatch prompts received.

dsh: zstd-compressed JSONL, read with compression.zstd when it imports (Python
3.14+), else with "zstd -dc" (no shell); with neither, dsh logs are skipped and
that is said on stderr and in the meta counts. Usage is read from the
assistant/message data only; the repeated usage inside stream chunks is
ignored. input = inputTokens, cache_read = cacheReadTokens, cache_creation =
cacheWriteTokens, output = outputTokens.

Orca (optional): run-list, worker-list, task-list and worktree list are called
with --environment local; a worker's workspace id is resolved to a worktree
path through the worktree list and matched to the cwd of the rows.

--format json carries the keys rows, summary and query.
"""


# ---- small helpers --------------------------------------------------------

def parse_day(text):
    try:
        return dt.date.fromisoformat(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a YYYY-MM-DD date: {text!r}")


def parse_ts(value):
    if not isinstance(value, str):
        return None
    try:
        ts = dt.datetime.fromisoformat(value)
    except ValueError:
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=dt.timezone.utc)


def ms_to_ts(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        return dt.datetime.fromtimestamp(value / 1000, dt.timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def as_int(value):
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def in_range(ts, since, until):
    if ts is None:
        return since is None and until is None
    day = ts.astimezone(dt.timezone.utc).date()
    return (since is None or day >= since) and (until is None or day <= until)


def is_dispatch_prompt(text):
    start = text.find(ORCA_LINE)
    if start < 0 or start > ORCA_LINE_MAX_OFFSET:
        return False
    gap = text.find(WORKER_LINE, start) - start
    return 0 <= gap <= WORKER_LINE_MAX_GAP


def text_parts(content):
    """Yield the text strings of a message content (a string or a block list)."""
    if isinstance(content, str):
        yield content
        return
    for block in content if isinstance(content, list) else ():
        if isinstance(block, dict) and block.get("type") == "text" \
                and isinstance(block.get("text"), str):
            yield block["text"]


def strip_heredocs(script):
    """Drop here-document bodies: their lines are input data, not commands."""
    lines, kept, i = script.split("\n"), [], 0
    while i < len(lines):
        line = lines[i]
        kept.append(line)
        i += 1
        found = HEREDOC.search(line)
        if found is None:
            continue
        tabs, end = found.group(1), found.group(3)
        while i < len(lines) and (lines[i].lstrip("\t") if tabs else lines[i]) != end:
            i += 1
        i += 1  # the delimiter line
    return "\n".join(kept)


def simple_commands(script):
    """Split a shell script into the word lists of its simple commands.

    Raises ValueError when the script cannot be tokenized (an unbalanced quote).
    """
    lexer = shlex.shlex(strip_heredocs(script).replace("\\\n", " "), posix=True,
                        punctuation_chars=SHELL_OPERATOR_CHARS)
    lexer.whitespace = SHELL_WHITESPACE
    lexer.whitespace_split = True
    lexer.commenters = ""
    commands, words = [], []
    for token in list(lexer):
        if token and all(ch in SHELL_OPERATOR_CHARS for ch in token):
            commands.append(words)
            words = []
        else:
            words.append(token)
    commands.append(words)
    return [w for w in commands if w]


def is_launch(words):
    words = list(itertools.takewhile(lambda w: not w.startswith("#"), words))
    start = next((i for i, w in enumerate(words) if not ASSIGNMENT.match(w)), len(words))
    program, rest = words[start:start + 1], words[start + 1:]
    return bool(program) and os.path.basename(program[0]) in ORCA_PROGRAMS \
        and rest[:len(LAUNCH_WORDS)] == LAUNCH_WORDS and HELP_FLAG not in rest


def runs_launch(script):
    """True when a shell command string executes an Orca worker launch."""
    if not isinstance(script, str) or LAUNCH_HINT not in script:
        return False
    try:
        commands = simple_commands(script)
    except ValueError:
        return False
    return any(is_launch(words) for words in commands)


def task_of(cwd):
    return os.path.basename(cwd.rstrip("/")) if cwd else UNKNOWN


# ---- data model -----------------------------------------------------------

@dataclasses.dataclass(slots=True)
class Call:
    session: str
    model: str
    tokens: tuple  # input, cache_read, cache_creation, output
    ts: dt.datetime | None
    n: int = 1
    own: bool = True  # recorded in the session file that owns its session id


@dataclasses.dataclass
class Session:
    key: str
    sid: str
    agent: str
    cwd: str = ""
    spawned: bool = False
    dispatches: int = 0
    prs: set = dataclasses.field(default_factory=set)
    efforts: set = dataclasses.field(default_factory=set)
    cost_usd: float | None = None
    first: dt.datetime | None = None
    last: dt.datetime | None = None

    @property
    def role(self):
        if self.spawned:
            return "orchestrator"
        return "worker" if self.dispatches else "other"

    def touch(self, ts):
        if ts is None:
            return
        self.first = ts if self.first is None or ts < self.first else self.first
        self.last = ts if self.last is None or ts > self.last else self.last

    def note_cwd(self, rec):
        cwd = rec.get("cwd")
        if not self.cwd and isinstance(cwd, str):
            self.cwd = cwd


def new_meta():
    return {agent: {"files_read": 0, "files_skipped": 0, "lines_skipped": 0,
                    "files_truncated": 0, "files_out_of_range": 0, "roots_missing": 0}
            for agent in AGENTS}


class Store:
    def __init__(self):
        self.sessions = {}
        self.claude_calls = {}
        self.other_calls = []
        self.meta = new_meta()
        self._anon = itertools.count()

    def session(self, key, sid, agent):
        if key not in self.sessions:
            self.sessions[key] = Session(key, sid, agent)
        return self.sessions[key]

    def offer_claude(self, msg_id, call):
        """Keep one record per message.id: the highest output, own file on a tie."""
        key = msg_id or ("anon", next(self._anon))
        best = self.claude_calls.get(key)
        if best is not None:
            new_out, old_out = call.tokens[3], best.tokens[3]
            if new_out < old_out or (new_out == old_out and not (call.own and not best.own)):
                return
        self.claude_calls[key] = call


# ---- reading --------------------------------------------------------------

class DecodeError(Exception):
    pass


READ_ERRORS = (OSError, EOFError, DecodeError) + \
    ((_pyzstd.ZstdError,) if _pyzstd is not None else ())


def plain_lines(path):
    with open(path, "rb") as handle:
        yield from handle


def pyzstd_lines(path):
    with _pyzstd.open(path, "rb") as handle:
        yield from handle


def cli_lines(path):
    exe = shutil.which("zstd")
    if exe is None:
        raise DecodeError("zstd not found")
    proc = subprocess.Popen([exe, "-dc", "--", path], stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL)
    try:
        yield from proc.stdout
    finally:
        proc.stdout.close()
        code = proc.wait()
    if code:
        raise DecodeError(f"zstd exited {code}")


def zstd_decoder_name():
    if _pyzstd is not None:
        return "compression.zstd"
    return "zstd-cli" if shutil.which("zstd") else "none"


def zstd_lines(path):
    return pyzstd_lines(path) if _pyzstd is not None else cli_lines(path)


def iter_records(lines, meta):
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            meta["lines_skipped"] += 1
            continue
        if isinstance(rec, dict):
            yield rec
        else:
            meta["lines_skipped"] += 1


def read_file(path, meta, handler, opener=plain_lines):
    """Feed every record of one file to handler; count the file, never raise."""
    seen = 0
    try:
        for rec in iter_records(opener(path), meta):
            seen += 1
            handler(rec)
    except READ_ERRORS as exc:
        if seen == 0:
            meta["files_skipped"] += 1
            reason = getattr(exc, "strerror", None) or type(exc).__name__
            print(f"skipped unreadable file: {path}: {reason}", file=sys.stderr)
            return
        meta["files_truncated"] += 1
    meta["files_read"] += 1


def may_hold_range(path, since, meta):
    """A file last written before the range starts cannot hold a call inside it."""
    if since is None:
        return True
    try:
        mtime = os.stat(path).st_mtime
    except OSError:
        return True
    start = dt.datetime.combine(since, dt.time(), dt.timezone.utc).timestamp()
    if mtime >= start - MTIME_MARGIN_SECONDS:
        return True
    meta["files_out_of_range"] += 1
    return False


def walk_files(root, accept):
    for base, dirs, files in os.walk(root):
        dirs.sort()
        for name in sorted(files):
            path = os.path.join(base, name)
            if accept(path):
                yield path


def usable_root(root, label, meta):
    if os.path.isdir(root):
        return True
    meta["roots_missing"] += 1
    print(f"{label} root not found, skipped: {root}", file=sys.stderr)
    return False


# ---- Claude Code ----------------------------------------------------------

def claude_layout(root, path):
    """Return (session key, session id) for a transcript or subagent file, or None."""
    parts = os.path.relpath(path, root).split(os.sep)
    if len(parts) == 2 and parts[1].endswith(".jsonl"):
        sid = parts[1][:-len(".jsonl")]
    elif len(parts) == 4 and parts[2] == "subagents" and parts[3].endswith(".jsonl"):
        sid = parts[1]
    else:
        return None
    return f"claude:{parts[0]}/{sid}", sid


def claude_usage(msg):
    usage = msg["usage"]
    return (as_int(usage.get("input_tokens")), as_int(usage.get("cache_read_input_tokens")),
            as_int(usage.get("cache_creation_input_tokens")), as_int(usage.get("output_tokens")))


def claude_assistant(rec, sess, store, sid):
    msg = rec.get("message")
    if not isinstance(msg, dict):
        return
    content = msg.get("content")
    for block in content if isinstance(content, list) else ():
        if isinstance(block, dict) and block.get("type") == "tool_use" \
                and block.get("name") == "Bash" and isinstance(block.get("input"), dict) \
                and runs_launch(block["input"].get("command")):
            sess.spawned = True
    model = msg.get("model") if isinstance(msg.get("model"), str) else "unknown"
    if model == SYNTHETIC_MODEL or not isinstance(msg.get("usage"), dict):
        return
    call = Call(sess.key, model, claude_usage(msg), parse_ts(rec.get("timestamp")),
                own=rec.get("sessionId") == sid)
    store.offer_claude(msg.get("id") or rec.get("uuid"), call)


def claude_record(rec, sess, store, sid):
    sess.note_cwd(rec)
    kind = rec.get("type")
    if kind == "assistant":
        claude_assistant(rec, sess, store, sid)
    elif kind == "user":
        message = rec.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        sess.dispatches += sum(is_dispatch_prompt(t) for t in text_parts(content))
    elif kind == "cost-state":
        total = rec.get("totalCostUSD")
        if isinstance(total, (int, float)) and not isinstance(total, bool):
            sess.cost_usd = total if sess.cost_usd is None else max(sess.cost_usd, total)
    elif kind == "pr-link":
        repo, number = rec.get("prRepository"), rec.get("prNumber")
        if isinstance(repo, str) and isinstance(number, int):
            sess.prs.add((repo, number))


def scan_claude(root, store, since):
    meta = store.meta["claude"]
    if not usable_root(root, "claude", meta):
        return
    for path in walk_files(root, lambda p: p.endswith(".jsonl")):
        layout = claude_layout(root, path)
        if layout is None or not may_hold_range(path, since, meta):
            continue
        key, sid = layout
        sess = store.session(key, sid, "claude")
        read_file(path, meta, lambda rec: claude_record(rec, sess, store, sid))


# ---- Codex ----------------------------------------------------------------

def codex_tokens(usage):
    total_in, cached = as_int(usage.get("input_tokens")), as_int(usage.get("cached_input_tokens"))
    written = as_int(usage.get("cache_write_input_tokens"))
    return (max(0, total_in - cached - written), cached, written, as_int(usage.get("output_tokens")))


def codex_launch(item):
    """True for a CommandExecution item whose [shell, -lc, script] runs a launch."""
    if not isinstance(item, dict) or item.get("type") != "CommandExecution":
        return False
    command = item.get("command")
    if not (isinstance(command, list) and len(command) == 3
            and all(isinstance(word, str) for word in command)):
        return False
    shell, flag, script = command
    return os.path.basename(shell) in SHELLS and flag in SHELL_SCRIPT_FLAGS and runs_launch(script)


class CodexState:
    def __init__(self, sess, meta):
        self.sess = sess
        self.meta = meta
        self.model = "unknown"
        self.models = {}  # model -> {"tokens": tuple of KINDS, "calls": int}
        self.last = (0,) * len(KINDS)
        self.last_total = None
        self.start = None

    def handle(self, rec):
        ts = parse_ts(rec.get("timestamp"))
        self.sess.touch(ts)
        payload = rec.get("payload") if isinstance(rec.get("payload"), dict) else {}
        kind = rec.get("type")
        if kind == "session_meta":
            self.sess.note_cwd(payload)
            self.start = parse_ts(payload.get("timestamp")) or ts
        elif kind == "turn_context":
            self.turn_context(payload)
        elif kind == "response_item":
            self.response_item(payload)
        elif kind == "event_msg" and payload.get("type") == "token_count":
            self.token_count(payload.get("info"))
        elif kind == "event_msg" and payload.get("type") == "item_completed" \
                and codex_launch(payload.get("item")):
            self.sess.spawned = True

    def turn_context(self, payload):
        if isinstance(payload.get("model"), str):
            self.model = payload["model"]
        effort = payload.get("effort") or payload.get("reasoning_effort")
        if isinstance(effort, str):
            self.sess.efforts.add(effort)

    def response_item(self, payload):
        if payload.get("type") == "message" and payload.get("role") == "user":
            self.sess.dispatches += sum(is_dispatch_prompt(t) for t in codex_texts(payload))

    def token_count(self, info):
        """Credit the growth of the cumulative counts to the model now active."""
        usage = info.get("total_token_usage") if isinstance(info, dict) else None
        if not isinstance(usage, dict):
            return
        total, current = as_int(usage.get("total_tokens")), codex_tokens(usage)
        if any(now < before for now, before in zip(current, self.last)):
            self.meta["counter_decreases"] += 1
        delta = tuple(max(0, now - before) for now, before in zip(current, self.last))
        new_call = total != self.last_total
        self.last, self.last_total = current, total
        if not new_call and not any(delta):
            return
        agg = self.models.get(self.model, {"tokens": (0,) * len(KINDS), "calls": 0})
        self.models[self.model] = {"tokens": tuple(a + b for a, b in zip(agg["tokens"], delta)),
                                   "calls": agg["calls"] + new_call}


def codex_texts(payload):
    for block in payload.get("content") if isinstance(payload.get("content"), list) else ():
        if isinstance(block, dict) and isinstance(block.get("text"), str):
            yield block["text"]


def finish_codex(state, store):
    """One call record per model; all carry the session start (Codex is filtered per session)."""
    ts = state.start or state.sess.first
    for model, agg in state.models.items():
        store.other_calls.append(Call(state.sess.key, model, agg["tokens"], ts, n=agg["calls"]))


def scan_codex(roots, store, since):
    meta = store.meta["codex"]
    meta.update(counter_decreases=0)
    for root in roots:
        if not usable_root(root, "codex", meta):
            continue
        for path in walk_files(root, lambda p: p.endswith(".jsonl")):
            if not may_hold_range(path, since, meta):
                continue
            sess = store.session(f"codex:{path}", os.path.basename(path)[:-len(".jsonl")], "codex")
            state = CodexState(sess, meta)
            read_file(path, meta, state.handle)
            finish_codex(state, store)


# ---- dsh ------------------------------------------------------------------

def dsh_tokens(usage):
    return (as_int(usage.get("inputTokens")), as_int(usage.get("cacheReadTokens")),
            as_int(usage.get("cacheWriteTokens")), as_int(usage.get("outputTokens")))


def dsh_record(rec, sess, store):
    sess.touch(ms_to_ts(rec.get("time")))
    kind = rec.get("type")
    data = rec.get("data") if isinstance(rec.get("data"), dict) else {}
    if kind == "session":
        sess.note_cwd(rec)
        sess.touch(ms_to_ts(rec.get("createdAt")))
    elif kind == "user/message":
        sess.dispatches += sum(is_dispatch_prompt(t) for t in codex_texts(data))
    elif kind == "tool/call" and runs_launch(dsh_command(data)):
        sess.spawned = True
    elif kind == "assistant/message":
        dsh_call(rec, data, sess, store)  # never descends into data["stream"]


def dsh_command(data):
    """The command of a dsh "bash" tool call; its arguments are a JSON string."""
    if data.get("name") != "bash":
        return None
    args = data.get("arguments")
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except ValueError:
            return None
    return args.get("command") if isinstance(args, dict) else None


def dsh_call(rec, data, sess, store):
    usage = data.get("usage")
    if not isinstance(usage, dict):
        return
    message = data.get("message") if isinstance(data.get("message"), dict) else {}
    source = message.get("source") if isinstance(message.get("source"), dict) else {}
    model = source.get("model") if isinstance(source.get("model"), str) else "unknown"
    ts = ms_to_ts(rec.get("time")) or sess.first
    store.other_calls.append(Call(sess.key, model, dsh_tokens(usage), ts))


def scan_dsh(root, store, since):
    meta = store.meta["dsh"]
    decoder = zstd_decoder_name()
    meta.update(decoder=decoder, files_skipped_no_zstd=0)
    if not usable_root(root, "dsh", meta):
        return
    for path in walk_files(root, lambda p: os.path.basename(p) == DSH_FILE):
        if decoder == "none":
            meta["files_skipped_no_zstd"] += 1
            continue
        if not may_hold_range(path, since, meta):
            continue
        sess = store.session(f"dsh:{path}", os.path.basename(os.path.dirname(path)), "dsh")
        read_file(path, meta, lambda rec: dsh_record(rec, sess, store), zstd_lines)
    if meta["files_skipped_no_zstd"]:
        print(f"neither compression.zstd nor the zstd command is available: "
              f"{meta['files_skipped_no_zstd']} dsh log(s) skipped", file=sys.stderr)


# ---- ledger rows ----------------------------------------------------------

@dataclasses.dataclass
class Row:
    task: str
    role: str
    agent: str
    model: str
    session: str | None
    tokens: list = dataclasses.field(default_factory=lambda: [0, 0, 0, 0])
    calls: int = 0
    wall: float = 0.0
    review_passes: int = 0
    cwds: set = dataclasses.field(default_factory=set)
    sessions: set = dataclasses.field(default_factory=set)
    prs: set = dataclasses.field(default_factory=set)
    efforts: set = dataclasses.field(default_factory=set)
    contexts: list = dataclasses.field(default_factory=list)
    orca: list = dataclasses.field(default_factory=list)


def calls_in_range(store, since, until):
    grouped = collections.defaultdict(list)
    for call in itertools.chain(store.claude_calls.values(), store.other_calls):
        if in_range(call.ts, since, until):
            grouped[call.session].append(call)
    return grouped


def session_wall(sess, calls):
    stamps = [c.ts for c in calls if c.ts is not None] if sess.agent == "claude" \
        else [t for t in (sess.first, sess.last) if t is not None]
    return (max(stamps) - min(stamps)).total_seconds() if stamps else 0.0


def per_model(calls):
    models = {}
    for call in calls:
        agg = models.setdefault(call.model, {"tokens": [0, 0, 0, 0], "n": 0, "contexts": []})
        agg["tokens"] = [a + b for a, b in zip(agg["tokens"], call.tokens)]
        agg["n"] += call.n
        if call.n == 1 and call.session.startswith("claude:"):
            agg["contexts"].append(sum(call.tokens[:3]))
    return models


def add_session(rows, sess, calls, by_session):
    models = per_model(calls)
    primary = min(models, key=lambda m: (-models[m]["n"], m))
    for model, agg in models.items():
        key = (sess.key if by_session else "", task_of(sess.cwd), sess.role, sess.agent, model)
        row = rows.setdefault(key, Row(key[1], sess.role, sess.agent, model,
                                       sess.sid if by_session else None))
        row.tokens = [a + b for a, b in zip(row.tokens, agg["tokens"])]
        row.calls += agg["n"]
        row.contexts += agg["contexts"]
        row.sessions.add(sess.key)
        if sess.cwd:
            row.cwds.add(sess.cwd)
        if model == primary:
            row.wall += session_wall(sess, calls)
            row.review_passes += sess.dispatches if sess.agent == "codex" else 0
            row.prs |= sess.prs
            row.efforts |= sess.efforts


def build_rows(store, args):
    rows = {}
    for key, calls in calls_in_range(store, args.since, args.until).items():
        add_session(rows, store.sessions[key], calls, args.by == "session")
    wanted = set(args.task or ())
    kept = [r for r in rows.values() if not wanted or r.task in wanted]
    return sorted(kept, key=lambda r: (r.task, r.agent, ROLES.index(r.role), r.model, r.session or ""))


# ---- summary --------------------------------------------------------------

def pct_map(values):
    total = sum(values.values())
    return {role: round(values[role] * 100 / total, PCT_DIGITS) if total else 0.0 for role in ROLES}


def token_shares(rows):
    by_kind = {kind: dict.fromkeys(ROLES, 0) for kind in ("total",) + KINDS}
    for row in rows:
        for kind, value in zip(KINDS, row.tokens):
            by_kind[kind][row.role] += value
            by_kind["total"][row.role] += value
    return {kind: pct_map(values) for kind, values in by_kind.items()}


def cost_estimate(rows, store):
    usd, counted, missing = dict.fromkeys(ROLES, 0.0), 0, 0
    keys = {k for r in rows if r.agent == "claude" for k in r.sessions}
    for key in sorted(keys):
        sess = store.sessions[key]
        if sess.cost_usd is None:
            missing += 1
            continue
        usd[sess.role] += sess.cost_usd
        counted += 1
    return {"label": COST_LABEL, "usd": {k: round(v, 6) for k, v in usd.items()},
            "share_pct": pct_map(usd), "sessions_counted": counted, "sessions_without_cost": missing}


def median_contexts(rows):
    contexts = {role: [] for role in ROLES}
    for row in rows:
        contexts[row.role] += row.contexts
    return {role: (statistics.median(v) if v else None) for role, v in contexts.items()}


def build_summary(rows, store):
    claude_rows = [r for r in rows if r.agent == "claude"]
    return {"token_share_pct": {"claude": token_shares(claude_rows), "all": token_shares(rows)},
            "cost_estimate": cost_estimate(rows, store),
            "median_context_per_call": median_contexts(claude_rows),
            "meta": store.meta}


# ---- Orca overlay ---------------------------------------------------------

class OrcaError(Exception):
    pass


def orca_call(binary, args):
    cmd = [binary, *args, "--json", "--environment", "local"]
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=ORCA_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        raise OrcaError("timed out")
    if done.returncode != 0:
        raise OrcaError(f"exited {done.returncode}")
    return parse_orca_json(done.stdout)


def parse_orca_json(text):
    for candidate in (text, text[text.find("{"):text.rfind("}") + 1]):
        try:
            data = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(data, dict) and isinstance(data.get("result"), dict):
            return data["result"]
    raise OrcaError("unparseable output")


def orca_paths(binary):
    """Return {worktree path: [{run_id, task_title}]} for every worker Orca knows."""
    try:
        trees = {w["id"]: w["path"] for w in orca_call(binary, ["worktree", "list"])["worktrees"]}
        found = collections.defaultdict(list)
        for run in orca_call(binary, ["orchestration", "run-list"])["runs"]:
            rid = run["id"]
            workers = orca_call(binary, ["orchestration", "worker-list", "--run", rid])["workers"]
            tasks = orca_call(binary, ["orchestration", "task-list", "--run", rid])["tasks"]
            titles = {t["id"]: t.get("title") for t in tasks}
            for worker in workers:
                path = trees.get(worker["workspace"])
                entry = {"run_id": rid, "task_title": titles.get(worker["taskId"])}
                if path and entry not in found[path]:
                    found[path].append(entry)
        return found
    except (KeyError, TypeError, AttributeError):
        raise OrcaError("unexpected output shape")


def apply_orca(rows, paths):
    for row in rows:
        for cwd in sorted(row.cwds):
            row.orca += [e for e in paths.get(cwd, ()) if e not in row.orca]


def resolve_orca(args):
    """Return (executable or None, status text)."""
    if args.orca is False:
        return None, "disabled"
    binary = args.orca_bin or os.environ.get("ORCA_CLI_COMMAND") or "orca"
    found = shutil.which(binary)
    if found:
        return found, "used"
    if args.orca:
        print(f"orca: executable not found ({binary}); ledger printed without Orca data",
              file=sys.stderr)
    return None, "not found"


def run_orca(args, rows):
    binary, status = resolve_orca(args)
    if binary is None:
        return status
    try:
        apply_orca(rows, orca_paths(binary))
    except (OrcaError, OSError, subprocess.SubprocessError) as exc:
        print(f"orca: {exc}; ledger printed without Orca data", file=sys.stderr)
        for row in rows:
            row.orca = []
        return "failed"
    return status


# ---- output ---------------------------------------------------------------

def row_json(row, by_session):
    out = {"task": row.task, "role": row.role, "agent": row.agent, "model": row.model}
    if by_session:
        out["session"] = row.session
    out.update(cwds=sorted(row.cwds), tokens=dict(zip(KINDS, row.tokens)), calls=row.calls,
               sessions=len(row.sessions), review_passes=row.review_passes,
               wall_seconds=round(row.wall), efforts=sorted(row.efforts),
               pull_requests=[{"repository": r, "number": n} for r, n in sorted(row.prs)],
               orca=row.orca)
    return out


def render_json(rows, summary, args, orca_status):
    query = {"since": args.since and args.since.isoformat(), "until": args.until and args.until.isoformat(),
             "by": args.by, "tasks": args.task or [], "orca": orca_status}
    doc = {"rows": [row_json(r, args.by == "session") for r in rows], "summary": summary, "query": query}
    return json.dumps(doc, indent=2)


def table(headers, body):
    widths = [max(len(str(x)) for x in col) for col in zip(headers, *body)] if body else \
        [len(h) for h in headers]
    lines = ["  ".join(str(c).ljust(w) for c, w in zip(headers, widths)).rstrip()]
    lines += ["  ".join(str(c).ljust(w) for c, w in zip(r, widths)).rstrip() for r in body]
    return lines


def row_cells(row, by_session, with_orca):
    cells = [row.task, row.role, row.agent, row.model]
    cells += [row.session] if by_session else []
    cells += [f"{t:,}" for t in row.tokens] + [f"{row.calls:,}", len(row.sessions),
                                              row.review_passes, round(row.wall)]
    if with_orca:
        first = row.orca[0] if row.orca else None
        cells += [f"{first['run_id']} {first['task_title']}" if first else "-"]
    return cells


def share_line(values):
    return "  ".join(f"{role} {values[role]:.{PCT_DIGITS}f}%" for role in ROLES)


def summary_lines(summary, args):
    shares = summary["token_share_pct"]
    span = f"{args.since or 'start'} to {args.until or 'now'}"
    out = ["", f"Summary ({span}, UTC days)"]
    for name, label in (("claude", "Claude"), ("all", "all agents")):
        out.append(f"Token share, {label}:")
        out += [f"  {kind:<14} {share_line(values)}" for kind, values in shares[name].items()]
    cost = summary["cost_estimate"]
    out.append(f"Cost share, {cost['label']} ({cost['sessions_counted']} sessions, "
               f"{sum(cost['usd'].values()):.2f} USD):")
    out.append(f"  {share_line(cost['share_pct'])}")
    med = summary["median_context_per_call"]
    out.append("Median context per call, Claude (tokens): " + "  ".join(
        f"{role} {'n/a' if med[role] is None else f'{med[role]:g}'}" for role in ROLES))
    out.append("Sources:")
    for agent, meta in summary["meta"].items():
        out.append(f"  {agent}: " + ", ".join(f"{k} {v}" for k, v in meta.items()))
    return out


def render_text(rows, summary, args, orca_status):
    by_session, with_orca = args.by == "session", orca_status == "used"
    headers = ["task", "role", "agent", "model"] + (["session"] if by_session else []) + \
        list(KINDS) + ["calls", "sessions", "review_passes", "wall_s"] + (["orca"] if with_orca else [])
    lines = table(headers, [row_cells(r, by_session, with_orca) for r in rows])
    return "\n".join(lines + summary_lines(summary, args))


# ---- main -----------------------------------------------------------------

def build_parser():
    p = argparse.ArgumentParser(prog="token_ledger.py", description=__doc__.split("\n\n")[0],
                                epilog=EPILOG, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--since", type=parse_day, metavar="YYYY-MM-DD", help="first UTC day, inclusive")
    p.add_argument("--until", type=parse_day, metavar="YYYY-MM-DD", help="last UTC day, inclusive")
    p.add_argument("--claude-root", default="~/.claude/projects", metavar="DIR")
    p.add_argument("--codex-root", action="append", metavar="DIR",
                   help="repeatable; default ~/.codex/sessions and ~/.codex/archived_sessions")
    p.add_argument("--dsh-root", default="~/.dsh/sessions", metavar="DIR")
    p.add_argument("--task", action="append", metavar="NAME", help="keep only this task; repeatable")
    p.add_argument("--by", choices=("task", "session"), default="task")
    p.add_argument("--format", choices=("text", "json"), default="text")
    p.add_argument("--orca", action=argparse.BooleanOptionalAction, default=None,
                   help="add Orca run and task data (default: when the executable is found)")
    p.add_argument("--orca-bin", metavar="PATH", help="default: $ORCA_CLI_COMMAND, else orca on PATH")
    return p


def parse_args(argv):
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.since and args.until and args.since > args.until:
        parser.error("--since is after --until")
    args.claude_root = os.path.expanduser(args.claude_root)
    args.dsh_root = os.path.expanduser(args.dsh_root)
    args.codex_root = [os.path.expanduser(r) for r in
                       (args.codex_root or ["~/.codex/sessions", "~/.codex/archived_sessions"])]
    return args


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    store = Store()
    scan_claude(args.claude_root, store, args.since)
    scan_codex(args.codex_root, store, args.since)
    scan_dsh(args.dsh_root, store, args.since)
    rows = build_rows(store, args)
    orca_status = run_orca(args, rows)
    summary = build_summary(rows, store)
    render = render_json if args.format == "json" else render_text
    print(render(rows, summary, args, orca_status))
    return 0


if __name__ == "__main__":
    sys.exit(main())
