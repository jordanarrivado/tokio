# Tokio

Tokio is a local VS Code extension that wraps a raw coding request in concise, deterministic scope and validation instructions. The refined prompt stays editable and can be copied into Codex or Claude Code by hand.

Optional repository discovery can suggest likely starting files and include a short, user-maintained architecture profile.

**What Tokio does not do:** it does not call an AI service, submit prompts to coding agents, or guarantee lower token usage. Repository discovery is local, read-only, opt-in, and available only in trusted workspaces.

## Contents

- [Requirements](#requirements) · [Development setup](#development-setup) · [Usage](#usage)
- [Refinement modes](#refinement-modes) · [Work categories](#work-categories) · [Repository context](#repository-context)
- [Packaging](#create-and-install-a-local-vsix) · [Manual QA](#manual-qa-checklist) · [Limitations](#mvp-limitations)

## Requirements

- VS Code 1.85 or newer
- Node.js 20 or newer
- npm

## Development setup

Install dependencies and verify the project from the repository root:

```powershell
npm.cmd install
npm.cmd run verify
```

On Windows, `npm.cmd` avoids PowerShell's script-execution policy blocking the `npm.ps1` wrapper. The included VS Code task selects `npm.cmd` automatically on Windows. On macOS or Linux, use the equivalent `npm` commands.

To run the extension:

1. Open this repository in VS Code.
2. Press `F5` and select **Run Tokio Extension** if prompted.
3. In the Extension Development Host, select the Tokio inward-chevron icon in the Activity Bar.

Available scripts:

- `npm.cmd run check` — run the strict TypeScript check without emitting files.
- `npm.cmd test` — compile and run the deterministic Node test suite.
- `npm.cmd run build` — clean and compile into `out/`.
- `npm.cmd run verify` — run the type check, tests, and clean build.

### Project layout

| Path | Purpose |
| --- | --- |
| `src/core/` | Pure refinement and category-detection logic with no VS Code dependency. |
| `src/context/` | Bounded, read-only repository discovery and the ranked repository map. |
| `src/broker/` | Node CLI and MCP server for coding agents: tools, policy, hook, audit, and benchmark. |
| `src/ui/` | Webview panel and message contracts. |
| `src/extension.ts` | Extension entry point; registers the view and the `Tokio: Focus View` command. |
| `media/` | Extension icons. |

Tests sit beside the code they cover as `*.test.ts`.

## Usage

Open the Tokio view from the Activity Bar, or run **Tokio: Focus View** from the Command Palette.

1. Enter the raw coding request, including every requirement that must be retained.
2. Optionally enter a target file path.
3. Select a refinement mode.
4. Keep Prompt Detail on **Compact** for the shortest scoped output, or choose Detailed when more guidance is useful.
5. Choose a repository context level. For Targeted or Architecture context, choose **Preview Context**, inspect the evidence, and deselect irrelevant files.
6. Choose **Refine** and review or edit the result.
7. Compare the raw and refined prompt estimates, then copy and paste manually into Codex or Claude Code.

**Clear** resets all fields, restores Adaptive mode, and returns focus to the raw prompt.

### Local productivity tools

- **Use Editor Selection** places the currently selected editor text into Raw Prompt.
- **Use Active File** fills Starting File with the active file's workspace-relative path.
- **Open in Editor** opens the current edited result in an untitled text editor.
- Raw and refined text show character counts and clearly labeled estimated token counts using a simple four-characters-per-token estimate.
- The comparison panel shows prompt-only raw, refined, and difference estimates without claiming end-to-end savings.
- `Ctrl+Enter` (`Cmd+Enter` on macOS) refines when the form is ready.

## Refinement modes

| Mode | Behavior |
| --- | --- |
| Minimal | Requests the smallest safe change, focused validation, and a brief report. |
| Adaptive | Also prefers existing patterns, limits inspection to necessary files and direct dependencies, and avoids unrelated edits. This is the default. |
| Strict | Adds approval requirements for new dependencies, schema changes, and architectural changes while keeping directly required code in scope. |

All modes retain the trimmed original task text. The engine adds deterministic instructions; it does not understand or semantically rewrite arbitrary requests.

### Prompt detail

- **Compact** is the default. It combines overlapping mode and category guidance and limits related files to three.
- **Detailed** retains expanded category and mode instructions for cases where stronger explanation is worth the extra prompt tokens.

## Work categories

Auto Detect is the default. It runs locally, using deterministic phrase scoring, when you press **Refine Prompt**: it writes the `Type:` and `Also:` lines into the refined prompt for you, then shows the main category, its confidence and matched signals, plus a `+` badge for each other kind of work it found. You never type these lines yourself. While you type, only the prompt-clarity hints update. Editing the raw prompt resets the badges until the next refine. Input with no clear signal falls back to General. Selecting a category manually turns off detection, including the extra lines, until Auto Detect is selected again.

### Several kinds of work in one prompt

A prompt can mix work, such as "the checkout is broken after payment; add tests and check it for XSS". Auto Detect picks the strongest category as the main type and adds up to three more that are clearly present. Each extra category adds one short `Also:` line to the refined prompt:

```
Type: Security — Name the threat; cover every entry point; no secrets in logs; test unsafe input.

Also: Bug Fix — Confirm root cause; add regression coverage.
Also: Tests — Prefer deterministic test-only changes unless production code must change.
```

Ties go to the more urgent or risk-bearing work: hotfix, then security, bug, migration, and so on.

### Categories

The panel groups categories as Plan, Build, Fix, Maintain, and Support.

| Group | Category | Added guidance |
| --- | --- | --- |
| | General | Adds no category assumptions. |
| Plan | Planning | Reads the code first, lists steps, files, and one check per acceptance criterion, then stops for approval before any code. |
| Plan | Decision | Writes no code: maps affected paths, compares options, and records what was chosen, what was rejected, and why. |
| Plan | Investigation | Collects evidence without modifying code unless implementation was requested. |
| Build | Feature | Limits implementation to the requested behavior and its focused validation. |
| Build | Enhancement | Preserves compatibility around the requested workflow improvement. |
| Build | UI Work | Reuses existing design tokens and components and checks the screen at about 360, 768, and 1280 px with keyboard access intact. |
| Build | Refactor | Preserves observable behavior and prevents unrelated feature work. |
| Build | Performance | Requires a baseline, measurement, and evidence for improvement claims. |
| Build | Migration | Requires a rollback step, keeps the deployed code working during rollout, and tests on invented data. |
| Fix | Bug Fix | Confirms root cause, requests the smallest safe fix, and adds regression validation. |
| Fix | Production Hotfix | Requires an evidence-backed root cause, a failing test, and the smallest fix; defers cleanup until production is stable. |
| Fix | Security | Names the threat, checks every entry point, keeps secrets out of logs, and tests that unsafe input is rejected. |
| Maintain | Dependency Upgrade | Checks release notes for breaking changes, upgrades one package at a time, and runs the full tests and build. |
| Maintain | Workflow / Automation | Follows existing CI, script, and job conventions, keeps secrets in the secret store, and shows a local dry run. |
| Support | Tests | Prefers deterministic test-only changes unless production code must be fixed. |
| Support | Documentation | Verifies examples and avoids runtime changes. |
| Support | Code Review | Makes no edits; reports findings with file and line, ranked by severity, correctness before style. |
| | Other | Records the work type without adding assumptions. |

Automatic classification is a suggestion, not semantic understanding. The category is deterministically checked again when Refine is submitted, preventing a pending UI update from using a stale suggestion.

## Repository context

Repository context is separate from refinement mode:

| Context | Behavior |
| --- | --- |
| None | Does not read the workspace; this is the default. |
| Targeted | Ranks likely files from task terms, an optional target file, and one level of relative imports from that target. |
| Architecture profile + targeted | Adds the Targeted behavior and reads `.tokio/architecture.md`. |

The preview is mandatory before context enters a refined prompt. All suggested files start selected and can be removed. Changing the task, target path, or context level invalidates the preview so stale repository information is not reused.

Discovery is deliberately bounded:

- Trusted workspaces only, with no execution or writes.
- At most 500 repository paths considered and 3 related paths placed in a prompt.
- At most one explicitly provided target file read, capped at 32 KB, only to identify relative imports.
- Direct imports are prioritized; weak filename matches are omitted below a confidence threshold.
- Audit paths are omitted unless the task mentions auditing or the target directly imports them.
- Common dependency, build, coverage, and version-control folders are excluded.
- Binary files and common secret paths such as `.env`, credential files, and private keys are excluded.
- File contents are never copied into the prompt. Only selected paths are included.
- Architecture profile text is capped at 1,200 characters.

### Architecture profile

Create `.tokio/architecture.md` in the repository you want Tokio to understand. Keep it concise and factual. For example:

```markdown
# Architecture

- HTTP handlers under `src/http` validate input and call services.
- Business rules belong in `src/services`.
- Database access belongs in `src/repositories`.
- Tests mirror source paths under `tests`.
- Schema changes and new runtime dependencies require approval.
- Run `npm test -- --runInBand <related-test>` for focused validation.
```

Treat this as curated project documentation. Tokio does not verify whether the statements are correct. The legacy `.token-saver/architecture.md` path remains readable but produces a rename notice.

### Architecture map

An architecture map routes every task straight to the files and lines that serve it, so the agent skips the repository search. Each repository keeps one map at `.tokio/map.md`, committed with the code. Each heading is one area of the system, and data structures are areas like any other:

```markdown
# Architecture map

## Auth
Keywords: login, token, session
- POST /api/login -> src/auth/login.ts#handleLogin
- GET /api/me -> src/auth/me.ts#getMe
- Related: src/auth/session.ts, src/db/users.ts

## Employee data
Keywords: employee, record, salary, model, table
- Employee model -> app/Models/Employee.php#Employee
- employees table -> database/migrations/2024_01_create_employees.php
- EmployeeResource -> app/Http/Resources/EmployeeResource.php
```

- A route line is `- <label> -> <path>[#symbol]`. The label can be an HTTP route, a model, a table, a CLI command, a job name, or anything else. `Class.method` names a method. Paths are relative to the repository root.
- `Keywords:` and `Related:` lines are optional. Other text under a heading still counts for matching, but is never sent to the agent.
- Tokio ranks the areas against each task with local BM25 (no model, no network) and sends only the best areas' files with line ranges, usually 50 to 200 tokens. The map itself is never sent whole.
- The panel shows the map's status under the workspace strip, such as `Map: 12 areas · 40 routes · 2 stale`. **Create** writes a starter map; **Open** edits it. Hover the line to see stale entries. The status rechecks on every save.
- `repo_map` uses the map without being asked: matched routes come first, and the routed files rank first in the repository map below them. `mapPath` picks a different map.
- The `prompt-hook` sends matched areas instead of a repository map. Each area's lines are sent once per Claude Code session; later prompts that match it get a one-line pointer instead, since the agent still has the lines. The per-session record is `.tokio/map-session.json`, which `tokio init` adds to `.gitignore`. When the repository has a map and no area matches, the hook adds nothing; the keyword-ranked repository map is used only in repositories without a map. Prompts for or from another agent (`~name`, or a cross-session message) get no context.
- An area matches only when the task shares at least two terms with its heading, keywords, route labels, or symbols, or one such term in a short task. Areas scoring under half of the best area are dropped. Paths, prose, and generic verbs (ask, send, check) never qualify an area on their own.
- A route or `Related:` entry that names a folder is listed as `path/ (folder)`. A missing path is reported as `no file or folder at <path>`, and a missing symbol as `symbol <Name> not found in <file>`.
- **Prompt for other tools** in the panel refines a prompt with the same routes, for chats that cannot call Tokio.
- A route whose file or symbol no longer exists is reported as not found, so a stale map shows up instead of sending the agent to the wrong place. Keep the map in review with the code it describes.

#### Test the map with sample prompts

`tokio map check` resolves every entry in the map and runs sample prompts through the same matching the prompt hook uses. Keep the prompts in `.tokio/map-prompts.json`, next to the map, and re-run the check after every Keywords edit:

```json
[
  { "prompt": "the payslip pdf shows the wrong net pay", "areas": ["Payslips", "Payroll run"] },
  { "prompt": "overtime is wrong for night differential", "areas": ["Time sheets"], "allow": ["Payroll parameters"] },
  { "prompt": "is this map worth keeping", "areas": [] }
]
```

- `areas` lists the areas the prompt must match. `[]` means it should match nothing.
- `allow` lists areas that may also match without failing the prompt.
- Area names are matched without regard to case. A name that is not in the map is an error, so a renamed area is caught.

The check prints each failing prompt with the areas it matched, the expected ones it missed, and any extra ones. Each matched area shows its score as a share of the best area and the terms behind it, such as `Loans 0.67 (via loan, deduction)`, so the keyword to edit is visible. A missed area gets a reason: no task term in the area, only one strong term, a score under the 0.5 cutoff, or outranked by the top three. The summary lists areas that no sample prompt covers. It exits 1 on a failing prompt or a stale entry, so it can run in CI. Without a prompts file it only checks the entries. `--prompts <file>` names another file inside the repository, and `--verbose` also prints passing prompts with their scores, to show an area close to the cutoff before it flips.

## Agent broker (Claude Code and Codex)

The broker is a local CLI with no runtime dependencies. It is separate from the VS Code panel and does not call any AI service. Build it first with `npm.cmd run build`, then run it from `out/broker/cli.js`.

### Set up a project

From the project root, run:

```powershell
node D:/tokio/out/broker/cli.js init
```

`tokio init` configures both agents in one step, using the path of the CLI it runs from:

- `.mcp.json` gets the `tokio` MCP server (Claude Code).
- `.claude/settings.json` gets the PreToolUse and UserPromptSubmit hooks (Claude Code).
- `.codex/config.toml` gets the `[mcp_servers.tokio]` table (Codex).
- `AGENTS.md` gets a block between `<!-- tokio:begin -->` and `<!-- tokio:end -->` with the tool workflow. Re-running refreshes only that block.

Existing content is preserved. Other servers, hooks, settings, and tables are not touched. A Tokio entry that points somewhere else is reported as a conflict and kept. Use `--force` to replace it. Use `--dry-run` to preview. `init` exits 1 when a file conflicts or cannot be read. Guidance that was written by hand without the markers is left in place, to avoid duplicating it.

The manual steps below show what `init` writes. Use them only if you prefer to edit the files yourself.

| Command | Purpose |
| --- | --- |
| `tokio mcp [--root <dir>]` | Serves the tools below over MCP (stdio). |
| `tokio hook` | `PreToolUse` hook. Reads the event on stdin, exits `2` to block secret access or an edit outside the write scope. |
| `tokio scope [<repo>...] [--hours <n>] [--clear] [--root <dir>]` | Shows or grants write on catalog repositories. Run it yourself, not through the agent. |
| `tokio map "<task>" [--root <dir>] [--target <path>] [--budget <tokens>]` | Prints the ranked repository map for a task. |
| `tokio map check [--root <dir>] [--prompts <file>] [--verbose]` | Checks the architecture map's entries and the areas sample prompts match. Exits 1 on a failure. |
| `tokio doctor [--root <dir>]` | Read-only check of the project's Tokio setup. Reports missing or misplaced config, such as a permissions rule nested inside a hook. Exits 1 on failures. |
| `tokio bench <tasks.json> [--repeat <n>] [--out <report.json>]` | Compares raw and Tokio prompts through `claude -p`. |

MCP tools:

- `refine_task` redacts credential-shaped values, then applies Tokio's deterministic refinement.
- `repo_map` returns files ranked by task terms, import relationships (JS/TS, Python, Go, Rust, and PHP through `composer.json` PSR-4), and co-change history from git when available, with top-level signatures and line numbers, within a token budget. PHP methods are listed inside their classes.
- `read_symbol` returns a body by line. Repeat reads of the same range return only changed lines, unless `full: true` is passed. Bodies over 200 lines are truncated and stored.
- `search_output` searches the stored remainder of a truncated read.
- `list_repositories` lists the repositories in `tokio.repos.json`: name, path, purpose, which one is the write target, and the merge order. Without the file, it lists the root alone.

### Several local repositories

Put a `tokio.repos.json` in the root that `tokio mcp --root` serves, and commit it. Relative paths resolve against that root, so the file works for anyone who clones the repositories side by side.

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

`default` is the write target. The other repositories are references. `dependsOn` sets the merge order: dependencies merge first. Commit each repository on its own, using the same branch name in every repository a feature touches.

With more than one repository:

- `repo_map`, `read_symbol`, `find_symbol`, and `route_task` take an optional `repo`. Without it, `repo_map`, `find_symbol`, and `route_task` cover every repository, and `read_symbol` reads from the default one. `path` and `targetPath` are relative to the chosen repository, or to the default one.
- Output paths carry their repository, such as `[backend] src/api/upload.ts`.
- An import of a package that another repository publishes links the two files in the map. The package can be a `package.json` name, a `go.mod` module, or a top-level Python package. So the files behind an API contract or a shared type rank together.
- `route_task` names the write target and the read-only repositories with relevant files, and warns when most relevant files are in a read-only one.
- An invalid catalog makes these tools and `list_repositories` return an error that names the problem.

The `tokio hook` PreToolUse hook blocks Edit, Write, MultiEdit, and NotebookEdit in any catalog repository except the default one. When a task needs another repository, run this in your own terminal:

```powershell
node D:/tokio/out/broker/cli.js scope backend              # write on backend for 4 hours
node D:/tokio/out/broker/cli.js scope backend --hours 8    # 1 to 24 hours
node D:/tokio/out/broker/cli.js scope                      # show the current scope
node D:/tokio/out/broker/cli.js scope --clear              # back to the default only
```

The Tokio panel in VS Code does the same from its **Repositories** card. It reads `tokio.repos.json` in the first workspace folder. It lists each repository with its access: write target, read-only, edits allowed until a time, or missing. Each repository has buttons to allow or revoke edits, make it the write target, or remove it, and the card can add a repository with a folder picker. Removing asks first and never touches the repository's files. Edits to the catalog are checked before saving, so the panel cannot write an invalid file. The card needs a trusted, local workspace.

**Repository map.** Open it with **⤢ Open Map** on the Workspace card or the command **Tokio: Open Repository Map**. Repositories are nodes on a board:

- Drag a node to arrange it. Positions are saved per user in `.tokio/layout.json`.
- Zoom with Ctrl + wheel, a trackpad pinch, `+` and `-`, or the − / 100% / + controls (25%–200%). Pan by dragging empty space, with the middle button, holding Space while dragging, or the wheel. **Fit** or `F` frames every repository, `0` resets to 100%, and `Esc` clears the selection.
- **Lines** sets the connector shape (curved, straight, or step), a style for each kind (solid, dashed, dotted, or long dash), and grid snapping. These save with the layout.
- Drag a node's ● port onto another node to record a dependency (`dependsOn`).
- Click a connection to see its dependency, file links, and detected imports. Remove any of them, or pin a detected import as a link.
- **+** adds a repository or a file link. A file link pins a contract that imports cannot reveal, such as an API route and the code that calls it:

```json
"links": [
  { "from": "frontend:src/api/upload.ts", "to": "backend:routes/api.php", "kind": "api", "note": "POST /users/{id}/avatar" }
]
```

Each repository scans up to 500 files. A large one can raise its own cap, up to 5000, with `"maxFiles": 2500` in its catalog entry. Laravel's generated `storage/framework`, `storage/logs`, and `bootstrap/cache` are skipped.

`kind` is one of `api`, `type`, `event`, `schema`, `config`, or `other`. Links live in `tokio.repos.json`, so the team and the agent share them: `repo_map` ranks both ends of a link together, and its automatic repository pick brings in the repository on the other end.

Grants live in `.tokio/scope.json`, and `tokio init` adds it and `.tokio/layout.json` to `.gitignore`. The hook refuses any agent attempt to run `tokio scope` or to write that file, so only you can widen the scope. An invalid catalog blocks edits until it is fixed.

With several repositories, `tokio init` adds the commit rules to the AGENTS.md block, the audit log records which repositories each call used, `tokio stats` shows calls per repository, and `tokio doctor` checks each catalog path.

Read-only scope is a guard, not a sandbox. The hook sees file-edit tools and the text of shell commands, but not what a script writes once it runs. Review diffs in read-only repositories as usual.

Register the server in the project's `.mcp.json`, replacing the path with your checkout:

```json
{
  "mcpServers": {
    "tokio": {
      "command": "node",
      "args": ["D:/tokio/out/broker/cli.js", "mcp", "--root", "D:/your-project"]
    }
  }
}
```

Block secret access with a hook in the project's `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read|Edit|Write|MultiEdit|Grep|Glob|Bash",
        "hooks": [{ "type": "command", "command": "node D:/tokio/out/broker/cli.js hook" }]
      }
    ]
  }
}
```

### Automatic repository context (optional)

`tokio prompt-hook` is a `UserPromptSubmit` hook. When a prompt names things that exist in the repository, it adds a ranked repository map to that prompt, so the agent does not have to call `repo_map` itself. It adds nothing for short prompts, slash commands, or prompts that match no files. The map is capped at about 1,500 tokens and is redacted for credential-shaped values. Every injection is recorded in `.tokio/audit.log` without the prompt text.

Register it in the project's `.claude/settings.json`, next to the PreToolUse hook:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [{ "type": "command", "command": "node D:/tokio/out/broker/cli.js prompt-hook" }]
      }
    ]
  }
}
```

The hook fails open. Any error, such as a missing repository or malformed input, adds nothing and never blocks the prompt. Claude Code allows 30 seconds for this hook and caps the injected context at 10,000 characters. Injection costs tokens on every matching prompt, even when the agent would not have needed the map. Whether it saves tokens overall depends on the task, so measure it with `tokio bench` before relying on it.

### Command output compaction

`tokio output-hook` is a `PostToolUse` hook for Bash and PowerShell. When a test, build, lint, or install command (`npm test`, `tsc`, `pytest`, `cargo test`, `php artisan test`, `composer install`, and similar) prints more than about 4,000 characters, the hook replaces the output the agent sees with:

- the first 5 and last 20 lines, which usually hold the command and the summary;
- every line that looks like an error, failure, assertion, warning, or `file:line` location, plus the 2 lines after it (up to 80 lines). Failures and thrown errors (`✖`, `not ok`, `FAIL`, `TypeError:`, `Traceback`) are picked before warnings, and passing-test lines (`✔`, `ok 3`, `PASS`) never count, even when a test's name mentions an error;
- a marker for each omitted run of lines, and a footer with an output id.

ANSI color codes and carriage-return progress frames are removed, and repeated lines collapse into one. The full output is redacted for credential-shaped values and saved under the system temp directory (`tokio-outputs`, newest 50 kept). `search_output` with the footer's id searches it. Output from other commands, and output that compaction would shrink by less than 30%, passes through unchanged. Any hook error also leaves the original output in place. `tokio init` registers the hook, and each compaction is recorded in `.tokio/audit.log` with its estimated savings.

The command has already run when the hook fires; only what the agent reads changes. A failure line that matches none of the patterns can be dropped, so the agent may need `search_output` for unusual tools.

Secret paths (`.env`, credential files, keys) are blocked in file fields and in Bash command tokens. Unparseable hook input is blocked. The hook blocks Bash commands that read whole trees: recursive `grep` (`-r`, `-R`, `--recursive`), `find -exec`, and `xargs` feeding a reader such as `cat`. The agent is asked to name files explicitly. It still does not parse arbitrary shell, so quoted or nested commands, shell globs such as `cat *`, and `$(find ...)` can still read secret files. As a second layer, `tokio init` adds `Read(...)` deny rules for the same file patterns to `permissions.deny` in `.claude/settings.json`. Claude Code applies a `Read` deny to Read, Grep, Glob, and Edit/Write on the same path, and it enforces the rule even when a hook allows the call. Deny rules match Bash command text, not what a program reads, so they do not stop `grep -r` or `cat` run through Bash. The hook is the only Bash-side check. Use a sandbox if Bash reads must be fully blocked.

Every broker call and every hook block appends one line to `.tokio/audit.log`. The log records tool name, estimated tokens, file paths, and redaction kinds. It never records file contents or prompt text. The `*.log` pattern in `.gitignore` keeps it out of version control.

### Benchmark

`tokio bench` runs each task twice, once with the raw text and once with the Tokio prompt (refined prompt plus repository map), using `claude -p --output-format json`. Prompts are sent on stdin. The Tokio arm is a proxy for the MCP flow, where the agent pulls the same context on demand.

Each arm reports the figures the agent itself returns for the whole run, summed across turns:

- `billableTokens`: input, cache-creation, and output tokens. Cache reads are excluded because they are billed at a lower rate.
- `turns` and `duration`: the agent's own turn count and wall-clock time.
- `costUsd`: the agent's reported cost.
- `verified`: pass count out of tasks that have a `verify` command.

A task may set `verify`, a shell command that runs after the agent exits. Exit code `0` counts as a pass. Verified tasks run each arm in a fresh `git worktree` at the repository's `HEAD`, so the agent's edits never reach the next run or your working tree. Uncommitted changes are not included. A `node_modules` folder in the repository is shared into each worktree through a junction, so commands such as `npm test` can run. The agent must be allowed to edit files in headless mode. A project `.claude/settings.json` committed to the repository is the usual way to grant that.

```json
[
  { "id": "login-redirect", "task": "Fix the redirect loop after login in the auth middleware.", "verify": "npm test" },
  { "id": "csv-export", "task": "Add a CSV export option to the reports page." }
]
```

Tasks without `verify` run in the current working tree, as before, and report `verified=n/a`.

Results depend on the model, the repository, and the task set. Run enough tasks and repeats to see the variance before drawing conclusions.

#### Live mode: with and without Tokio

`--mode live` measures Tokio as agents actually use it. Both arms get the same task text; only the setup differs:

- **off**: `--strict-mcp-config` with no MCP servers, and `--settings` with `disableAllHooks`, so no Tokio hooks run, even ones the repository's own settings register.
- **on**: `--strict-mcp-config` with the Tokio MCP server rooted in the run's workspace, the Tokio `PreToolUse`, `PostToolUse`, and `UserPromptSubmit` hooks, and `--allowedTools mcp__tokio`.
- Both arms get `--permission-mode acceptEdits` and the secret-file `Read` deny rules, so they differ only in Tokio.

Every live run gets its own throwaway workspace, with `.tokio/map.md` and `.tokio/map-prompts.json` copied in even when they are not committed. Live mode defaults to 3 repeats and reports, per task, the median billable tokens per arm with the lowest and highest run, verify passes, and the on/off ratio; then the median ratio across tasks and the pass rate per arm. The on arm also records Tokio tool calls per tool from its own audit log (`--out` saves them).

A task can be rebuilt from a real fix commit, SWE-bench style:

```json
[
  { "id": "loan-schedules", "task": "Editing a loan entry wipes its payout deduction schedules. Preserve them on update.",
    "commit": "bd47831e", "verify": "php vendor/bin/phpunit tests/Feature/LoanEntry/UpdateLoanEntryTest.php" }
]
```

The workspace starts at the commit's parent, and the commit's test files are checked out on top: by default every file it changed under a tests folder, or the files listed in `"tests"`. Run `tokio bench <tasks.json> --check` first. Without starting an agent, it confirms each commit task's tests fail before the fix and pass at the fix; a task that already passes measures nothing.

- `--share <folder>` links another ignored folder, such as `vendor`, into each workspace (`node_modules` is always linked).
- `--copy <file>` copies an ignored file, such as a test environment file, into each workspace. It may hold credentials, so name it only when the tests need it. Both arms deny `Read` on secret files, and the on arm's hook also blocks Bash reads of them. The off arm has no hook, so a Bash command such as `cat` can still read the file there.
- Runs are sequential, so arms that share one test database do not collide.
- Verify commands run through the system shell, `cmd.exe` on Windows: write `php vendor/bin/phpunit …`, not `./vendor/bin/phpunit …`.
- Each live run is a full headless agent session and is billed as one. Five tasks with three repeats is 30 sessions.

## Create and install a local VSIX

The VSIX packaging tool is not a project dependency. Use `npx` to fetch the official packaging CLI on demand and build a local package:

```powershell
npx.cmd @vscode/vsce package --allow-missing-repository
```

This produces `tokio-<version>.vsix` for the version in `package.json` (0.6.0 at the time of writing). Install it with:

```powershell
code --uninstall-extension local.token-saver
code --install-extension .\tokio-0.6.0.vsix --force
```

Version 0.5 renamed the extension identifier from `local.token-saver` to `local.tokio`. The uninstall command above only needs to run once, to avoid duplicate Activity Bar entries.

The `vscode:prepublish` hook runs a clean build, and `.vscodeignore` keeps source, tests, source maps, development configuration, and dependencies out of the package.

## Manual QA checklist

- Open the Activity Bar view and confirm there are no CSP or runtime errors in Developer Tools.
- Refine blank, multiline, Unicode, special-character, and long prompts.
- Test Minimal, Adaptive, and Strict modes, with and without a target path.
- Test Auto Detect and every manual category; verify prompts with no clear signal fall back to General.
- Paste a prompt that mixes work (for example a bug, tests, and a migration); press Refine Prompt and confirm the `+` badges appear and each adds an `Also:` line.
- Compare Compact and Detailed output and verify the displayed estimates update after editing either prompt.
- Test None, Targeted, and Architecture context; inspect and deselect suggested files.
- Confirm context scanning is rejected in an untrusted workspace.
- Confirm `.env`, credential, key, binary, dependency, and build files are not suggested.
- Edit the task after previewing context and confirm Refine requires a fresh preview.
- Confirm every original requirement appears in the result.
- Switch modes without refining and verify existing input and output remain unchanged.
- Edit the output, copy it, and confirm the pasted text matches exactly.
- Test Use Editor Selection, Use Active File, Open in Editor, and the live counters.
- Test copy with empty output and with repeated clicks.
- Use Clear and verify all fields, default mode, button state, and keyboard focus.
- Check keyboard navigation and both light and dark VS Code themes.
- Confirm the Network panel shows no extension-initiated requests.

## MVP limitations

- Refinement is rule-based rather than semantic or AI-assisted.
- Repository matching is filename/import heuristic-based and may miss relevant files, especially after the 500-path cap.
- Architecture knowledge is only as accurate as the user-maintained profile.
- Prompts must be copied and pasted manually in the VS Code panel; there is no interception or automatic submission. The agent broker supplies context through MCP for Claude Code only.
- The repository map uses regex symbol extraction and regex import rules for JS/TS, Python, Go, and Rust. Rules are dependency-free and approximate: Go resolution matches package directories by import path suffix, and Python and Rust follow the common layouts only.
- Co-change ranking uses the last 300 commits, and only when git can read the repository. Bulk commits and pairs that changed together fewer than twice are ignored.
- Other MCP servers are not trimmed by Tokio. Use a tool such as mcpfold or mcp-compressor for their schemas.
- There are no accounts, telemetry, analytics, persistence across VS Code sessions, or remote calls.
- Prompt length is not the same as end-to-end coding-agent token usage; no token-saving claim has been benchmarked.
- Automated tests cover the core and message contracts, but not rendered VS Code UI behavior or the operating-system clipboard integration.
