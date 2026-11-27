#!/usr/bin/env bash
# Pins the wording of the model ladder (docs/decisions/0004-model-ladder.md)
# across the files that carry it. Exits 1 and lists every missing
# "file: phrase" so a later edit cannot silently drop a rule.
set -u

cd "$(dirname "$0")/.." || exit 1

missing=0

need() {
  local file="$1" phrase="$2"
  if ! grep -qF -- "$phrase" "$file" 2>/dev/null; then
    printf '%s: %s\n' "$file" "$phrase"
    missing=$((missing + 1))
  fi
}
forbid() {
  local file="$1" phrase="$2"
  if grep -qF -- "$phrase" "$file" 2>/dev/null; then
    printf '%s: must not contain %s\n' "$file" "$phrase"; missing=$((missing + 1))
  fi
}
agent_fields() { # file field... : the agent file's frontmatter is exactly these fields
  # A field is "key=value" (the line must read exactly "key: value") or "key"
  # (free text, which must be a folded block: "key: >-", then one or more
  # lines indented by exactly two spaces). The frontmatter is held to one
  # canonical form, so that what this check sees is what any YAML parser sees
  # and nothing in it can be malformed YAML (Claude Code drops every field of
  # an agent whose frontmatter does not parse, the model and tools limits
  # included): "---" on line 1 and a closing "---"; inside, only those lines,
  # each key once, no key outside the listed set, printable ASCII only.
  # Anything else is rejected rather than interpreted: quoted or spaced keys,
  # comments, inline free text, continuation lines, nested values, blank or
  # uneven block lines, carriage returns and Unicode line breaks.
  local out
  if ! out="$(python3 -I -c '
import re, sys

path, wanted = sys.argv[1], [a.partition("=") for a in sys.argv[2:]]


def fail(msg):
    print(f"{path}: {msg}")
    sys.exit(1)


try:
    with open(path, "rb") as fh:
        raw = fh.read().split(b"\n")
except OSError as exc:
    fail(f"cannot read the agent file: {exc}")
if raw[0] != b"---":
    fail("no frontmatter block on line 1")
if b"---" not in raw[1:]:
    fail("the frontmatter block is not closed")
block = raw[1:raw.index(b"---", 1)]
for number, line in enumerate(block, start=2):
    if any(byte < 0x20 or byte > 0x7E for byte in line):
        fail(f"line {number}: only printable ASCII is accepted in the frontmatter")
fields, folded_lines, folded = {}, {}, None
for number, line in enumerate((line.decode("ascii") for line in block), start=2):
    plain = re.fullmatch(r"([A-Za-z][A-Za-z0-9_-]*): (\S.*)", line)
    if plain:
        key, value = plain.groups()
        if key in fields:
            fail(f"line {number}: frontmatter key {key} is declared twice")
        fields[key] = value
        folded = key if value == ">-" else None
        if folded:
            folded_lines[key] = 0
    elif folded and re.fullmatch(r"  \S.*", line):
        folded_lines[folded] += 1
    else:
        fail(f"line {number}: not a plain key: value line, nor a two-space line of a folded block")
allowed = [key for key, _, _ in wanted]
for key in fields:
    if key not in allowed:
        fail(f"frontmatter key {key} is not one of: {", ".join(allowed)}")
for key, pinned, value in wanted:
    if key not in fields:
        fail(f"frontmatter must carry the field {key}")
    if pinned and fields[key] != value:
        fail(f"frontmatter must carry exactly: {key}: {value}")
    if not pinned and not folded_lines.get(key):
        fail(f"frontmatter field {key} must be a folded block: a >- line, then lines indented by two spaces")
' "$@" 2>&1)"; then
    printf '%s\n' "$out"
    missing=$((missing + 1))
  fi
}

need docs/05-delegation.md "## Model ladder"
need docs/05-delegation.md "rung defaults to its tier"
need docs/05-delegation.md "risky tier is always rung 2"
need docs/05-delegation.md "never moved down a rung"
need docs/05-delegation.md 'at most `limits.review_cycles` escalations'
need docs/05-delegation.md "identical at every rung"
need docs/05-delegation.md "only through a new decision record"
need docs/05-delegation.md "docs/12-orca-setup.md records a working dsh"
need docs/05-delegation.md "## Plans and owner items"
need docs/05-delegation.md "## Ladder review"
# Final-review pins (2026-11-17)
need docs/05-delegation.md "gpt-6.1-sol"
need docs/05-delegation.md "reported to the owner and corrected by a decision record"
need docs/05-delegation.md "At rung 2, an escalation re-dispatches at rung 2"
need docs/05-delegation.md 'one allowance of `limits.review_cycles` per task'
need docs/05-delegation.md 'up to `limits.review_cycles` correction cycles (default 2)'
need docs/05-delegation.md 'DeepSeek row where `platform.hosts` has an entry for the host, otherwise the Claude row'
# Decision 0005: portability
need docs/05-delegation.md ".claude/crew64.json"
need docs/05-delegation.md "config/crew64.defaults.json"
need docs/05-delegation.md "gateway.kind"
need docs/05-delegation.md "the configured gateway"
need AGENTS.md "features.bot_identity"
need AGENTS.md "install-bot-identity.sh"
need README.md "## Using this on your own setup"
need README.md "tools/crew64-enable.sh"
need README.md "config/examples/orca-solvela.json"
need README.md "crew64.trustedRoot"
need README.md "## Upgrading an existing install"
need README.md "re-run tools/crew64-enable.sh against each existing main checkout"
need docs/decisions/0005-feature-switches-and-portability.md "until it is registered every reader uses the defaults"
need docs/decisions/0005-feature-switches-and-portability.md "crew64.trustedRoot"
need docs/12-orca-setup.md "crew64.bot.name"
need docs/05-delegation.md "except a budget or provider error"
need docs/05-delegation.md "Rung: <n>; Model: <id>; Tokens: <in>/<out>"
need docs/05-delegation.md "no Claude Code skills or hooks"

need AGENTS.md "complexity rung"
need AGENTS.md 'one allowance of `limits.review_cycles` per task'
need AGENTS.md "one budget, not three"

need skills/orchestrator/SKILL.md "Rung:"
need skills/orchestrator/SKILL.md "--model"
need skills/orchestrator/SKILL.md "x-solvela-session"
need skills/orchestrator/SKILL.md "rung 1"
need skills/orchestrator/SKILL.md "one rung higher"
need skills/orchestrator/SKILL.md "budget"
need skills/orchestrator/SKILL.md "Risky is always rung 2"
need skills/orchestrator/SKILL.md "When the allowance is spent"
need skills/orchestrator/SKILL.md "limits.review_cycles"
need skills/orchestrator/SKILL.md "CREW64_LIMIT_REVIEW_CYCLES"
need skills/orchestrator/SKILL.md "grants one more cycle"
need config/crew64.defaults.json '"review_cycles": 2'
need config/examples/orca-solvela.json '"review_cycles": 3'
# Decision 0007: the literal allowance of two is gone from live policy.
forbid AGENTS.md "allowance of two"
forbid docs/05-delegation.md "allowance of two"
forbid docs/05-delegation.md "at most two escalations"
forbid docs/05-delegation.md "up to two correction cycles"
forbid skills/orchestrator/SKILL.md "allowance of two"
forbid skills/orchestrator/SKILL.md "After two escalations"
forbid skills/orchestrator/SKILL.md "two-cycle allowance"
# Decision 0007: every brief names the runtime floor the review applies to.
need agents/specialist-agent.md.tmpl "Runtime:"
need agents/docs-engineer.md "Runtime:"
need skills/orchestrator/SKILL.md "Runtime:"
need skills/orchestrator/SKILL.md "outside that floor are out of scope"
need docs/05-delegation.md "Runtime:"
need AGENTS.md "Python 3.13+"
need .claude-plugin/plugin.json '"version": "0.9.1"'
# Field fixes 2026-11-18: briefs travel by --spec-file from the scratchpad.
need skills/orchestrator/SKILL.md "--spec-file"
need skills/orchestrator/SKILL.md "the guard allows Write and Edit there"
need README.md "/harness-enable"
need tools/harness-enable-skill/SKILL.md "crew64@crew64"
need tools/harness-enable-skill/enable.sh.tmpl "@CREW64_ENABLE@"
need skills/orchestrator/SKILL.md "orca-version-check.sh"
need docs/12-orca-setup.md "| Orca | 1.4.271"
need AGENTS.md "test-orca-version-check.sh"
need skills/orchestrator/SKILL.md "At rung 2, an escalation re-dispatches at rung 2"
need skills/orchestrator/SKILL.md "model parameter of the Agent tool"
need skills/orchestrator/SKILL.md "DeepSeek row where platform.hosts has an entry for the current host, otherwise the Claude row"
need skills/orchestrator/SKILL.md '${CLAUDE_PLUGIN_ROOT}/docs/12-orca-setup.md'
need skills/orchestrator/SKILL.md "Rung: <n>; Model: <id>; Tokens: <in>/<out>"
need skills/orchestrator/SKILL.md "--model gpt-6.1-sol --effort"
need skills/orchestrator/SKILL.md "--model claude-sonnet-5-5"
need skills/orchestrator/SKILL.md "role attribution through the team API key"
# Decision 0005: configuration, switches, platform seam
need skills/orchestrator/SKILL.md "## Configuration"
need skills/orchestrator/SKILL.md 'crew64_config.py" status'
need skills/orchestrator/SKILL.md "CREW64_FEATURE_"
need skills/orchestrator/SKILL.md "model_ladder"
need skills/orchestrator/SKILL.md "When model_ladder is off"
need skills/orchestrator/SKILL.md "When metering is none"
need skills/orchestrator/SKILL.md "When bot_identity is off"
need skills/orchestrator/SKILL.md "## Platform seam"
need skills/orchestrator/SKILL.md "create an isolated workspace"
need skills/orchestrator/SKILL.md "hand a diff to a reviewer"
need skills/orchestrator/SKILL.md "platform.hosts"
need skills/orchestrator/SKILL.md "gateway.kind"
need skills/orchestrator/SKILL.md "config/crew64.defaults.json"

need docs/templates/plan.md "| Vendor |"

need docs/12-orca-setup.md "## Model ladder routing"
need docs/12-orca-setup.md "applies once the profile row below is verified"

need agents/specialist-agent.md.tmpl "Rung:"
need agents/specialist-agent.md.tmpl "budget"
need agents/specialist-agent.md.tmpl "tokens"

need agents/docs-engineer.md "Rung:"

need docs/templates/plan.md "| Rung |"
need docs/templates/plan.md "## Owner items"
need docs/templates/plan.md "## Tooling"

need skills/plan-tooling/SKILL.md "name: plan-tooling"

# Decision 0008: scout64, the read-only Haiku helper. Its tools field carries no
# write tool, and its prompt makes "could not answer" a first-class result. The
# frontmatter is pinned as a whole: exactly these four fields, so no other
# field can widen what the scout may do, and matching text elsewhere in the
# file does not satisfy the pin (tools/test-check-ladder-docs.sh).
agent_fields agents/scout64.md name=scout64 description model=haiku "tools=Read, Grep, Glob, Bash"
need agents/scout64.md "could not answer"
need agents/scout64.md "never write, edit, commit"
forbid agents/scout64.md "Write,"
forbid agents/scout64.md "Edit,"
# Decision 0008: the rule. The skill states both the on and the off behaviour,
# so an off switch never leaves the orchestrator without a rule.
need skills/orchestrator/SKILL.md "crew64:scout64"
need skills/orchestrator/SKILL.md "When the scout's first line is"
need skills/orchestrator/SKILL.md "With \`features.scout64\` off"
need docs/05-delegation.md "crew64:scout64"
need README.md "features.scout64"
need config/crew64.defaults.json '"scout64": true'
forbid skills/orchestrator/SKILL.md "Native read-only subagents run on the rung 1 model from the table"
forbid docs/05-delegation.md "read-only native subagents run at rung 1 by default, and at rung 2 only"

# Decision 0009: the process ladder. Mode (native or delegated) is decided by
# checkable facts; risk still decides review; native never touches the main checkout.
need skills/orchestrator/SKILL.md "## Process ladder"
need skills/orchestrator/SKILL.md "Risky tier is never native, whatever \`process.default_mode\` says."
need skills/orchestrator/SKILL.md "stops, commits its work in progress, and hands the worktree to a worker; the mode never goes back to native."
need skills/orchestrator/SKILL.md "mode=native tier=<tier> rung=<rung>"
need skills/orchestrator/SKILL.md "Docs-only diffs skip Codex at normal tier; any code change gets it."
need skills/orchestrator/SKILL.md "With \`features.process_ladder\` off every task is delegated."
need skills/orchestrator/SKILL.md "return to the main checkout"
need skills/orchestrator/SKILL.md "you do not commit in the main checkout; in native mode you work in a task worktree"
need skills/orchestrator/SKILL.md "CREW64_PROCESS_MODE"
need docs/05-delegation.md "## Process ladder"
need docs/05-delegation.md "Risky tier is never native"
need docs/05-delegation.md "never goes back to native"
need docs/05-delegation.md "Process numbers"
need docs/05-delegation.md "and the mode (native or delegated)"
need AGENTS.md "in the main checkout; in native mode"
need docs/templates/plan.md "| Mode |"
need docs/templates/plan.md "native / delegated (risky is always delegated)"
need README.md "features.process_ladder"
need config/crew64.defaults.json '"native_max_files": 3'
need config/crew64.defaults.json '"native_max_tool_calls": 40'
need tools/hooks/orchestrator-guard.py "Process ladder"
forbid skills/orchestrator/SKILL.md "You do not write files and you do not commit."
forbid skills/orchestrator/SKILL.md "Anything that writes runs as an Orca worker."
forbid AGENTS.md "does not write code or commit, apart"
forbid docs/05-delegation.md "Otherwise it delegates at every tier."
# Codex cycle 1 on decision 0009: the file count sees every untracked file, a
# planned native task keeps its plan's rung, and the tier and summary texts
# carry the native exceptions.
need skills/orchestrator/SKILL.md "git status --porcelain --untracked-files=all"
need docs/05-delegation.md "git status --porcelain --untracked-files=all"
need skills/orchestrator/SKILL.md "its plan row's rung"
forbid skills/orchestrator/SKILL.md "Record the rung the tier gives"
need AGENTS.md "a docs-only native diff skips the review"
need docs/05-delegation.md "none for a docs-only native diff"
forbid README.md "orchestrates without writing code"
forbid docs/05-delegation.md "the orchestrator does not code"
need docs/05-delegation.md "# Delegation policy: the orchestrator does not write in the main checkout"
# The orchestrator line harness-enable writes into an application repo's CLAUDE.md.
need tools/crew64-enable.sh "The orchestrator does not write or commit in the main checkout; in native mode it works in a task worktree."
need docs/11-plugin-install.md "The orchestrator does not write or commit in the main checkout; in native mode it works in a task worktree."
forbid docs/11-plugin-install.md "The orchestrator does not write or commit."
# This repository's own CLAUDE.md agrees with AGENTS.md on native mode.
need CLAUDE.md "in the main checkout"
forbid CLAUDE.md "does not write code; specialists implement"


# Decision 0010: field fixes of 2026-11-26.
# The session runs in the repository its tasks change.
need skills/orchestrator/SKILL.md "The session runs in a workspace of the repository its tasks change."
# DeepSeek at rung 2 only where the host names a "2" overlay; never the rung 0 one; escalation goes to Claude.
need docs/05-delegation.md 'only where that host entry'"'"'s `dsh_profiles` has a non-empty `"2"` name'
need docs/05-delegation.md "never the rung 0 one"
need docs/05-delegation.md "never goes back to the DeepSeek row"
need docs/05-delegation.md "changed the rung 2 DeepSeek cell without such numbers"
need skills/orchestrator/SKILL.md 'dsh_profiles` has a non-empty `"2"` name'
need skills/orchestrator/SKILL.md "never back to the DeepSeek row"
need skills/orchestrator/SKILL.md "rung-2 Claude worker (never the DeepSeek row)"
need docs/templates/plan.md 'names a `"2"` overlay'
forbid docs/05-delegation.md "not used; rung 2 implementation goes to the Claude row"
forbid config/examples/orca-solvela.json '"2":'
forbid config/crew64.defaults.json "dsh_profiles"
# Reviews: complete first pass, blocker or follow-up, re-review scoped to the fix.
need skills/orchestrator/SKILL.md "the review is complete, not incremental"
need skills/orchestrator/SKILL.md 'Mark each finding `blocker` or `follow-up`'
need skills/orchestrator/SKILL.md "Only blockers start a correction cycle."
need skills/orchestrator/SKILL.md "names the earlier blockers and the fix commit range"
need AGENTS.md 'each marked `blocker` or `follow-up`; only blockers start a correction cycle'
# Order: review until clean, deploy once, live check, merge.
need skills/orchestrator/SKILL.md "implement, review until clean, deploy the reviewed head once, run the live check, then merge"
need skills/orchestrator/SKILL.md "A branch is not deployed before its review is clean"
need AGENTS.md "review until clean, deploy the reviewed head once, run the live check, then merge"
# No polling: end the turn; the installed guide wins.
need skills/orchestrator/SKILL.md "end the turn after \`worker-start\`"
need skills/orchestrator/SKILL.md "the installed guide wins"
need skills/orchestrator/SKILL.md "worker-read --dispatch"
forbid skills/orchestrator/SKILL.md "--timeout-ms 900000"
forbid skills/orchestrator/SKILL.md "check --ack <delivery id>"
need docs/12-orca-setup.md "## Orca 1.4.271 checks"
# Codex review of 25803ea, blocker 3: only a blocker escalates.
need docs/05-delegation.md 'the reviewer records a finding it marked `blocker` under the review rules'
need skills/orchestrator/SKILL.md 'the reviewer records a finding it marked `blocker` under the review rules'
need docs/decisions/0010-field-fixes-2026-11-26.md 'a reviewer finding marked `blocker` under section 3'
forbid docs/05-delegation.md "reviewer records a correctness finding"
forbid skills/orchestrator/SKILL.md "reviewer records a correctness finding"
forbid docs/decisions/0010-field-fixes-2026-11-26.md "reviewer correctness finding"
# The guard allows Claude Code memory files, home from the password database.
need tools/hooks/orchestrator-guard.py "def memory_target"
need tools/hooks/orchestrator-guard.py "pwd.getpwuid(os.getuid()).pw_dir"
need docs/05-delegation.md "Claude Code memory files"
# Orchestrator default and the global CLAUDE.md section.
need config/crew64.defaults.json '"orchestrator": "claude-fable-5-2"'
need docs/05-delegation.md "shipped default \`claude-fable-5-2\`"
need skills/orchestrator/SKILL.md "shipped default \`claude-fable-5-2\`"
forbid skills/orchestrator/SKILL.md "claude-fable-5-1"
need skills/orchestrator/SKILL.md "Agent roles (Orca)"
need docs/decisions/0010-field-fixes-2026-11-26.md "no such numbers exist yet"

# Decision 0011: the merge gate is machines (ci and codex-review on the same
# head), the owner is told, no human approval, no agent approval, and a
# protection that still requires an approving review is reported, not worked around.
need AGENTS.md 'the `ci` check is green on its head; the `codex-review` status on that same head is `success`'
need AGENTS.md "No human approval is required to merge, and no agent approves a pull request to satisfy a review rule."
need AGENTS.md "A bot approval of agent work is not a review."
need AGENTS.md "is misconfigured for this harness: the orchestrator reports it to the owner and does not work around it"
need AGENTS.md "tools/bot/review-status.sh"
need AGENTS.md "no review required: <reason>"
need AGENTS.md "reports the missing CI as a gap in the completion report"
forbid AGENTS.md "the merge waits for a human approval"
forbid AGENTS.md "does not replace human approval"
need skills/orchestrator/SKILL.md 'the `ci` check is green on its head; the `codex-review` status on that same head is `success`'
need skills/orchestrator/SKILL.md "No human approval is required, and no agent approves a pull request to satisfy a review rule."
need skills/orchestrator/SKILL.md "A bot approval of agent work is not a review."
need skills/orchestrator/SKILL.md "is misconfigured for this harness: report it to the owner and do not work around it"
need skills/orchestrator/SKILL.md "tools/bot/review-status.sh"
need skills/orchestrator/SKILL.md "only for the exact SHA the reviewer named in its verdict line"
need skills/orchestrator/SKILL.md "no review required: <reason>"
need skills/orchestrator/SKILL.md "Report the missing CI as a gap in the completion report; do not block on it."
need skills/orchestrator/SKILL.md 'the "allowance spent" question'
need docs/05-delegation.md "no human approval is required, and no agent approves a pull request to satisfy a review rule"
need docs/05-delegation.md "codex-review"
need docs/09-agent-identity.md "superseded by [decision 0011]"
need docs/12-orca-setup.md "review-status.sh"
forbid docs/12-orca-setup.md "The owner approves the pull request."
forbid docs/12-orca-setup.md "waits on the Run inbox"
forbid README.md "the owner approves where branch protection requires it"
forbid README.md "Human approval remains manual"
forbid CLAUDE.md "human approval remains separate where branch protection requires it"
forbid docs/11-plugin-install.md "(one approving review, admin enforcement, no force pushes)"
need docs/decisions/0011-machine-merge-gate.md "does not prove that a review happened"
need docs/decisions/0011-machine-merge-gate.md "## How to revert"
need .github/workflows/ci.yml "  ci:"
# Codex review of 74519d5, blocker 2: the verdict contract, so follow-ups alone never post failure.
need AGENTS.md "VERDICT: CLEAN <full reviewed sha>"
need AGENTS.md "VERDICT: FINDINGS <full reviewed sha>"
need AGENTS.md "Follow-ups alone never make a FINDINGS verdict"
need skills/orchestrator/SKILL.md "Every reviewer brief, first review and re-review, requires the verdict contract"
need skills/orchestrator/SKILL.md "means no blocker remains (follow-ups may still be listed)"
need skills/orchestrator/SKILL.md "means at least one blocker remains"
need skills/orchestrator/SKILL.md "Follow-ups alone never make a FINDINGS verdict"
need docs/decisions/0011-machine-merge-gate.md "VERDICT: CLEAN <full reviewed sha>"
need docs/decisions/0011-machine-merge-gate.md "Follow-ups alone never make a FINDINGS verdict"
# Codex review of 74519d5, blocker 1: CI reads file names NUL-separated and fails on an unreadable one.
need .github/workflows/ci.yml "git ls-files -z tools"
need .github/workflows/ci.yml "while IFS= read -r -d '' f; do"
need .github/workflows/ci.yml 'cannot read $f'
forbid .github/workflows/ci.yml "done < <(git ls-files tools)"
need .github/workflows/ci.yml "contents: read"
need .github/workflows/ci.yml "claude plugin validate ."
need tools/bot/review-status.sh "context=codex-review"
need .claude/crew64.json '"bot_identity": true'

# Decision 0005: the defaults file validates, and every model id it ships
# appears in the docs/05 ladder table, so the table and the file cannot drift.
if ! python3 -I tools/crew64_config.py check config/crew64.defaults.json >/dev/null 2>&1; then
  echo "config/crew64.defaults.json: fails crew64_config.py check"; missing=$((missing + 1))
fi
for id in $(python3 -I -c '
import json; d=json.load(open("config/crew64.defaults.json"))["models"]
ids=set(d["research"])|set(d["claude_implementer"])|{d["codex_reviewer"]["model"]}
print(" ".join(sorted(ids)))' 2>/dev/null); do
  need docs/05-delegation.md "$id"
done
# No owner-specific identity in stranger-facing docs.
forbid docs/11-plugin-install.md "Solvela-bot"

if [ "$missing" -ne 0 ]; then
  printf '%d required phrase(s) missing\n' "$missing"
  exit 1
fi
echo "ladder docs OK"
