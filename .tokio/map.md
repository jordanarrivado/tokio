# Architecture map

One heading per area. Tokio matches the task against each area and sends the agent only the matched
files and lines. Route lines: `- <label> -> <path>[#symbol]`. Paths are relative to the repository root.

## MCP server and agent tools
Keywords: mcp, json-rpc, stdio, tool, broker, agent, claude, codex, cancel, timeout, schema, validation, tool call, truncated output
- MCP stdio server -> src/broker/mcp.ts#createMcpServer
- stdio loop -> src/broker/mcp.ts#serveStdio
- tool registry and dispatch -> src/broker/tools.ts#Broker
- call a tool with timeout -> src/broker/tools.ts#Broker.callTool
- refine_task tool -> src/broker/tools.ts#Broker.refineTask
- repo_map tool -> src/broker/tools.ts#Broker.repoMap
- read_symbol tool -> src/broker/tools.ts#Broker.readSymbol
- search_output tool -> src/broker/tools.ts#Broker.searchOutput
- stored output for search -> src/broker/tools.ts#Broker.storeOutput
- find_symbol tool -> src/broker/tools.ts#Broker.findSymbol
- route_task tool -> src/broker/tools.ts#Broker.routeTask
- list_repositories tool -> src/broker/tools.ts#Broker.listRepositories
- Related: src/broker/cli.ts, src/broker/mcp.test.ts, src/broker/tools.test.ts, .mcp.json

## Prompt refinement
Keywords: refine, prompt, scoped prompt, mode, minimal, adaptive, strict, category, classify, clarity, compact, detailed, rewrite task, prompt target, output style
- refine prompt -> src/core/refine.ts#refinePrompt
- work category detection -> src/core/category.ts#classifyWorkCategory
- prompt clarity score -> src/core/analysis.ts#analyzePrompt
- token estimate -> src/core/tokens.ts#estimateTokens
- Related: src/core/types.ts, src/core/refine.test.ts, src/core/category.test.ts, src/core/analysis.test.ts

## Repository map and ranking
Keywords: repo map, rank, pagerank, signatures, symbols, budget, imports, co-change, git history, scan, relevant files, php, composer, python, go, rust, packages, monorepo, related tests
- build repo map -> src/context/repomap.ts#buildRepoMap
- top-level symbols -> src/context/repomap.ts#extractSymbols
- import graph -> src/context/repomap.ts#buildImportEdges
- language imports (Python, Go, PHP, Rust) -> src/context/imports.ts#resolveLanguageImports
- PHP composer namespaces -> src/context/imports.ts#parseComposerNamespaces
- package imports across repos -> src/context/packages.ts#linkPackageImports
- co-change links -> src/context/history.ts#readCoChangeLinks
- repository scan -> src/broker/scan.ts#scanRepository
- search terms -> src/context/discovery.ts#extractSearchTerms
- rank context paths -> src/context/discovery.ts#rankContextPaths
- related tests -> src/context/discovery.ts#findRelatedTests
- Related: src/context/repomap.test.ts, src/context/imports.test.ts, src/context/php.test.ts, src/context/packages.test.ts, src/context/history.test.ts, src/context/discovery.test.ts, src/broker/scan.test.ts

## Architecture map
Keywords: architecture map, map.md, routes, areas, bm25, stale, regenerate, create map, generate map, open map, session, anchors, line range
- parse map -> src/context/archmap.ts#parseArchitectureMap
- rank areas -> src/context/archmap.ts#rankMapAreas
- resolve lines -> src/context/archmap.ts#resolveMapAnchors
- format map routing -> src/context/archmap.ts#formatMapRouting
- symbol line range -> src/context/archmap.ts#findSymbolRange
- check stale entries -> src/context/archmap.ts#checkMap
- new map template -> src/context/archmap.ts#MAP_TEMPLATE
- load map file -> src/broker/mapfile.ts#loadArchitectureMap
- once-per-session record -> src/broker/mapfile.ts#recordSessionAreas
- repo_map routes from the map -> src/broker/tools.ts#Broker.routeFromMap
- tokio map command -> src/broker/cli.ts#runMapCommand
- map request text -> src/ui/mapgen.ts#buildMapRequest
- generate map from the panel -> src/ui/panel.ts#generateArchitectureMap
- panel map status -> src/context/workspace.ts#architectureMapStatus
- open or create map -> src/context/workspace.ts#openArchitectureMap
- route a panel prompt through the map -> src/context/workspace.ts#routeArchitectureMap
- tokio map check command -> src/broker/cli.ts#runMapCheckCommand
- sample prompts file -> src/broker/mapcheck.ts#parseMapPrompts
- run sample prompts -> src/broker/mapcheck.ts#runMapPrompts
- folder entries -> src/broker/mapfile.ts#isRoutedFolder
- Related: .tokio/map.md, .tokio/map-prompts.json, src/context/archmap.test.ts, src/broker/mapfile.test.ts, src/broker/mapcheck.test.ts, src/ui/mapgen.test.ts

## Command output compaction (PostToolUse)
Keywords: compact, compaction, output hook, post tool use, test output, build log, noisy command, long output, saved output, updatedToolOutput
- PostToolUse output hook command -> src/broker/cli.ts#runOutputHookCommand
- noisy command detection -> src/broker/compact.ts#isNoisyCommand
- keep failures, head and tail -> src/broker/compact.ts#compactText
- compact a command's output -> src/broker/compact.ts#compactCommandOutput
- save full output -> src/broker/compact.ts#saveOutput
- read saved output for search_output -> src/broker/compact.ts#readSavedOutput
- Related: src/broker/compact.test.ts

## Prompt hook (UserPromptSubmit)
Keywords: prompt hook, user prompt submit, inject context, automatic context, session id, hook output, budget
- prompt hook command -> src/broker/cli.ts#runPromptHookCommand
- map context for a prompt -> src/broker/cli.ts#injectMapContext
- parse hook event -> src/broker/prompt-hook.ts#parsePromptHookEvent
- repo map decision -> src/broker/prompt-hook.ts#decidePromptContext
- map decision -> src/broker/prompt-hook.ts#decideMapContext
- map context text -> src/broker/prompt-hook.ts#formatMapContext
- Related: src/broker/prompt-hook.test.ts, .claude/settings.json

## Secret protection and tool policy (PreToolUse)
Keywords: secret, env, credentials, keys, block, deny, redact, pre tool use, hook, policy, path traversal, recursive grep, security
- PreToolUse hook command -> src/broker/cli.ts#runHookCommand
- evaluate tool call -> src/broker/hook.ts#evaluateToolUse
- parse tool call -> src/broker/hook.ts#parseToolUse
- secret in a command -> src/broker/policy.ts#findSecretReference
- broad read command -> src/broker/policy.ts#findBroadReadCommand
- safe path resolution -> src/broker/policy.ts#resolveRepoPath
- redact secrets -> src/broker/policy.ts#redactSecrets
- secret path patterns -> src/context/discovery.ts#isSecretPath
- Related: src/broker/policy.test.ts, src/broker/hook.test.ts, src/ui/security.test.ts

## Write scope and edit grants
Keywords: write target, read-only, grant, revoke, clear, scope, permission, edit access, hours, expiry
- tokio scope command -> src/broker/cli.ts#runScopeCommand
- check a write -> src/broker/scope.ts#evaluateWriteScope
- grant edits -> src/broker/scope.ts#grantScope
- revoke a grant -> src/broker/scope.ts#revokeScope
- clear all grants -> src/broker/scope.ts#clearScope
- read grants -> src/broker/scope.ts#readGrants
- Related: src/broker/scope.test.ts

## Multiple repositories (catalog)
Keywords: catalog, tokio.repos.json, repositories, multi-repo, dependency, merge order, links, list repositories, add repo, remove repo, default repo
- load catalog -> src/broker/catalog.ts#loadCatalog
- parse catalog -> src/broker/catalog.ts#parseCatalog
- merge order -> src/broker/catalog.ts#dependencyOrder
- add repository -> src/broker/catalog.ts#addRepo
- remove repository -> src/broker/catalog.ts#removeRepo
- set default repository -> src/broker/catalog.ts#setDefaultRepo
- add dependency -> src/broker/catalog.ts#addDependency
- add link -> src/broker/catalog.ts#addLink
- pick repositories for a task -> src/broker/repos.ts#pickReposForTask
- select repositories -> src/broker/repos.ts#selectRepos
- cross-repo links -> src/broker/repos.ts#detectCrossRepoLinks
- Related: tokio.repos.json, src/broker/catalog.test.ts, src/broker/repos.test.ts, src/broker/links.test.ts

## Messaging between repository agents
Keywords: ask repo, messaging, send message, ~name, relay, other repository, answer agent, feedback, connect, disconnect
- ask_repo tool -> src/broker/tools.ts#Broker.askRepo
- run answer agent -> src/broker/ask.ts#runAnswerAgent
- answer prompt -> src/broker/ask.ts#buildAskPrompt
- addressed prompt (~name:) -> src/broker/messaging.ts#addressedPromptContext
- route addressed prompt -> src/broker/messaging.ts#routeAddressedPrompt
- messaging switch -> src/broker/messaging.ts#evaluateMessaging
- connect or disconnect a repository -> src/broker/messaging.ts#setConnection
- Related: src/broker/messaging.test.ts

## Task routing and model choice
Keywords: route task, tier, small, medium, large, model, phase, validation commands, confidence, test command
- plan route -> src/context/routing.ts#planRoute
- decide tier -> src/context/routing.ts#decideTier
- plan phases -> src/context/routing.ts#planPhases
- relevant files -> src/context/routing.ts#findRelevantFiles
- validation commands -> src/context/project.ts#detectValidationCommands
- Related: src/context/routing.test.ts, src/broker/route.test.ts, src/context/project.test.ts

## Audit log, stats, and savings
Keywords: audit, log, stats, tokens saved, savings, footer, session stats, estimate, by repository
- write audit entry -> src/broker/audit.ts#appendAuditEntry
- read audit entries -> src/broker/stats.ts#readAuditEntries
- summarize audit -> src/broker/stats.ts#summarizeAudit
- format stats -> src/broker/stats.ts#formatStats
- savings footer -> src/broker/stats.ts#formatFooter
- session_stats tool -> src/broker/tools.ts#Broker.sessionStats
- tokio stats command -> src/broker/cli.ts#runStatsCommand
- Related: src/broker/stats.test.ts, src/broker/audit.test.ts, src/broker/repo-audit.test.ts

## Project setup and health checks
Keywords: init, setup, install, doctor, AGENTS.md, settings.json, .mcp.json, codex config, gitignore, guidance
- CLI entry -> src/broker/cli.ts#main
- tokio init command -> src/broker/cli.ts#runInitCommand
- tokio init -> src/broker/init.ts#initProject
- tokio doctor command -> src/broker/cli.ts#runDoctorCommand
- tokio doctor -> src/broker/doctor.ts#runDoctor
- check Claude settings -> src/broker/doctor.ts#checkClaudeSettings
- check MCP config -> src/broker/doctor.ts#checkMcpConfig
- Related: src/broker/init.test.ts, src/broker/doctor.test.ts, .mcp.json, .codex/config.toml, .claude/settings.json, AGENTS.md

## VS Code panel (sidebar UI)
Keywords: panel, sidebar, webview, ui, compose, refine button, copy, chips, workspace strip, extension, activate, command, editor selection, diagnostics
- extension activation -> src/extension.ts#activate
- tokio.focusView and tokio.openRepositoryMap commands -> src/extension.ts#activate
- sidebar view -> src/ui/panel.ts#TokioViewProvider
- active file diagnostics -> src/ui/panel.ts#getActiveFileDiagnostics
- selected editor text -> src/ui/panel.ts#getSelectedEditorText
- webview messages -> src/ui/messages.ts#handleWebviewRequest
- editor tool requests -> src/ui/messages.ts#useEditorTool
- map routes for a refine -> src/ui/messages.ts#withMapRoutes
- workspace context scan -> src/context/workspace.ts#WorkspaceContextService
- Related: package.json, src/ui/messages.test.ts

## Repository map view (graph editor) 
Keywords: repository map, graph, nodes, drag, layout, links, activity, working, open map, line shape, map settings
- map editor tab -> src/ui/map.ts#RepositoryMapPanel
- catalog service for the UI -> src/ui/repos.ts#createRepoCatalogService
- catalog actions from the webview -> src/ui/messages.ts#useRepoCatalog
- repository activity -> src/ui/repos.ts#readRepoActivity
- saved layout -> src/ui/repos.ts#readLayout
- map settings -> src/ui/repos.ts#readMapSettings
- tool activity log -> src/broker/activity.ts#recordToolActivity
- Related: .tokio/layout.json, src/ui/repos.test.ts, src/broker/activity.test.ts

## Benchmark
Keywords: bench, benchmark, compare, raw vs tokio, token usage, agent usage
- tokio bench command -> src/broker/cli.ts#runBenchCommand
- run bench -> src/broker/bench.ts#runBench
- parse bench tasks -> src/broker/bench.ts#parseBenchTasks
- bench summary -> src/broker/bench.ts#formatBenchSummary
- Related: src/broker/bench.test.ts

## Data structures and types
Keywords: types, model, interface, dto, schema, refine input, refine output, map area, catalog repo, audit entry, grant, route plan, repo map
- refine input and output -> src/core/types.ts#RefineInput
- work category -> src/core/types.ts#WorkCategory
- repository context -> src/core/types.ts#RepositoryContext
- map area -> src/context/archmap.ts#MapArea
- map route -> src/context/archmap.ts#MapRoute
- catalog -> src/broker/catalog.ts#Catalog
- catalog repository -> src/broker/catalog.ts#CatalogRepo
- audit entry -> src/broker/audit.ts#AuditEntry
- edit grant -> src/broker/scope.ts#Grant
- activity entry -> src/broker/activity.ts#ActivityEntry
- route plan -> src/context/routing.ts#RoutePlan
- repo map result -> src/context/repomap.ts#RepoMap
- webview response -> src/ui/messages.ts#WebviewResponse
- Related: src/core/types.ts

## Build, packaging, and CI
Keywords: build, compile, package, vsix, vscodeignore, tsconfig, ci, github actions, verify, npm test, release
- Related: package.json, tsconfig.json, src/packaging.test.ts, src/tsconfig.test.ts, .github/workflows/verify.yml
