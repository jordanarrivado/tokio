---
name: verify
description: How to verify Tokio changes at their runtime surface (the PreToolUse hook CLI and the MCP stdio server) instead of re-running unit tests.
---

# Verifying Tokio changes

Build first: `npm run compile` (output in `out/`).

## PreToolUse hook (policy.ts, hook.ts)

The surface is `node out/broker/cli.js hook`. Claude Code runs it before every tool call
(see `.claude/settings.json`). It reads one event as JSON on stdin and exits 2 with a reason
on stderr when it blocks, 0 when it allows.

Event shape: `{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"..."},"cwd":"<dir>"}`.

Gotchas:
- The live hook also guards your own Bash calls. A command line that names a secret path
  (`.env`, `secrets`, `credentials`, ...) or uses recursive grep is blocked before it runs.
  Write test commands into a JSON file with the Write tool, then pipe each one into the CLI
  from a small Node script, so your own command line names no secret.
- Set `cwd` in the event to a scratch directory; the hook writes its audit log under `cwd/.tokio/`.
- In JSON, a Windows path `config\secrets` is written `"config\\secrets"`.

## MCP server (tools.ts, mcp.ts)

The surface is `node out/broker/cli.js mcp --root <dir>`: newline-delimited JSON-RPC on stdio.
Pipe `initialize`, `tools/list`, and `tools/call` lines in with `printf '%s\n' ... |` and read
one JSON response per line. SPEC.md has a ready-made end-to-end check.
