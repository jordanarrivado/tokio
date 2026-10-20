# SPEC: Tokio engine — versatility and reliability

Users: AI coding agents calling Tokio over MCP stdio.
Data: repo files inside the root, read-only; the existing audit log, append-only.

## Changes, in priority order

### P1. Input validation for every tool
Validate `tools/call` arguments against the tool's `inputSchema` before the handler runs.
Check required fields, `type`, `enum`, `minimum`, and `maximum`. Ignore unknown fields. Add no new dependency.

Acceptance:
- Missing required field → `isError: true`, text `Invalid input: <field> is required.`
- Wrong type → `isError: true`, text names the field, the expected type, and the received value, e.g. `Invalid input: startLine must be an integer (got "x").`
- Out of range or unknown enum → `isError: true`, text names the allowed range or values.
- Unknown extra field → call succeeds and the output is the same as without it.
- Unknown tool name → `isError: true` listing the valid tool names.
- The handler is never invoked on invalid input (unit test with a spy).

### P2. Per-call timeout (10s)
Every tool call gets an `AbortSignal` that fires at 10s. Handlers pass it to fs reads and repo scans.

Acceptance:
- A call still running at 10s returns `isError: true` with `Timed out after 10s. Narrow targetPath or the request.`
- The next queued call starts within 100 ms of the timeout. Unit test: a fake slow tool, then `ping`.
- The audit entry for the call records outcome `timeout`.
- Calls under 10s are unaffected; existing tests pass unchanged.

### P3. Cancellation (`notifications/cancelled`)
Handle `notifications/cancelled` with `params.requestId`.

Acceptance:
- In-flight call with that id: abort its signal and send no response for that id.
- Queued call with that id: never run it and send no response.
- Unknown or already-finished id: ignore it with no response and no error.
- The audit entry records outcome `cancelled`.
- Responses for other ids are unaffected and stay in order.

### P4. New tool: `find_symbol`
Input: `name` (string, required), `targetPath` (string, optional, inside the root), `limit` (integer 1–10, default 10).
Behavior: scan the repo the same way `repo_map` does, skipping secret and unsafe paths. Match top-level symbols from `extractSymbols`.
Ranking: exact case-sensitive, then exact case-insensitive, then prefix. Ties sort by path.
Output: one line per hit, `path:line  signature`, plus the standard estimate footer.

Acceptance:
- `name: "Broker"` in this repo returns `src/broker/tools.ts:<line>` with the `export class Broker` signature, where `<line>` is the line that `grep -n "^export class Broker" src/broker/tools.ts` prints.
- More than `limit` matches → exactly `limit` lines, plus a line `N more; narrow with targetPath`.
- No match → `isError: true` with `No symbol "<name>".` and up to 3 close names (edit distance ≤ 2 or substring).
- Never returns hits from paths that `isSecretPath` blocks; unit test with a `.env` and a `secrets.ts` fixture.
- `targetPath` outside the root → `isError` from the existing path policy.
- Listed in `tools/list` and mentioned in the MCP `instructions` string.
- Obeys P1–P3: validation, 10s timeout, and cancellation.

## End-to-end check (run from repo root after `npm run build`)

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"find_symbol","arguments":{"name":"Broker"}}}' \
  '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"find_symbol","arguments":{"name":"Brokr"}}}' \
  '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"read_symbol","arguments":{"path":"src/broker/tools.ts","startLine":"x"}}}' \
  | node out/broker/cli.js mcp --root .
```

Pass when:
- id 2 lists 7 tools, including `find_symbol`.
- id 3 text starts with `src/broker/tools.ts:<line>  export class Broker`, with `<line>` from the grep above (147 after this work).
- id 4 has `isError: true` and suggests `Broker`.
- id 5 has `isError: true` and mentions `startLine` and `integer`.
- `npm run verify` passes.

Timeout and cancellation are covered by unit tests in `src/broker/mcp.test.ts` and `src/broker/tools.test.ts`. They are hard to trigger from a shell pipe.

## Out of scope
- Other new tools: `compress_output`, `search_code`, `run_check`.
- Parallel request handling. The serial queue in `mcp.ts` stays.
- VS Code panel and UI: `src/ui/`, `src/extension.ts`.
- On-disk symbol index or cache; reading outside the repo root.
- Configurable timeout.
