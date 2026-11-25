---
name: piko-workspace
description: Use Piko workspace guidance, memory notes, Wiki and artifacts for relevant background or when explaining the assistant workspace.
---

# Piko Workspace

The built-in `core.md` defines runtime rules, tool use, and truthful reporting. It does not set the assistant's name or tone.

The user owns these kinds of workspace content:

- `AGENTS.md` (guidance): the assistant's identity, default expression, and general operating/workflow rules.
- `MEMORY.md` (long-term memory): stable, cross-session collaboration information: user background and long-term goals; explicit communication, work, and decision preferences; standing boundaries and confirmation requirements; long-term project purposes, key constraints, and reference locations; verified reusable experience. Keep it concise and do not copy chat transcripts.
- `memory/YYYY-MM-DD.md` (daily notes): concise dated context that may affect future judgment, collaboration, action, or follow-up: goals and progress, new facts or changes, decisions and reasons, next steps and blockers, explicit preferences/boundaries, unresolved questions, and worthwhile suggestions with triggers. Distinguish user-confirmed information, Agent proposals, and unverified hypotheses; these are not daily conversation summaries. Use one file per date.
- `wiki/` (Wiki): topic-organized background and reusable knowledge curated from main-conversation messages.

Put general assistant identity and operating rules in `AGENTS.md`; put user-specific stable preferences and collaboration boundaries in `MEMORY.md`; keep changing context and follow-up signals in daily notes. A memory note may preserve a standing restriction or confirmation requirement, but it never grants one-time permission or changes runtime capabilities.

Daily notes and Wiki pages are not injected automatically. When relevant, use `read` or `bash` to find them; for Wiki, start with `wiki/index.md` when available, then read or search relevant pages. Wiki content can be outdated or incorrect: verify current state and operational details against the actual files, code, or environment. Background curation processes daily notes first, then independently updates `MEMORY.md` only with stable, confirmed information. It runs after the main conversation is idle and uses `read`, `write`, and `edit`; there is no manual trigger. Confirm a change only after the relevant tool call succeeds.

User skills live in `.agents/skills/<name>/SKILL.md` and may contain `scripts/` and `references/` directories.
Use `projects/` for focused project work and `artifacts/` for deliverables. Application databases are outside the workspace.
Use `read`, `write`, and `edit` to maintain guidance, memory, and skills; use `bash` to run scripts. Relative paths are based on the workspace, while skill scripts and references are based on their skill directory.
