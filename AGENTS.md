# Tokio tools

For each coding task:
1. Call `refine_task` once with the task text. Use its output as the scoped prompt.
2. Call `repo_map` with the task to find relevant files and line numbers.
3. Call `read_symbol` only for the bodies you need. A repeat read returns only changed lines unless `full` is true.
4. If a result says it was truncated, call `search_output` with the output id.

Never read files named .env, credentials, secrets, or keys.
