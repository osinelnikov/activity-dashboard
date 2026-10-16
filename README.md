# activity-dashboard

A Claude Code mod: a live pane that shows what the session is doing right now and
what it costs — the active model and effort, every subagent and its orchestration
tree, where the time goes, the context window fill, token usage per model, rate
limits, cost, tool statistics and a log of recent events. Numbers plus horizontal
bars. Every chat's figures are also written to disk, so you can summarise what a
task took and export the summary as a PDF report.

## Install

From a terminal session of Claude Code (the repository is
https://github.com/osinelnikov/activity-dashboard):

```
/plugin install activity-dashboard --marketplace osinelnikov/activity-dashboard
```

Answer `y` to add the marketplace, then pick the user scope.

From a local folder (no repository needed):

```
claude plugin marketplace add ~/.claude/mods/activity-dashboard
claude plugin install activity-dashboard@activity-dashboard
```

Or load it straight from its folder in every session, terminal and desktop app
alike, by naming the folder in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/activity-dashboard" } }
```

Use one of these ways, not several: each loads its own copy of the mod.

## Use

The pane opens by itself when a session starts. `/activity-dashboard` reopens it
with the keyboard focus. Arguments:

| Argument                          | Effect                                                                 |
| --------------------------------- | ---------------------------------------------------------------------- |
| `summary`                         | prints this chat's summary into the chat: time, tokens, cost, agents, tools |
| `sessions`                        | lists every recorded chat with its task, time, tokens and cost         |
| `report [pdf\|html\|md] [all\|<id>]` | writes a report (PDF by default) for this chat, one by id, or all chats |
| `title <text>`                    | names the task this chat is about (otherwise the first prompt is used) |
| `reset`                           | clears every counter                                                   |
| `close`                           | closes the pane                                                        |
| `breakdown`                       | refreshes the context-window breakdown                                 |
| `time`, `models`, `tools`, `steps`, `log` | show or hide a section                                       |

While the pane has the keyboard (ctrl+x tab, or a click), the hotkeys `p`
(PDF report), `b`, `i`, `m`, `t`, `s`, `l` and `r` do the same.

## What is recorded

At the end of every turn the mod writes `~/.claude/activity-dashboard/sessions/<session id>.json`
(override the home with `ACTIVITY_DASHBOARD_HOME`). Reports go to
`~/.claude/activity-dashboard/reports/<date>_<id>.{md,html,pdf}`. A record holds:

- the task title, session id, project folder, repository and branch, session model;
- wall time and active time, and **where the time went**: model requests of the
  main loop, tool calls of the main loop, subagents' wall time, and waiting for
  you between turns;
- every turn: start, duration, prompt head, model and tool time, tokens, tool
  calls, agents spawned, cost delta;
- tokens per model (uncached input, cache read, cache write, output, calls);
- every subagent: type, model, status, time, tokens, tool calls, task;
- tool statistics, compactions, peak context fill, cost.

Subagent time overlaps the main loop when agents run in the background, so the
phases need not add up to the wall time. Cost is the host's own ledger.

## PDF

The PDF is rendered from the HTML report by a headless browser found at one of
the usual paths (Google Chrome, Chromium, Microsoft Edge, Brave on macOS or
Linux), or at the path in `ACTIVITY_DASHBOARD_CHROME`. Without one, macOS's
`cupsfilter` renders the markdown as plain text. Without either, the HTML report
is still written and can be printed to PDF from any browser.

## Sections of the pane

- **Header** — phase of the main loop (idle, thinking, tools), time inside the
  turn, turn count, uptime, current model and effort, task title, project and
  branch, the last turn's duration, tokens, calls and cost delta.
- **TIME** — wall, active and waiting time; bars for model, tools, agents and
  waiting as a share of wall time; average and longest turn.
- **CONTEXT** — window fill bar (green, amber, red by threshold), tokens and
  window size, autocompact threshold, peak fill, compaction count with the last
  before → after, and the window broken down by category.
- **Rate limits and cost** — the 5h and 7d windows with reset times; total USD,
  last-turn delta and average per turn.
- **TOKENS** — uncached input, cache read, cache write, output; cache hit rate,
  call count, output-to-input ratio; then each model's share, calls and hit rate.
- **ORCHESTRATION** — the main loop and every subagent nested under its parent:
  status, type, name, model, elapsed, tokens, tool calls, background flag, tools
  running right now, task description. Below it a per-agent-type summary.
- **ACTIVE TOOLS** — tool calls in flight, with elapsed time, owner and a short
  argument summary.
- **TOOLS** — top tools by call count, with errors, total and average duration.
- **RECENT MODEL CALLS** — the last requests with input and output bars, model,
  duration, caller and an unusual stop reason when there was one.
- **LOG** — turn starts and ends, agent spawns and completions, compactions,
  tool failures, rate limits past 90 %.

## Develop

```
claude plugin validate ~/.claude/mods/activity-dashboard
claude plugin test ~/.claude/mods/activity-dashboard
```

State lives in `$.state` under the contract in `types/index.d.ts`, so a hot
reload keeps the counters. `hooks/register.tsx` holds the hooks and the pane,
`hooks/report.ts` the session record and the Markdown and HTML renderers,
`hooks/format.ts` the formatting helpers.
