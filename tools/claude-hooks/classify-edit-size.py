#!/usr/bin/env python3
"""
PreToolUse hook for Edit|Write in this project: blocks direct edits that
look like NEW IMPLEMENTATION work (lots of added/changed lines), forcing
that work through the local-worker MCP's delegate_task instead. Small
fixes to existing code pass through untouched.

This is a deterministic heuristic (line-diff size), not an LLM judgment
call -- chosen specifically so it's provable: same input always gives the
same decision, and can be pipe-tested directly. Tune LINES_THRESHOLD below
if it's too strict/loose in practice.

Reads the hook input JSON (tool_name, tool_input) from stdin. Exits 0
printing nothing for "allow" (or on any error -- fail open, never block a
tool call due to a hook bug). Prints the PreToolUse JSON output to deny
when the change looks too large.
"""
import json
import os
import sys
from difflib import SequenceMatcher

LINES_THRESHOLD = 60  # net changed/added lines above this -> looks like new implementation, not a fix


def changed_line_count(old_text: str, new_text: str) -> int:
    old_lines = old_text.splitlines()
    new_lines = new_text.splitlines()
    sm = SequenceMatcher(None, old_lines, new_lines)
    changed = 0
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag in ("replace", "insert"):
            changed += j2 - j1
        elif tag == "delete":
            changed += i2 - i1
    return changed


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return  # fail open: malformed input, don't block

    tool_name = payload.get("tool_name")
    tool_input = payload.get("tool_input", {})

    try:
        if tool_name == "Edit":
            old_text = tool_input.get("old_string", "")
            new_text = tool_input.get("new_string", "")
        elif tool_name == "Write":
            file_path = tool_input.get("file_path", "")
            new_text = tool_input.get("content", "")
            old_text = ""
            if file_path and os.path.exists(file_path):
                with open(file_path, "r", errors="ignore") as f:
                    old_text = f.read()
        else:
            return  # not our concern, allow

        changed = changed_line_count(old_text, new_text)
    except Exception:
        return  # fail open on any unexpected error

    if changed > LINES_THRESHOLD:
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": (
                    f"This {tool_name} changes ~{changed} lines (limit {LINES_THRESHOLD}) -- looks like new "
                    "implementation work, not a small fix. Delegate this to the local-worker MCP's "
                    "delegate_task instead of editing it directly. If this really is just a fix (e.g. a "
                    "large but simple rename), do it as several smaller Edit calls, or ask the user to "
                    "raise LINES_THRESHOLD in .claude/hooks/classify-edit-size.py."
                ),
            }
        }))
    # else: print nothing -- default allow


if __name__ == "__main__":
    main()
