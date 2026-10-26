---
name: tokio-workflow
description: Token-efficient workflow for coding tasks in this repo using the tokio MCP tools (refine_task, repo_map, read_symbol, search_output). Use before reading or editing source files for any code change, bug fix, refactor, or question about how the code works.
---

# Tokio workflow

Use this for any task that touches code. The goal is to read only the code the task needs, and to keep the prompt small.

## Steps

1. **Refine once.** Call `mcp__tokio__refine_task` with the user's task text. Use the returned text as the scoped prompt for the rest of the task. Do not call it again for the same task.
2. **Map.** Call `mcp__tokio__repo_map` with the task. Pick the files and line numbers it ranks highest. Pass `targetPath` when the user has named a file or folder.
3. **Read only the bodies you need.** Call `mcp__tokio__read_symbol` with `path` and `startLine` from the map. Do not `Read` whole files when a symbol read covers the change.
4. **Follow truncation.** If a result says it was truncated, call `mcp__tokio__search_output` with the output `id` and a `query`. Do not re-read the whole body.
5. **Edit.** Make changes with `Edit` using exact text from the symbol read.
6. **Confirm.** After an edit, a repeat `read_symbol` returns only the lines that changed since the last read. Use that to check the edit without re-reading the body. Pass `full: true` only when you have lost the body from context and need all of it.
7. **Verify.** Run the project's checks. In this repo that is `npm run verify`, which runs type-check, tests, and build.
8. **Report.** When the task is done, call `mcp__tokio__session_stats` once. In your reply, include its "this session" line and the last `[tokio estimate: ...]` footer, both copied as they are.

## Rules

- Never read files named `.env`, credentials, secrets, or keys, including `.env.*`. The PreToolUse hook blocks them, but do not try.
- `repo_map` and `read_symbol` are for code. Plain `Read` is fine for config files that are short, such as `package.json` or `AGENTS.md`.
- For a quick question that needs no code change, skip `refine_task` and answer from the map and a symbol read.
- When the user asks about savings, call `mcp__tokio__session_stats` and report its numbers as they are. Do not estimate them.
- End your final reply with the last `[tokio estimate: ...]` line from a tool result, copied as it is. If no tool result had one, say so. These lines are estimates (characters ÷ 4), not billed tokens.
