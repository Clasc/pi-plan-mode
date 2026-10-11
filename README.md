# pi-plan-mode

Approval-gated **plan-first workflow** for [pi](https://pi.dev) — a single-file extension that forces alignment → plan → explicit approval before any non-trivial implementation.

## What it does

- **`propose_plan` tool** (model-only): the model presents a plan (title + markdown body); an **Approve / Adjust / Cancel** dialog blocks until you decide. Approve → implemented; Adjust → feedback loop; Cancel → no implementation.
- **Enforcement gate**: while the dialog is open, mutating tool calls are blocked; read-only tools pass. With no plan pending, everything is silent (questions, reads, trivial fixes stay friction-free).
- **Plan checklist widget**: the approved plan's numbered steps render above the editor (`☐`/`☑`, max 6 lines). The model emits `[DONE:n]` as each step completes and the widget ticks live.
- **Workflow rules travel with the tool** via `promptGuidelines` — the model gets the full convention (when to propose, exemptions, `[DONE:n]`, `/plans done`) in its system prompt. The extension file is fully self-contained.
- **Persistence**: approved plans are written to `<agent-dir>/plans/YYYY-MM-DD-<slug>.md` (`status: approved`); unfinished plans are surfaced on session start. State survives session resume.

## Commands

| Command | Description |
|---|---|
| `/plan <task>` | Force the plan flow for a task (skips the "is a plan needed?" judgment) |
| `/plan` | Usage hint |
| `/plans` | List saved plans + full checklist of the active plan |
| `/plans done` | Mark the active plan `done` and clear the widget |

## Install

```bash
pi install git:github.com/Clasc/pi-plan-mode
```

Then `/reload` (or restart pi). Uninstall with `pi remove git:github.com/Clasc/pi-plan-mode`.

Works on every device — the plans directory follows `PI_CODING_AGENT_DIR` when set.

## Optional: pointer in your AGENTS.md

If you keep a user-level `~/.pi/agent/AGENTS.md`, a one-liner keeps it from duplicating the rules:

```markdown
## Plan-first workflow
Non-trivial work requires an aligned, user-approved plan before implementation.
Enforced by the plan-mode extension (`propose_plan`) — rules travel with the tool's
guidelines. Read-only exploration, Q&A, and trivial single-step fixes are exempt.
```

## Files

```
pi-plan-mode/
├── package.json              # pi manifest
├── extensions/plan-mode.ts   # the whole extension (self-contained)
└── README.md
```
