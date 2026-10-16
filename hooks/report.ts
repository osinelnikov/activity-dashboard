import type { DashAgent, DashContext, DashEvent, DashMain, DashModelUsage, DashTime, DashTool, DashTurn, DashUsage, SessionRecord } from '../types'
import {
  addUsageInto,
  cacheHit,
  cut,
  emptyUsage,
  escapeHtml,
  fmtDateTime,
  fmtMs,
  fmtTok,
  fmtUsd,
  inputOf,
  isDoneStatus,
  oneLine,
  pct,
  shortModel,
  toolLabel,
  total,
} from './format'

// ---------------------------------------------------------------------------
// The record: one chat's figures, as written to disk
// ---------------------------------------------------------------------------

export type Snapshot = {
  main: DashMain
  usage: DashModelUsage
  agents: DashAgent[]
  ctx: DashContext
  tools: Record<string, DashTool>
  turns: DashTurn[]
  time: DashTime
  events: DashEvent[]
  now: number
  ended?: boolean
}

export const buildRecord = (s: Snapshot): SessionRecord => {
  const totals = Object.values(s.usage).reduce((acc, u) => addUsageInto(acc, u), emptyUsage())
  const activeMs = s.turns.reduce((n, t) => n + (t.ms ?? (t.endedAt === undefined ? s.now - t.startedAt : 0)), 0)
  return {
    version: 1,
    id: s.main.sessionId || 'unknown',
    title: s.main.title || '(untitled)',
    cwd: s.main.cwd,
    repo: s.main.repo,
    branch: s.main.branch,
    sessionModel: s.main.sessionModel,
    startedAt: s.main.startedAt || s.now,
    updatedAt: s.now,
    endedAt: s.ended ? s.now : undefined,
    wallMs: Math.max(0, s.now - (s.main.startedAt || s.now)),
    activeMs,
    time: { modelMs: s.time.modelMs, toolMs: s.time.toolMs, agentMs: s.time.agentMs, waitMs: s.time.waitMs },
    turns: s.turns,
    usage: s.usage,
    totals,
    costUsd: s.ctx.costUsd,
    tools: Object.values(s.tools).sort((a, b) => b.calls - a.calls),
    agents: s.agents,
    compactions: s.ctx.compactions,
    maxContextPercent: s.ctx.maxPercent,
    events: s.events,
  }
}

/** Reads a stored record back; undefined for a file that is not one. */
export const parseRecord = (text: string): SessionRecord | undefined => {
  try {
    const v = JSON.parse(text) as Partial<SessionRecord>
    if (!v || v.version !== 1 || typeof v.id !== 'string' || typeof v.startedAt !== 'number') return undefined
    return v as SessionRecord
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Derived figures
// ---------------------------------------------------------------------------

type TimeRow = { label: string; ms: number; note: string }

/** Wall time of top-level subagents the main loop waited for (foreground), which no other phase counts. */
const foregroundAgentMs = (r: SessionRecord): number =>
  r.agents.filter(a => !a.background && !a.parentId).reduce((n, a) => n + Math.max(0, (a.endedAt ?? r.updatedAt) - a.startedAt), 0)

const timeRows = (r: SessionRecord): TimeRow[] => {
  const other = Math.max(0, r.wallMs - r.time.modelMs - r.time.toolMs - r.time.waitMs - foregroundAgentMs(r))
  return [
    { label: 'model (main loop)', ms: r.time.modelMs, note: 'requests to the model: thinking and answering' },
    { label: 'tools (main loop)', ms: r.time.toolMs, note: 'Bash, Read, Edit, MCP and the rest; the Agent tool excluded' },
    { label: 'subagents', ms: r.time.agentMs, note: 'wall time of subagents, spawn to completion (overlaps the above when run in the background)' },
    { label: 'waiting for you', ms: r.time.waitMs, note: 'idle between a turn’s end and the next prompt' },
    { label: 'other', ms: other, note: 'hooks, permission prompts, compaction, engine overhead' },
  ]
}

type AgentTypeRow = { type: string; count: number; tokens: number; ms: number; failed: number }

const agentTypes = (r: SessionRecord): AgentTypeRow[] => {
  const m = new Map<string, AgentTypeRow>()
  for (const a of r.agents) {
    const row = m.get(a.type) ?? { type: a.type, count: 0, tokens: 0, ms: 0, failed: 0 }
    row.count += 1
    row.tokens += total(a.usage)
    row.ms += (a.endedAt ?? r.updatedAt) - a.startedAt
    row.failed += a.status === 'failed' || a.status === 'killed' ? 1 : 0
    m.set(a.type, row)
  }
  return [...m.values()].sort((a, b) => b.tokens - a.tokens)
}

const modelRows = (usage: DashModelUsage): Array<[string, DashUsage]> =>
  Object.entries(usage).sort((a, b) => total(b[1]) - total(a[1]))

const longestTurn = (r: SessionRecord): DashTurn | undefined =>
  r.turns.reduce<DashTurn | undefined>((best, t) => ((t.ms ?? 0) > (best?.ms ?? -1) ? t : best), undefined)

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const mdTable = (head: string[], rows: string[][]): string => {
  const line = (cells: string[]) => `| ${cells.map(c => c.replace(/\|/g, '\\|')).join(' | ')} |`
  return [line(head), `| ${head.map(() => '---').join(' | ')} |`, ...rows.map(line)].join('\n')
}

/** The compact summary a `/activity-dashboard summary` prints into the chat. */
export const chatSummary = (r: SessionRecord): string => {
  const t = r.totals
  const lines: string[] = []
  lines.push(`**Activity summary — ${r.title}**`)
  lines.push(`session ${r.id.slice(0, 8)} · ${fmtDateTime(r.startedAt)} → ${fmtDateTime(r.updatedAt)} · ${r.branch ? `${r.repo ?? ''}@${r.branch}` : r.cwd}`)
  lines.push('')
  lines.push(`**TIME** wall ${fmtMs(r.wallMs)} · active ${fmtMs(r.activeMs)} · turns ${r.turns.length}`)
  for (const row of timeRows(r)) lines.push(`- ${row.label}: ${fmtMs(row.ms)} (${Math.round(pct(row.ms, r.wallMs))}%)`)
  lines.push('')
  lines.push(`**TOKENS** ${fmtTok(total(t))} total · in ${fmtTok(inputOf(t))} (uncached ${fmtTok(t.input)}, cache read ${fmtTok(t.cacheRead)}, cache write ${fmtTok(t.cacheWrite)}) · out ${fmtTok(t.output)} · ${t.calls} calls · cache hit ${Math.round(cacheHit(t))}%`)
  for (const [name, u] of modelRows(r.usage)) {
    lines.push(`- ${shortModel(name)}: ${Math.round(pct(total(u), total(t)))}% · ${u.calls} calls · in ${fmtTok(inputOf(u))} out ${fmtTok(u.output)}`)
  }
  lines.push('')
  lines.push(`**COST** ${r.costUsd !== undefined ? fmtUsd(r.costUsd) : 'n/a'}${r.costUsd !== undefined && r.turns.length ? ` · ${fmtUsd(r.costUsd / r.turns.length)}/turn` : ''}`)
  const at = agentTypes(r)
  if (at.length) {
    lines.push('')
    lines.push(`**AGENTS** ${r.agents.length}`)
    for (const a of at) lines.push(`- ${a.type}: ×${a.count} · ${fmtTok(a.tokens)} tok · ${fmtMs(a.ms)}${a.failed ? ` · ${a.failed} failed` : ''}`)
  }
  if (r.tools.length) {
    lines.push('')
    lines.push(`**TOOLS** ${r.tools.reduce((n, x) => n + x.calls, 0)} calls`)
    for (const x of r.tools.slice(0, 6)) lines.push(`- ${toolLabel(x.name)}: ${x.calls}${x.errors ? ` (${x.errors} failed)` : ''} · ${fmtMs(x.totalMs)}`)
  }
  const lt = longestTurn(r)
  if (lt) {
    lines.push('')
    lines.push(`**LONGEST TURN** #${lt.index} ${fmtMs(lt.ms ?? 0)}: ${cut(lt.prompt, 80)}`)
  }
  if (r.compactions) lines.push(`compactions: ${r.compactions}`)
  return lines.join('\n')
}

export const recordToMarkdown = (r: SessionRecord): string => {
  const t = r.totals
  const out: string[] = []
  out.push(`# Activity report: ${r.title}`)
  out.push('')
  out.push(mdTable(
    ['Field', 'Value'],
    [
      ['Session', r.id],
      ['Started', fmtDateTime(r.startedAt)],
      ['Last activity', fmtDateTime(r.updatedAt)],
      ['Project', r.repo ?? r.cwd],
      ['Branch', r.branch ?? '—'],
      ['Session model', shortModel(r.sessionModel)],
      ['Wall time', fmtMs(r.wallMs)],
      ['Active time (turns)', fmtMs(r.activeMs)],
      ['Turns', String(r.turns.length)],
      ['Cost', r.costUsd !== undefined ? fmtUsd(r.costUsd) : 'n/a'],
    ],
  ))
  out.push('')
  out.push('## Time')
  out.push('')
  out.push(mdTable(['Phase', 'Time', 'Share of wall', 'What'], timeRows(r).map(x => [x.label, fmtMs(x.ms), `${Math.round(pct(x.ms, r.wallMs))}%`, x.note])))
  out.push('')
  out.push('## Tokens')
  out.push('')
  out.push(mdTable(
    ['Kind', 'Tokens', 'Share'],
    [
      ['Input, uncached', fmtTok(t.input), `${Math.round(pct(t.input, total(t)))}%`],
      ['Input, cache read', fmtTok(t.cacheRead), `${Math.round(pct(t.cacheRead, total(t)))}%`],
      ['Input, cache write', fmtTok(t.cacheWrite), `${Math.round(pct(t.cacheWrite, total(t)))}%`],
      ['Output', fmtTok(t.output), `${Math.round(pct(t.output, total(t)))}%`],
      ['Total', fmtTok(total(t)), `${t.calls} calls, cache hit ${Math.round(cacheHit(t))}%`],
    ],
  ))
  out.push('')
  out.push('### By model')
  out.push('')
  out.push(mdTable(
    ['Model', 'Share', 'Calls', 'Input', 'Output', 'Cache hit'],
    modelRows(r.usage).map(([name, u]) => [shortModel(name), `${Math.round(pct(total(u), total(t)))}%`, String(u.calls), fmtTok(inputOf(u)), fmtTok(u.output), `${Math.round(cacheHit(u))}%`]),
  ))
  out.push('')
  out.push('## Agents')
  out.push('')
  if (!r.agents.length) out.push('No subagents were spawned.')
  else {
    out.push(mdTable(['Type', 'Runs', 'Tokens', 'Time', 'Failed'], agentTypes(r).map(a => [a.type, String(a.count), fmtTok(a.tokens), fmtMs(a.ms), String(a.failed)])))
    out.push('')
    out.push(mdTable(
      ['#', 'Type', 'Model', 'Status', 'Time', 'Tokens', 'Tools', 'Task'],
      r.agents.map((a, i) => [String(i + 1), a.parentId ? `↳ ${a.type}` : a.type, shortModel(a.model), a.status, fmtMs((a.endedAt ?? r.updatedAt) - a.startedAt), fmtTok(total(a.usage)), String(a.toolCalls), cut(a.description, 70)]),
    ))
  }
  out.push('')
  out.push('## Tools')
  out.push('')
  out.push(r.tools.length ? mdTable(['Tool', 'Calls', 'Failed', 'Total time', 'Avg'], r.tools.map(x => [toolLabel(x.name), String(x.calls), String(x.errors), fmtMs(x.totalMs), fmtMs(x.totalMs / Math.max(1, x.calls))])) : 'No tool calls.')
  out.push('')
  out.push('## Turns')
  out.push('')
  out.push(mdTable(
    ['#', 'Start', 'Duration', 'Model', 'Tools', 'Agents', 'Input', 'Output', 'Cost', 'Prompt'],
    r.turns.map(x => [
      String(x.index),
      fmtDateTime(x.startedAt).slice(11),
      fmtMs(x.ms ?? r.updatedAt - x.startedAt),
      fmtMs(x.modelMs),
      `${x.toolCalls} (${fmtMs(x.toolMs)})`,
      String(x.agents),
      x.usage ? fmtTok(inputOf(x.usage)) : '—',
      x.usage ? fmtTok(x.usage.output) : '—',
      x.costDelta !== undefined ? fmtUsd(x.costDelta) : '—',
      cut(x.prompt, 60),
    ]),
  ))
  if (r.compactions || r.maxContextPercent !== undefined) {
    out.push('')
    out.push('## Context')
    out.push('')
    out.push(`Compactions: ${r.compactions}. Peak context fill: ${r.maxContextPercent !== undefined ? `${Math.round(r.maxContextPercent)}%` : 'n/a'}.`)
  }
  out.push('')
  out.push(`_Generated by activity-dashboard on ${fmtDateTime(r.updatedAt)}._`)
  return out.join('\n')
}

export const aggregateToMarkdown = (recs: SessionRecord[], now: number): string => {
  const out: string[] = []
  const totals = recs.reduce((acc, r) => addUsageInto(acc, r.totals), emptyUsage())
  const wall = recs.reduce((n, r) => n + r.wallMs, 0)
  const active = recs.reduce((n, r) => n + r.activeMs, 0)
  const cost = recs.reduce((n, r) => n + (r.costUsd ?? 0), 0)
  out.push('# Activity report: all sessions')
  out.push('')
  out.push(`${recs.length} sessions · wall ${fmtMs(wall)} · active ${fmtMs(active)} · ${fmtTok(total(totals))} tokens · ${fmtUsd(cost)}`)
  out.push('')
  out.push('## Sessions')
  out.push('')
  out.push(mdTable(
    ['Date', 'Task', 'Project', 'Wall', 'Active', 'Turns', 'Tokens', 'Cost', 'Session'],
    recs.map(r => [fmtDateTime(r.startedAt), cut(r.title, 60), cut(r.repo ?? r.cwd, 30), fmtMs(r.wallMs), fmtMs(r.activeMs), String(r.turns.length), fmtTok(total(r.totals)), r.costUsd !== undefined ? fmtUsd(r.costUsd) : '—', r.id.slice(0, 8)]),
  ))
  out.push('')
  out.push('## Time across sessions')
  out.push('')
  const time: DashTime = recs.reduce(
    (acc, r) => ({ modelMs: acc.modelMs + r.time.modelMs, toolMs: acc.toolMs + r.time.toolMs, agentMs: acc.agentMs + r.time.agentMs, waitMs: acc.waitMs + r.time.waitMs }),
    { modelMs: 0, toolMs: 0, agentMs: 0, waitMs: 0 },
  )
  out.push(mdTable(['Phase', 'Time', 'Share of wall'], [
    ['model (main loop)', fmtMs(time.modelMs), `${Math.round(pct(time.modelMs, wall))}%`],
    ['tools (main loop)', fmtMs(time.toolMs), `${Math.round(pct(time.toolMs, wall))}%`],
    ['subagents', fmtMs(time.agentMs), `${Math.round(pct(time.agentMs, wall))}%`],
    ['waiting for you', fmtMs(time.waitMs), `${Math.round(pct(time.waitMs, wall))}%`],
  ]))
  out.push('')
  out.push('## Tokens by model')
  out.push('')
  const byModel: DashModelUsage = {}
  for (const r of recs) for (const [m, u] of Object.entries(r.usage)) byModel[m] = addUsageInto(byModel[m] ?? emptyUsage(), u)
  out.push(mdTable(['Model', 'Share', 'Calls', 'Input', 'Output', 'Cache hit'], modelRows(byModel).map(([name, u]) => [shortModel(name), `${Math.round(pct(total(u), total(totals)))}%`, String(u.calls), fmtTok(inputOf(u)), fmtTok(u.output), `${Math.round(cacheHit(u))}%`])))
  out.push('')
  out.push('## By project')
  out.push('')
  const byProject = new Map<string, { sessions: number; wall: number; tokens: number; cost: number }>()
  for (const r of recs) {
    const k = r.repo ?? r.cwd
    const p = byProject.get(k) ?? { sessions: 0, wall: 0, tokens: 0, cost: 0 }
    p.sessions += 1
    p.wall += r.wallMs
    p.tokens += total(r.totals)
    p.cost += r.costUsd ?? 0
    byProject.set(k, p)
  }
  out.push(mdTable(['Project', 'Sessions', 'Wall', 'Tokens', 'Cost'], [...byProject.entries()].sort((a, b) => b[1].tokens - a[1].tokens).map(([k, p]) => [k, String(p.sessions), fmtMs(p.wall), fmtTok(p.tokens), fmtUsd(p.cost)])))
  out.push('')
  out.push(`_Generated by activity-dashboard on ${fmtDateTime(now)}._`)
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// HTML (for the PDF)
// ---------------------------------------------------------------------------

const CSS = `
  :root { --ink:#1d2433; --dim:#6b7280; --line:#e5e7eb; --bar:#4c6ef5; --bar2:#12b886; --bar3:#f59f00; --bar4:#adb5bd; --bar5:#845ef7; }
  * { box-sizing: border-box; }
  body { font: 11pt/1.45 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: var(--ink); margin: 32px 40px; }
  h1 { font-size: 20pt; margin: 0 0 4px; }
  h2 { font-size: 13pt; margin: 22px 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
  h3 { font-size: 11pt; margin: 14px 0 6px; color: var(--dim); }
  .sub { color: var(--dim); margin-bottom: 14px; }
  table { border-collapse: collapse; width: 100%; font-size: 9.5pt; page-break-inside: auto; }
  th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--dim); font-weight: 600; }
  td.num, th.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .bars { margin: 6px 0 2px; }
  .row { display: flex; align-items: center; gap: 10px; margin: 3px 0; font-size: 9.5pt; }
  .row .lbl { width: 150px; color: var(--ink); }
  .row .trk { flex: 1; height: 10px; background: #f1f3f5; border-radius: 3px; overflow: hidden; }
  .row .fil { height: 100%; background: var(--bar); }
  .row .val { width: 170px; color: var(--dim); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .kpis { display: flex; flex-wrap: wrap; gap: 10px; margin: 10px 0 4px; }
  .kpi { border: 1px solid var(--line); border-radius: 6px; padding: 8px 12px; min-width: 120px; }
  .kpi b { display: block; font-size: 14pt; }
  .kpi span { color: var(--dim); font-size: 9pt; }
  .foot { color: var(--dim); font-size: 8.5pt; margin-top: 24px; }
  tr { page-break-inside: avoid; }
  @page { size: A4; margin: 14mm; }
`

const bar = (label: string, frac: number, value: string, color = 'var(--bar)'): string =>
  `<div class="row"><div class="lbl">${escapeHtml(label)}</div><div class="trk"><div class="fil" style="width:${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%;background:${color}"></div></div><div class="val">${escapeHtml(value)}</div></div>`

const htmlTable = (head: Array<string | [string, 'num']>, rows: string[][]): string => {
  const th = head.map(h => (Array.isArray(h) ? `<th class="num">${escapeHtml(h[0])}</th>` : `<th>${escapeHtml(h)}</th>`)).join('')
  const numCols = head.map(h => Array.isArray(h))
  const tr = rows.map(r => `<tr>${r.map((c, i) => `<td${numCols[i] ? ' class="num"' : ''}>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')
  return `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`
}

const kpi = (value: string, label: string): string => `<div class="kpi"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`

const page = (title: string, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`

export const recordToHtml = (r: SessionRecord): string => {
  const t = r.totals
  const tr = timeRows(r)
  const colors = ['var(--bar)', 'var(--bar3)', 'var(--bar5)', 'var(--bar4)', '#ced4da']
  const body = [
    `<h1>${escapeHtml(r.title)}</h1>`,
    `<div class="sub">Activity report · session ${escapeHtml(r.id)} · ${escapeHtml(fmtDateTime(r.startedAt))} → ${escapeHtml(fmtDateTime(r.updatedAt))} · ${escapeHtml(r.repo ?? r.cwd)}${r.branch ? ` @ ${escapeHtml(r.branch)}` : ''} · model ${escapeHtml(shortModel(r.sessionModel))}</div>`,
    `<div class="kpis">${kpi(fmtMs(r.wallMs), 'wall time')}${kpi(fmtMs(r.activeMs), 'active (turns)')}${kpi(String(r.turns.length), 'turns')}${kpi(fmtTok(total(t)), 'tokens')}${kpi(r.costUsd !== undefined ? fmtUsd(r.costUsd) : 'n/a', 'cost')}${kpi(String(r.agents.length), 'subagents')}${kpi(String(r.tools.reduce((n, x) => n + x.calls, 0)), 'tool calls')}</div>`,
    '<h2>Where the time went</h2>',
    `<div class="bars">${tr.map((x, i) => bar(x.label, x.ms / Math.max(1, r.wallMs), `${fmtMs(x.ms)} · ${Math.round(pct(x.ms, r.wallMs))}%`, colors[i])).join('')}</div>`,
    htmlTable(['Phase', ['Time', 'num'], ['Share', 'num'], 'What it counts'], tr.map(x => [x.label, fmtMs(x.ms), `${Math.round(pct(x.ms, r.wallMs))}%`, x.note])),
    '<h2>Tokens</h2>',
    `<div class="bars">${[
      bar('input, uncached', t.input / Math.max(1, total(t)), fmtTok(t.input), 'var(--bar3)'),
      bar('input, cache read', t.cacheRead / Math.max(1, total(t)), fmtTok(t.cacheRead), 'var(--bar2)'),
      bar('input, cache write', t.cacheWrite / Math.max(1, total(t)), fmtTok(t.cacheWrite), 'var(--bar5)'),
      bar('output', t.output / Math.max(1, total(t)), fmtTok(t.output), 'var(--bar)'),
    ].join('')}</div>`,
    `<div class="sub">${t.calls} model calls · cache hit ${Math.round(cacheHit(t))}% · output/input ${pct(t.output, Math.max(1, inputOf(t))).toFixed(1)}%</div>`,
    '<h3>By model</h3>',
    htmlTable(['Model', ['Share', 'num'], ['Calls', 'num'], ['Input', 'num'], ['Output', 'num'], ['Cache hit', 'num']], modelRows(r.usage).map(([name, u]) => [shortModel(name), `${Math.round(pct(total(u), total(t)))}%`, String(u.calls), fmtTok(inputOf(u)), fmtTok(u.output), `${Math.round(cacheHit(u))}%`])),
    '<h2>Subagents</h2>',
    r.agents.length
      ? htmlTable(['Type', ['Runs', 'num'], ['Tokens', 'num'], ['Time', 'num'], ['Failed', 'num']], agentTypes(r).map(a => [a.type, String(a.count), fmtTok(a.tokens), fmtMs(a.ms), String(a.failed)])) +
        '<h3>Each run</h3>' +
        htmlTable(['#', 'Type', 'Model', 'Status', ['Time', 'num'], ['Tokens', 'num'], ['Tools', 'num'], 'Task'], r.agents.map((a, i) => [String(i + 1), a.parentId ? `↳ ${a.type}` : a.type, shortModel(a.model), a.status, fmtMs((a.endedAt ?? r.updatedAt) - a.startedAt), fmtTok(total(a.usage)), String(a.toolCalls), cut(a.description, 90)]))
      : '<div class="sub">No subagents were spawned.</div>',
    '<h2>Tools</h2>',
    r.tools.length
      ? `<div class="bars">${r.tools.slice(0, 8).map(x => bar(toolLabel(x.name), x.calls / Math.max(1, r.tools[0]?.calls ?? 1), `${x.calls} calls · ${fmtMs(x.totalMs)}${x.errors ? ` · ${x.errors} failed` : ''}`, x.errors ? 'var(--bar3)' : 'var(--bar2)')).join('')}</div>` +
        htmlTable(['Tool', ['Calls', 'num'], ['Failed', 'num'], ['Total', 'num'], ['Avg', 'num']], r.tools.map(x => [toolLabel(x.name), String(x.calls), String(x.errors), fmtMs(x.totalMs), fmtMs(x.totalMs / Math.max(1, x.calls))]))
      : '<div class="sub">No tool calls.</div>',
    '<h2>Turns</h2>',
    htmlTable(['#', 'Start', ['Duration', 'num'], ['Model', 'num'], ['Tools', 'num'], ['Agents', 'num'], ['Input', 'num'], ['Output', 'num'], ['Cost', 'num'], 'Prompt'], r.turns.map(x => [
      String(x.index),
      fmtDateTime(x.startedAt).slice(11),
      fmtMs(x.ms ?? r.updatedAt - x.startedAt),
      fmtMs(x.modelMs),
      `${x.toolCalls} · ${fmtMs(x.toolMs)}`,
      String(x.agents),
      x.usage ? fmtTok(inputOf(x.usage)) : '—',
      x.usage ? fmtTok(x.usage.output) : '—',
      x.costDelta !== undefined ? fmtUsd(x.costDelta) : '—',
      cut(oneLine(x.prompt), 90),
    ])),
    '<h2>Context</h2>',
    `<div class="sub">Compactions: ${r.compactions}. Peak context fill: ${r.maxContextPercent !== undefined ? `${Math.round(r.maxContextPercent)}%` : 'n/a'}.</div>`,
    `<div class="foot">Generated by activity-dashboard on ${escapeHtml(fmtDateTime(r.updatedAt))}. Times are wall-clock; subagent time overlaps the main loop when agents run in the background. Cost is the host’s own ledger.</div>`,
  ].join('\n')
  return page(`Activity report: ${r.title}`, body)
}

export const aggregateToHtml = (recs: SessionRecord[], now: number): string => {
  const totals = recs.reduce((acc, r) => addUsageInto(acc, r.totals), emptyUsage())
  const wall = recs.reduce((n, r) => n + r.wallMs, 0)
  const active = recs.reduce((n, r) => n + r.activeMs, 0)
  const cost = recs.reduce((n, r) => n + (r.costUsd ?? 0), 0)
  const time: DashTime = recs.reduce(
    (acc, r) => ({ modelMs: acc.modelMs + r.time.modelMs, toolMs: acc.toolMs + r.time.toolMs, agentMs: acc.agentMs + r.time.agentMs, waitMs: acc.waitMs + r.time.waitMs }),
    { modelMs: 0, toolMs: 0, agentMs: 0, waitMs: 0 },
  )
  const byModel: DashModelUsage = {}
  for (const r of recs) for (const [m, u] of Object.entries(r.usage)) byModel[m] = addUsageInto(byModel[m] ?? emptyUsage(), u)
  const maxTok = Math.max(1, ...recs.map(r => total(r.totals)))
  const body = [
    '<h1>Activity report: all sessions</h1>',
    `<div class="sub">${recs.length} sessions · generated ${escapeHtml(fmtDateTime(now))}</div>`,
    `<div class="kpis">${kpi(String(recs.length), 'sessions')}${kpi(fmtMs(wall), 'wall time')}${kpi(fmtMs(active), 'active')}${kpi(fmtTok(total(totals)), 'tokens')}${kpi(fmtUsd(cost), 'cost')}</div>`,
    '<h2>Sessions</h2>',
    `<div class="bars">${recs.slice(0, 20).map(r => bar(cut(r.title, 28), total(r.totals) / maxTok, `${fmtTok(total(r.totals))} · ${fmtMs(r.wallMs)}${r.costUsd !== undefined ? ` · ${fmtUsd(r.costUsd)}` : ''}`)).join('')}</div>`,
    htmlTable(['Date', 'Task', 'Project', ['Wall', 'num'], ['Active', 'num'], ['Turns', 'num'], ['Tokens', 'num'], ['Cost', 'num'], 'Session'], recs.map(r => [fmtDateTime(r.startedAt), cut(r.title, 70), cut(r.repo ?? r.cwd, 34), fmtMs(r.wallMs), fmtMs(r.activeMs), String(r.turns.length), fmtTok(total(r.totals)), r.costUsd !== undefined ? fmtUsd(r.costUsd) : '—', r.id.slice(0, 8)])),
    '<h2>Where the time went</h2>',
    `<div class="bars">${[
      bar('model (main loop)', time.modelMs / Math.max(1, wall), `${fmtMs(time.modelMs)} · ${Math.round(pct(time.modelMs, wall))}%`),
      bar('tools (main loop)', time.toolMs / Math.max(1, wall), `${fmtMs(time.toolMs)} · ${Math.round(pct(time.toolMs, wall))}%`, 'var(--bar3)'),
      bar('subagents', time.agentMs / Math.max(1, wall), `${fmtMs(time.agentMs)} · ${Math.round(pct(time.agentMs, wall))}%`, 'var(--bar5)'),
      bar('waiting for you', time.waitMs / Math.max(1, wall), `${fmtMs(time.waitMs)} · ${Math.round(pct(time.waitMs, wall))}%`, 'var(--bar4)'),
    ].join('')}</div>`,
    '<h2>Tokens by model</h2>',
    htmlTable(['Model', ['Share', 'num'], ['Calls', 'num'], ['Input', 'num'], ['Output', 'num'], ['Cache hit', 'num']], modelRows(byModel).map(([name, u]) => [shortModel(name), `${Math.round(pct(total(u), total(totals)))}%`, String(u.calls), fmtTok(inputOf(u)), fmtTok(u.output), `${Math.round(cacheHit(u))}%`])),
    `<div class="foot">Generated by activity-dashboard. Each session’s figures come from its own JSON record under ~/.claude/activity-dashboard/sessions.</div>`,
  ].join('\n')
  return page('Activity report: all sessions', body)
}

export const agentsDone = (agents: DashAgent[]): number => agents.filter(a => isDoneStatus(a.status)).length
