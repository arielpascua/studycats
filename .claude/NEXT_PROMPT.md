# Next prompt (review before use)

> This is a **suggestion** generated locally. Review and edit before submitting. Sensitive prompts are
> never sent to an external model; the original prompt is never rewritten automatically.

## Suggested prompt

Goal: <task-notification> <task-id>wjlplif4r</task-id> <tool-use-id>toolu_01B2Tu2u7bGXWsNKhGjwFBU7</tool-use-id> <output-file>C:\Users\USER\AppData\Local\Temp\claude\c--Users-USER-Desktop-StudyCats-studycats\3c7758a9-03cb-410d-804e-e89e13ae1616\tasks\wjlplif4r.output</output-file> <status>completed</status> <summary>Dynamic workflow "Design the room system that replaces the arena disc with actual interiors (library, classroom, gallery, conference room)" completed</summary> <result>{"spec":null,"proposalCount":4}</result> <diagnostics>Per-agent results: C:\Users\USER\.claude\projects\c--Users-USER-Desktop-StudyCats-studycats\3c7758a9-03cb-410d-804e-e89e13ae1616\subagents\workflows\wf_bd1babfa-d96/journal.jsonl — one {"type":"result",...} line per completed agent with its full return value. If the result above is empty or unexpected, Read this file BEFORE diagnosing — do not assume agents returned non-empty results. To re-run with edited post-processing: Workflow({scriptPath: 'C:\Users\USER\.claude\projects\C--Users-USER-Desktop-StudyCats-studycats\3c7758a9-03cb-410d-804e-e89e13ae1616\workflows\scripts\real-rooms-design-wf_bd1babfa-d96.js', resumeFromRunId: 'wf_bd1babfa-d96'}) — agents whose (prompt, opts) are unchanged replay from cache.</diagnostics> <failures>[harden:camera] failed: You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 6:50pm (Asia/Manila) [judge:2] failed: You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 6:50pm (Asia/Manila) [judge:3] failed: You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 6:50pm (Asia/Manila) [judge:1] failed: You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 6:50pm (Asia/Manila) [final-spec] failed: You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 6:50pm (Asia/Manila)</failures> <usage><agent_count>18</agent_count><agents_done>13</agents_done><agents_error>5</agents_error><agents_skipped>0</agents_skipped><agents_empty_result>0</agents_empty_result><subagent_tokens>2287682</subagent_tokens><tool_uses>299</tool_uses><duration_ms>3176775</duration_ms></usage> </task-notification>

Deterministic framing (no external model was used):
- Suggested tier T2, model sonnet + security-reviewer (advisory).
- Risk domains: auth. Treat as T2+; no destructive/production actions without explicit approval.
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
