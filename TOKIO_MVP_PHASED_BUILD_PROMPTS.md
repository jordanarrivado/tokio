# Tokio — Phased MVP Build Prompts

> **Historical document.** This playbook describes the original MVP build of **Tokio** (identifier `local.tokio`). Some paths and commands below reflect that build and may differ from the current code; see [README.md](README.md) for current behavior.

A copy-ready implementation playbook for **Codex or Claude Code in VS Code**.

## Product goal

Build a VS Code extension that takes a raw coding request and returns a concise, scoped, implementation-ready prompt. In V1 it is **local and rule-based**: no AI provider, no network access, and no automatic submission to other coding agents. Users can preview, edit, and copy the refined prompt.

**Primary flow:** Open Tokio → paste raw prompt → choose Minimal / Adaptive / Strict → Refine → review/edit result → Copy → paste into Codex or Claude Code.

**Success criteria:** working extension in an Extension Development Host; deterministic unit tests; no network dependencies; empty-input and error handling; easy clipboard copy; original requirements retained verbatim in the refined prompt when semantic rewriting is unavailable.

## Operating rules for all phases

1. Work on **one phase per request**. Do not preemptively implement future phases.
2. Inspect only relevant project files first; inspect dependencies when necessary. Do not refactor unrelated code.
3. Prefer built-in VS Code APIs and small dependencies. Do not add an AI SDK or MCP integration to V1.
4. Use TypeScript with strict type checking. Keep core refinement logic independent of VS Code APIs for testing.
5. Preserve the user's original task requirements. Never claim rule-based code semantically interprets arbitrary requests.
6. Prefer concise outputs: files changed, checks performed/results, and any blocker. Do not dump entire files unless requested.
7. Run targeted tests and type checks for affected code; do not run unrelated full-repository operations.
8. After each phase, **stop** and wait for review/approval before starting the next.
9. If a key prerequisite is missing, ask one targeted question; otherwise use the defaults in this guide.
10. Do not claim guaranteed token savings. Later benchmarks should measure end-to-end agent usage, not just prompt length.

## Technical decisions (fixed for V1)

- **Platform:** VS Code desktop extension, TypeScript.
- **UI:** VS Code webview view in the Activity Bar (simple accessible HTML/CSS/JS with Content Security Policy), plus command to focus the view. Do not inject into Codex/Claude chat boxes.
- **Core engine:** pure TypeScript in `src/core/`.
- **Modes:** `minimal`, `adaptive` (default), `strict`.
- **Input:** raw prompt, optional target file path, refinement mode.
- **Output:** refined plain-text prompt, editable in UI before copying.
- **Permissions:** no workspace file reads required for V1; optional target path is user-provided, not inferred. No telemetry.
- **Tests:** Node built-in test runner or a light test runner already present; use one consistent approach.
- **Packaging:** VS Code extension manifest, README and build scripts.

## Suggested repository tree

```text
tokio/
├── src/
│   ├── core/
│   │   ├── types.ts
│   │   ├── refine.ts
│   │   └── refine.test.ts
│   ├── ui/
│   │   └── panel.ts
│   └── extension.ts
├── media/              # only if needed
├── package.json
├── tsconfig.json
├── README.md
└── .vscodeignore
```

Paths are suggestions; adapt to the scaffold you create without introducing unnecessary folders.

---

# Phase 0 — Scope and acceptance criteria

**Purpose:** Confirm V1 and prevent scope creep. No implementation.

### Copy-ready prompt

```text
You are helping me build "Tokio", a token-efficient coding prompt refiner for use alongside Codex and Claude Code in VS Code.

V1 scope:
- Standalone VS Code extension with an Activity Bar webview.
- Raw prompt + optional target path + Minimal/Adaptive/Strict mode.
- Deterministic, local rule-based refinement.
- Editable refined output and Copy button.
- No API calls, MCP, account system, automatic message interception, or sending to coding agents.

First, inspect only any existing manifest/README or relevant scaffold files. Do not write code. Return a concise implementation plan, acceptance criteria, and concrete file list. Flag only blocking questions; otherwise use the V1 defaults above. Stop after planning.
```

**Gate:** A short implementation plan clearly excludes AI integration, MCP, and automatic agent submission.

---

# Phase 1 — Scaffold the VS Code extension

**Purpose:** Create an extension that activates successfully in the Extension Development Host.

### Copy-ready prompt

```text
Implement Phase 1 ONLY of Tokio.

Create a minimal TypeScript VS Code extension scaffold:
- package.json with correct VS Code engine, activation, command, Activity Bar view container and webview view contributions.
- TypeScript compilation and basic build/check scripts.
- src/extension.ts registering a WebviewViewProvider and a command to focus the Tokio view.
- A minimal placeholder webview with CSP and no external scripts/resources.
- README with instructions to run the Extension Development Host (F5).

Constraints: use built-in VS Code APIs; keep dependencies minimal; no refinement engine or full UI yet. Preserve any existing project work.

Validate compilation and that the extension can activate where testable. Return a concise file/change summary and exact manual F5 check. Stop after Phase 1.
```

**Gate:** F5 opens an Extension Development Host; Activity Bar shows Tokio; panel renders without CSP errors.

---

# Phase 2 — Pure refinement engine

**Purpose:** Make prompt construction testable without VS Code. Be transparent that V1 is rule-based, not semantic AI rewriting.

### Copy-ready prompt

```text
Implement Phase 2 ONLY of Tokio. Do not modify the webview beyond what's required for compilation.

Create pure TypeScript refinement logic under src/core/ with:
- Types: Mode = 'minimal' | 'adaptive' | 'strict'; input = { rawPrompt: string; targetPath?: string; mode?: Mode }; output includes refinedPrompt and mode.
- Trim input, reject blank prompts, and preserve the substantive original task text without deleting requirements.
- Optional target path rendered as "Start with: <path>". Never claim that file content was inspected.
- Minimal mode: task + smallest safe change + focused validation + brief report.
- Adaptive mode: task + prefer existing patterns + start from provided file/only necessary related files + avoid unrelated edits + focused validation + brief report.
- Strict mode: Adaptive constraints plus no new dependencies, schema changes, or architectural changes without explicit approval; do not unnecessarily block direct dependencies.
- Avoid repeating identical boilerplate; don't invent task type, acceptance criteria, or file paths.
- Deterministic behavior, no AI requests and no third-party runtime dependencies.

Write focused tests covering empty input, whitespace, multiline tasks, paths, every mode, Unicode, and preservation of user requirements. Choose a lightweight test runner consistent with the scaffold.

Run tests and TypeScript checks. Report only changed files, results and caveats. Stop after Phase 2.
```

**Gate:** Core tests pass and the original requirements survive refinement. Modes produce meaningfully different scope instructions.

---

# Phase 3 — Functional webview UI

**Purpose:** Complete the paste → refine → preview experience.

### Copy-ready prompt

```text
Implement Phase 3 ONLY of Tokio.

Replace the placeholder webview with a compact, accessible VS Code-native-looking interface containing:
- Multiline Raw Prompt input.
- Optional Target File Path input.
- Mode selector: Minimal, Adaptive (default), Strict.
- Refine button; disabled when raw input is blank.
- Editable Refined Prompt output and clear inline validation/errors.

Use VS Code webview messaging to call the pure Phase 2 refinement engine in the extension host. Keep refinement logic out of browser scripts. Use CSP/nonces and safely populate text fields (never inject user prompts as HTML). No frameworks, remote resources, or AI APIs.

Preserve input while switching modes; do not overwrite manual output edits unexpectedly. Check basic keyboard accessibility and VS Code light/dark themes.

Run focused checks and provide a short manual test script. Stop after Phase 3.
```

**Gate:** Enter raw text → Refine → editable output appears. Invalid input gets feedback. Themes and keyboard focus work.

---

# Phase 4 — Copy and usability polish

**Purpose:** Make the output practical in daily coding workflows.

### Copy-ready prompt

```text
Implement Phase 4 ONLY of Tokio.

Add to the existing webview:
- Copy Refined Prompt button that copies the CURRENT edited output (not a stale generated value).
- Reliable clipboard behavior using VS Code extension-host clipboard API via message passing.
- Clear copy success/failure status, including when the output is empty.
- Optional "Clear" action with predictable behavior.
- Concise microcopy stating prompts are refined locally and must be pasted manually into Codex/Claude Code.

Keep existing styling minimal and accessible. Do not add sending, interception, analytics, storage, remote calls, or external libraries.

Run targeted checks. Manually test copy → paste in an editor, copying after output edits, empty state, and repeated clicks. Stop after Phase 4.
```

**Gate:** Clipboard contains exactly the current refined text, including manual edits. No accidental automatic submission.

---

# Phase 5 — Testing and regression checks

**Purpose:** Verify that V1 is reliable, not just visually complete.

### Copy-ready prompt

```text
Implement Phase 5 ONLY of Tokio: reliability and regression checks.

Review the actual changed code, then add or improve focused tests for:
- Every refinement mode and optional-path behavior.
- Blank/very long/multiline/Unicode/special-character input.
- Preservation of original task requirements.
- Correct webview request-response and error messages where testable.
- Copy uses the latest edited output.
- No external requests and no untrusted HTML injection.

Fix only defects found in scope. Run type checks, unit tests and build. Provide a short manual Extension Development Host QA checklist and accurately report what was/wasn't tested. Do not claim end-to-end savings or VS Code UI test coverage unless measured. Stop after Phase 5.
```

**Gate:** Build and tests pass; manual QA confirms primary flow; outstanding issues are documented.

---

# Phase 6 — Documentation and local packaging

**Purpose:** Make the MVP runnable and shareable.

### Copy-ready prompt

```text
Implement Phase 6 ONLY of Tokio.

Finish the VS Code extension MVP:
- README: prerequisites, install, F5 development workflow, local usage, each mode, limitations, and how to copy into Codex/Claude Code.
- package.json scripts and sensible extension metadata.
- .vscodeignore to exclude dev/test output and unnecessary files.
- Optional local VSIX packaging command if a packaging tool is already available; otherwise document the exact command and clearly say packaging wasn't executed.
- A small manual QA checklist.

Do not add features, third-party AI calls, integrations, telemetry, or unrelated restructuring.

Run build/tests and report exact outcomes, generated artifact path only if it exists, and remaining limitations. Stop after Phase 6.
```

**Gate:** Another developer can clone, build, run and use the extension from the README.

---

# Optional Phase 7 — Benchmark before AI integration

**Not part of the core MVP.** Establish whether the process truly helps before paying for model-based refinement.

### Copy-ready prompt

```text
Plan and implement an OPTIONAL, LOCAL benchmark harness for Tokio; do not change refinement behavior.

Prepare 15–20 representative prompts (UI tweaks, bug reports, features, refactors) with expected requirements. Evaluate raw vs refined prompt on:
- Requirement preservation and clarity (manual or documented rubric).
- Prompt character length and estimated token counts (clearly labeled estimates).
- If execution logs are provided, actual coding-agent input/output tokens, tool calls, completion correctness, and retries.

Do not fabricate usage figures or promise token savings. Make benchmark repeatable, show trade-offs, and suggest refinements only after evidence. Stop after reporting.
```

**Gate:** Honest repeatable baseline and clear distinction between estimated prompt length and actual coding-agent token consumption.

---

# Later roadmap — deliberately excluded from V1

- **AI semantic refiner:** optional model provider; request/response schema; cache; user consent and cost limits; clarify critical ambiguities; preserve constraints.
- **Workspace-aware scope suggestions:** opt-in targeted file inspection with privacy safeguards and bounded search.
- **MCP server:** explicit agent-invoked `refine_coding_prompt` tool, not a promise of interception.
- **Agent integrations:** only through officially supported mechanisms; separate manual-copy V1 from automatic execution.
- **Measurement dashboard:** actual token/cost outcomes when authorized usage data is available.

## How to use this guide

1. Open your `tokio` workspace in VS Code.
2. Give Codex or Claude Code the **Operating rules for all phases** once, preferably in a short `AGENTS.md` or `CLAUDE.md`.
3. Paste the **Phase 0** prompt and review the plan.
4. Paste each subsequent phase prompt individually. Verify the stated gate before proceeding.
5. Use a Git commit after each phase to make reviewing/rolling back easy.

**Reminder:** The prompts intentionally favor small, reliable changes over artificially short wording. Total agent effort matters more than raw prompt character count.
