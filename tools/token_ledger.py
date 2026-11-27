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
# A program word that is one shell variable and nothing else: $NAME, ${NAME}, ${NAME:-default},
# ${NAME:=default}; any other operator (${NAME:+x}, ${NAME%x} ...) gives another value.
PROGRAM_VARIABLE = re.compile(r"\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-=][^}]*)?\})\Z")
ORCA_VARIABLE_PART = "orca"  # e.g. ORCA_CLI_COMMAND, the variable this repository's scripts use
LAUNCH_WORDS = ["orchestration", "worker-start"]
LAUNCH_HINT = "worker"  # cheap pre-check; every launch command contains it
HELP_FLAG = "--help"
BLANKS = " \t\r"
NEWLINE = "\n"
WORD_END = BLANKS + "\n;&|()<>"
CONTROL_CHARS = ";&|()"
OPERATORS = (";;&", ";;", ";&", "&&", "||", "|&", ";", "&", "|", "(", ")")  # longest first
SEPARATORS = frozenset({";", "&", NEWLINE})
CASE_ENDS = (";;", ";&", ";;&")
REDIRECTS = ("<<<", "<<-", "<<", "&>>", "&>", ">>", "<&", ">&", "<>", ">|", "<", ">")  # longest first
HEREDOC_STRIP_TABS = "<<-"
HERE_STRING = "<<<"
HEREDOC_OPERATORS = frozenset({"<<", HEREDOC_STRIP_TABS})
GROUP_CLOSE = {"(": ")", "{": "}"}
DOUBLE_QUOTE_ESCAPE = re.compile(r'\\([$`"\\\n])')
ANSI_ESCAPE = re.compile(r"\\(.)", re.DOTALL)
TIME_POSIX_FLAG = "-p"
# Reserved words that open a compound command at command start, and the parser method for each.
COMPOUND_COMMANDS = {"{": "brace_group", "if": "if_command", "while": "loop_command",
                     "until": "loop_command", "for": "for_command", "select": "select_command",
                     "case": "case_command", "[[": "conditional", "function": "function_keyword",
                     "coproc": "coproc_command"}
BODY_COMMANDS = frozenset(COMPOUND_COMMANDS) - {"function", "coproc"}
CLOSING_WORDS = frozenset({"}", "then", "else", "elif", "fi", "do", "done", "esac", "in"})
# NAME=, NAME+= or NAME[subscript]=; groups: name, subscript, plus.
ASSIGNMENT = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)(\[[^]]*\])?(\+?)=")
ARRAY_PREFIX = re.compile(ASSIGNMENT.pattern + r"\Z")  # followed by an unquoted ( : an array value
DECLARED_NAME = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)(?:\[|\+?=|\Z)")
ARRAY_EXPANSION = re.compile(r'(")?\$\{([A-Za-z_][A-Za-z0-9_]*)\[([@*])\]\}(?(1)")\Z')
DECLARATIONS = frozenset({"declare", "typeset", "local", "export", "readonly"})
LOCAL_DECLARATIONS = frozenset({"declare", "typeset", "local"})  # local inside a function, unless -g
GLOBAL_FLAG = re.compile(r"-[A-Za-z]*g[A-Za-z]*\Z")
STATE_RESETS = frozenset({"eval", "source", ".", "trap"})  # may change any variable or function
NOEXEC_FLAG = re.compile(r"-[A-Za-z]*n[A-Za-z]*\Z")
IFS_NAME = "IFS"
MAX_FUNCTION_CALLS = 1000  # per script; a call beyond it is not followed
SHELLS = frozenset({"bash", "sh", "zsh"})
SHELL_SCRIPT_FLAGS = frozenset({"-c", "-lc"})
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
Roles (first rule that holds): worker = a user turn is an Orca dispatch
prompt (it opens with "You are working inside Orca" and says "You are a
dispatched worker" within the first lines; a prompt that only quotes the
phrase later in other text does not count); orchestrator = the session
executed an Orca launch (rule below); other. The dispatch prompt comes first
because it is structural evidence, while the launch test reads shell text, so
no reading error of the launch test can move a dispatched worker's tokens into
the orchestrator share; a dispatched worker that starts workers of its own is a
worker. A subagent file takes the role and task of its parent session.
task = last path component of the session cwd.

Launch rule: only shell tool calls are read (Claude: tool_use "Bash",
input.command; Codex: event_msg item_completed with item type
"CommandExecution", command [bash, -lc, script]; dsh: tool/call "bash",
arguments.command). The script is parsed by a small reader of the Bash
grammar, not run. Words: single quotes, double quotes (a backslash escapes),
$'...' and backslash escapes are honoured; backslash-newline joins lines;
adjacent quoted and plain parts are one word; "#" at the start of a word
outside quotes is a comment to the end of the line ("a#b" is one word).
Outside quotes only, ; & && | || |& ( ) ;; ;& ;;& and newline are operators;
a quoted ";" is an argument. A redirection (< > >> <& >& <> >| &> &>> with an
optional fd number) is not a word and its target is never the program. A
here-document (<< or <<-) skips the lines after its line up to the delimiter
line, or to the end of the script when it is missing; <<< takes one word.
Structure: pipelines, lists, { } and ( ) groups, if, while, until, for (also
for ((...)) and a { } body), select, case (patterns are not commands), [[ ]]
and (( )) (their words are never commands), function definitions and
coproc are parsed; reserved words count only at the start of a command.
The commands are then read in source order:
  - A simple command is a launch when, after any NAME=value, NAME+=value or
    NAME[i]=value words, its program is orca, orca-ide or orca-dev by
    basename, or is one shell variable whose name contains "orca" in any case
    ($ORCA_CLI_COMMAND, ${ORCA_CLI_COMMAND:-orca}; a default with :- or := only),
    unquoted or in double quotes, its next words are "orchestration
    worker-start", and no word is --help. The variable's value is not known
    unless the script assigned it a literal value earlier, which is then the
    program. A single-quoted '$ORCA_CLI_COMMAND', a variable with any other
    name, or a variable that is only part of the program word is not a launch.
  - Arrays: an unquoted ( right after NAME=, NAME+= or NAME[...]= opens an
    array value; up to its matching ) it is one assignment word (quote,
    comment and newline aware), never commands, also after declare, typeset,
    local, export and readonly. Its elements are remembered by name, with +=
    appending, the last assignment before a command counting, a local array of
    a function ending with the call, and a prefix assignment or one in a
    subshell, pipeline or background job not persisting. A command whose
    program word is "${NAME[@]}", ${NAME[@]} or ${NAME[*]} is read as the
    remembered elements followed by its other words (unquoted expansion splits
    elements at blanks); "${NAME[*]}" is one word, the elements joined by a
    blank, as in bash. An array is forgotten (its expansion is then no launch)
    when the script names it in any other way than reading it whole, for
    example cmd[0]=x, cmd=x, unset, read -a, (( )), or after eval, source, .,
    trap or a program word that is itself an unknown expansion; elements
    written as [i]=value are not followed.
  - Functions: NAME() body and function NAME [()] body define a function; the
    body does not run at its definition. A later simple command whose program
    word is that name (quoted or not) runs the body, read by the same rules,
    following one function calling another, with recursion and more than
    1000 calls per script not followed. A function shadows the Orca CLI of the
    same name. unset and redefinition apply; a function defined in a subshell
    or pipeline does not persist.
  - set -n or set -o noexec, and shopt -s expand_aliases, end the reading:
    nothing after them counts.
Text in other tools' arguments or in a quoted argument of another program is
not a launch. A script with an unterminated quote, $(, ${, <(, backtick,
array value or compound command, or another syntax error, cannot be read and
has no launch.
Limits: the launch test is static. It does not evaluate control flow (a launch
in a branch not taken, in a loop that never runs, or after exit still counts),
nor PATH or hash changes. It does not follow command substitution ($(...) and
backticks), process substitution, here-document bodies, eval, source, trap, a
nested shell (bash -c '...'), a scalar variable or "$@" that holds the whole
command, or wrapper programs (env, sudo, timeout, xargs, exec, command,
coproc, nohup); their quotes, comments and here-documents are tracked only to
find their end. Each of those is a missed launch, never an invented one.

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


# ---- shell word scanner ---------------------------------------------------
# Reads a shell script far enough to find its simple commands; it does not run or
# expand anything. Every rule is stated in --help under "Launch rule".

Word = collections.namedtuple("Word", "text raw quoted array", defaults=(None,))  # text: quotes removed; raw: as written
ArrayValue = collections.namedtuple("ArrayValue", "name indexed append elements")  # elements: Words


def close_single(s, i):
    """Index after the ' that closes a single-quoted string whose body starts at i."""
    end = s.find("'", i)
    if end < 0:
        raise ValueError("unterminated single quote")
    return end + 1


def close_escaped(s, i, quote):
    """Index after the quote that closes a $'...' string or a backtick span; backslash escapes."""
    while i < len(s):
        if s[i] == "\\":
            i += 2
        elif s[i] == quote:
            return i + 1
        else:
            i += 1
    raise ValueError("unterminated " + quote)


def close_double(s, i):
    """Index after the " that closes a double-quoted string whose body starts at i."""
    while i < len(s):
        if s[i] == "\\":
            i += 2
        elif s[i] == '"':
            return i + 1
        else:
            i = skip_expansion(s, i)
    raise ValueError("unterminated double quote")


def skip_expansion(s, i):
    """Index after a $(...), $((...)), ${...} or backtick span at i, else i + 1."""
    if s[i] == "`":
        return close_escaped(s, i + 1, "`")
    if s.startswith("$((", i):
        return close_group(s, i + 2, "(", commands=False)
    if s[i] == "$" and s[i + 1:i + 2] in GROUP_CLOSE:
        return close_group(s, i + 2, s[i + 1], commands=s[i + 1] == "(")
    return i + 1


def close_group(s, i, opener, commands=True):
    """Index after the bracket that closes a group whose body starts at i.

    commands: the body is a command list ($( or <(), so it has comments and here-documents.
    """
    closer, depth, start, heredocs = GROUP_CLOSE[opener], 1, i, []
    while i < len(s):
        c = s[i]
        if c in (opener, closer):
            depth += 1 if c == opener else -1
            i += 1
            if depth == 0:
                return i
        elif commands:
            i = command_list_step(s, i, start, heredocs)
        else:
            i = group_step(s, i)
    raise ValueError("unterminated " + opener)


def group_step(s, i):
    """Index after the quoting construct, expansion or character at i inside a group."""
    c = s[i]
    if c == "\\":
        return i + 2
    if c == "'":
        return close_single(s, i + 1)
    if c == '"':
        return close_double(s, i + 1)
    if s.startswith("$'", i):
        return close_escaped(s, i + 2, "'")
    return skip_expansion(s, i)


def command_list_step(s, i, start, heredocs):
    """group_step, plus the comments and here-documents of a command list."""
    c = s[i]
    if c == "#" and (i == start or s[i - 1] in WORD_END):
        end = s.find("\n", i)
        return len(s) if end < 0 else end
    if c == "\n":
        i = skip_heredoc_bodies(s, i + 1, heredocs)
        heredocs.clear()
        return i
    if s.startswith("<<", i) and not s.startswith(HERE_STRING, i):
        return read_heredoc_delimiter(s, i, heredocs)
    return group_step(s, i)


def read_heredoc_delimiter(s, i, heredocs):
    """Index after the << or <<- operator at i and its delimiter word, which joins heredocs."""
    strip_tabs = s.startswith(HEREDOC_STRIP_TABS, i)
    i += len(HEREDOC_STRIP_TABS) if strip_tabs else len(HEREDOC_STRIP_TABS) - 1
    while i < len(s) and s[i] in BLANKS:
        i += 1
    if i >= len(s) or s[i] in WORD_END:
        raise ValueError("here-document without a delimiter")
    word, i = read_word(s, i)
    heredocs.append((word.text, strip_tabs))
    return i


def word_piece(s, i):
    """(end, text, quoted) of one quoting construct, expansion or plain character at i."""
    c, nxt = s[i], s[i + 1:i + 2]
    if c == "\\":
        return (i + 2, "", False) if nxt == "\n" else (i + 2, nxt, True)
    if c == "'":
        end = close_single(s, i + 1)
        return end, s[i + 1:end - 1], True
    if c == '"':
        end = close_double(s, i + 1)
        return end, DOUBLE_QUOTE_ESCAPE.sub(unescape, s[i + 1:end - 1]), True
    if c == "$" and nxt == "'":
        end = close_escaped(s, i + 2, "'")
        return end, ANSI_ESCAPE.sub(unescape, s[i + 2:end - 1]), True
    end = skip_expansion(s, i)
    return end, s[i:end], False


def unescape(match):
    """Escape letters such as \\n are not decoded; only the quoted character matters here."""
    return "" if match.group(1) == "\n" else match.group(1)


def read_word(s, i):
    """(Word, end) of the word at i; a <( or >( at its start is process substitution.

    An unquoted ( right after NAME=, NAME+= or NAME[...]= opens an array value: everything
    up to the matching ) belongs to this one word.
    """
    start, parts, quoted = i, [], False
    if s[i] in "<>":
        i = close_group(s, i + 2, "(")
        parts.append(s[start:i])
    while i < len(s) and s[i] not in WORD_END:
        i, text, piece_quoted = word_piece(s, i)
        parts.append(text)
        quoted = quoted or piece_quoted
    prefix = ARRAY_PREFIX.match(s[start:i]) if s.startswith("(", i) else None
    if prefix is None:
        return Word("".join(parts), s[start:i], quoted), i
    elements, i = read_array(s, i + 1)
    if i < len(s) and s[i] not in WORD_END:
        raise ValueError("text after an array value")
    value = ArrayValue(prefix.group(1), bool(prefix.group(2)), bool(prefix.group(3)), elements)
    return Word("".join(parts), s[start:i], quoted, value), i


def read_array(s, i):
    """(element Words, end) of an array value whose body starts at i, up to its closing )."""
    elements = []
    while i < len(s):
        c = s[i]
        if c in BLANKS or c == NEWLINE:
            i += 1
        elif s.startswith("\\\n", i):
            i += 2
        elif c == "#":
            i = line_end(s, i)
        elif c == ")":
            return tuple(elements), i + 1
        elif c in WORD_END:
            raise ValueError("operator inside an array value")
        else:
            word, i = read_word(s, i)
            if word.array is not None:
                raise ValueError("array value inside an array value")
            elements.append(word)
    raise ValueError("unterminated array value")


def line_end(s, i):
    """Index of the newline that ends the line holding i, or the end of s."""
    end = s.find(NEWLINE, i)
    return len(s) if end < 0 else end


def skip_heredoc_bodies(s, i, heredocs):
    """Index after the bodies of the here-documents opened on the line that ended before i."""
    for delimiter, strip_tabs in heredocs:
        while i < len(s):
            end = s.find("\n", i)
            line, i = (s[i:], len(s)) if end < 0 else (s[i:end], end + 1)
            if (line.lstrip("\t") if strip_tabs else line) == delimiter:
                break
    return i


Token = collections.namedtuple("Token", "kind value")  # kind WORD (value a Word), OP (a str) or END
WORD, OP, END = "word", "op", "end"
END_TOKEN = Token(END, None)


class Lexer:
    """The words and control operators of a shell script, one token at a time.

    A redirection never reaches the parser: the operator, an fd number before it and its
    target are consumed here, and the target's text is kept in side for the variable
    bookkeeping, as are here-document bodies, which are skipped at the end of their line.
    """

    def __init__(self, script):
        self.s, self.i = script, 0
        self.heredocs, self.side, self.peeked = [], [], None

    def peek(self):
        if self.peeked is None:
            self.peeked = self.read()
        return self.peeked

    def take(self):
        token, self.peeked = self.peek(), None
        return token

    def read(self):
        s = self.s
        while self.i < len(s):
            c = s[self.i]
            if c in BLANKS:
                self.i += 1
            elif s.startswith("\\\n", self.i):
                self.i += 2
            elif c == "#":  # between tokens, so at the start of a word
                self.i = line_end(s, self.i)
            elif c == NEWLINE:
                self.skip_bodies()
                return Token(OP, NEWLINE)
            elif s.startswith("&>", self.i) or (c in "<>" and s[self.i + 1:self.i + 2] != "("):
                self.redirect()
            elif c in CONTROL_CHARS:
                op = next(op for op in OPERATORS if s.startswith(op, self.i))
                self.i += len(op)
                return Token(OP, op)
            else:
                word, self.i = read_word(s, self.i)
                if not (word.raw.isdigit() and s[self.i:self.i + 1] in ("<", ">")):
                    return Token(WORD, word)  # an fd number before a redirect is not a word
        return END_TOKEN

    def skip_bodies(self):
        start = self.i + 1
        self.i = skip_heredoc_bodies(self.s, start, self.heredocs)
        if self.heredocs:
            self.side.append(self.s[start:self.i])
        self.heredocs = []

    def redirect(self):
        s = self.s
        op = next(op for op in REDIRECTS if s.startswith(op, self.i))
        self.i += len(op)
        while s.startswith("\\\n", self.i) or s[self.i:self.i + 1] in tuple(BLANKS):
            self.i += 2 if s[self.i] == "\\" else 1
        if self.i >= len(s) or (s[self.i] in WORD_END and not s.startswith(("<(", ">("), self.i)):
            raise ValueError("redirect without a target")
        word, self.i = read_word(s, self.i)
        self.side.append(word.raw)
        if op in HEREDOC_OPERATORS:
            self.heredocs.append((word.text, op == HEREDOC_STRIP_TABS))

    def try_arithmetic(self):
        """After a ( at command start: the text of a (( ... )) command, else None (a subshell)."""
        s, i = self.s, self.i
        if not s.startswith("(", i):
            return None
        inner = close_group(s, i + 1, "(", commands=False)
        if not s.startswith(")", inner):
            return None
        self.i = inner + 1
        return s[i:self.i]

    def conditional(self):
        """After [[: the text up to and including the closing ]] word; nothing in it is a command."""
        s, start = self.s, self.i
        while self.i < len(s):
            c = s[self.i]
            if c in BLANKS or c == NEWLINE:
                self.i += 1
            elif s.startswith("\\\n", self.i):
                self.i += 2
            elif c == "#":
                self.i = line_end(s, self.i)
            elif c == ";":
                raise ValueError("; inside [[ ]]")
            elif c in WORD_END:
                self.i += 1  # && || ! ( ) < > are operators of the expression
            else:
                word, self.i = read_word(s, self.i)
                if word.raw == "]]":
                    return s[start:self.i]
        raise ValueError("unterminated [[")


# Parsed items, in source order. Cmd: a simple command; Text: words that are expanded but
# never run (for and case words, [[ ]], (( )), redirect targets, here-document bodies);
# Func: a function definition; Sub: a subshell, whose variables and functions do not persist.
Cmd = collections.namedtuple("Cmd", "words side")
Text = collections.namedtuple("Text", "raw")
Func = collections.namedtuple("Func", "name body")
Sub = collections.namedtuple("Sub", "items")


def is_assignment(word):
    return word.array is not None or ASSIGNMENT.match(word.raw) is not None


class ShellParser:
    """A recursive-descent reader of the Bash grammar; raises ValueError on a syntax error."""

    def __init__(self, script):
        self.lex = Lexer(script)

    def parse(self):
        items = self.command_list(allow_empty=True)
        if self.lex.peek().kind != END:
            raise ValueError("unexpected token")
        return items

    def is_word(self, token, *raws):
        return token.kind == WORD and not token.value.quoted and token.value.raw in raws

    def expect_word(self, raw):
        if not self.is_word(self.lex.take(), raw):
            raise ValueError("expected " + raw)

    def expect_op(self, op):
        if self.lex.take() != Token(OP, op):
            raise ValueError("expected " + op)

    def skip_newlines(self):
        while self.lex.peek() == Token(OP, NEWLINE):
            self.lex.take()

    def at_stop(self, stops):
        token = self.lex.peek()
        if token.kind == OP:
            return token.value in stops
        return token.kind == END or self.is_word(token, *stops)

    def flush_side(self):
        items, self.lex.side = [Text(raw) for raw in self.lex.side], []
        return items

    def command_list(self, stops=(), allow_empty=False):
        """Commands up to a stop word or operator at command start (or the end), which stays unread."""
        items, count = [], 0
        self.skip_newlines()
        while not self.at_stop(stops):
            part, count = self.and_or(), count + 1
            token = self.lex.peek()
            items.extend([Sub(tuple(part))] if token == Token(OP, "&") else part)
            if token.kind != OP or token.value not in SEPARATORS:
                break
            self.lex.take()
            self.skip_newlines()
            items.extend(self.flush_side())
        if not count and not allow_empty:
            raise ValueError("empty command list")
        return items

    def and_or(self):
        items = self.pipeline()
        while self.lex.peek() in (Token(OP, "&&"), Token(OP, "||")):
            self.lex.take()
            self.skip_newlines()
            items = items + self.pipeline()
        return items

    def pipeline(self):
        while self.is_word(self.lex.peek(), "!", "time"):
            if self.lex.take().value.raw == "time" and self.is_word(self.lex.peek(), TIME_POSIX_FLAG):
                self.lex.take()
        parts = [self.command()]
        while self.lex.peek() in (Token(OP, "|"), Token(OP, "|&")):
            self.lex.take()
            self.skip_newlines()
            parts.append(self.command())
        return parts[0] if len(parts) == 1 else [Sub(tuple(part)) for part in parts]

    def command(self):
        token = self.lex.peek()
        if token == Token(OP, "("):
            self.lex.take()
            return self.paren()
        if token.kind != WORD:
            raise ValueError("expected a command")
        if self.is_word(token, *COMPOUND_COMMANDS):
            self.lex.take()
            return getattr(self, COMPOUND_COMMANDS[token.value.raw])(token.value.raw)
        if self.is_word(token, *CLOSING_WORDS):
            raise ValueError("unexpected " + token.value.raw)
        return self.simple_command()

    def paren(self):
        arithmetic = self.lex.try_arithmetic()
        if arithmetic is not None:
            return [Text(arithmetic)]
        body = self.command_list((")",))
        self.expect_op(")")
        return [Sub(tuple(body))]

    def brace_group(self, _keyword="{"):
        body = self.command_list(("}",))
        self.expect_word("}")
        return body

    def take_keyword(self):
        token = self.lex.take()
        return token.value.raw if token.kind == WORD and not token.value.quoted else None

    def if_command(self, keyword):
        items = []
        while keyword in ("if", "elif"):
            items += self.command_list(("then",))
            self.expect_word("then")
            items += self.command_list(("elif", "else", "fi"))
            keyword = self.take_keyword()
        if keyword == "else":
            items += self.command_list(("fi",))
            keyword = self.take_keyword()
        if keyword != "fi":
            raise ValueError("expected fi")
        return items

    def loop_command(self, _keyword):
        return self.command_list(("do",)) + self.do_group(allow_brace=False)

    def do_group(self, allow_brace):
        if allow_brace and self.is_word(self.lex.peek(), "{"):
            self.lex.take()
            return self.brace_group()
        self.expect_word("do")
        body = self.command_list(("done",))
        self.expect_word("done")
        return body

    def for_command(self, keyword):
        token = self.lex.take()
        if keyword == "for" and token == Token(OP, "("):
            arithmetic = self.lex.try_arithmetic()
            if arithmetic is None:
                raise ValueError("expected (( after for")
            items = [Text(arithmetic)]
        elif token.kind == WORD:
            items = self.word_list()
        else:
            raise ValueError("expected a name after " + keyword)
        if self.lex.peek() == Token(OP, ";"):
            self.lex.take()
        self.skip_newlines()
        return items + self.do_group(allow_brace=True)

    def select_command(self, keyword):
        return self.for_command(keyword)

    def word_list(self):
        """The optional 'in words' of for and select, up to its ; or newline (left unread)."""
        self.skip_newlines()
        if not self.is_word(self.lex.peek(), "in"):
            return []
        self.lex.take()
        items = []
        while self.lex.peek().kind == WORD:
            items.append(Text(self.lex.take().value.raw))
        if self.lex.peek() not in (Token(OP, ";"), Token(OP, NEWLINE)):
            raise ValueError("expected ; or newline after the word list")
        return items

    def case_command(self, _keyword):
        subject = self.lex.take()
        if subject.kind != WORD:
            raise ValueError("expected a word after case")
        items = [Text(subject.value.raw)]
        self.skip_newlines()
        self.expect_word("in")
        self.skip_newlines()
        while not self.is_word(self.lex.peek(), "esac"):
            items += self.case_item()
            if self.lex.peek().kind != OP or self.lex.peek().value not in CASE_ENDS:
                break
            self.lex.take()
            self.skip_newlines()
        self.expect_word("esac")
        return items

    def case_item(self):
        if self.lex.peek() == Token(OP, "("):
            self.lex.take()
        items = [self.pattern()]
        while self.lex.peek() == Token(OP, "|"):
            self.lex.take()
            items.append(self.pattern())
        self.expect_op(")")
        return items + self.command_list(("esac",) + CASE_ENDS, allow_empty=True)

    def pattern(self):
        token = self.lex.take()
        if token.kind != WORD:
            raise ValueError("expected a case pattern")
        return Text(token.value.raw)

    def conditional(self, _keyword):
        return [Text(self.lex.conditional())]

    def function_keyword(self, _keyword):
        name = self.lex.take()
        if name.kind != WORD:
            raise ValueError("expected a function name")
        if self.lex.peek() == Token(OP, "("):
            self.lex.take()
            if self.lex.peek() != Token(OP, ")"):  # function NAME ( list ): a subshell body
                body = self.command_list((")",))
                self.expect_op(")")
                return [Func(name.value, (Sub(tuple(body)),))]
            self.lex.take()
        return [Func(name.value, tuple(self.function_body()))]

    def function_body(self):
        self.skip_newlines()
        token = self.lex.peek()
        if token == Token(OP, "("):
            self.lex.take()
            return self.paren()
        if not self.is_word(token, *BODY_COMMANDS):
            raise ValueError("a function body is a compound command")
        self.lex.take()
        return getattr(self, COMPOUND_COMMANDS[token.value.raw])(token.value.raw)

    def starts_compound(self, token):
        return token == Token(OP, "(") or self.is_word(token, *BODY_COMMANDS)

    def coproc_command(self, _keyword):
        """coproc [NAME] command: parsed for its syntax, never followed (a wrapper)."""
        if not self.starts_compound(self.lex.peek()):
            first = self.lex.take()
            if first.kind != WORD:
                raise ValueError("expected a command after coproc")
            if not self.starts_compound(self.lex.peek()):
                self.simple_command(first.value)
                return [Text("")]
        self.command()
        return [Text("")]

    def simple_command(self, first=None):
        words = [first] if first else []
        while self.lex.peek().kind == WORD:
            words.append(self.lex.take().value)
        side, self.lex.side = tuple(self.lex.side), []
        if self.lex.peek() == Token(OP, "("):
            return self.function_definition(words)
        program = next((k for k, word in enumerate(words) if not is_assignment(word)), len(words))
        declares = program < len(words) and not words[program].quoted and words[program].raw in DECLARATIONS
        if not declares and any(word.array is not None for word in words[program:]):
            raise ValueError("array value outside an assignment")
        return [Cmd(tuple(words), side)]

    def function_definition(self, words):
        if len(words) != 1 or is_assignment(words[0]):
            raise ValueError("( after a word")
        self.lex.take()
        self.expect_op(")")
        return [Func(words[0], tuple(self.function_body()))]


# ---- what the parsed script executes ------------------------------------------
# Walks the items in order with what is known so far: arrays and literal scalar values by
# name, function bodies by name. Anything that could change them in a way not modelled
# here forgets them, so a reading error can only miss a launch, never invent one.

@dataclasses.dataclass
class ShellState:
    values: dict  # name -> list of Words (an array, never changed in place) or one Word (a literal scalar)
    functions: dict  # name -> body items
    budget: list  # function calls still allowed to be followed, shared with subshells
    stopped: bool = False
    custom_ifs: bool = False  # IFS was named, so unquoted splitting is not known

    def copy(self):
        return ShellState(dict(self.values), dict(self.functions), self.budget, self.stopped,
                          self.custom_ifs)

    def forget_all(self):
        self.values.clear()
        self.functions.clear()


def mentions(text, name):
    """True when text names the variable other than by reading it whole ($N, ${N}, ${N[@]}, ${#N[*]})."""
    if name not in text:
        return False
    reads = re.compile(r"\$\{#?%s(?:\[[@*0-9]*\])?\}|\$%s(?![A-Za-z0-9_])" % (name, name))
    return re.search(r"(?<![A-Za-z0-9_])%s(?![A-Za-z0-9_])" % name, reads.sub("", text)) is not None


def forget_mentions(state, text):
    state.custom_ifs = state.custom_ifs or IFS_NAME in text
    for name in [name for name in state.values if mentions(text, name)]:
        del state.values[name]


def mention_text(cmd):
    raws = list(cmd.side)
    for word in cmd.words:
        raws.extend(e.raw for e in word.array.elements) if word.array else raws.append(word.raw)
    return NEWLINE.join(raws)


def walk(items, state, active=frozenset(), frame=None):
    """True when the items execute a launch. active: the function call chain; frame: its local names."""
    for item in items:
        if state.stopped:
            return False
        if isinstance(item, Text):
            forget_mentions(state, item.raw)
        elif isinstance(item, Sub):
            if walk(item.items, state.copy(), active, None if frame is None else set()):
                return True
        elif isinstance(item, Func):
            define_function(state, item)
        elif run_command(item, state, active, frame):
            return True
    return False


def define_function(state, func):
    name = func.name
    if not name.quoted and "$" not in name.raw and "`" not in name.raw:
        state.functions[name.text] = func.body


def run_command(cmd, state, active, frame):
    words = cmd.words
    forget_mentions(state, mention_text(cmd))
    program = next((k for k, word in enumerate(words) if not is_assignment(word)), len(words))
    if program == len(words):
        for word in words:
            assign(state, word)
        return False
    expanded = expand_program(words[program], state)
    if expanded is None:  # an array or variable whose value is not known: any program
        state.forget_all()
        return False
    command = expanded + list(words[program + 1:])
    return bool(command) and run_simple(command, state, active, frame)


def expand_program(word, state):
    """The words a program word or array element stands for, using known values; None when unknown."""
    array = ARRAY_EXPANSION.match(word.raw)
    if array:
        quoted, name, kind = array.groups()
        elements = state.values.get(name)
        if not isinstance(elements, list):
            return None
        if quoted and kind == "@":
            return list(elements)
        if quoted:  # "${NAME[*]}" joins the elements into one word
            joined = " ".join(e.text for e in elements)
            return [Word(joined, joined, True)]
        if state.custom_ifs:
            return None
        return [split for e in elements for split in split_element(e)]
    quoted = len(word.raw) >= 2 and word.raw[0] == word.raw[-1] == '"'
    variable = PROGRAM_VARIABLE.match(word.raw[1:-1] if quoted else word.raw)
    if variable is None or (variable.group(1) or variable.group(2)) not in state.values:
        return [word]
    if state.custom_ifs and not quoted:
        return None
    value = state.values[variable.group(1) or variable.group(2)]
    value = (value[0] if value else None) if isinstance(value, list) else value
    return None if value is None or not value.text else [value]


def split_element(word):
    """An array element after unquoted expansion: split at blanks, dropped when empty."""
    if "$" in word.raw or "`" in word.raw:
        return [word]
    return [Word(part, part, True) for part in word.text.split()]


def run_simple(command, state, active, frame):
    name = command[0].text
    if name in state.functions:
        return call_function(name, state, active)
    if name in DECLARATIONS:
        declare(command, state, frame)
    elif name in STATE_RESETS:
        state.forget_all()
    elif name == "unset":
        for word in command[1:]:
            state.values.pop(word.text, None)
            state.functions.pop(word.text, None)
    elif stops_execution([word.text for word in command]):
        state.stopped = True
    elif is_launch(command):
        return True
    elif "$" in command[0].raw or "`" in command[0].raw:
        state.forget_all()  # an unknown program, which may be a function that changes them
    return False


def call_function(name, state, active):
    if name in active or state.budget[0] <= 0:
        state.forget_all()  # recursion, or too many calls: what it changes is not followed
        return False
    state.budget[0] -= 1
    saved, frame = dict(state.values), set()
    if walk(state.functions[name], state, active | {name}, frame):
        return True
    for local in frame:
        if local in saved:
            state.values[local] = saved[local]
        else:
            state.values.pop(local, None)
    return False


def declare(command, state, frame):
    local = frame is not None and command[0].text in LOCAL_DECLARATIONS \
        and not any(GLOBAL_FLAG.match(word.text) for word in command[1:])
    for word in command[1:]:
        name = word.array.name if word.array else DECLARED_NAME.match(word.raw)
        if name is None:
            continue
        if local:
            frame.add(name if isinstance(name, str) else name.group(1))
        assign(state, word)


def assign(state, word):
    """Remember an array, or a scalar with a literal value; forget what cannot be known."""
    if word.array is not None:
        name, indexed, append, elements = word.array
        old = state.values.pop(name, None)
        if indexed or any(e.raw.startswith("[") for e in elements):
            return  # NAME[i]=( ) fails in bash; [i]=value elements are not followed
        expanded = [expand_program(e, state) for e in elements]  # bash expands at assignment
        if None in expanded:
            return
        elements = [w for words in expanded for w in words]
        if not append:
            state.values[name] = elements
        elif isinstance(old, list):
            state.values[name] = old + elements
        return
    match = ASSIGNMENT.match(word.raw)
    if match is None:
        return
    name, old = match.group(1), state.values.pop(match.group(1), None)
    value_raw = word.raw[match.end():]
    if match.group(2) or match.group(3) or isinstance(old, list) or "$" in value_raw or "`" in value_raw:
        return
    state.values[name] = Word(word.text[match.end():], value_raw, word.quoted)


def stops_execution(texts):
    """set -n (noexec) runs nothing after it; with expand_aliases a later word may be an alias."""
    if texts[0] == "set":
        return any(NOEXEC_FLAG.match(t) for t in texts[1:]) or ("-o" in texts and "noexec" in texts)
    return texts[0] == "shopt" and "-s" in texts and "expand_aliases" in texts


def is_launch(command):
    if not is_orca_program(command[0]):
        return False
    texts = [word.text for word in command]
    return texts[1:1 + len(LAUNCH_WORDS)] == LAUNCH_WORDS and HELP_FLAG not in texts


def is_orca_program(word):
    """True for the Orca CLI by basename, or for one shell variable named after it."""
    if os.path.basename(word.text) in ORCA_PROGRAMS:
        return True
    raw = word.raw
    if len(raw) >= 2 and raw[0] == raw[-1] == '"':
        raw = raw[1:-1]
    variable = PROGRAM_VARIABLE.match(raw)
    return variable is not None \
        and ORCA_VARIABLE_PART in (variable.group(1) or variable.group(2)).lower()


def runs_launch(script):
    """True when a shell command string executes an Orca worker launch."""
    if not isinstance(script, str) or LAUNCH_HINT not in script:
        return False
    try:
        items = ShellParser(script).parse()
        return walk(items, ShellState({}, {}, [MAX_FUNCTION_CALLS]))
    except (ValueError, RecursionError):
        return False


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
        if self.dispatches:  # structural evidence first; see --help under Roles
            return "worker"
        return "orchestrator" if self.spawned else "other"

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
