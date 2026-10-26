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
- id 2 lists every tool, including `find_symbol` (7 before P5, 8 after).
- id 3 text starts with `src/broker/tools.ts:<line>  export class Broker`, with `<line>` from the grep above (147 after this work).
- id 4 has `isError: true` and suggests `Broker`.
- id 5 has `isError: true` and mentions `startLine` and `integer`.
- `npm run verify` passes.

Timeout and cancellation are covered by unit tests in `src/broker/mcp.test.ts` and `src/broker/tools.test.ts`. They are hard to trigger from a shell pipe.

## Out of scope
- Other new tools: `compress_output`, `search_code`, `run_check`.
- Parallel request handling. The serial queue in `mcp.ts` stays.
- VS Code panel and UI: `src/ui/`, `src/extension.ts`.
- On-disk symbol index or cache; reading outside the repo root. Part 2 revisits both: P6 reads catalog repositories outside the root, and may add a cache.
- Configurable timeout.

# Part 2: one agent across several local repositories

Source: *Single Agent Multi Repository Architecture*, v1.0, 26 October 2026.
Tokio is the context router and the read side of the tool gateway. Edits, git, and tests stay with the agent's own tools.

Decisions:
- Local repositories only. No GitHub or GitLab adapters.
- One default write target per catalog. Every other repository is read-only unless the user grants write for a task (P7).
- Commits stay independent per repository, with two rules: the same branch name in every repository a feature touches, and merges in dependency order (`dependsOn`).

## P5. Repository catalog and `list_repositories`

Catalog file: `tokio.repos.json` in the root given to `--root`. Commit it. Relative paths keep it portable when teammates clone the repositories side by side.

```json
{
  "default": "frontend",
  "repos": [
    { "name": "frontend", "path": ".", "purpose": "React UI", "dependsOn": ["shared", "backend"] },
    { "name": "backend", "path": "../backend", "purpose": "REST API", "dependsOn": ["shared"] },
    { "name": "shared", "path": "../shared", "purpose": "Shared types" }
  ]
}
```

Rules:
- `repos` is a non-empty array. Each entry needs `name` and `path`; `purpose` and `dependsOn` are optional. Unknown fields are ignored.
- `name`: 1–64 letters, digits, `.`, `_`, or `-`, starting with a letter or digit. Unique, ignoring case.
- `path`: a local directory, absolute or relative to the root. Not a URL. Two repositories may not share a path or nest one inside the other.
- `default`: required. Names a repository exactly. It is the write target.
- `dependsOn`: names other catalog repositories. No self-reference, no cycles. A repeated name counts once.
- No catalog file: the root is the only repository and the default, named after the root folder. Every tool behaves as before.
- The file is read on every call, so edits apply without a restart.

`list_repositories` takes no input and returns:

```
Repositories from tokio.repos.json. Write target: frontend; the others are read-only.
frontend  write  D:/work/frontend  React UI (depends on: shared, backend)
backend   read   D:/work/backend   REST API (depends on: shared)
shared    read   D:/work/shared    Shared types
Merge order: shared, backend, frontend
```

Acceptance:
- No catalog → first line `No tokio.repos.json; the root is the only repository and the write target.`, then one `write` line for the root. No merge order line.
- Valid catalog → the header, one line per repository in catalog order with its absolute path in forward slashes, then the merge order: dependencies first, ties in catalog order.
- A path that is not a directory → its line ends with `[missing]`. The call still succeeds.
- Each invalid catalog → `isError: true`, text starting `Invalid tokio.repos.json:` and naming the problem: bad JSON; `repos` missing or empty; a bad or duplicate name; a bad or URL path; a missing or unknown `default`; an unknown or self `dependsOn`; a cycle, shown as `a -> b -> a`; overlapping paths.
- An invalid catalog does not stop the server, and in P5 it does not change the other tools.
- No estimate footer, like `route_task`: the result replaces no file read.
- Listed in `tools/list` and in the MCP `instructions`. Obeys P1–P3.

## P6. Repo-aware tools

- `repo_map`, `read_symbol`, `find_symbol`, and `route_task` take an optional `repo` (string) that names a catalog repository. `path` and `targetPath` are relative to that repository.
- Unknown `repo` → `isError: true` with `Unknown repository "<name>". Repositories: <names>.`
- `read_symbol` without `repo` reads from the default repository. `resolveRepoPath` gets the repository's path as its root, so the secret, symlink, and outside-root rules apply per repository.
- `repo_map` and `find_symbol` without `repo` cover every repository. Repositories are scanned in parallel, each with its own 500-file cap. Ranking is shared; on ties, files in the default repository rank first.
- With more than one repository, every path in the output carries its repository: `[backend] src/api/upload.ts`. With one repository, output is unchanged byte for byte.
- `route_task` adds a line `Repositories: write <default>; read <others with relevant files>`. When a read-only repository has more relevant files than the default, it adds `Most relevant files are in <repo>, which is read-only. Ask the user before editing it.` Validation commands come from the default repository.
- Repeat-read state is keyed by repository and path, so the same path in two repositories never reads as unchanged.
- `targetPath` without `repo` is relative to the default repository.
- Without `repo`, a repository whose directory is missing is skipped, and the `repo_map` footer says `skipped missing <names>`. Named, it is an error: `Repository "<name>" is missing: <path> is not a directory.`
- An invalid catalog makes these four tools return the P5 error. `refine_task`, `search_output`, and `session_stats` are unaffected.
- Import edges are built per repository, then merged, because Python and Go imports resolve from each repository's own root.
- An import of a package that another catalog repository publishes links to that repository's files, so contracts across repositories rank together:
  - JS/TS: the `package.json` `name`. Named imports link to the files that define those names; other imports link to the subpath module or the package entry (`types`, `main`, `module`, then `index`, then `src/index`).
  - Go: the `go.mod` module path. An import links to the non-test files of that package directory.
  - Python: top-level packages with an `__init__.py` at the root or under `src/`, except `test` and `tests`. Absolute imports link to the module files.
- `tokio map` and the prompt hook stay single-root.

Acceptance:
- With no catalog file, every existing test passes unchanged. A catalog with one repository gives the same output as no catalog.
- Three-repository fixture: `repo_map` lists labeled hits from all three; `read_symbol` with `repo: "backend"` reads from `backend`; `../frontend/x.ts` requested in `backend` is blocked.
- A `frontend` file that imports `{ UserAvatar } from '@org/shared'` ranks `shared`'s defining file above unrelated `shared` files, for a task that names only the `frontend` file.
- `repo_map` over three repositories of 500 files each finishes under the 10s timeout on this machine. Measured: about 0.4 s per call, including Node startup, so no scan cache is needed.

Status: P5 and P6 are done.

## P7. Write scope in the PreToolUse hook

- The hook loads the catalog from the event's `cwd`, else the process cwd.
- Edit, Write, MultiEdit, and NotebookEdit on a path inside a catalog repository are allowed only for the default repository and for repositories granted in `.tokio/scope.json`.
- Denied → exit 2 with `Tokio blocked Edit: backend is read-only for this task. Ask the user to run: tokio scope backend`.
- Paths outside every catalog repository keep today's rules. Without a catalog file, nothing is read-only.
- An invalid catalog blocks those edits with the P5 message, because the read-only repositories are unknown.
- `NotebookEdit` joins the hook matcher that `tokio init` writes, so the hook sees notebook edits.
- `tokio scope <name...>` grants write for 4 hours, or for `--hours <n>` (1–24). `tokio scope` alone prints the current grants. `tokio scope --clear` removes them. An unknown name → exit 1 with the list of names.
- Only the user grants. The hook denies agent Edit or Write on `.tokio/scope.json`, and Bash commands that run `tokio scope` or `cli.js scope`, or that name `.tokio/scope.json`.
- `tokio init` adds `.tokio/scope.json` to `.gitignore`.

Acceptance:
- Edit in `backend` with no grant → denied with the message above. After `tokio scope backend` → allowed. After `--clear` or expiry → denied again.
- Edit in the default repository, and outside every repository → unchanged.
- Each agent-side grant attempt above → denied.
- Known gap, stated in the README: the hook cannot see every Bash write, such as a script that writes files. Read-only scope is a guard, not a sandbox.

Status: P7 is done.

## P8. Per-repository audit, stats, and doctor

- Audit entries gain an optional `repos`: the catalog repositories the call drew on. It is a list, because one `repo_map` can cover several repositories. With more than one repository, `files` are logged as `<repo>/<path>`. With one, neither changes.
- A write the hook blocks in a read-only repository records that repository in `repos`.
- `tokio stats` and `session_stats` add a "by repo" section, with calls and blocked calls per repository, when entries name more than one repository.
- `tokio doctor` checks the catalog: invalid → `fail` with the P5 message; a missing path → `fail`; a path that is not a git repository → `warn`; more than one repository and no PreToolUse hook → `warn`, because write scope is not enforced.
- `tokio init` adds the two commit rules to the AGENTS.md guidance block when the catalog lists more than one repository.

Acceptance:
- A fixture for each doctor check.
- A stats fixture with two repositories shows both in the "by repo" section.

Status: P8 is done. Part 2 is complete.

## End-to-end check for P5 (run from repo root after `npm run build`)

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_repositories","arguments":{}}}' \
  | node out/broker/cli.js mcp --root .
```

Pass when:
- id 1 `instructions` mention `list_repositories`.
- id 2 lists 8 tools, ending with `list_repositories`.
- id 3 starts with `No tokio.repos.json;` and lists one `write` line for this repo.
- `npm run verify` passes.

## Out of scope for Part 2
- Remote repositories and Git hosting APIs.
- Tokio committing, pushing, opening pull requests, or running tests.
- A `repo_status` tool for branch mismatches. Add it only if mismatches happen.
- Coordinated merges across repositories.

## P9. Repository map and file links

- `tokio.repos.json` gains optional `links`: `{ "from": "<repo>:<path>", "to": "<repo>:<path>", "kind": "api|type|event|schema|config|other", "note"?: string }`. Ends must name catalog repositories, two different ones, with a relative, non-secret path. A link and its reverse are the same link.
- `repo_map` treats each link as a two-way ranking edge when both files are scanned, and its automatic repository pick adds the repository on the other end of a link.
- Removing a repository drops its links. Every catalog edit is validated before it is written.
- The VS Code command **Tokio: Open Repository Map** opens an editor tab: drag nodes to arrange them (positions in `.tokio/layout.json`, per user), drag a port onto a node to add `dependsOn`, click a connection to see and remove its dependency, links, and detected imports, and use **+** to add a repository or a link.
- `tokio init` git-ignores the write-grant file and `.tokio/layout.json`.

Status: P9 is done.

## P10. PHP and larger repositories

- PHP symbols: `class`, `interface`, `trait`, `enum`, top-level `function`, and methods inside classes, so `read_symbol` stops at the next method. Docblocks are masked like JS comments.
- PHP `use` imports (single, aliased, `function`/`const`, grouped) resolve through `composer.json` `autoload` and `autoload-dev` PSR-4 maps; without composer.json, `App\` → `app/` is assumed.
- Across repositories, a `use` links to another repository only through namespaces that repository's own composer.json declares, and never for a namespace the importing repository declares itself.
- The map orders files by half import rank and half direct task match, so a file imported by many matching files cannot outrank the files the task names.
- Repositories may set `maxFiles` (1–5000, default 500). The scan skips `storage/framework`, `storage/logs`, and `bootstrap/cache` at a repository's root. The truncation note names the repository and points at `maxFiles`.
- The repository map's inspector has the same 1–24 hour picker as the sidebar for Allow Edits.

Acceptance (measured on hierpayroll-v3-api, 2,034 files): `find_symbol` finds PHP controllers; `repo_map` for a report task lists that report's controller, requests, and feature tests in the top results; with `maxFiles: 2500` a map takes about 0.8 s.

Status: P10 is done.
