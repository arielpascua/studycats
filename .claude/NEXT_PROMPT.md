# Next prompt (review before use)

> This is a **suggestion** generated locally. Review and edit before submitting. Sensitive prompts are
> never sent to an external model; the original prompt is never rewritten automatically.

## Suggested prompt

Goal: how can players save their progress without accounts?

Deterministic framing (no external model was used):
- Suggested tier T1, model sonnet (advisory).
- No risk domains detected by the deterministic scan.
- Confirm acceptance criteria and scope before implementing.
- Prefer existing repo automation and approved MCP sources over guessing.

## Grounding

Use approved free/OSS MCPs as ground truth — never guess when an MCP can supply the real source.
If an MCP is unavailable, say so and proceed with safe assumptions (do not fabricate).
- Context7: package/library/API/framework docs (never memory)
- GitHub: repo, PRs, issues, commits, CI context
- Playwright: browser/UI verification
- Filesystem: scoped project files only
- DB (read-only): schema/table/column truth
Security defaults: filesystem scoped to the current project; database read-only; production DB disabled; no cloud write access; no destructive commands without explicit approval; never install untrusted MCP servers globally.
