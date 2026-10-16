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

Auto Detect is the default. It uses local deterministic phrase scoring and displays the suggested category, confidence, and matched signals while you type. Low-confidence or ambiguous input falls back to General. Selecting a category manually pauses automatic selection until Auto Detect is selected again.

| Category | Added guidance |
| --- | --- |
| General | Adds no category assumptions. |
| Bug Fix | Confirms root cause, requests the smallest safe fix, and adds regression validation. |
| Feature | Limits implementation to the requested behavior and its focused validation. |
| Enhancement | Preserves compatibility around the requested workflow improvement. |
| Refactor | Preserves observable behavior and prevents unrelated feature work. |
| Performance | Requires a baseline, measurement, and evidence for improvement claims. |
| Tests | Prefers deterministic test-only changes unless production code must be fixed. |
| Documentation | Verifies examples and avoids runtime changes. |
| Investigation | Collects evidence without modifying code unless implementation was requested. |
| Other | Records the work type without adding assumptions. |

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

## Agent broker (Claude Code and Codex)

The broker is a local CLI with no runtime dependencies. It is separate from the VS Code panel and does not call any AI service. Build it first with `npm.cmd run build`, then run it from `out/broker/cli.js`.

### Set up a project

From the project root, run:

```powershell
node D:/token-saver/out/broker/cli.js init
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
| `tokio hook` | `PreToolUse` hook. Reads the event on stdin, exits `2` to block secret access. |
| `tokio map "<task>" [--root <dir>] [--target <path>] [--budget <tokens>]` | Prints the ranked repository map for a task. |
| `tokio bench <tasks.json> [--repeat <n>] [--out <report.json>]` | Compares raw and Tokio prompts through `claude -p`. |

MCP tools:

- `refine_task` redacts credential-shaped values, then applies Tokio's deterministic refinement.
- `repo_map` returns files ranked by task terms, import relationships (JS/TS, Python, Go, Rust), and co-change history from git when available, with top-level signatures and line numbers, within a token budget.
- `read_symbol` returns a body by line. Repeat reads of the same range return only changed lines, unless `full: true` is passed. Bodies over 200 lines are truncated and stored.
- `search_output` searches the stored remainder of a truncated read.

Register the server in the project's `.mcp.json`, replacing the path with your checkout:

```json
{
  "mcpServers": {
    "tokio": {
      "command": "node",
      "args": ["D:/token-saver/out/broker/cli.js", "mcp", "--root", "D:/your-project"]
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
        "hooks": [{ "type": "command", "command": "node D:/token-saver/out/broker/cli.js hook" }]
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
        "hooks": [{ "type": "command", "command": "node D:/token-saver/out/broker/cli.js prompt-hook" }]
      }
    ]
  }
}
```

The hook fails open. Any error, such as a missing repository or malformed input, adds nothing and never blocks the prompt. Claude Code allows 30 seconds for this hook and caps the injected context at 10,000 characters. Injection costs tokens on every matching prompt, even when the agent would not have needed the map. Whether it saves tokens overall depends on the task, so measure it with `tokio bench` before relying on it.

Secret paths (`.env`, credential files, keys) are blocked in file fields and in Bash command tokens. Unparseable hook input is blocked. The hook does not parse arbitrary shell, so broad searches such as `grep -r` can still read secret files. As a second layer, `tokio init` adds `Read(...)` deny rules for the same file patterns to `permissions.deny` in `.claude/settings.json`. Claude Code applies a `Read` deny to Read, Grep, Glob, and Edit/Write on the same path, and it enforces the rule even when a hook allows the call. Deny rules match Bash command text, not what a program reads, so they do not stop `grep -r` or `cat` run through Bash. The hook is the only Bash-side check. Use a sandbox if Bash reads must be fully blocked.

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

## Create and install a local VSIX

The VSIX packaging tool is not a project dependency. Use `npx` to fetch the official packaging CLI on demand and build a local package:

```powershell
npx.cmd @vscode/vsce package --allow-missing-repository
```

This produces `tokio-0.5.2.vsix` for the current version. Install it with:

```powershell
code --uninstall-extension local.token-saver
code --install-extension .\tokio-0.5.2.vsix --force
```

Version 0.5 renamed the extension identifier from `local.token-saver` to `local.tokio`. The uninstall command above only needs to run once, to avoid duplicate Activity Bar entries.

The `vscode:prepublish` hook runs a clean build, and `.vscodeignore` keeps source, tests, source maps, development configuration, and dependencies out of the package.

## Manual QA checklist

- Open the Activity Bar view and confirm there are no CSP or runtime errors in Developer Tools.
- Refine blank, multiline, Unicode, special-character, and long prompts.
- Test Minimal, Adaptive, and Strict modes, with and without a target path.
- Test Auto Detect and every manual category; verify ambiguous prompts fall back to General.
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
