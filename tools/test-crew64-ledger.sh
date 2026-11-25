#!/usr/bin/env bash
# Unit test for tools/crew64_ledger.py: the crew64-map log writer and reader
# (decision 0010). Runs against throwaway repositories with a throwaway state
# directory. Exit 0 = all pass.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LEDGER="$ROOT/tools/crew64_ledger.py"
DEFAULTS="$ROOT/config/crew64.defaults.json"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export GIT_CONFIG_GLOBAL="$TMP/gitconfig"; : > "$GIT_CONFIG_GLOBAL"
export XDG_CONFIG_HOME="$TMP/xdg"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@x GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@x
export CREW64_STATE_DIR="$TMP/state"
unset CREW64_FEATURE_BUILD_MAP CREW64_LIMIT_REVIEW_CYCLES CREW64_THIS_HOST
fail=0
ok()  { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
L()   { (cd "$1" && shift && python3 -I "$LEDGER" "$@" 2>&1); }
# J evaluates an expression written in this test file over JSON read from stdin; the
# expression is test code, never data, so eval is safe here.
J()   { python3 -I -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
P="docs/superpowers/plans/2026-11-19-demo.md"
newrepo() { # <dir> <build_map true|false>
  git init -q "$1" && git -C "$1" commit -q --allow-empty -m init
  git config --global --add crew64.trustedRoot "$1"
  mkdir -p "$1/.claude"
  python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["features"]["build_map"]=sys.argv[3]=="true"; json.dump(d,open(sys.argv[2],"w"))' "$DEFAULTS" "$1/.claude/crew64.json" "$2"
}

# switch_off_writes_nothing
R0="$TMP/off"; newrepo "$R0" false
out="$(L "$R0" record --plan "$P" --task 1 --event planned --field title=x)"; rc=$?
[ "$rc" = 0 ] && [ ! -e "$TMP/state" ] && ok "switch_off_writes_nothing" || bad "switch_off_writes_nothing: rc=$rc out=$out $(ls -R "$TMP/state" 2>/dev/null)"

R="$TMP/on"; newrepo "$R" true
git -C "$R" remote add origin https://github.com/acme/demo.git

# dir_name
d="$(L "$R" path)"; real="$(cd "$R" && pwd -P)"
h="$(printf '%s' "$real" | sha256sum | cut -c1-12)"
[ "$d" = "$TMP/state/on-$h" ] && ok "dir_name" || bad "dir_name: $d (want $TMP/state/on-$h)"

# unknown_event_exit_2 / bad task
L "$R" record --plan "$P" --task 1 --event exploded >/dev/null; rc=$?
[ "$rc" = 2 ] && ok "unknown_event_exit_2" || bad "unknown_event_exit_2: rc=$rc"
L "$R" record --plan "$P" --task one --event planned >/dev/null; rc=$?
[ "$rc" = 2 ] && ok "non_integer_task_exit_2" || bad "non_integer_task_exit_2: rc=$rc"

# record_then_show_json
L "$R" record --plan "$P" --task 1 --event planned --field title="Brief template" --field tier=trivial --field rung=0 --field mode=native >/dev/null
L "$R" record --plan "$P" --task 1 --event dispatched --field worktree=/w/one --field branch=sky64/one --field dispatch=ctx_1 --field model=claude-sonnet-5-5 >/dev/null
L "$R" record --plan "$P" --task 1 --event review --field cycle=1 --field verdict=findings >/dev/null
L "$R" record --plan "$P" --task 1 --event review --field cycle=2 --field verdict=clean >/dev/null
L "$R" record --plan "$P" --task 1 --event escalated --field from=0 --field to=1 --field reason=files >/dev/null
L "$R" record --plan "$P" --task 1 --event committed --field sha=abc --field tokens_in=100 --field tokens_out=20 >/dev/null
L "$R" record --plan "$P" --task 1 --event pr_opened --field pr=41 --field pr_url=https://x/41 >/dev/null
L "$R" record --plan "$P" --task 1 --event merged --field sha=def >/dev/null
js="$(L "$R" show --json)"
t='[t for t in d["plans"][0]["tasks"] if t["task"]==1][0]'
got="$(printf '%s' "$js" | J "($t['title'],$t['tier'],$t['rung'],$t['mode'],$t['model'],$t['worktree'],$t['branch'],$t['dispatch'],$t['reviews'],$t['escalations'],$t['tokens_in'],$t['tokens_out'],$t['pr'],$t['pr_url'],$t['merged'],$t['abandoned'],$t['last_event'])")"
[ "$got" = "('Brief template', 'trivial', 0, 'native', 'claude-sonnet-5-5', '/w/one', 'sky64/one', 'ctx_1', 2, 1, 100, 20, 41, 'https://x/41', True, False, 'merged')" ] && ok "record_then_show_json" || bad "record_then_show_json: $got"
got="$(printf '%s' "$js" | J "d['plans'][0]['plan']")"
[ "$got" = "$P" ] && ok "show_names_the_plan" || bad "show_names_the_plan: $got"

# repo_json_written
rj="$(L "$R" path)/repo.json"
got="$(J "(d['v'],d['build_map'],d['review_cycles'],d['this_host'],d['repo_root'],d['github'],d['ledger_version'])" < "$rj" 2>&1)"
[ "$got" = "(1, True, 2, None, '$real', 'acme/demo', '1')" ] && ok "repo_json_written" || bad "repo_json_written: $got"
printf '%s' "$js" | J "d['repo']['github']" | grep -qx 'acme/demo' && ok "show_json_carries_repo" || bad "show_json_carries_repo"

# github null without a GitHub origin
R2="$TMP/nogh"; newrepo "$R2" true
L "$R2" record --plan "$P" --task 1 --event planned --field title=a >/dev/null
got="$(J "d['github']" < "$(L "$R2" path)/repo.json")"
[ "$got" = "None" ] && ok "github_null_without_origin" || bad "github_null_without_origin: $got"

# field values: JSON when they parse, else strings
L "$R2" record --plan "$P" --task 2 --event planned --field title="2. Upload form" --field rung=1 --field deps='[1]' >/dev/null
got="$(L "$R2" show --json | J "[(t['title'],t['rung']) for t in d['plans'][0]['tasks'] if t['task']==2][0]")"
[ "$got" = "('2. Upload form', 1)" ] && ok "field_values_parse_as_json_else_string" || bad "field_values: $got"

# last_value_wins
L "$R2" record --plan "$P" --task 1 --event dispatched --field worktree=/w/a >/dev/null
L "$R2" record --plan "$P" --task 1 --event dispatched --field worktree=/w/b >/dev/null
got="$(L "$R2" show --json | J "[t['worktree'] for t in d['plans'][0]['tasks'] if t['task']==1][0]")"
[ "$got" = "/w/b" ] && ok "last_value_wins" || bad "last_value_wins: $got"

# malformed_lines_skipped
log="$(L "$R2" path)/2026-11-19-demo.jsonl"
printf '{"v":1,\nnot json\n' >> "$log"
L "$R2" record --plan "$P" --task 3 --event planned --field title=c >/dev/null
js="$(L "$R2" show --json)"
got="$(printf '%s' "$js" | J "(d['skipped_lines'], sorted(t['task'] for t in d['plans'][0]['tasks']))")"
[ "$got" = "(2, [1, 2, 3])" ] && ok "malformed_lines_skipped" || bad "malformed_lines_skipped: $got"

# newest_plan_first
P2="docs/superpowers/plans/2026-11-20-other.md"
L "$R2" record --plan "$P2" --task 1 --event planned --field title=z >/dev/null
got="$(L "$R2" show --json | J "[p['plan'] for p in d['plans']]")"
[ "$got" = "['$P2', '$P']" ] && ok "newest_plan_first" || bad "newest_plan_first: $got"
got="$(L "$R2" show --json --plan "$P" | J "[p['plan'] for p in d['plans']]")"
[ "$got" = "['$P']" ] && ok "show_plan_filter" || bad "show_plan_filter: $got"

# text show lists tasks
out="$(L "$R2" show)"
case "$out" in *"2026-11-19-demo"*"Upload form"*) ok "show_text_lists_tasks";; *) bad "show_text_lists_tasks: $out";; esac

# concurrent_appends_whole_lines
R3="$TMP/conc"; newrepo "$R3" true
big="$(head -c 2048 /dev/zero | tr '\0' 'x')"
for i in $(seq 1 20); do L "$R3" record --plan "$P" --task "$i" --event planned --field title="$big" >/dev/null & done; wait
log3="$(L "$R3" path)/2026-11-19-demo.jsonl"
n="$(wc -l < "$log3")"; bad_lines="$(python3 -I -c 'import json,sys
b=0
for line in open(sys.argv[1]):
    try: json.loads(line)
    except ValueError: b+=1
print(b)' "$log3")"
[ "$n" = 20 ] && [ "$bad_lines" = 0 ] && ok "concurrent_appends_whole_lines" || bad "concurrent_appends_whole_lines: lines=$n bad=$bad_lines"

# a symlinked log directory or log file is refused, its target untouched
R4="$TMP/link"; newrepo "$R4" true
d4="$(L "$R4" path)"; mkdir -p "$(dirname "$d4")" "$TMP/elsewhere"; ln -s "$TMP/elsewhere" "$d4"
L "$R4" record --plan "$P" --task 1 --event planned --field title=a >/dev/null; rc=$?
[ "$rc" != 0 ] && [ -z "$(ls -A "$TMP/elsewhere")" ] && ok "symlinked_log_dir_refused" || bad "symlinked_log_dir_refused: rc=$rc $(ls -A "$TMP/elsewhere")"
rm "$d4"; mkdir -p "$d4"; echo keep > "$TMP/victim"; ln -s "$TMP/victim" "$d4/2026-11-19-demo.jsonl"
L "$R4" record --plan "$P" --task 1 --event planned --field title=a >/dev/null; rc=$?
[ "$rc" != 0 ] && [ "$(cat "$TMP/victim")" = keep ] && ok "symlinked_log_file_refused" || bad "symlinked_log_file_refused: rc=$rc $(cat "$TMP/victim")"

# outside a trusted repository: nothing is written, exit 0 (switch reads as default off)
U="$TMP/untrusted"; git init -q "$U"; mkdir -p "$U/.claude"; cp "$DEFAULTS" "$U/.claude/crew64.json"
before="$(ls "$TMP/state" | wc -l)"
L "$U" record --plan "$P" --task 1 --event planned --field title=a >/dev/null; rc=$?
[ "$rc" = 0 ] && [ "$(ls "$TMP/state" | wc -l)" = "$before" ] && ok "untrusted_repo_writes_nothing" || bad "untrusted_repo_writes_nothing: rc=$rc"

# show with no log: empty plans, exit 0
R5="$TMP/empty"; newrepo "$R5" true
got="$(L "$R5" show --json | J "(d['plans'], d['skipped_lines'])")"
[ "$got" = "([], 0)" ] && ok "show_without_log_is_empty" || bad "show_without_log_is_empty: $got"

# Codex task 2: malformed event shapes are skipped and counted, never folded
R6="$TMP/shapes"; newrepo "$R6" true
L "$R6" record --plan "$P" --task 1 --event planned --field title=ok >/dev/null
log6="$(L "$R6" path)/2026-11-19-demo.jsonl"
printf '%s\n' '{"v":1,"ts":"2026-11-25T00:00:00+00:00","task":true,"event":"planned","plan":"'"$P"'"}' \
  '{"v":1,"ts":"2026-11-25T00:00:00+00:00","task":2,"event":"planned","plan":"'"$P"'","title":["wrong type"]}' \
  '{"v":1,"task":3,"event":"planned","plan":"'"$P"'"}' \
  '{"v":1,"ts":"2026-11-25T00:00:00+00:00","task":4,"event":"planned","plan":"'"$P"'","rung":"one"}' >> "$log6"
got="$(L "$R6" show --json | J "(d['skipped_lines'], [t['task'] for t in d['plans'][0]['tasks']])")"
[ "$got" = "(4, [1])" ] && ok "malformed_shapes_skipped" || bad "malformed_shapes_skipped: $got"
# known string fields stay strings, known integer fields must be integers
L "$R6" record --plan "$P" --task 5 --event planned --field title=5 --field model=2 >/dev/null
got="$(L "$R6" show --json | J "[(t['title'],t['model']) for t in d['plans'][0]['tasks'] if t['task']==5][0]")"
[ "$got" = "('5', '2')" ] && ok "numeric_looking_strings_stay_strings" || bad "numeric_looking_strings_stay_strings: $got"
L "$R6" record --plan "$P" --task 5 --event planned --field rung=one >/dev/null; rc=$?
[ "$rc" = 2 ] && ok "non_integer_rung_exit_2" || bad "non_integer_rung_exit_2: rc=$rc"
L "$R6" record --plan "$P" --task 5 --event planned --field 'deps=["a"]' >/dev/null; rc=$?
[ "$rc" = 2 ] && ok "deps_must_be_task_numbers" || bad "deps_must_be_task_numbers: rc=$rc"

# Codex task 2: a short write is rolled back and reported, the next event stays whole
R7="$TMP/short"; newrepo "$R7" true
L "$R7" record --plan "$P" --task 1 --event planned --field title=first >/dev/null
log7="$(L "$R7" path)/2026-11-19-demo.jsonl"; size0="$(stat -c %s "$log7")"
big="$(head -c 4096 /dev/zero | tr '\0' 'y')"
out="$( (ulimit -f 1; cd "$R7" && python3 -I "$LEDGER" record --plan "$P" --task 2 --event planned --field title="$big") 2>&1)"; rc=$?
[ "$rc" != 0 ] && [ "$(stat -c %s "$log7")" = "$size0" ] && case "$out" in *"short write"*) true;; *) false;; esac && ok "short_write_rolled_back" || bad "short_write_rolled_back: rc=$rc size=$(stat -c %s "$log7") was=$size0 out=$out"
L "$R7" record --plan "$P" --task 3 --event planned --field title=after >/dev/null
got="$(L "$R7" show --json | J "(d['skipped_lines'], [t['task'] for t in d['plans'][0]['tasks']])")"
[ "$got" = "(0, [1, 3])" ] && ok "next_event_whole_after_short_write" || bad "next_event_whole_after_short_write: $got"

# Codex task 4 cycle 2: the model's provenance travels with it
R8="$TMP/prov"; newrepo "$R8" true
L "$R8" record --plan "$P" --task 1 --event planned --field model=claude-opus-5-5 >/dev/null
L "$R8" record --plan "$P" --task 1 --event dispatched --field worktree=/w/p --field dispatch=ctx_1 >/dev/null
got="$(L "$R8" show --json | J "[(t['model'],t['model_source']) for t in d['plans'][0]['tasks']][0]")"
[ "$got" = "('claude-opus-5-5', 'planned')" ] && ok "launch_without_model_keeps_planned_source" || bad "launch_without_model_keeps_planned_source: $got"
L "$R8" record --plan "$P" --task 1 --event native_started --field model=claude-fable-5-1 >/dev/null
got="$(L "$R8" show --json | J "[(t['model'],t['model_source']) for t in d['plans'][0]['tasks']][0]")"
[ "$got" = "('claude-fable-5-1', 'launch')" ] && ok "launch_with_model_sets_launch_source" || bad "launch_with_model_sets_launch_source: $got"
L "$R8" record --plan "$P" --task 2 --event review --field cycle=1 >/dev/null
got="$(L "$R8" show --json | J "[t['model_source'] for t in d['plans'][0]['tasks'] if t['task']==2][0]")"
[ "$got" = "None" ] && ok "no_model_no_source" || bad "no_model_no_source: $got"

exit $fail
