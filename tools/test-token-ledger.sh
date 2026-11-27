#!/usr/bin/env bash
# Test for tools/token_ledger.py. Every fixture is synthetic and generated into a
# temporary directory at run time; no real log is read (HOME is redirected and every
# root is passed explicitly).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LEDGER="$ROOT/tools/token_ledger.py"
PY="${PYTHON:-python3}"
PYABS="$(command -v "$PY")"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
FX="$TMP/fx"
SENT="SENTINEL_BODY_7f3a"
LABEL="Claude Code estimate, not a bill"
fail=0
ok()  { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }

# run [args]: all roots point into the fixture tree, HOME is a decoy, Orca defaults to a missing binary.
export ORCA_CLI_COMMAND="$TMP/no-such-orca"
run() {
  HOME="$TMP/home" "$PY" -I "$LEDGER" --claude-root "$FX/claude" --codex-root "$FX/codex" \
    --dsh-root "$FX/dsh" "$@"
}
# chk NAME JSONFILE EXPR: EXPR is Python with d (parsed output), row(task, role, agent, model) and tok(row).
# eval() runs only the literal expressions written in this file, never data from a log.
cat > "$TMP/chk.py" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
def row(task, role=None, agent=None, model=None):
    m = [r for r in d["rows"] if r["task"] == task and (role is None or r["role"] == role)
         and (agent is None or r["agent"] == agent) and (model is None or r["model"] == model)]
    assert len(m) == 1, ("expected one row", task, role, agent, model, len(m))
    return m[0]
def tok(r):
    t = r["tokens"]
    return (t["input"], t["cache_read"], t["cache_creation"], t["output"])
sys.exit(0 if eval("(" + sys.argv[2] + "\n)") else 1)
EOF
chk() { "$PY" -I "$TMP/chk.py" "$2" "$3" 2>"$TMP/chk.err" && ok "$1" || { bad "$1"; tail -3 "$TMP/chk.err"; }; }

# ---- fixture generator -------------------------------------------------------
cat > "$TMP/gen.py" <<'EOF'
import json, os, sys, datetime as dt
FX, SENT = sys.argv[1], sys.argv[2]
MARK = "You are working inside Orca, a multi-agent IDE. You are a dispatched worker. "

def write(path, lines, tail=""):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        for ln in lines:
            f.write((ln if isinstance(ln, str) else json.dumps(ln)) + "\n")
        f.write(tail)

def usage(i, cr, cc, o):
    return {"input_tokens": i, "cache_read_input_tokens": cr,
            "cache_creation_input_tokens": cc, "output_tokens": o}

def asst(sid, cwd, ts, mid, model, u, blocks=None):
    return {"type": "assistant", "timestamp": ts, "cwd": cwd, "sessionId": sid, "gitBranch": "b",
            "version": "1", "message": {"id": mid, "model": model, "role": "assistant",
            "content": blocks or [{"type": "text", "text": SENT}], "usage": u}}

def user(sid, cwd, ts, content):
    return {"type": "user", "timestamp": ts, "cwd": cwd, "sessionId": sid,
            "message": {"role": "user", "content": content}}

def cost(sid, total):
    return {"type": "cost-state", "sessionId": sid, "totalCostUSD": total,
            "modelUsage": {"opus-test": {"costUSD": total}}}

OPUS, SONNET = "opus-test", "sonnet-test"
P = FX + "/claude/-p1/"
ORCH, IMPL, MISC, MISC2 = "/w/orch-main", "/w/impl-task", "/w/misc", "/w2/misc"
spawn = [{"type": "tool_use", "name": "Bash",
          "input": {"command": "orca orchestration worker-start --agent codex " + SENT}}]

# S1: dispatched, and launches a worker: a worker (role order). m1 on three lines (output grows), synthetic call, malformed + truncated lines.
write(P + "sess-orch.jsonl", [
    user("sess-orch", ORCH, "2026-11-10T09:59:00Z", [{"type": "text", "text": MARK + SENT}]),
    asst("sess-orch", ORCH, "2026-11-10T10:00:00Z", "m1", OPUS, usage(100, 1000, 200, 10)),
    asst("sess-orch", ORCH, "2026-11-10T10:00:00Z", "m1", OPUS, usage(100, 1000, 200, 20)),
    asst("sess-orch", ORCH, "2026-11-10T10:00:00Z", "m1", OPUS, usage(100, 1000, 200, 30), spawn),
    cost("sess-orch", 1.0),
    asst("sess-orch", ORCH, "2026-11-10T10:00:01Z", "m2", "<synthetic>", usage(9999, 9999, 9999, 9999)),
    "this is not json {",
    asst("sess-orch", ORCH, "2026-11-12T23:59:59Z", "m3", OPUS, usage(50, 500, 0, 5)),
    cost("sess-orch", 3.0),
], tail='{"type":"assistant","message":{"id":"m9","model":"opus-test","usage":{"input_tok')
# Resumed file repeats m1 under the original session id; it must not be counted twice.
write(P + "sess-orch-resumed.jsonl", [
    asst("sess-orch", ORCH, "2026-11-10T10:00:00Z", "m1", OPUS, usage(100, 1000, 200, 30)),
])
# Subagent of S1: takes S1's task and role.
write(P + "sess-orch/subagents/agent-a1.jsonl", [
    user("sess-orch", ORCH, "2026-11-12T07:59:00Z", [{"type": "text", "text": SENT}]),
    asst("sess-orch", ORCH, "2026-11-12T08:00:00Z", "m4", SONNET, usage(10, 100, 0, 4)),
])
# S2: dispatched worker with a pull request.
write(P + "sess-impl.jsonl", [
    user("sess-impl", IMPL, "2026-11-12T08:59:00Z", [{"type": "text", "text": MARK + SENT}]),
    asst("sess-impl", IMPL, "2026-11-12T09:00:00Z", "m5", SONNET, usage(20, 200, 100, 50)),
    {"type": "pr-link", "sessionId": "sess-impl", "prNumber": 7, "prUrl": "u",
     "prRepository": "o/r", "timestamp": "2026-11-12T09:01:00Z"},
    cost("sess-impl", 1.0),
])
# S3: plain chat (string content). S4: quotes the marker in the middle of other text.
write(P + "sess-misc.jsonl", [
    user("sess-misc", MISC, "2026-11-12T23:58:00Z", "just a chat " + SENT),
    asst("sess-misc", MISC, "2026-11-13T00:00:00Z", "m6", OPUS, usage(5, 50, 0, 2)),
    cost("sess-misc", 1.0),
])
write(P + "sess-quote.jsonl", [
    user("sess-quote", MISC2, "2026-11-13T04:59:00Z",
         [{"type": "text", "text": "x" * 300 + " quote: " + MARK + SENT}]),
    asst("sess-quote", MISC2, "2026-11-13T05:00:00Z", "m10", OPUS, usage(3, 30, 0, 1)),
    cost("sess-quote", 1.0),
])
# unreadable file: dangling symlink
os.symlink("/nonexistent-token-ledger-target", P + "broken.jsonl")

# ---- Codex ----
def cx(ts, typ, payload):
    return {"timestamp": ts, "type": typ, "payload": payload}
def tc(ts, i, cached, o, cw=0):
    t = {"input_tokens": i, "cached_input_tokens": cached, "cache_write_input_tokens": cw,
         "output_tokens": o, "reasoning_output_tokens": 0, "total_tokens": i + o}
    return cx(ts, "event_msg", {"type": "token_count", "info": {"total_token_usage": t, "last_token_usage": t}})
def dispatch(ts):
    return cx(ts, "response_item", {"type": "message", "role": "user",
              "content": [{"type": "input_text", "text": MARK + SENT}]})
C = FX + "/codex/2026/11/12/"
write(C + "rollout-a.jsonl", [
    cx("2026-11-12T10:00:00Z", "session_meta", {"id": "cx-a", "timestamp": "2026-11-12T10:00:00Z", "cwd": "/w/review-task"}),
    cx("2026-11-12T10:00:01Z", "turn_context", {"model": "gpt-test", "effort": "high"}),
    dispatch("2026-11-12T10:00:02Z"),
    tc("2026-11-12T10:01:00Z", 100, 40, 10),
    tc("2026-11-12T10:01:00Z", 100, 40, 10),
    cx("2026-11-12T10:01:30Z", "event_msg", {"type": "token_count", "info": None}),
    dispatch("2026-11-12T10:02:00Z"),
    cx("2026-11-12T10:02:30Z", "response_item", {"type": "function_call", "arguments": '{"cmd": "ls ' + SENT + '"}'}),
    tc("2026-11-12T10:03:00Z", 300, 100, 30),
    tc("2026-11-12T10:05:00Z", 600, 200, 50),
])
write(C + "rollout-b.jsonl", [
    cx("2026-11-12T11:00:00Z", "session_meta", {"id": "cx-b", "timestamp": "2026-11-12T11:00:00Z", "cwd": "/w/review-b"}),
    cx("2026-11-12T11:00:01Z", "turn_context", {"model": "gpt-test", "reasoning_effort": "low"}),
    dispatch("2026-11-12T11:00:02Z"),
    tc("2026-11-12T11:01:00Z", 80, 30, 10),
])

# ---- dsh (plain JSONL; the test script compresses it) ----
t0 = int(dt.datetime(2026, 11, 12, 12, tzinfo=dt.timezone.utc).timestamp() * 1000)
def asm(seq, ms, i, o, cr, cw):
    u = {"inputTokens": i, "outputTokens": o, "totalTokens": i + o + cr, "cacheReadTokens": cr, "cacheWriteTokens": cw}
    return {"type": "assistant/message", "seq": seq, "time": t0 + ms, "data": {
        "turn": 1, "step": seq, "message": {"role": "assistant", "content": [{"type": "text", "text": SENT}],
        "source": {"kind": "model", "provider": "p", "model": "dsh-model"}, "id": "x"}, "usage": u,
        "stream": [{"type": "usage", "time": t0 + ms, "chunk": {"usage": u}},
                   {"type": "usage", "time": t0 + ms, "chunk": {"usage": u}}]}}
write(FX + "/dsh-plain/session.jsonl", [
    {"type": "session", "version": 4, "id": "d1", "createdAt": t0, "cwd": "/w/dsh-task"},
    {"type": "user/message", "seq": 1, "time": t0 + 1000, "data": {"role": "user", "source": {"kind": "user"},
     "content": [{"type": "text", "text": "Please carry out this task. Brief follows.\n" + MARK + SENT}]}},
    asm(2, 10000, 1000, 100, 500, 50),
    {"type": "tool/call", "seq": 3, "time": t0 + 20000, "data": {"callId": "c", "name": "bash", "arguments": "echo " + SENT}},
    asm(4, 30000, 200, 20, 100, 0),
    {"type": "turn/end", "seq": 5, "time": t0 + 90000, "data": {}},
])
EOF
"$PY" -I "$TMP/gen.py" "$FX" "$SENT" || { bad "fixture generation"; exit 1; }

# zstd fixture: the zstd CLI, else compression.zstd; with neither this test FAILS.
mkdir -p "$FX/dsh/--w-dsh-task--/d1"
DSHF="$FX/dsh/--w-dsh-task--/d1/session.v4.jsonl.zstd"
if command -v zstd >/dev/null 2>&1; then
  zstd -q -c "$FX/dsh-plain/session.jsonl" > "$DSHF"
else
  "$PY" -I -c 'import sys; from compression import zstd; open(sys.argv[2],"wb").write(zstd.compress(open(sys.argv[1],"rb").read()))' \
    "$FX/dsh-plain/session.jsonl" "$DSHF" 2>/dev/null
fi
if [ -s "$DSHF" ]; then ok "zstd fixture built"; else bad "zstd fixture could not be built (need zstd CLI or compression.zstd)"; fi
rm -rf "$FX/dsh-plain"

# ---- 1 Claude counting -------------------------------------------------------
run --format json >"$TMP/full.json" 2>"$TMP/full.err"; rc=$?
[ "$rc" = 0 ] && ok "full run exits 0" || bad "full run rc=$rc"
chk "claude: m1 counted once at highest output; synthetic skipped; resumed repeat ignored; subagent merged under parent" "$TMP/full.json" \
  'tok(row("orch-main","worker","claude","opus-test"))==(150,1500,200,35) and row("orch-main","worker","claude","opus-test")["calls"]==2'
chk "claude: subagent call under parent task and role, own model row" "$TMP/full.json" \
  'tok(row("orch-main","worker","claude","sonnet-test"))==(10,100,0,4) and row("orch-main","worker","claude","sonnet-test")["sessions"]==1'
chk "claude: malformed and truncated lines are counted" "$TMP/full.json" 'd["summary"]["meta"]["claude"]["lines_skipped"]==2'
chk "claude: unreadable file counted, others read" "$TMP/full.json" \
  'd["summary"]["meta"]["claude"]["files_skipped"]==1 and d["summary"]["meta"]["claude"]["files_read"]==6'
grep -q "broken.jsonl" "$TMP/full.err" && ok "unreadable file named on stderr" || bad "unreadable file not named on stderr"
chk "claude: cwd kept in full" "$TMP/full.json" 'row("orch-main","worker","claude","opus-test")["cwds"]==["/w/orch-main"]'
chk "claude: wall time is last minus first counted call" "$TMP/full.json" \
  'sum(r["wall_seconds"] for r in d["rows"] if r["task"]=="orch-main")==223199'
chk "claude: pull request seen in pr-link" "$TMP/full.json" \
  'row("impl-task","worker","claude")["pull_requests"]==[{"repository":"o/r","number":7}]'

# ---- 2 Roles -------------------------------------------------------------------
chk "roles: a dispatch prompt beats an executed launch; worker; other; quote in the middle stays other" "$TMP/full.json" \
  'row("orch-main",agent="claude",model="opus-test")["role"]=="worker" and row("impl-task",agent="claude")["role"]=="worker" and row("misc",agent="claude")["role"]=="other"'
chk "roles: task is the last path component; same name in two parents groups into one row" "$TMP/full.json" \
  'row("misc",agent="claude")["sessions"]==2 and row("misc",agent="claude")["cwds"]==["/w/misc","/w2/misc"] and tok(row("misc",agent="claude"))==(8,80,0,3)'

# ---- 3 Codex ---------------------------------------------------------------------
chk "codex: only the last cumulative token_count, input net of cached, repeats and null info not counted as calls" "$TMP/full.json" \
  'tok(row("review-task",agent="codex"))==(400,200,0,50) and row("review-task",agent="codex")["calls"]==3'
chk "codex: effort from both field names, role worker, model read" "$TMP/full.json" \
  'row("review-task",agent="codex")["efforts"]==["high"] and row("review-b",agent="codex")["efforts"]==["low"] and row("review-b",agent="codex")["model"]=="gpt-test" and row("review-b",agent="codex")["role"]=="worker"'
chk "codex: two dispatch prompts give review_passes 2; other agents 0" "$TMP/full.json" \
  'row("review-task",agent="codex")["review_passes"]==2 and row("review-b",agent="codex")["review_passes"]==1 and row("impl-task",agent="claude")["review_passes"]==0'
chk "codex: wall time from first to last record" "$TMP/full.json" 'row("review-task",agent="codex")["wall_seconds"]==300'

# ---- 4 dsh -------------------------------------------------------------------------
chk "dsh: usage in data counted once, stream chunks ignored; worker; createdAt in ms" "$TMP/full.json" \
  'tok(row("dsh-task",agent="dsh"))==(1200,600,50,120) and row("dsh-task",agent="dsh")["calls"]==2 and row("dsh-task",agent="dsh")["role"]=="worker" and row("dsh-task",agent="dsh")["model"]=="dsh-model" and row("dsh-task",agent="dsh")["wall_seconds"]==90'
"$PY" -I -c 'import compression.zstd' 2>/dev/null; HAVE_PYZSTD=$?
if [ "$HAVE_PYZSTD" = 0 ]; then
  chk "dsh: compression.zstd path used when it imports" "$TMP/full.json" 'd["summary"]["meta"]["dsh"]["decoder"]=="compression.zstd"'
fi
blockpy() { # run with compression.zstd made unimportable; args after --
  HOME="$TMP/home" PATH="${BLOCK_PATH:-$PATH}" "$PYABS" -I -c '
import sys
sys.dont_write_bytecode = True
sys.modules["compression.zstd"] = None
sys.path.insert(0, sys.argv[1])
import token_ledger
sys.exit(token_ledger.main(sys.argv[2:]))' "$ROOT/tools" --claude-root "$FX/claude" --codex-root "$FX/codex" --dsh-root "$FX/dsh" "$@"
}
blockpy --format json >"$TMP/cli.json" 2>"$TMP/cli.err"; rc=$?
[ "$rc" = 0 ] && chk "dsh: zstd -dc path gives the same numbers" "$TMP/cli.json" \
  'tok(row("dsh-task",agent="dsh"))==(1200,600,50,120) and d["summary"]["meta"]["dsh"]["decoder"]=="zstd-cli"' || bad "dsh via zstd -dc: rc=$rc"
mkdir -p "$TMP/emptybin"
BLOCK_PATH="$TMP/emptybin" blockpy --format json >"$TMP/nozstd.json" 2>"$TMP/nozstd.err"; rc=$?
if [ "$rc" = 0 ] && grep -qi zstd "$TMP/nozstd.err"; then ok "dsh: without any zstd the logs are skipped, said on stderr"; else bad "no-zstd stderr/rc=$rc"; fi
chk "dsh: without any zstd the meta counts the skipped file and no dsh row exists" "$TMP/nozstd.json" \
  'd["summary"]["meta"]["dsh"]["files_skipped_no_zstd"]==1 and not [r for r in d["rows"] if r["agent"]=="dsh"] and any(r["agent"]=="claude" for r in d["rows"])'

# ---- 5 Date range ---------------------------------------------------------------------
run --format json --since 2026-11-12 --until 2026-11-12 >"$TMP/day.json" 2>/dev/null
chk "range: one UTC day includes 23:59:59, excludes 00:00:00 next day and the day before" "$TMP/day.json" \
  'tok(row("orch-main","worker","claude","opus-test"))==(50,500,0,5) and tok(row("impl-task",agent="claude"))==(20,200,100,50) and not [r for r in d["rows"] if r["task"]=="misc"]'
chk "range: codex and dsh sessions by their start day" "$TMP/day.json" \
  'row("review-task",agent="codex") and row("dsh-task",agent="dsh")'
run --format json --until 2026-11-11 >"$TMP/early.json" 2>/dev/null
chk "range: --until alone keeps only earlier calls" "$TMP/early.json" \
  '[r["task"] for r in d["rows"]]==["orch-main"] and tok(d["rows"][0])==(100,1000,200,30)'
run --format json --since 2026-11-13 >"$TMP/late.json" 2>/dev/null
chk "range: --since alone keeps the later day" "$TMP/late.json" \
  'sorted(r["task"] for r in d["rows"])==["misc"]'

# ---- 6 Summary ---------------------------------------------------------------------------
chk "summary: Claude token shares, total and per kind" "$TMP/full.json" '(s:=d["summary"]["token_share_pct"]["claude"]) and
s["total"]=={"orchestrator":0.0,"worker":96.3,"other":3.7} and
s["input"]=={"orchestrator":0.0,"worker":95.7,"other":4.3} and
s["cache_read"]=={"orchestrator":0.0,"worker":95.7,"other":4.3} and
s["cache_creation"]=={"orchestrator":0.0,"worker":100.0,"other":0.0} and
s["output"]=={"orchestrator":0.0,"worker":96.7,"other":3.3}'
chk "summary: shares over all agents" "$TMP/full.json" '(s:=d["summary"]["token_share_pct"]["all"]) and
s["total"]=={"orchestrator":0.0,"worker":98.2,"other":1.8} and
s["input"]=={"orchestrator":0.0,"worker":99.6,"other":0.4} and
s["output"]=={"orchestrator":0.0,"worker":98.9,"other":1.1}'
chk "summary: cost estimate shares from the last cost-state of each session, labelled" "$TMP/full.json" '(c:=d["summary"]["cost_estimate"]) and
c["label"]=="Claude Code estimate, not a bill" and c["usd"]=={"orchestrator":0.0,"worker":4.0,"other":2.0} and
c["share_pct"]=={"orchestrator":0.0,"worker":66.7,"other":33.3} and c["sessions_counted"]==4'
chk "summary: median context per call, Claude, per role" "$TMP/full.json" \
  'd["summary"]["median_context_per_call"]=={"orchestrator":None,"worker":435,"other":44}'
chk "summary: cost counts only sessions with a counted call in range" "$TMP/day.json" \
  'd["summary"]["cost_estimate"]["usd"]=={"orchestrator":0.0,"worker":4.0,"other":0.0} and d["summary"]["cost_estimate"]["sessions_counted"]==2'
run >"$TMP/full.txt" 2>/dev/null
grep -qF "$LABEL" "$TMP/full.txt" && ok "text: cost-estimate label present" || bad "text: label missing"
grep -qF "orchestrator 0.0%  worker 96.3%  other 3.7%" "$TMP/full.txt" && ok "text: Claude total share line" || bad "text: share line missing"
grep -qF "orchestrator 0.0%  worker 98.2%  other 1.8%" "$TMP/full.txt" && ok "text: all-agents total share line" || bad "text: all share line missing"

# ---- 7 Orca overlay ------------------------------------------------------------------------
cat > "$TMP/orca-stub" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "${STUB_LOG:?}"
case "$*" in
  "orchestration run-list "*)  echo '{"result":{"runs":[{"id":"run_T1","objective":"o"}]}}' ;;
  "orchestration worker-list "*) echo '{"result":{"workers":[{"dispatchId":"ctx_1","taskId":"task_T1","state":"done","workspace":"ws-1","host":"local"}]}}' ;;
  "orchestration task-list "*) echo '{"result":{"tasks":[{"id":"task_T1","status":"done","title":"Title T1"}]}}' ;;
  "worktree list "*) echo '{"result":{"worktrees":[{"id":"ws-1","path":"/w/impl-task"}]}}' ;;
  *) exit 4 ;;
esac
EOF
chmod +x "$TMP/orca-stub"
printf '#!/usr/bin/env bash\nexit 3\n' > "$TMP/orca-fail"; chmod +x "$TMP/orca-fail"
printf '#!/usr/bin/env bash\necho "not json"\n' > "$TMP/orca-junk"; chmod +x "$TMP/orca-junk"
export STUB_LOG="$TMP/stub.log"; : > "$STUB_LOG"
run --format json --orca-bin "$TMP/orca-stub" >"$TMP/orca.json" 2>"$TMP/orca.err"; rc=$?
[ "$rc" = 0 ] && ok "orca stub: exit 0" || bad "orca stub rc=$rc"
chk "orca: rows carry run id and Orca task title via the worktree path" "$TMP/orca.json" \
  'row("impl-task",agent="claude")["orca"]==[{"run_id":"run_T1","task_title":"Title T1"}] and row("misc",agent="claude")["orca"]==[]'
if [ -s "$STUB_LOG" ] && ! grep -qv -- '--environment local' "$STUB_LOG"; then ok "orca: every call passes --environment local"; else bad "orca: --environment local missing: $(head -2 "$STUB_LOG")"; fi
: > "$STUB_LOG"
ORCA_CLI_COMMAND="$TMP/orca-stub" run --format json >"$TMP/orca-env.json" 2>/dev/null
chk "orca: default binary is \$ORCA_CLI_COMMAND" "$TMP/orca-env.json" 'row("impl-task",agent="claude")["orca"][0]["run_id"]=="run_T1"'
: > "$STUB_LOG"
run --format json --orca-bin "$TMP/orca-stub" --no-orca >"$TMP/noorca.json" 2>/dev/null; rc=$?
[ "$rc" = 0 ] && [ ! -s "$STUB_LOG" ] && chk "orca: --no-orca makes no Orca call and omits the overlay" "$TMP/noorca.json" 'row("impl-task",agent="claude")["orca"]==[]' || bad "--no-orca rc=$rc log=$(head -1 "$STUB_LOG")"
for stub in "$TMP/no-such-bin" "$TMP/orca-fail" "$TMP/orca-junk"; do
  name="$(basename "$stub")"
  run --format json --orca --orca-bin "$stub" >"$TMP/o-$name.json" 2>"$TMP/o-$name.err"; rc=$?
  lines="$(grep -c '^orca: ' "$TMP/o-$name.err")"
  if [ "$rc" = 0 ] && [ "$lines" = 1 ]; then ok "orca $name: one 'orca: ' stderr line, exit 0"; else bad "orca $name: rc=$rc orca lines=$lines"; fi
  chk "orca $name: ledger still printed" "$TMP/o-$name.json" 'len(d["rows"])==7'
done

# ---- 8 Read-only ------------------------------------------------------------------------------
snap() { (cd "$FX" && find . \( -type f -o -type l \) -printf '%p %s %T@\n' | sort; find . -type f -exec sha256sum {} + | sort; find . | sort); }
snap > "$TMP/before.txt"
run --format json >/dev/null 2>&1; run >/dev/null 2>&1; blockpy >/dev/null 2>&1
snap > "$TMP/after.txt"
cmp -s "$TMP/before.txt" "$TMP/after.txt" && ok "read-only: fixture tree identical after runs" || bad "read-only: fixture tree changed"

# ---- 9 No bodies ---------------------------------------------------------------------------------
leak=0
for args in "--format json" "--format text" "--format json --by session" "--format text --by session"; do
  # shellcheck disable=SC2086
  run $args >"$TMP/nb.out" 2>"$TMP/nb.err"
  grep -q "$SENT" "$TMP/nb.out" "$TMP/nb.err" && leak=1
done
run --format json --orca-bin "$TMP/orca-stub" >"$TMP/nb.out" 2>"$TMP/nb.err"; grep -q "$SENT" "$TMP/nb.out" "$TMP/nb.err" && leak=1
blockpy --format json >"$TMP/nb.out" 2>"$TMP/nb.err"; grep -q "$SENT" "$TMP/nb.out" "$TMP/nb.err" && leak=1
[ "$leak" = 0 ] && ok "no bodies: sentinel absent from every output" || bad "no bodies: sentinel leaked"
grep -q "$SENT" "$FX/claude/-p1/sess-orch.jsonl" && ok "no bodies: sentinel is present in the fixtures (test is live)" || bad "sentinel missing from fixtures"

# ---- 10 JSON shape, filters, arguments ----------------------------------------------------------------
chk "json: documented keys" "$TMP/full.json" '
set(d)=={"rows","summary","query"} and
set(row("impl-task",agent="claude"))>={"task","role","agent","model","cwds","tokens","calls","sessions","review_passes","wall_seconds","pull_requests","orca"} and
set(row("impl-task",agent="claude")["tokens"])=={"input","cache_read","cache_creation","output"} and
set(d["summary"])>={"token_share_pct","cost_estimate","median_context_per_call","meta"} and
set(d["summary"]["meta"])=={"claude","codex","dsh"} and d["query"]["by"]=="task"'
run --format json --by session >"$TMP/bysession.json" 2>/dev/null
chk "json: --by session gives one row per session, model and role" "$TMP/bysession.json" \
  'len(d["rows"])==8 and all("session" in r for r in d["rows"]) and len([r for r in d["rows"] if r["task"]=="misc"])==2'
chk "json: --by task default has 7 rows" "$TMP/full.json" 'len(d["rows"])==7 and "session" not in d["rows"][0]'
run --format json --task misc >"$TMP/task.json" 2>/dev/null
chk "--task keeps only that task, summary follows" "$TMP/task.json" \
  '[r["task"] for r in d["rows"]]==["misc"] and d["summary"]["token_share_pct"]["claude"]["total"]=={"orchestrator":0.0,"worker":0.0,"other":100.0}'
run --format json --task misc --task dsh-task >"$TMP/task2.json" 2>/dev/null
chk "--task is repeatable" "$TMP/task2.json" 'sorted(r["task"] for r in d["rows"])==["dsh-task","misc"]'
run --format json --task nope >"$TMP/task0.json" 2>/dev/null; rc=$?
[ "$rc" = 0 ] && chk "--task with no match: empty rows, exit 0" "$TMP/task0.json" 'd["rows"]==[]' || bad "--task nope rc=$rc"
HOME="$TMP/home" "$PY" -I "$LEDGER" --claude-root "$TMP/missing-root" --codex-root "$FX/codex" --dsh-root "$TMP/missing-dsh" --format json >"$TMP/miss.json" 2>"$TMP/miss.err"; rc=$?
[ "$rc" = 0 ] && grep -q "missing-root" "$TMP/miss.err" && grep -q "missing-dsh" "$TMP/miss.err" && chk "missing roots: skipped with a stderr note, exit 0" "$TMP/miss.json" \
  'sorted(r["task"] for r in d["rows"])==["review-b","review-task"]' || bad "missing roots rc=$rc"
for badarg in "--since 2026-13-45" "--until garbage" "--since 2026-11-12 --until 2026-11-01" "--by nope" "--format xml" "--bogus"; do
  # shellcheck disable=SC2086
  run $badarg >/dev/null 2>"$TMP/bad.err"; rc=$?
  [ "$rc" = 2 ] && ok "bad argument '$badarg' exits 2" || bad "bad argument '$badarg' rc=$rc"
done
run --help >"$TMP/help.txt" 2>&1; rc=$?
if [ "$rc" = 0 ] && grep -qi "per call" "$TMP/help.txt" && grep -qi "per session" "$TMP/help.txt" && grep -qi "cached_input_tokens" "$TMP/help.txt"; then ok "help states the date-filter granularity and the Codex token mapping"; else bad "help text incomplete rc=$rc"; fi

# ---- 11 Codex model switch and executed launches (second fixture tree) --------------------------
# A separate tree, so the fixtures and expected numbers of sections 1 to 10 stay as they are.
FX2="$TMP/fx2"
cat > "$TMP/gen2.py" <<'EOF'
import json, os, sys, datetime as dt
FX = sys.argv[1]
MARK = "You are working inside Orca, a multi-agent IDE. You are a dispatched worker. "
LAUNCH = "orca orchestration worker-start --agent codex --spec brief.md"
ARRAY = "cmd=(orca orchestration worker-start --agent codex)"

def write(path, lines):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.writelines(json.dumps(ln) + "\n" for ln in lines)

# Each role case: (task, dispatched?, tool kind, text). "shell" is the source's shell tool call;
# "other" is a non-shell tool whose arguments contain the text.
CASES = [
    ("launch", False, "shell", LAUNCH),
    ("grep-worker", True, "shell", 'rg -n "orchestration worker-start" docs'),
    ("help", False, "shell", "orca orchestration worker-start --help"),
    ("cd-launch", False, "shell", "cd dir && " + LAUNCH),
    ("non-shell", False, "other", LAUNCH),
    ("unbalanced", False, "shell", LAUNCH + ' --title "unbalanced'),
    # The re-review's two mentions, in a dispatched session: the session stays a worker.
    ("rev-comment", True, "shell", "# Example only; orca orchestration worker-start --agent codex\nprintf ok"),
    ("rev-quoted-semi", True, "shell", 'printf "%s\\n" ";" orca orchestration worker-start --agent codex'),
    # Correction cycle 3. Role order: a dispatched session stays a worker, even when it really launches.
    ("disp-launch", True, "shell", LAUNCH),
    # The review's unexecuted array, dispatched and not; then the array really run.
    ("disp-array", True, "shell", ARRAY + "\nprintf '%s\\n' \"${cmd[@]}\""),
    ("array-only", False, "shell", ARRAY + "\nprintf '%s\\n' \"${cmd[@]}\""),
    ("array-run", False, "shell", ARRAY + '\n"${cmd[@]}"'),
    # A function holding the launch: defined only, then defined and called.
    ("func-only", False, "shell", "start() { " + LAUNCH + "; }\necho ready"),
    ("func-called", False, "shell", "start() { " + LAUNCH + "; }\necho ready\nstart"),
]
CLAUDE_ONLY = [
    ("env-launch", False, "shell", "ORCA_X=1 /opt/bin/orca-dev orchestration worker-start --agent dsh"),
    ("quoted-args", False, "shell", "echo 'orca orchestration worker-start'; git commit -m \"orca orchestration worker-start\" && grep -r 'orca orchestration worker-start' ."),
    ("heredoc-body", False, "shell", "cat > brief.sh <<'EOF'\n" + LAUNCH + "\nEOF\nchmod +x brief.sh"),
    ("heredoc-then-launch", False, "shell", "cat > note.txt <<EOF\ndon't stop\nEOF\n" + LAUNCH),
    ("continued-launch", False, "shell", "orca orchestration \\\n  worker-start --agent codex"),
    ("comment-only", False, "shell", "# " + LAUNCH + "\nls"),
    ("pipe-launch", False, "shell", "true | " + LAUNCH + " --json 2>&1"),
    # The Orca CLI named through a shell variable (this repository's own scripts use ORCA_CLI_COMMAND).
    ("var-launch", False, "shell", '"$ORCA_CLI_COMMAND" orchestration worker-start --agent codex'),
    ("braced-var-launch", False, "shell", 'ls .agents; "${ORCA_CLI_COMMAND:-orca}" orchestration worker-start --agent codex'),
    ("bare-var-launch", False, "shell", "cd dir && $orca_bin orchestration worker-start --agent dsh"),
    ("other-var", False, "shell", '"$EDITOR" orchestration worker-start --agent codex'),
    ("var-help", False, "shell", "$ORCA orchestration worker-start --help"),
    ("var-grep", False, "shell", 'rg -n "$ORCA_CLI_COMMAND orchestration worker-start" docs'),
    ("var-suffix", False, "shell", '"$ORCA_HOME/bin/tool" orchestration worker-start --agent codex'),
]

# ---- Claude: tool_use name Bash, input.command ----
def claude(task, dispatched, kind, text):
    cwd, sid = "/v/claude-" + task, "c-" + task
    tool = {"type": "tool_use", "name": "Bash", "input": {"command": text, "description": "d"}} if kind == "shell" \
        else {"type": "tool_use", "name": "Write", "input": {"file_path": "/v/x.md", "content": text}}
    lines = [{"type": "user", "timestamp": "2026-11-20T10:00:00Z", "cwd": cwd, "sessionId": sid,
              "message": {"role": "user", "content": [{"type": "text", "text": (MARK if dispatched else "hi ") + "go"}]}},
             {"type": "assistant", "timestamp": "2026-11-20T10:01:00Z", "cwd": cwd, "sessionId": sid,
              "message": {"id": "m-" + task, "model": "opus-test", "role": "assistant", "content": [tool],
                          "usage": {"input_tokens": 1, "cache_read_input_tokens": 0,
                                    "cache_creation_input_tokens": 0, "output_tokens": 1}}}]
    if kind == "other":  # a search tool with the phrase as its pattern, too
        lines.append({"type": "assistant", "timestamp": "2026-11-20T10:02:00Z", "cwd": cwd, "sessionId": sid,
                      "message": {"id": "m2-" + task, "model": "opus-test", "role": "assistant",
                                  "content": [{"type": "tool_use", "name": "Grep", "input": {"pattern": text}}]}})
    write(FX + "/claude/-v/" + sid + ".jsonl", lines)

# ---- Codex: event_msg item_completed, item CommandExecution, command [shell, -lc, script] ----
def cx(ts, typ, payload):
    return {"timestamp": ts, "type": typ, "payload": payload}
def tc(ts, i, cached, o):
    t = {"input_tokens": i, "cached_input_tokens": cached, "cache_write_input_tokens": 0,
         "output_tokens": o, "reasoning_output_tokens": 0, "total_tokens": i + o}
    return cx(ts, "event_msg", {"type": "token_count", "info": {"total_token_usage": t, "last_token_usage": t}})
def codex_file(name, cwd, body):
    write(FX + "/codex/2026/11/20/rollout-" + name + ".jsonl",
          [cx("2026-11-20T10:00:00Z", "session_meta", {"id": name, "timestamp": "2026-11-20T10:00:00Z", "cwd": cwd})] + body)
def codex(task, dispatched, kind, text):
    body = [cx("2026-11-20T10:00:01Z", "turn_context", {"model": "gpt-test"})]
    if dispatched:
        body.append(cx("2026-11-20T10:00:02Z", "response_item", {"type": "message", "role": "user",
                    "content": [{"type": "input_text", "text": MARK + "go"}]}))
    if kind == "shell":
        body.append(cx("2026-11-20T10:00:03Z", "event_msg", {"type": "item_completed", "item": {
            "type": "CommandExecution", "id": "i1", "command": ["/bin/bash", "-lc", text], "cwd": "/v",
            "exit_code": 0, "status": "completed", "source": "s", "aggregated_output": ""}}))
    else:
        body.append(cx("2026-11-20T10:00:03Z", "response_item", {"type": "custom_tool_call", "name": "apply_patch",
                    "input": "*** Begin Patch\n+" + text}))
        body.append(cx("2026-11-20T10:00:04Z", "response_item", {"type": "custom_tool_call", "name": "exec",
                    "input": "await tools.exec_command({cmd: " + json.dumps(text) + "})"}))
    body.append(tc("2026-11-20T10:01:00Z", 10, 0, 1))
    codex_file(task, "/v/codex-" + task, body)

# ---- dsh: tool/call name bash, arguments a JSON string with command ----
t0 = int(dt.datetime(2026, 11, 20, 10, tzinfo=dt.timezone.utc).timestamp() * 1000)
def dsh(task, dispatched, kind, text):
    args = {"command": text, "description": "d"} if kind == "shell" else {"file_path": "/v/x.md", "content": text}
    lines = [{"type": "session", "version": 4, "id": task, "createdAt": t0, "cwd": "/v/dsh-" + task},
             {"type": "user/message", "seq": 1, "time": t0 + 1000, "data": {"role": "user",
              "content": [{"type": "text", "text": (MARK if dispatched else "hi ") + "go"}]}},
             {"type": "tool/call", "seq": 2, "time": t0 + 2000, "data": {"callId": "c",
              "name": "bash" if kind == "shell" else "write", "arguments": json.dumps(args)}},
             {"type": "assistant/message", "seq": 3, "time": t0 + 3000, "data": {
              "message": {"role": "assistant", "content": [], "source": {"model": "dsh-model"}},
              "usage": {"inputTokens": 1, "outputTokens": 1, "cacheReadTokens": 0, "cacheWriteTokens": 0}}}]
    write(FX + "/dsh-plain/" + task + ".jsonl", lines)

for case in CASES + CLAUDE_ONLY:
    claude(*case)
for case in CASES:
    codex(*case)
    dsh(*case)

# ---- Codex model switch ----
def ctx(ts, model):
    return cx(ts, "turn_context", {"model": model})
# A at 100/10, a repeat of that total after the switch to B, B at 300/30, then a final switch to C with no usage.
codex_file("switch", "/v/cx-switch", [
    ctx("2026-11-20T11:00:01Z", "model-a"), tc("2026-11-20T11:01:00Z", 100, 0, 10),
    ctx("2026-11-20T11:02:00Z", "model-b"), tc("2026-11-20T11:02:01Z", 100, 0, 10),
    tc("2026-11-20T11:03:00Z", 300, 0, 30),
    ctx("2026-11-20T11:04:00Z", "model-c"),
])
# With cached input: the per-model rows must add up to the mapping of the last cumulative record.
codex_file("cached", "/v/cx-cached", [
    ctx("2026-11-20T12:00:01Z", "model-a"), tc("2026-11-20T12:01:00Z", 100, 40, 10),
    ctx("2026-11-20T12:02:00Z", "model-b"), tc("2026-11-20T12:03:00Z", 300, 100, 30),
])
# A cumulative counter that goes down (not seen in real logs): no negative count, counted in meta.
codex_file("decrease", "/v/cx-decrease", [
    ctx("2026-11-20T13:00:01Z", "model-a"), tc("2026-11-20T13:01:00Z", 300, 0, 30),
    tc("2026-11-20T13:02:00Z", 200, 0, 40),
])
# Started the day before the range: all of its models drop out together.
write(FX + "/codex/2026/11/19/rollout-early.jsonl", [
    cx("2026-11-19T10:00:00Z", "session_meta", {"id": "early", "timestamp": "2026-11-19T10:00:00Z", "cwd": "/v/cx-early"}),
    ctx("2026-11-19T10:00:01Z", "model-a"), tc("2026-11-19T10:01:00Z", 10, 0, 1),
    ctx("2026-11-20T10:00:01Z", "model-b"), tc("2026-11-20T10:01:00Z", 30, 0, 3),
])
EOF
"$PY" -I "$TMP/gen2.py" "$FX2" || { bad "fixture generation (second tree)"; exit 1; }
for plain in "$FX2"/dsh-plain/*.jsonl; do
  name="$(basename "$plain" .jsonl)"; mkdir -p "$FX2/dsh/--v-$name--/$name"
  out="$FX2/dsh/--v-$name--/$name/session.v4.jsonl.zstd"
  if command -v zstd >/dev/null 2>&1; then zstd -q -c "$plain" > "$out"
  else "$PY" -I -c 'import sys; from compression import zstd; open(sys.argv[2],"wb").write(zstd.compress(open(sys.argv[1],"rb").read()))' "$plain" "$out" 2>/dev/null; fi
done
rm -rf "$FX2/dsh-plain"
run2() {
  HOME="$TMP/home" "$PY" -I "$LEDGER" --claude-root "$FX2/claude" --codex-root "$FX2/codex" \
    --dsh-root "$FX2/dsh" --no-orca "$@"
}
run2 --format json >"$TMP/fx2.json" 2>"$TMP/fx2.err"; rc=$?
[ "$rc" = 0 ] && ok "second tree: run exits 0" || bad "second tree: rc=$rc"

chk "codex switch: model A keeps its 100/10 and one call" "$TMP/fx2.json" \
  'tok(row("cx-switch",model="model-a"))==(100,0,0,10) and row("cx-switch",model="model-a")["calls"]==1'
chk "codex switch: model B gets only the growth after the switch, 200/20, one call" "$TMP/fx2.json" \
  'tok(row("cx-switch",model="model-b"))==(200,0,0,20) and row("cx-switch",model="model-b")["calls"]==1'
chk "codex switch: a final turn_context without later usage creates no row" "$TMP/fx2.json" \
  'not [r for r in d["rows"] if r["model"]=="model-c"] and len([r for r in d["rows"] if r["task"]=="cx-switch"])==2'
chk "codex switch: an identical token_count repeated across the switch is no call and moves no tokens" "$TMP/fx2.json" \
  'sum(r["calls"] for r in d["rows"] if r["task"]=="cx-switch")==2 and tuple(map(sum, zip(*[tok(r) for r in d["rows"] if r["task"]=="cx-switch"])))==(300,0,0,30)'
chk "codex switch: per-model rows with cached input add up to the mapped last record" "$TMP/fx2.json" \
  'tok(row("cx-cached",model="model-a"))==(60,40,0,10) and tok(row("cx-cached",model="model-b"))==(140,60,0,20)'
chk "codex: a decreasing cumulative counter gives no negative count and is counted in meta" "$TMP/fx2.json" \
  'tok(row("cx-decrease",agent="codex"))==(300,0,0,40) and row("cx-decrease",agent="codex")["calls"]==2 and d["summary"]["meta"]["codex"]["counter_decreases"]==1 and all(v>=0 for r in d["rows"] for v in tok(r))'
chk "codex switch: real fixture has no counter decrease elsewhere" "$TMP/full.json" 'd["summary"]["meta"]["codex"]["counter_decreases"]==0'
run2 --format json --since 2026-11-20 --until 2026-11-20 >"$TMP/fx2day.json" 2>/dev/null
chk "codex switch: a session is filtered by its start day for every model" "$TMP/fx2day.json" \
  'not [r for r in d["rows"] if r["task"]=="cx-early"] and len([r for r in d["rows"] if r["task"]=="cx-switch"])==2'
chk "codex switch: without a filter the early session has both models" "$TMP/fx2.json" \
  'tok(row("cx-early",model="model-a"))==(10,0,0,1) and tok(row("cx-early",model="model-b"))==(20,0,0,2)'

roles() { # roles SOURCE "task role" ...
  src="$1"; shift
  for spec in "$@"; do
    set -- $spec
    chk "roles $src: $1 is $2" "$TMP/fx2.json" "row(\"$src-$1\")[\"role\"]==\"$2\""
  done
}
for src in claude codex dsh; do
  roles "$src" "launch orchestrator" "grep-worker worker" "help other" "cd-launch orchestrator" \
    "non-shell other" "unbalanced other" "rev-comment worker" "rev-quoted-semi worker" \
    "disp-launch worker" "disp-array worker" "array-only other" "array-run orchestrator" \
    "func-only other" "func-called orchestrator"
done
roles claude "env-launch orchestrator" "quoted-args other" "heredoc-body other" \
  "heredoc-then-launch orchestrator" "continued-launch orchestrator" "comment-only other" "pipe-launch orchestrator"
roles claude "var-launch orchestrator" "braced-var-launch orchestrator" "bare-var-launch orchestrator" \
  "other-var other" "var-help other" "var-grep other" "var-suffix other"
grep -qi "shell variable" "$TMP/help.txt" && ok "help states the shell-variable launch rule" || bad "help: shell-variable launch rule not described"
grep -qi "simple command" "$TMP/help.txt" && grep -qi "here-document" "$TMP/help.txt" && grep -qi "counter_decreases" "$TMP/help.txt" \
  && ok "help states the executed-launch rule and the per-model Codex split" || bad "help: role rule or Codex split not described"

# ---- 12 Shell scanner table (runs_launch called directly) ------------------------------------
# One check per row: (expected, name, script). expected is True when bash would execute the
# Orca launch. Rows follow the rules in --help; the comments name the rule a row covers.
cat > "$TMP/scan_rows.py" <<'EOF'
L = "orca orchestration worker-start --agent codex"
ROWS = [
    # The re-review's two scripts and the three further defects.
    (False, "comment holding a semicolon", "# Example only; " + L + "\nprintf ok"),
    (False, "quoted semicolon argument", 'printf "%s\\n" ";" ' + L),
    (True, "quoted << on an earlier line", 'echo "a << EOF"\n' + L),
    (True, "launch as an if condition", "if " + L + "; then echo ok; fi"),
    (False, "redirect target named orca", "echo hi > out.txt; cat < " + L),
    # 1 quoting
    (True, "single-quoted program", "'orca' orchestration worker-start"),
    (True, "every word quoted", '"orca" "orchestration" \'worker-start\''),
    (True, "adjacent quoted and plain parts", 'o"rc"a orch\'estr\'ation worker-start'),
    (True, "backslash-escaped program", "\\orca orchestration worker-start"),
    (False, "escaped double quote keeps the string open", 'echo "a \\" ; ' + L + '"'),
    (True, "escaped backslash closes the string", 'echo "a \\\\"; ' + L),
    (False, "ANSI-C string with an escaped quote", "echo $'it\\'s ; " + L + "'"),
    (True, "ANSI-C string ends before the launch", "echo $'a\\\\'; " + L),
    (False, "escaped semicolon", "echo hi\\; " + L),
    (True, "backslash-newline inside a word", "orca orches\\\ntration worker-start"),
    (True, "backslash-newline between words", "orca \\\n  orchestration \\\n  worker-start"),
    # 2 unterminated quoting
    (False, "unterminated double quote", L + ' --title "x'),
    (False, "unterminated single quote", L + " --title 'x"),
    (False, "unterminated ANSI-C string", L + " --title $'x"),
    (False, "unterminated backtick", L + " --title `date"),
    (False, "unterminated command substitution", L + " --title $(date"),
    (False, "unterminated parameter expansion", L + " --title ${X:-a"),
    # 3 comments
    (False, "comment after a command on the same line", "ls # " + L),
    (True, "comment line between two commands", "ls\n# do not run twice\n" + L),
    (True, "comment after the launch", L + " # start it"),
    (True, "a#b is one word", "echo a#b; " + L),
    (False, "comment right after an operator", "echo x;# " + L),
    (False, "comment swallows a later operator", "echo a #; " + L),
    # 4 operators
    (False, "quoted && argument", 'echo "&&" ' + L),
    (False, "quoted | argument", 'echo "|" ' + L),
    (False, "quoted ( argument", 'echo "(" ' + L),
    (True, "after &&", "true && " + L),
    (True, "after ||", "false || " + L),
    (True, "after a background &", "sleep 1 & " + L),
    (True, "pipe without spaces", "echo a|" + L),
    (True, "inside ( ... )", "(" + L + ")"),
    (True, "inside { ...; }", "{ " + L + "; }"),
    # 5 redirections
    (True, "2>&1 after the launch", L + " 2>&1"),
    (True, ">/dev/null before the launch", ">/dev/null " + L),
    (True, "redirects in the middle keep the arguments", "orca orchestration worker-start >/dev/null 2>&1 --agent codex"),
    (True, "fd redirect before the program", "2>/dev/null " + L),
    (True, "&> before the program", "&>/dev/null " + L),
    (True, ">| after the launch", L + " >| out.log"),
    (False, "output redirect target named orca", "echo > " + L),
    (False, "fd input redirect target named orca", "cat 3< " + L),
    (False, "&> target named orca", "echo hi &> " + L),
    # 6 here-documents and here-strings
    (False, "body of a quoted-delimiter here-document", "cat <<'EOF'\n" + L + "\nEOF"),
    (True, "launch after a double-quoted-delimiter here-document", 'cat <<"EOF"\nx\nEOF\n' + L),
    (False, "body of a <<- here-document", "cat <<-EOF\n\t" + L + "\n\tEOF\n"),
    (True, "launch after a <<- here-document", "cat <<-EOF\n\tx\n\tEOF\n" + L),
    (False, "here-document without its delimiter line", "cat <<EOF\n" + L),
    (True, "<< inside a comment is text", "# cat <<EOF\n" + L),
    (True, "launch on the here-document line", "cat <<EOF; " + L + "\nbody\nEOF"),
    (True, "two here-documents, launch after both", "cat <<A <<B\na\nA\nb\nB\n" + L),
    (False, "two here-documents, launch in the second body", "cat <<A <<B\nA\n" + L + "\nB"),
    (False, "here-string argument named orca", "cat <<< " + L),
    (True, "launch after a here-string", "cat <<< x; " + L),
    # 7 command position
    (True, "after then", "if true; then " + L + "; fi"),
    (True, "after else", "if false; then :; else " + L + "; fi"),
    (True, "after elif", "if false; then :; elif " + L + "; then :; fi"),
    (True, "after do", "for i in 1; do " + L + "; done"),
    (True, "after while", "while " + L + "; do break; done"),
    (True, "after until", "until " + L + "; do :; done"),
    (True, "after !", "! " + L),
    (True, "after {", "{ " + L + "\n}"),
    (True, "after time", "time " + L),
    (True, "assignment after a reserved word", "if A=1 " + L + "; then :; fi"),
    (True, "two assignments", "A=1 B='x y' " + L),
    (False, "quoted reserved word is a program", '"if" ' + L),
    (False, "reserved word as an argument", "echo if " + L),
    (False, "quoted assignment is a program", '"A=1" ' + L),
    (False, "! after an assignment is a program, as in bash", "A=1 ! " + L),
    (False, "time after an assignment is a program, as in bash", "A=1 time " + L),
    # 8 the launch words
    (True, "orca-ide by path", "/usr/local/bin/orca-ide orchestration worker-start"),
    (False, "another program name", "orcas orchestration worker-start"),
    (True, "unquoted variable", "$ORCA_CLI_COMMAND orchestration worker-start"),
    (True, "double-quoted braced variable with default", '"${ORCA_CLI:-orca}" orchestration worker-start'),
    (False, "single-quoted variable is literal text", "'$ORCA_CLI_COMMAND' orchestration worker-start"),
    (False, "--help", L + " --help"),
    (False, "another subcommand", "orca orchestration worker-list"),
    (False, "the subcommand words in one quoted word", 'orca orchestration "worker-start --agent x"'),
    (False, "words in the wrong order", "orca worker-start orchestration"),
    # 9 not followed by design
    (False, "inside command substitution", 'echo "$(' + L + ')"'),
    (False, "inside command substitution of an assignment", "x=$(" + L + ")"),
    (False, "inside backticks", "echo `" + L + "`"),
    (False, "inside process substitution", "cat <(" + L + ")"),
    (False, "nested shell", "bash -c '" + L + "'"),
    (False, "wrapper env", "env " + L),
    (False, "wrapper sudo", "sudo " + L),
    (False, "wrapper timeout", "timeout 5 " + L),
    (False, "wrapper xargs", "echo | xargs " + L),
    (False, "wrapper exec", "exec " + L),
    (True, "operators inside a quoted $(...) argument", L + ' --title "$(date; echo x)"'),
    (True, "operators inside an unquoted $(...) argument", L + " --title $(a && b | c)"),
    (False, "semicolon inside $(...) does not end the outer command", "echo $(ls; ) " + L),
    (True, "operators inside ${...}", L + ' --spec "${SPEC:-a;b}"'),
    (False, "operators inside backticks", "echo `true; echo` " + L),
    # Self-attack: mentions that bash does not execute (checked against bash with a stub orca).
    (False, "attack: launch in a here-document inside $(...)", "git commit -m \"$(cat <<'EOF'\n" + L + "\nEOF\n)\""),
    (False, "attack: echo of the launch", "echo " + L),
    (False, "attack: printf to a file", "printf '%s\\n' '" + L + "' > notes.md"),
    (False, "attack: here-document body with a substitution", "cat > f <<EOF\n$(date) " + L + "\nEOF"),
    (False, "attack: grep with a here-string", 'grep -c "' + L + '" <<< "$LOG"'),
    (False, "attack: colon builtin", ": " + L),
    (False, "attack: comment holding &&", "true # && " + L),
    (False, "attack: escaped semicolon word", "echo \\; " + L),
    (False, "attack: alias definition", "alias o='" + L + "'"),
    (False, "attack: newline inside double quotes", 'echo "a\n' + L + '"'),
    (False, "attack: test expression", '[ "$x" = "' + L + '" ] && echo yes'),
    (False, "attack: ANSI-C string holding a semicolon", "echo $'\\'; " + L + "\\''"),
    (False, "attack: here-document with a pipe on its line", "cat <<EOF | sed s/a/b/\n" + L + "\nEOF"),
    (False, "attack: quoted delimiter with a space", "cat <<'A B'\n" + L + "\nA B\nls"),
    (False, "attack: backslash-quoted delimiter", "cat <<\\EOF\n" + L + "\nEOF"),
    (False, "attack: inside a parameter default", "echo ${X:-" + L + "}"),
    (False, "attack: shebang and comment", "#!/bin/bash\n# " + L),
    (False, "attack: comment holding quotes", "echo 'x' # it's \"" + L + "\""),
    (False, "attack: append to a log", "echo " + L + " >> log.md"),
    (False, "attack: <<- delimiter indented with spaces is not the end", "cat <<-EOF\n\t" + L + "\n    EOF\n" + L + "\nEOF"),
    (False, "attack: assignment of the launch text", "x='" + L + "'"),
    (False, "attack: unbalanced quote inside a here-document body", "cat <<EOF\n\"\n" + L + "\nEOF"),
    # Self-attack: unusual but valid executions (checked the same way).
    (True, "attack: launch after a here-document in $(...) with an apostrophe", "git commit -m \"$(cat <<'EOF'\ndon't\nEOF\n)\"; " + L),
    (True, "attack: comment with an apostrophe, launch next line", "ls # don't\n" + L),
    (True, "attack: semicolon without spaces", "cd /tmp;" + L),
    (True, "attack: tabs between words", "orca\torchestration\tworker-start"),
    (True, "attack: assignment, quoted variable and a substitution argument", 'ORCA_X=1 "$ORCA_CLI_COMMAND" orchestration worker-start --spec "$(cat brief.md)"'),
    (True, "attack: group with redirect and pipe", "{ " + L + "; } 2>&1 | tee log"),
    (True, "attack: if !", "if ! " + L + "; then exit 1; fi"),
    (True, "attack: time -p", "time -p " + L),
    (True, "attack: nested quotes with ) inside $(...)", L + " --title \"$(printf '%s' \"a)b\")\""),
    (True, "attack: after an assignment from $(...)", "out=$(date) && " + L),
    (True, "attack: here-document with a redirect on its line", "cat <<EOF >brief.md\nhello; orca\nEOF\n" + L + " --spec brief.md"),
    (True, "attack: quote-concatenated argument", L + " --title 'it'\"'\"'s'"),
    (True, "attack: launch reading a here-document", L + " --spec - <<'EOF'\nbody\nEOF"),
    (True, "attack: inside a while loop with input redirect", "while read x; do " + L + "; done < /dev/null\n" + L),
    (True, "attack: escaped quotes outside quotes", L + ' --title \\"x\\"'),
    (True, "attack: background launch", L + ' --spec "${SPEC}" &'),
    (True, "attack: double-quoted absolute path", '"/opt/orca/bin/orca" orchestration worker-start'),
    (True, "attack: piped into jq", "echo start; " + L + " | jq ."),
    (True, "attack: after ||", "[ -f x ] || " + L),
    (True, "attack: # inside a quoted argument", L + ' --title "a # b"'),
    (True, "attack: here-document in $(...) inside the launch arguments", L + " --title \"$(cat <<'EOF'\nit's\nEOF\n)\""),
    (True, "attack: comment inside $(...) with an apostrophe", L + " --title \"$(echo a # it's\n)\""),
    (True, "attack: arithmetic shift is not a here-document", "echo $((1<<2))\n" + L),
    (True, "attack: arithmetic shift inside an argument", L + ' --n "$((1 << 3))"\nls'),
    (True, "attack: case pattern inside $(...)", L + " --title \"$(case x in x) echo a;; esac)\""),
    # Correction cycle 3. B1: an array value is one assignment word, never commands.
    (False, "array: plain assignment", "cmd=(" + L + ")"),
    (False, "array: += assignment", "cmd+=(" + L + ")"),
    (False, "array: indexed assignment", "cmd[1]=(" + L + ")"),
    (False, "array: after declare", "declare -a cmd=(" + L + ")"),
    (False, "array: after local", "local cmd=(" + L + ")"),
    (False, "array: after export", "export cmd=(" + L + ")"),
    (False, "array: after readonly", "readonly cmd=(" + L + ")"),
    (False, "array: after typeset", "typeset cmd=(" + L + ")"),
    (False, "array: multi-line", "cmd=(\n  orca\n  orchestration worker-start\n  --agent codex\n)"),
    (False, "array: comment inside", "cmd=(orca # the CLI\n  orchestration worker-start)"),
    (False, "array: quoted elements", "cmd=('orca' \"orchestration\" worker-start)"),
    (False, "array: nested $(...) element", 'cmd=(' + L + ' --title "$(date; echo x)")'),
    (False, "array: then printf (the review case)", "cmd=(" + L + ")\nprintf '%s\\n' \"${cmd[@]}\""),
    (False, "array: then echo of its length", "cmd=(" + L + ")\necho \"${#cmd[@]}\""),
    (False, "array: as a prefix assignment is temporary", "cmd=(" + L + ") true\n\"${cmd[@]}\""),
    (False, "array: assigned in a subshell", "(cmd=(" + L + "))\n\"${cmd[@]}\""),
    (False, "array: assigned in a pipeline", "cmd=(" + L + ") | true\n\"${cmd[@]}\""),
    (False, "array: value outside an assignment is a syntax error", "echo cmd=(x); " + L),
    (False, "array: value after a quoted declare is a syntax error", '"declare" cmd=(x); ' + L),
    # B2: a remembered array run as the program.
    (True, "array run: \"${cmd[@]}\"", "cmd=(" + L + ")\n\"${cmd[@]}\""),
    (True, "array run: ${cmd[@]}", "cmd=(" + L + ")\n${cmd[@]}"),
    (True, "array run: ${cmd[*]}", "cmd=(" + L + ")\n${cmd[*]}"),
    (False, "array run: \"${cmd[*]}\" joins into one program word", "cmd=(" + L + ")\n\"${cmd[*]}\""),
    (True, "array run: the remaining words follow the elements", "cmd=(orca orchestration)\n\"${cmd[@]}\" worker-start --agent codex"),
    (True, "array run: built with +=", "cmd=(orca)\ncmd+=(orchestration worker-start)\n\"${cmd[@]}\""),
    (True, "array run: multi-line with a comment", "cmd=(\n  orca # the CLI\n  orchestration worker-start\n)\n\"${cmd[@]}\" --agent codex"),
    (True, "array run: quoted elements", "cmd=('orca' \"orchestration\" worker-start)\n\"${cmd[@]}\""),
    (True, "array run: after declare -a", "declare -a cmd=(" + L + ")\n\"${cmd[@]}\""),
    (True, "array run: after export", "export cmd=(" + L + ")\n\"${cmd[@]}\""),
    (True, "array run: after an assignment word", "cmd=(" + L + ")\nA=1 \"${cmd[@]}\""),
    (True, "array run: unquoted expansion splits an element", "cmd=(\"orca orchestration\" worker-start)\n${cmd[@]}"),
    (False, "array run: quoted expansion keeps an element whole", "cmd=(\"orca orchestration\" worker-start)\n\"${cmd[@]}\""),
    (True, "array run: an empty array leaves the next word as program", "cmd=()\n\"${cmd[@]}\" " + L),
    (False, "array run: an element that looks like an assignment is the program", "cmd=(A=1 " + L + ")\n\"${cmd[@]}\""),
    (False, "array run: reassigned to another command", "cmd=(" + L + ")\ncmd=(echo hi)\n\"${cmd[@]}\""),
    (False, "array run: element 0 changed", "cmd=(" + L + ")\ncmd[0]=echo\n\"${cmd[@]}\""),
    (False, "array run: scalar assignment changes element 0", "cmd=(" + L + ")\ncmd=echo\n\"${cmd[@]}\""),
    (False, "array run: unset", "cmd=(" + L + ")\nunset cmd\n\"${cmd[@]}\""),
    (False, "array run: read into it", "cmd=(" + L + ")\nread -ra cmd <<< 'echo hi'\n\"${cmd[@]}\""),
    (False, "array run: changed by arithmetic", "cmd=(" + L + ")\n(( cmd[0] = 1 ))\n\"${cmd[@]}\""),
    (False, "array run: after eval", "cmd=(" + L + ")\neval 'cmd=(echo)'\n\"${cmd[@]}\""),
    (False, "array run: never assigned", "\"${cmd[@]}\" orchestration worker-start"),
    (False, "array run: indexed elements are not followed", "cmd=([0]=orca [1]=orchestration [2]=worker-start)\n\"${cmd[@]}\""),
    (True, "array named like the Orca variable, run", "ORCA_CLI_COMMAND=(" + L + ")\n\"${ORCA_CLI_COMMAND[@]}\""),
    (False, "array named like the Orca variable, printed", "ORCA_CLI_COMMAND=(" + L + ")\necho \"${ORCA_CLI_COMMAND[@]}\""),
    (False, "array named like the Orca variable, then the variable as program", "ORCA_CLI_COMMAND=(echo)\n\"$ORCA_CLI_COMMAND\" orchestration worker-start"),
    (True, "Orca variable assigned orca in the script", "ORCA_CLI_COMMAND=orca\n\"$ORCA_CLI_COMMAND\" orchestration worker-start"),
    (False, "Orca variable assigned another program in the script", "ORCA_CLI_COMMAND=echo\n\"$ORCA_CLI_COMMAND\" orchestration worker-start"),
    (False, "Orca variable with :+ is not the variable", "${ORCA_CLI_COMMAND:+echo} orchestration worker-start"),
    (True, "array run: a function named by an element", "start() { " + L + "; }\ncmd=(start)\n\"${cmd[@]}\""),
    (True, "array run: a global array set in a function", "set_cmd() { cmd=(" + L + "); }\nset_cmd\n\"${cmd[@]}\""),
    (False, "array run: a local array of a function", "set_cmd() { local cmd=(" + L + "); }\nset_cmd\n\"${cmd[@]}\""),
    (True, "array run: declare -g in a function", "set_cmd() { declare -g cmd=(" + L + "); }\nset_cmd\n\"${cmd[@]}\""),
    (True, "array run: command skips the function that would change it", "cmd=(" + L + ")\nreset() { cmd=(echo); }\ncommand reset\n\"${cmd[@]}\""),
    # B3: a function definition does not run its body; a call does.
    (False, "function: { } body never called", "start() { " + L + "; }"),
    (True, "function: { } body called", "start() { " + L + "; }\nstart"),
    (False, "function: ( ) body never called", "start() ( " + L + " )"),
    (True, "function: ( ) body called", "start() ( " + L + " )\nstart"),
    (False, "function keyword: { } body never called", "function start { " + L + "; }"),
    (True, "function keyword: { } body called", "function start { " + L + "; }; start"),
    (False, "function keyword with (): ( ) body never called", "function start() ( " + L + " )"),
    (True, "function keyword with (): ( ) body called", "function start() ( " + L + " ); start"),
    (False, "function keyword: ( ) body without () never called", "function start (" + L + ")"),
    (False, "function: called before its definition", "start\nstart() { " + L + "; }"),
    (True, "function: calling another", "a() { b; }\nb() { " + L + "; }\na"),
    (False, "function: calling another, never called", "a() { b; }\nb() { " + L + "; }"),
    (True, "function: recursive", "a() { " + L + "; a; }\na"),
    (False, "function: recursive without a launch", "a() { b; }\nb() { a; }\na"),
    (False, "function: defined inside another, outer never called", "outer() { inner() { " + L + "; }; }\ninner"),
    (False, "function: defined inside another, inner never called", "outer() { inner() { " + L + "; }; }\nouter"),
    (True, "function: defined inside another, both called", "outer() { inner() { " + L + "; }; }\nouter\ninner"),
    (False, "function: if body never called", "f() if true; then " + L + "; fi"),
    (True, "function: if body called", "f() if true; then " + L + "; fi\nf"),
    (False, "function: body on the next line never called", "f()\n{\n  " + L + "\n}"),
    (True, "function: body with a redirect, called", "f() { " + L + "; } > /dev/null\nf"),
    (True, "function: called in a pipeline", "f() { " + L + "; }\nf | cat"),
    (True, "function: called by a quoted name", "f() { " + L + "; }\n\"f\""),
    (False, "function: named orca shadows the CLI", "orca() { echo stub; }\n" + L),
    (False, "function: unset before the call", "f() { " + L + "; }\nunset -f f\nf"),
    (False, "function: redefined before the call", "f() { " + L + "; }\nf() { :; }\nf"),
    (False, "function: defined in a subshell", "( f() { " + L + "; } )\nf"),
    (False, "function: defined in a pipeline", "f() { " + L + "; } | cat\nf"),
    (False, "function: defined after an assignment is a syntax error", "x=1 f() { :; }; " + L),
    (False, "function: quoted name is not defined", "\"f\"() { " + L + "; }\nf"),
    (False, "function: case pattern ) inside a ( ) body", "f() ( case x in x) echo;; esac; " + L + " )"),
    (True, "function: case pattern ) inside a ( ) body, called", "f() ( case x in x) echo;; esac; " + L + " )\nf"),
    # Self-attack over the Bash grammar: launch words present but not run, then run.
    (False, "grammar: pipeline element prints it", "echo " + L + " | cat"),
    (True, "grammar: |& pipeline", L + " |& cat"),
    (True, "grammar: && list, not evaluated", "false && " + L),
    (False, "grammar: for word list", "for w in " + L + "; do echo \"$w\"; done"),
    (True, "grammar: for body", "for w in a; do " + L + "; done"),
    (True, "grammar: arithmetic for", "for ((i = 0; i < 1; i++)); do " + L + "; done"),
    (False, "grammar: arithmetic for prints it", "for ((i = 0; i < 1; i++)) do echo \"" + L + "\"; done"),
    (True, "grammar: for with a { } body", "for w in a; { " + L + "; }"),
    (False, "grammar: select word list", "select w in " + L + "; do break; done < /dev/null"),
    (True, "grammar: select body", "select w in a; do " + L + "; break; done < /dev/null"),
    (False, "grammar: case subject and patterns", "case $x in orca|orchestration|worker-start) echo hit;; esac"),
    (True, "grammar: case item", "case x in x) " + L + ";; esac"),
    (True, "grammar: case item with ( pattern", "case x in (x|y) " + L + ";; esac"),
    (True, "grammar: case item after ;;&", "case x in a) echo;;& *) " + L + ";; esac"),
    (True, "grammar: case on several lines", "case x in\n  a)\n    echo a\n    ;;\n  *)\n    " + L + "\n    ;;\nesac"),
    (True, "grammar: case inside a subshell", "( case x in x) echo;; esac; " + L + " )"),
    (False, "grammar: if condition prints it", "if echo " + L + "; then :; fi"),
    (True, "grammar: if branch, not evaluated", "if false; then " + L + "; fi"),
    (False, "grammar: while condition prints it", "while echo " + L + "; do break; done"),
    (True, "grammar: while body, not evaluated", "while false; do " + L + "; done"),
    (False, "grammar: [[ ]] string", "[[ -n \"" + L + "\" ]] && echo yes"),
    (False, "grammar: [[ ]] with && and a regex", "[[ a && x =~ (orca|y) ]] && echo yes"),
    (True, "grammar: launch after [[ ]] on several lines", "[[ a &&\n  b ]]\n" + L),
    (False, "grammar: (( )) holding the words", "(( orca + orchestration + worker ))"),
    (True, "grammar: launch after (( ))", "(( 1 )) && " + L),
    (True, "grammar: (( )) shift is not a here-document", "(( x = 1 << 2 ))\n" + L),
    (True, "grammar: (( that is a nested subshell", "((" + L + ") )"),
    (False, "grammar: { } group prints it", "{ echo " + L + "; }"),
    (True, "grammar: { } groups nested without ;", "{ { true; } }; " + L),
    (True, "grammar: if condition is a group", "if { true; } then " + L + "; fi"),
    (True, "grammar: ! { }", "! { " + L + "; }"),
    (True, "grammar: time { }", "time { " + L + "; }"),
    (False, "grammar: coproc is a wrapper", "coproc " + L),
    (False, "grammar: coproc group is a wrapper", "coproc NAME { " + L + "; }"),
    (False, "grammar: a stray fi is a syntax error", "fi\n" + L),
    (False, "grammar: ;; outside case is a syntax error", "echo a;; " + L),
    (False, "grammar: in at command start is a syntax error", "in x; " + L),
    (False, "grammar: empty group is a syntax error", "{ }; " + L),
    (True, "grammar: exit does not stop the static reading", "exit 0\n" + L),
    (False, "grammar: set -n stops execution", "set -n\n" + L),
    (False, "grammar: aliases may rename the program", "shopt -s expand_aliases\nalias orca=echo\n" + L),
    (True, "grammar: += assignment word before the program", "A+=1 " + L),
    (True, "grammar: indexed assignment word before the program", "a[0]=x " + L),
    # Further self-attack after the first implementation.
    (False, "array run: unquoted, with IFS changed", "cmd=(" + L + ")\nIFS=o\n${cmd[@]}"),
    (False, "function running its arguments is not followed", 'run() { "$@"; }\nrun ' + L),
    (False, "function: here-document in the body", "f() {\n  cat <<EOF\n" + L + "\nEOF\n}\nf"),
    (True, "function: defined in an if branch, called", "if true; then f() { " + L + "; }; fi\nf"),
    (True, "function: defined after &&, called", "true && f() { " + L + "; }\nf"),
    (False, "function: comment holding } inside the body", "f() { # }\n  " + L + "\n}"),
    (False, "function: declare -f prints it", "f() { " + L + "; }\ndeclare -f f"),
    (True, "function: name with a hyphen", "start-worker() { " + L + "; }\nstart-worker"),
    (True, "function keyword: body on later lines", "function f\n{\n  " + L + "\n}\nf"),
    (False, "function keyword shadows the CLI", "function orca { :; }\n" + L),
    (True, "array run: in a subshell", "cmd=(" + L + ")\n( \"${cmd[@]}\" )"),
    (True, "array run: background call to a function does not change it", "cmd=(" + L + ")\nf() { cmd=(echo); }\nf &\n\"${cmd[@]}\""),
    (False, "array run: nameref may change it", "cmd=(" + L + ")\ndeclare -n r=cmd\nr=(echo)\n\"${cmd[@]}\""),
    (False, "array run: printf -v", "cmd=(" + L + ")\nprintf -v cmd '%s' echo\n\"${cmd[@]}\""),
    (False, "array run: let", "cmd=(" + L + ")\nlet cmd[0]=1\n\"${cmd[@]}\""),
    (False, "array run: unset of one element", "cmd=(" + L + ")\nunset 'cmd[0]'\n\"${cmd[@]}\""),
    (False, "array run: arithmetic expansion assigns", "cmd=(" + L + ")\n: $((cmd[0]=1))\n\"${cmd[@]}\""),
    (False, "array run: here-document body assigns", "cmd=(" + L + ")\ncat <<EOF\n$((cmd[0]=1))\nEOF\n\"${cmd[@]}\""),
    (False, "array run: --help among the elements", "cmd=(" + L + " --help)\n\"${cmd[@]}\""),
    (True, "array run: copied into another array", "a=(" + L + ")\nb=(\"${a[@]}\")\n\"${b[@]}\""),
    (False, "grammar: trap is not followed", "trap '" + L + "' EXIT"),
    (True, "group: function defined in { } without ; before }", "{ f() { " + L + "; } }\nf"),
    (False, "case: launch words as a pattern with escaped blanks", "case x in orca\\ orchestration\\ worker-start) ;; esac"),
    (True, "case: function defined in an item, called", "case x in x) f() { " + L + "; };; esac\nf"),
    (False, "set -o noexec", "set -o noexec\n" + L),
    (True, "set -e does not stop the reading", "set -euo pipefail\n" + L),
    (True, "exec with only redirects", "exec 3>&1\n" + L),
    (True, "local at top level still assigns", "local cmd=(" + L + ") 2>/dev/null\n\"${cmd[@]}\""),
    (True, "Orca variable assigned empty, default orca", "ORCA_CLI_COMMAND=\n\"${ORCA_CLI_COMMAND:-orca}\" orchestration worker-start"),
    (False, "array run: an element holding a known variable", 'ORCA=echo\ncmd=("$ORCA" orchestration worker-start)\n"${cmd[@]}"'),
    (True, "array run: an element holding a known orca variable", 'ORCA=orca\ncmd=("$ORCA" orchestration worker-start)\n"${cmd[@]}"'),
]
EOF
SCAN='import sys
sys.path[:0] = [sys.argv[1], sys.argv[2]]
import token_ledger, scan_rows
for expected, name, script in scan_rows.ROWS:
    got = token_ledger.runs_launch(script)
    print(("ok   " if got is expected else "FAIL ") + "scanner: " + name
          + ("" if got is expected else " (expected %s, got %s)" % (expected, got)))'
"$PY" -I -c "$SCAN" "$ROOT/tools" "$TMP" >"$TMP/scan.out" 2>&1 || bad "scanner table: import or run failed"
cat "$TMP/scan.out"
grep -q '^FAIL' "$TMP/scan.out" && fail=1
[ "$(grep -c '^ok   scanner: ' "$TMP/scan.out")" -ge 270 ] || bad "scanner table: fewer rows passed than expected"
grep -qi "command substitution" "$TMP/help.txt" && grep -qi "wrapper" "$TMP/help.txt" && grep -qi "comment" "$TMP/help.txt" \
  && ok "help states the scanner rules and its limits" || bad "help: scanner rules or limits not described"
grep -qi "structural evidence" "$TMP/help.txt" && grep -qi "dispatched worker that starts workers of its own is a" "$TMP/help.txt" \
  && ok "help states the role order and its reason" || bad "help: role order or its reason not described"
grep -qi "array value" "$TMP/help.txt" && grep -qi "define a function" "$TMP/help.txt" \
  && ok "help states the array and function rules" || bad "help: array or function rule not described"
grep -qi "the launch test is static" "$TMP/help.txt" && grep -qi "control flow" "$TMP/help.txt" \
  && grep -qi "never an invented one" "$TMP/help.txt" && grep -qi "coproc, nohup" "$TMP/help.txt" \
  && ok "help states the static limits" || bad "help: static limits not described"

exit $fail
