# classify-edit-size.py

A `PreToolUse` guardrail hook for Claude Code: blocks direct `Edit`/`Write`
calls that look like new implementation work, forcing that work through
`delegate_task` on `local-worker-mcp` instead. Small fixes to existing code
pass through untouched.

Not applied to this repo itself -- it lived here only as a test while
building it. Install it into any other project you want to enforce
delegation in.

## Why deterministic instead of LLM-judged

Classifies purely by diff size (changed/added lines via `difflib`), not by
an LLM call. That makes it provable: same input always gives the same
decision, and it can be pipe-tested directly before trusting it. An
LLM-judged `prompt`-type hook was considered but rejected for this reason.

## Install into a project

```bash
mkdir -p /path/to/project/.claude/hooks
cp classify-edit-size.py /path/to/project/.claude/hooks/
```

Then merge `settings.snippet.json` into that project's `.claude/settings.json`
(don't overwrite an existing `hooks` block -- merge the `PreToolUse` array).

After adding it to a project that doesn't already have a `.claude/` directory
watched by the current session, run `/hooks` once (or restart the session)
for it to take effect -- Claude Code doesn't watch a brand-new `.claude/`
directory until then.

## Tuning

Edit `LINES_THRESHOLD` in `classify-edit-size.py` (default: 60 lines).
Lower = stricter (more gets pushed to delegation); higher = looser (more
direct edits allowed through).

## Verifying it works

```bash
# small fix -- should print nothing, exit 0
echo '{"tool_name":"Edit","tool_input":{"old_string":"const x = 1;","new_string":"const x = 2;"}}' \
  | python3 classify-edit-size.py; echo "EXIT:$?"

# large change -- should print a deny decision JSON, exit 0
python3 -c "
import json
print(json.dumps({'tool_name':'Edit','tool_input':{'old_string':'line\n'*5,'new_string':'newline\n'*75}}))
" | python3 classify-edit-size.py; echo "EXIT:$?"
```
