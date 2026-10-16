import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, RenderNode, SessionUsage } from 'claude-code'

import type {
  DashActiveTool,
  DashAgent,
  DashContext,
  DashEvent,
  DashMain,
  DashModelUsage,
  DashStep,
  DashTime,
  DashTool,
  DashTurn,
  DashView,
  SessionRecord,
} from '../types'
import {
  addUsage,
  addUsageInto,
  barOf,
  cacheHit,
  clamp,
  cut,
  detailOf,
  emptyUsage,
  fmtClock,
  fmtDateTime,
  fmtMs,
  fmtStamp,
  fmtTok,
  fmtUsd,
  fromModelUsage,
  inputOf,
  isDoneStatus,
  oneLine,
  pad,
  padL,
  pct,
  pctColor,
  shortModel,
  statusGlyph,
  toolLabel,
  total,
  untilIso,
} from './format'
import { aggregateToHtml, aggregateToMarkdown, buildRecord, chatSummary, parseRecord, recordToHtml, recordToMarkdown } from './report'
import type { Snapshot } from './report'

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const PANE = 'activity-dashboard'
const COMMAND = 'activity-dashboard'
const TITLE = 'Activity'

const MAX_AGENTS = 80
const MAX_ACTIVE = 60
const MAX_STEPS = 60
const MAX_EVENTS = 40
const MAX_TURNS = 500

// ---------------------------------------------------------------------------
// State (held by the host; survives hot reloads)
// ---------------------------------------------------------------------------

const emptyMain = (): DashMain => ({
  phase: 'idle',
  sessionId: '',
  cwd: '',
  title: '',
  titleIsManual: false,
  sessionModel: '',
  model: '',
  stepIndex: 0,
  messageCount: 0,
  startedAt: 0,
  turns: 0,
})

const emptyContext = (): DashContext => ({ window: 0, rateLimits: [], compactions: 0 })
const emptyTime = (): DashTime => ({ modelMs: 0, toolMs: 0, agentMs: 0, waitMs: 0 })

const mainAtom = atom({ plugin: 'activity-dashboard', key: 'main' } as const, emptyMain())
const usageAtom = atom({ plugin: 'activity-dashboard', key: 'usage' } as const, {} as DashModelUsage)
const agentsAtom = atom({ plugin: 'activity-dashboard', key: 'agents' } as const, [] as DashAgent[])
const contextAtom = atom({ plugin: 'activity-dashboard', key: 'context' } as const, emptyContext())
const toolsAtom = atom({ plugin: 'activity-dashboard', key: 'tools' } as const, {} as Record<string, DashTool>)
const activeAtom = atom({ plugin: 'activity-dashboard', key: 'active' } as const, [] as DashActiveTool[])
const stepsAtom = atom({ plugin: 'activity-dashboard', key: 'steps' } as const, [] as DashStep[])
const eventsAtom = atom({ plugin: 'activity-dashboard', key: 'events' } as const, [] as DashEvent[])
const turnsAtom = atom({ plugin: 'activity-dashboard', key: 'turns' } as const, [] as DashTurn[])
const timeAtom = atom({ plugin: 'activity-dashboard', key: 'time' } as const, emptyTime())
const viewAtom = atom({ plugin: 'activity-dashboard', key: 'view' } as const, {
  showTools: true,
  showLog: true,
  showSteps: true,
  showModels: true,
  showTime: true,
} as DashView)

// ---------------------------------------------------------------------------
// State writers
// ---------------------------------------------------------------------------

const pushEvent = async ($: EngineInterface, at: number, text: string, kind: DashEvent['kind'] = 'info') => {
  await update($, eventsAtom, list => [...list, { at, text, kind }].slice(-MAX_EVENTS))
}

const applySessionUsage = async ($: EngineInterface, u: SessionUsage, at: number) => {
  await update($, contextAtom, c => {
    const percent = u.context.percent ?? c.percent
    return {
      ...c,
      tokens: u.context.tokens ?? c.tokens,
      window: u.context.window || c.window,
      percent,
      maxPercent: Math.max(c.maxPercent ?? 0, percent ?? 0),
      costUsd: u.cost?.usd ?? c.costUsd,
      rateLimits: u.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
      measuredAt: at,
    }
  })
}

const fetchBreakdown = async ($: EngineInterface) => {
  try {
    const u = await $.session.usage({ breakdown: 'summary' })
    const b = u.context.breakdown
    const at = await $.clock.now()
    await applySessionUsage($, u, at)
    if (!b) return
    await update($, contextAtom, c => ({
      ...c,
      breakdown: b.categories.map(r => ({ name: r.name, tokens: r.tokens, kind: r.kind, color: r.color })),
      breakdownMax: b.rawMaxTokens,
      autoCompactThreshold: b.autoCompactThreshold,
    }))
  } catch {
    // a session that cannot measure yet: keep what we have
  }
}

const clearStats = async ($: EngineInterface, keepSession: boolean) => {
  await update($, usageAtom, () => ({}))
  await update($, agentsAtom, () => [])
  await update($, toolsAtom, () => ({}))
  await update($, activeAtom, () => [])
  await update($, stepsAtom, () => [])
  await update($, eventsAtom, () => [])
  await update($, turnsAtom, () => [])
  await update($, timeAtom, () => emptyTime())
  await update($, contextAtom, c => (keepSession ? { ...c, compactions: 0, lastCompaction: undefined, maxPercent: c.percent } : emptyContext()))
}

const resetAll = async ($: EngineInterface) => {
  const now = await $.clock.now()
  await clearStats($, true)
  await update($, mainAtom, m => ({ ...emptyMain(), sessionId: m.sessionId, cwd: m.cwd, repo: m.repo, branch: m.branch, title: m.title, titleIsManual: m.titleIsManual, sessionModel: m.sessionModel, startedAt: now }))
  await pushEvent($, now, 'statistics reset', 'info')
}

const toggleView = async ($: EngineInterface, key: keyof DashView) => {
  await update($, viewAtom, v => ({ ...v, [key]: !v[key] }))
}

const bumpTurn = async ($: EngineInterface, change: (t: DashTurn) => DashTurn) => {
  await update($, turnsAtom, list => {
    const last = list[list.length - 1]
    if (!last || last.endedAt !== undefined) return list
    return [...list.slice(0, -1), change(last)]
  })
}

const noteStepUsage = async (
  $: EngineInterface,
  model: string,
  agentId: string | undefined,
  usage: ModelUsage,
  ms: number,
  at: number,
  stopReason: string | undefined,
) => {
  await update($, usageAtom, map => ({ ...map, [model]: addUsage(map[model] ?? emptyUsage(), usage) }))
  await update($, stepsAtom, list =>
    [
      ...list,
      {
        at,
        model,
        agentId,
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0,
        stopReason,
        ms,
      },
    ].slice(-MAX_STEPS),
  )
  if (agentId) {
    await update($, agentsAtom, list =>
      list.map(a => (a.id === agentId ? { ...a, usage: addUsage(a.usage, usage), model: model || a.model } : a)),
    )
  }
}

// ---------------------------------------------------------------------------
// Persistence: one JSON per chat under <home>/.claude/activity-dashboard
// ---------------------------------------------------------------------------

const baseDir = async ($: EngineInterface): Promise<string> => {
  let home: string | undefined
  try {
    home = (await $.env.get('ACTIVITY_DASHBOARD_HOME')) ?? (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  } catch {
    home = undefined
  }
  if (!home) home = await $.session.cwd()
  return `${home.replace(/\/+$/, '')}/.claude/activity-dashboard`
}

const snapshot = async ($: EngineInterface, ended = false): Promise<Snapshot> => {
  const [main, usage, agents, ctx, tools, turns, time, events, now] = await Promise.all([
    read($, mainAtom),
    read($, usageAtom),
    read($, agentsAtom),
    read($, contextAtom),
    read($, toolsAtom),
    read($, turnsAtom),
    read($, timeAtom),
    read($, eventsAtom),
    $.clock.now(),
  ])
  return { main, usage, agents, ctx, tools, turns, time, events, now, ended }
}

const persist = async ($: EngineInterface, ended = false): Promise<SessionRecord | undefined> => {
  try {
    const rec = buildRecord(await snapshot($, ended))
    if (!rec.id || rec.id === 'unknown') return rec
    const dir = await baseDir($)
    await $.fs.write(`${dir}/sessions/${rec.id}.json`, JSON.stringify(rec, null, 2))
    return rec
  } catch {
    return undefined
  }
}

const loadRecords = async ($: EngineInterface): Promise<SessionRecord[]> => {
  const dir = `${await baseDir($)}/sessions`
  if (!(await $.fs.exists(dir))) return []
  const entries = await $.fs.list(dir)
  const recs: SessionRecord[] = []
  for (const e of entries) {
    if (e.kind !== 'file' || !e.name.endsWith('.json')) continue
    try {
      const rec = parseRecord(await $.fs.read(`${dir}/${e.name}`))
      if (rec) recs.push(rec)
    } catch {
      // a file that cannot be read is left out
    }
  }
  return recs.sort((a, b) => b.startedAt - a.startedAt)
}

// ---------------------------------------------------------------------------
// Reports: markdown + html always; pdf through a headless browser or cupsfilter
// ---------------------------------------------------------------------------

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  '/snap/bin/chromium',
]

const findChrome = async ($: EngineInterface): Promise<string | undefined> => {
  let override: string | undefined
  try {
    override = await $.env.get('ACTIVITY_DASHBOARD_CHROME')
  } catch {
    override = undefined
  }
  for (const p of [override, ...CHROME_CANDIDATES]) {
    if (p && (await $.fs.exists(p))) return p
  }
  return undefined
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

type PdfOutcome = { path: string; via: 'chrome' | 'cupsfilter'; reason?: undefined } | { path?: undefined; via?: undefined; reason: string }

const toPdf = async ($: EngineInterface, htmlPath: string, textPath: string, pdfPath: string, title: string, profileDir: string): Promise<PdfOutcome> => {
  const chrome = await findChrome($)
  if (chrome) {
    try {
      const r = await $.process.run(
        [chrome, '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profileDir}`, '--no-pdf-header-footer', `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`],
        { timeoutMs: 90_000 },
      )
      if (r.exitCode === 0 && (await $.fs.exists(pdfPath))) return { path: pdfPath, via: 'chrome' }
    } catch {
      // fall through to cupsfilter
    }
  }
  if (await $.fs.exists('/usr/sbin/cupsfilter')) {
    try {
      const r = await $.process.run(['/bin/sh', '-c', `/usr/sbin/cupsfilter -t ${shq(title)} ${shq(textPath)} > ${shq(pdfPath)} 2>/dev/null`], { timeoutMs: 60_000 })
      if (r.exitCode === 0 && (await $.fs.exists(pdfPath))) return { path: pdfPath, via: 'cupsfilter' }
    } catch {
      // nothing else to try
    }
  }
  return { reason: chrome ? 'the browser did not produce a PDF' : 'no headless browser (Chrome, Chromium, Edge, Brave) and no cupsfilter found; set ACTIVITY_DASHBOARD_CHROME to a browser binary' }
}

type ReportKind = 'pdf' | 'html' | 'md'

const makeReport = async ($: EngineInterface, kind: ReportKind, target: string): Promise<string> => {
  const now = await $.clock.now()
  const dir = await baseDir($)
  let md: string
  let html: string
  let stem: string
  let title: string
  if (target === 'all') {
    const recs = await loadRecords($)
    const current = buildRecord(await snapshot($))
    const merged = [current, ...recs.filter(r => r.id !== current.id)].sort((a, b) => b.startedAt - a.startedAt)
    if (!merged.length) return 'No sessions recorded yet.'
    md = aggregateToMarkdown(merged, now)
    html = aggregateToHtml(merged, now)
    stem = `${fmtStamp(now)}_all-sessions`
    title = 'Activity report: all sessions'
  } else {
    let rec: SessionRecord | undefined
    if (target === '' || target === 'current' || target === 'this') {
      rec = (await persist($)) ?? buildRecord(await snapshot($))
    } else {
      rec = (await loadRecords($)).find(r => r.id === target || r.id.startsWith(target))
      if (!rec) return `No stored session matches "${target}". Run \`/${COMMAND} sessions\` for the list.`
    }
    md = recordToMarkdown(rec)
    html = recordToHtml(rec)
    stem = `${fmtStamp(rec.startedAt)}_${rec.id.slice(0, 8)}`
    title = `Activity report: ${rec.title}`
  }
  const reports = `${dir}/reports`
  const mdPath = `${reports}/${stem}.md`
  const htmlPath = `${reports}/${stem}.html`
  await $.fs.write(mdPath, md)
  await $.fs.write(htmlPath, html)
  if (kind === 'md') return `Report written: ${mdPath}`
  if (kind === 'html') return `Report written: ${htmlPath} (markdown beside it)`
  const pdfPath = `${reports}/${stem}.pdf`
  const out = await toPdf($, htmlPath, mdPath, pdfPath, title, `${dir}/.browser-profile`)
  if (out.path) {
    $.ui.toast(`PDF report: ${out.path}`)
    return `PDF report written: ${out.path} (via ${out.via}; HTML and markdown beside it)`
  }
  return `Could not render a PDF: ${out.reason}. The HTML report is at ${htmlPath}; open it in a browser and print to PDF.`
}

// ---------------------------------------------------------------------------
// Ticker: elapsed times tick while something runs; agent statuses refresh
// ---------------------------------------------------------------------------

let tick = 0

const startTicker = ($: EngineInterface) => {
  $.clock.every(1000, async () => {
    tick += 1
    try {
      const [main, active, agents] = await Promise.all([read($, mainAtom), read($, activeAtom), read($, agentsAtom)])
      const liveAgents = agents.some(a => !isDoneStatus(a.status))
      const busy = main.phase !== 'idle' || active.length > 0 || liveAgents
      if (liveAgents && tick % 3 === 0) {
        const live = await $.agent.list()
        const now = await $.clock.now()
        let agentMsDelta = 0
        await update($, agentsAtom, list =>
          list.map(a => {
            const l = live.find(x => x.id === a.id)
            if (!l || l.status === a.status) return a
            const done = isDoneStatus(l.status)
            if (done && a.endedAt === undefined) agentMsDelta += now - a.startedAt
            return { ...a, status: l.status, endedAt: done ? (a.endedAt ?? now) : a.endedAt }
          }),
        )
        if (agentMsDelta > 0) await update($, timeAtom, t => ({ ...t, agentMs: t.agentMs + agentMsDelta }))
      }
      if (busy) $.ui.invalidate('ui.render')
    } catch {
      // a tick that cannot read is skipped
    }
  })
}

// ---------------------------------------------------------------------------
// Session identity: id, cwd, repo, branch
// ---------------------------------------------------------------------------

const learnSession = async ($: EngineInterface) => {
  let sessionId = ''
  let cwd = ''
  let repo: string | undefined
  let branch: string | undefined
  let model = ''
  try {
    sessionId = await $.session.id()
  } catch {
    sessionId = ''
  }
  try {
    cwd = await $.session.cwd()
  } catch {
    cwd = ''
  }
  try {
    model = await $.session.model()
  } catch {
    model = ''
  }
  try {
    const r = await $.session.repo()
    if (r) repo = r.name ?? r.root
  } catch {
    repo = undefined
  }
  try {
    const g = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 })
    if (g.exitCode === 0) branch = g.stdout.trim() || undefined
  } catch {
    branch = undefined
  }
  await update($, mainAtom, m => ({
    ...m,
    sessionId: sessionId || m.sessionId,
    cwd: cwd || m.cwd,
    repo: repo ?? m.repo,
    branch: branch ?? m.branch,
    sessionModel: model || m.sessionModel,
  }))
  return model
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Activity dashboard: live model, agents, orchestration, time, tokens, cost; summary and PDF reports',
      argumentHint: '[summary|sessions|report [pdf|html|md] [all|<id>]|title <text>|reset|close|breakdown|tools|log|steps|models|time]',
    })
    const now = await $.clock.now()
    const model = await learnSession($)
    await update($, mainAtom, m => ({ ...m, startedAt: m.startedAt || now, phase: 'idle' as const }))
    await update($, timeAtom, t => ({ ...t, idleSince: t.idleSince ?? now }))
    try {
      const u = await $.session.usage()
      await update($, mainAtom, m => ({ ...m, startedAt: u.startedAt || m.startedAt }))
      await applySessionUsage($, u, now)
    } catch {
      // not bound yet: session.measure fills it in later
    }
    await pushEvent($, now, `dashboard ready · ${shortModel(model)}`, 'info')
    startTicker($)
    void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const raw = e.args.trim()
    const [word = '', ...rest] = raw.split(/\s+/)
    const arg = word.toLowerCase()
    switch (arg) {
      case 'summary': {
        const rec = (await persist($)) ?? buildRecord(await snapshot($))
        return { text: chatSummary(rec) }
      }
      case 'sessions': {
        const recs = await loadRecords($)
        if (!recs.length) return { text: 'No sessions recorded yet: a record is written at the end of every turn.' }
        const lines = recs.slice(0, 40).map(r => `- ${fmtDateTime(r.startedAt)} · **${cut(r.title, 60)}** · ${cut(r.repo ?? r.cwd, 28)} · ${fmtMs(r.wallMs)} wall · ${r.turns.length} turns · ${fmtTok(total(r.totals))} tok${r.costUsd !== undefined ? ` · ${fmtUsd(r.costUsd)}` : ''} · \`${r.id.slice(0, 8)}\``)
        return { text: `**Recorded sessions (${recs.length})**\n${lines.join('\n')}\n\n\`/${COMMAND} report pdf <id>\` for one, \`/${COMMAND} report pdf all\` for the whole set.` }
      }
      case 'report': {
        const kinds: ReportKind[] = ['pdf', 'html', 'md']
        let kind: ReportKind = 'pdf'
        let target = ''
        for (const r of rest) {
          const low = r.toLowerCase()
          if ((kinds as string[]).includes(low)) kind = low as ReportKind
          else target = r
        }
        return { text: await makeReport($, kind, target) }
      }
      case 'title': {
        const title = oneLine(rest.join(' '))
        if (!title) {
          const m = await read($, mainAtom)
          return { text: `Current task title: ${m.title || '(none yet)'}` }
        }
        await update($, mainAtom, m => ({ ...m, title: cut(title, 160), titleIsManual: true }))
        await persist($)
        return { text: `Task title set: ${cut(title, 160)}` }
      }
      case 'reset':
        await resetAll($)
        await $.ui.open({ id: PANE, title: TITLE })
        return { text: 'Activity dashboard: statistics reset.' }
      case 'close':
        await $.ui.close({ id: PANE })
        return { text: 'Activity dashboard closed.' }
      case 'breakdown':
        await fetchBreakdown($)
        await $.ui.open({ id: PANE, title: TITLE })
        return { text: 'Activity dashboard: context breakdown refreshed.' }
      case 'tools':
        await toggleView($, 'showTools')
        return { text: 'Activity dashboard: tools section toggled.' }
      case 'log':
        await toggleView($, 'showLog')
        return { text: 'Activity dashboard: log section toggled.' }
      case 'steps':
        await toggleView($, 'showSteps')
        return { text: 'Activity dashboard: steps section toggled.' }
      case 'models':
        await toggleView($, 'showModels')
        return { text: 'Activity dashboard: models section toggled.' }
      case 'time':
        await toggleView($, 'showTime')
        return { text: 'Activity dashboard: time section toggled.' }
      default: {
        const placed = await $.ui.open({ id: PANE, title: TITLE, focus: true })
        return {
          text: placed.isPlaced
            ? 'Activity dashboard opened.'
            : 'Activity dashboard is open but waits for room (widen the window or dock a pane).',
        }
      }
    }
  })

  // --- turns -------------------------------------------------------------

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    const ctx = await read($, contextAtom)
    const head = oneLine(e.text)
    await update($, timeAtom, t => ({
      ...t,
      waitMs: t.waitMs + (t.idleSince !== undefined ? Math.max(0, now - t.idleSince) : 0),
      idleSince: undefined,
    }))
    await update($, mainAtom, m => ({
      ...m,
      phase: 'model' as const,
      turnId: e.turnId,
      turnStartedAt: now,
      stepIndex: 0,
      costAtTurnStart: ctx.costUsd,
      title: m.title || (head ? cut(head, 160) : m.title),
      sessionId: m.sessionId,
    }))
    await update($, turnsAtom, list =>
      [...list, { index: list.length + 1, turnId: e.turnId, startedAt: now, prompt: cut(head, 200), toolCalls: 0, agents: 0, modelMs: 0, toolMs: 0 }].slice(-MAX_TURNS),
    )
    await pushEvent($, now, head ? `turn: ${cut(head, 60)}` : 'turn started (continuation)', 'info')
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const started = await $.clock.now()
    if (e.agentId) {
      const id = e.agentId
      await update($, agentsAtom, list =>
        list.map(a => (a.id === id ? { ...a, steps: a.steps + 1, model: e.model || a.model, status: 'running' } : a)),
      )
    } else {
      await update($, mainAtom, m => ({
        ...m,
        phase: 'model' as const,
        model: e.model,
        effort: e.effort === undefined ? m.effort : String(e.effort),
        stepIndex: e.index,
        messageCount: e.messageCount,
      }))
    }
    const r = yield* next(e)
    const now = await $.clock.now()
    const ms = now - started
    if (!e.agentId) {
      await update($, timeAtom, t => ({ ...t, modelMs: t.modelMs + ms }))
      await bumpTurn($, t => ({ ...t, modelMs: t.modelMs + ms }))
    }
    if (r && r.usage) {
      await noteStepUsage($, e.model, e.agentId, r.usage, ms, now, r.stopReason ?? undefined)
    }
    if (r && r.stopReason === 'model_context_window_exceeded') {
      await pushEvent($, now, 'context window exceeded', 'error')
    } else if (r && r.stopReason === 'max_tokens') {
      await pushEvent($, now, 'response cut at max_tokens', 'warn')
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.agentId) {
      const id = e.agentId
      const status = e.isAborted ? 'killed' : e.reason === 'error' || e.reason === 'refusal' ? 'failed' : 'completed'
      let known: DashAgent | undefined
      let agentMsDelta = 0
      await update($, agentsAtom, list =>
        list.map(a => {
          if (a.id !== id) return a
          known = a
          if (a.endedAt === undefined) agentMsDelta = now - a.startedAt
          return { ...a, status, endedAt: a.endedAt ?? now }
        }),
      )
      if (agentMsDelta > 0) await update($, timeAtom, t => ({ ...t, agentMs: t.agentMs + agentMsDelta }))
      if (known) {
        const k = known
        await pushEvent(
          $,
          now,
          `${status === 'completed' ? '✓' : '✗'} agent ${k.type} (${shortModel(k.model)}) ${fmtMs(e.durationMs)} · ${fmtTok(total(k.usage))} tok`,
          status === 'completed' ? 'ok' : 'error',
        )
      }
    } else {
      const ctx = await read($, contextAtom)
      const u = e.usage ? fromModelUsage(e.usage) : undefined
      let costDelta: number | undefined
      await update($, mainAtom, m => {
        costDelta = ctx.costUsd !== undefined && m.costAtTurnStart !== undefined ? Math.max(0, ctx.costUsd - m.costAtTurnStart) : undefined
        return {
          ...m,
          phase: 'idle' as const,
          turns: m.turns + 1,
          lastTurnMs: e.durationMs,
          lastTurnUsage: u ?? m.lastTurnUsage,
          lastTurnCostUsd: costDelta ?? m.lastTurnCostUsd,
        }
      })
      await bumpTurn($, t => ({ ...t, endedAt: now, ms: Math.max(e.durationMs, now - t.startedAt), usage: u, costDelta, reason: e.reason }))
      await update($, timeAtom, t => ({ ...t, idleSince: now }))
      await pushEvent(
        $,
        now,
        `${e.reason === 'answer' ? '✓' : '✗'} turn ${e.reason} ${fmtMs(e.durationMs)}${u ? ` · in ${fmtTok(inputOf(u))} out ${fmtTok(u.output)}` : ''}`,
        e.reason === 'answer' ? 'ok' : e.reason === 'aborted' ? 'warn' : 'error',
      )
      void fetchBreakdown($).then(() => persist($))
    }
    return next(e)
  })

  // --- agents --------------------------------------------------------------

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && r.agentId) {
      const now = await $.clock.now()
      const agent: DashAgent = {
        id: r.agentId,
        type: e.subagentType,
        description: cut(oneLine(e.description), 80),
        model: r.model || e.model || e.parentModel,
        parentId: e.parentAgentId,
        name: e.name,
        status: 'running',
        background: e.background,
        startedAt: now,
        usage: emptyUsage(),
        steps: 0,
        toolCalls: 0,
      }
      await update($, agentsAtom, list => [...list.filter(a => a.id !== agent.id), agent].slice(-MAX_AGENTS))
      if (!e.parentAgentId) await bumpTurn($, t => ({ ...t, agents: t.agents + 1 }))
      await pushEvent($, now, `▶ agent ${agent.type} (${shortModel(agent.model)}): ${cut(agent.description, 50)}`, 'info')
    }
    return r
  })

  // --- tools ---------------------------------------------------------------

  on('tool.call', async ($, e, next) => {
    const started = await $.clock.now()
    const tool = String(e.tool)
    const id = e.tool_use_id
    const agentId = e.agentId
    const detail = detailOf(e as unknown as Record<string, unknown>)
    await update($, activeAtom, list => [...list, { id, tool, agentId, startedAt: started, detail }].slice(-MAX_ACTIVE))
    if (!agentId) await update($, mainAtom, m => ({ ...m, phase: 'tool' as const }))
    let isError = false
    try {
      const r = await next(e)
      isError = r.deny !== undefined || r.isError === true
      return r
    } catch (err) {
      isError = true
      throw err
    } finally {
      const now = await $.clock.now()
      const ms = now - started
      await update($, activeAtom, list => list.filter(a => a.id !== id))
      await update($, toolsAtom, map => {
        const t = map[tool] ?? { name: tool, calls: 0, errors: 0, totalMs: 0 }
        return { ...map, [tool]: { ...t, calls: t.calls + 1, errors: t.errors + (isError ? 1 : 0), totalMs: t.totalMs + ms } }
      })
      if (agentId) {
        await update($, agentsAtom, list => list.map(a => (a.id === agentId ? { ...a, toolCalls: a.toolCalls + 1 } : a)))
      } else {
        const countsAsTool = tool !== 'Agent'
        if (countsAsTool) await update($, timeAtom, t => ({ ...t, toolMs: t.toolMs + ms }))
        await bumpTurn($, t => ({ ...t, toolCalls: t.toolCalls + 1, toolMs: t.toolMs + (countsAsTool ? ms : 0) }))
        await update($, mainAtom, m => (m.phase === 'tool' ? { ...m, phase: 'model' as const } : m))
      }
      if (isError) await pushEvent($, now, `✗ ${toolLabel(tool)} failed${detail ? `: ${cut(detail, 40)}` : ''}`, 'error')
    }
  })

  // --- context, cost, rate limits -----------------------------------------

  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, contextAtom, c => {
      const percent = e.context.percent ?? c.percent
      return {
        ...c,
        tokens: e.context.tokens ?? c.tokens,
        window: e.context.window || c.window,
        percent,
        maxPercent: Math.max(c.maxPercent ?? 0, percent ?? 0),
        costUsd: e.cost?.usd ?? c.costUsd,
        rateLimits: e.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
        measuredAt: now,
      }
    })
    const hot = e.rateLimits.find(r => r.percentUsed >= 90)
    if (hot && e.changed.includes('rateLimits')) {
      await pushEvent($, now, `rate limit ${hot.kind} at ${hot.percentUsed}%`, 'warn')
    }
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.trigger !== 'precompute') {
      const now = await $.clock.now()
      if (r.skip === undefined) {
        await update($, contextAtom, c => ({
          ...c,
          compactions: c.compactions + 1,
          lastCompaction: { before: r.tokensBefore, after: r.tokensAfter, at: now },
        }))
        await pushEvent(
          $,
          now,
          `compaction (${e.trigger})${r.tokensBefore !== undefined && r.tokensAfter !== undefined ? ` ${fmtTok(r.tokensBefore)} → ${fmtTok(r.tokensAfter)}` : ''}`,
          'warn',
        )
      } else {
        await pushEvent($, now, `compaction skipped: ${cut(r.skip, 50)}`, 'warn')
      }
    }
    return r
  })

  on('session.end', async ($, e, next) => {
    await persist($, true)
    if (e.reason === 'clear') {
      await clearStats($, false)
      await update($, mainAtom, m => ({ ...emptyMain(), sessionModel: m.sessionModel, cwd: m.cwd, repo: m.repo, branch: m.branch }))
    }
    return next(e)
  })

  // --- the pane ------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const [main, usage, agents, ctx, tools, active, steps, events, view, turns, time] = await Promise.all([
      read($, mainAtom),
      read($, usageAtom),
      read($, agentsAtom),
      read($, contextAtom),
      read($, toolsAtom),
      read($, activeAtom),
      read($, stepsAtom),
      read($, eventsAtom),
      read($, viewAtom),
      read($, turnsAtom),
      read($, timeAtom),
    ])

    const W = clamp(e.props.bodyColumns ?? e.viewport?.columns ?? 80, 36, 160)
    const BAR = clamp(W - 34, 8, 30)
    const LABEL = 9
    const rows: RenderNode[] = []

    const header = (text: string) =>
      rows.push(
        <Text bold color="claude">
          {text}
        </Text>,
      )
    const dim = (text: string) => rows.push(<Text dimColor>{cut(text, W)}</Text>)
    const barRow = (label: string, frac: number, color: string, tail: string, width = BAR) => {
      const b = barOf(frac, width)
      rows.push(
        <Text wrap="truncate-end">
          {pad(label, LABEL)}
          <Text color={color}>{b.filled}</Text>
          <Text dimColor>{b.empty}</Text> {tail}
        </Text>,
      )
    }

    // ---- 1. header: session, phase, uptime ------------------------------
    const uptime = main.startedAt ? fmtMs(now - main.startedAt) : '—'
    const phase =
      main.phase === 'idle'
        ? { glyph: '○', text: 'idle', color: 'subtle' }
        : main.phase === 'tool'
          ? { glyph: '◆', text: `tools${active.length ? ` (${active.length})` : ''}`, color: 'warning' }
          : { glyph: '●', text: 'thinking', color: 'claude' }
    const inTurn = main.phase !== 'idle' && main.turnStartedAt ? ` ${fmtMs(now - main.turnStartedAt)}` : ''
    rows.push(
      <Text wrap="truncate-end">
        <Text bold>ACTIVITY</Text>
        {'  '}
        <Text color={phase.color} bold>
          {phase.glyph} {phase.text}
          {inTurn}
        </Text>
        <Text dimColor>
          {'  '}turns {String(main.turns)} · up {uptime}
        </Text>
      </Text>,
    )
    const effort = main.effort ? `  effort ${main.effort}` : ''
    const stepInfo = main.phase !== 'idle' ? `  step ${String(main.stepIndex + 1)} · ${String(main.messageCount)} msgs` : ''
    rows.push(
      <Text wrap="truncate-end">
        {pad('model', LABEL)}
        <Text bold color="claude">
          {shortModel(main.model || main.sessionModel)}
        </Text>
        <Text dimColor>
          {main.model && main.sessionModel && main.model !== main.sessionModel ? `  (session: ${shortModel(main.sessionModel)})` : ''}
          {effort}
          {stepInfo}
        </Text>
      </Text>,
    )
    if (main.title) {
      rows.push(
        <Text wrap="truncate-end">
          {pad('task', LABEL)}
          <Text>{cut(main.title, Math.max(10, W - LABEL - 2))}</Text>
        </Text>,
      )
    }
    dim(`${pad('where', LABEL)}${main.repo ?? cut(main.cwd, 40)}${main.branch ? ` @ ${main.branch}` : ''}${main.sessionId ? ` · ${main.sessionId.slice(0, 8)}` : ''}`)
    if (main.lastTurnMs !== undefined) {
      const lu = main.lastTurnUsage
      dim(
        `${pad('last turn', LABEL)}${fmtMs(main.lastTurnMs)}${lu ? ` · in ${fmtTok(inputOf(lu))} out ${fmtTok(lu.output)} · ${String(lu.calls)} calls` : ''}${main.lastTurnCostUsd !== undefined ? ` · +${fmtUsd(main.lastTurnCostUsd)}` : ''}`,
      )
    }
    rows.push(<Text> </Text>)

    // ---- 2. time ----------------------------------------------------------
    if (view.showTime) {
      const wall = Math.max(1, now - (main.startedAt || now))
      const waiting = time.waitMs + (time.idleSince !== undefined ? Math.max(0, now - time.idleSince) : 0)
      const liveModel = time.modelMs
      const liveAgents = time.agentMs + agents.filter(a => a.endedAt === undefined).reduce((n, a) => n + (now - a.startedAt), 0)
      const activeMs = turns.reduce((n, t) => n + (t.ms ?? now - t.startedAt), 0)
      header('TIME')
      dim(`${pad('', LABEL)}wall ${fmtMs(wall)} · active ${fmtMs(activeMs)} · waiting ${fmtMs(waiting)} · ${String(turns.length)} turns`)
      barRow('model', liveModel / wall, 'claude', `${padL(fmtMs(liveModel), 7)}  ${String(Math.round(pct(liveModel, wall)))}%`)
      barRow('tools', time.toolMs / wall, 'warning', `${padL(fmtMs(time.toolMs), 7)}  ${String(Math.round(pct(time.toolMs, wall)))}%`)
      barRow('agents', liveAgents / wall, 'planMode', `${padL(fmtMs(liveAgents), 7)}  ${String(Math.round(pct(liveAgents, wall)))}%`)
      barRow('waiting', waiting / wall, 'inactive', `${padL(fmtMs(waiting), 7)}  ${String(Math.round(pct(waiting, wall)))}%`)
      if (turns.length) {
        const done = turns.filter(t => t.ms !== undefined)
        const longest = done.reduce<DashTurn | undefined>((b, t) => ((t.ms ?? 0) > (b?.ms ?? -1) ? t : b), undefined)
        const avg = done.length ? done.reduce((n, t) => n + (t.ms ?? 0), 0) / done.length : 0
        dim(`${pad('', LABEL)}avg turn ${fmtMs(avg)}${longest ? ` · longest #${String(longest.index)} ${fmtMs(longest.ms ?? 0)}: ${cut(longest.prompt, 30)}` : ''}`)
      }
      rows.push(<Text> </Text>)
    }

    // ---- 3. context window ----------------------------------------------
    header('CONTEXT')
    if (ctx.window > 0) {
      const p = ctx.percent ?? (ctx.tokens !== undefined ? (ctx.tokens / ctx.window) * 100 : 0)
      barRow('window', p / 100, pctColor(p), `${padL(`${Math.round(p)}%`, 4)}  ${fmtTok(ctx.tokens ?? 0)} / ${fmtTok(ctx.window)}`)
      const extra: string[] = []
      if (ctx.autoCompactThreshold !== undefined) {
        extra.push(`autocompact at ${ctx.autoCompactThreshold <= 100 ? `${String(ctx.autoCompactThreshold)}%` : fmtTok(ctx.autoCompactThreshold)}`)
      }
      if (ctx.maxPercent !== undefined && ctx.maxPercent > 0) extra.push(`peak ${String(Math.round(ctx.maxPercent))}%`)
      if (ctx.compactions > 0) {
        const lc = ctx.lastCompaction
        extra.push(
          `compactions ${String(ctx.compactions)}${lc && lc.before !== undefined && lc.after !== undefined ? ` (last ${fmtTok(lc.before)} → ${fmtTok(lc.after)})` : ''}`,
        )
      }
      if (extra.length) dim(`${pad('', LABEL)}${extra.join(' · ')}`)
      if (ctx.breakdown && ctx.breakdown.length) {
        const used = ctx.breakdown.filter(r => r.kind === 'used' && r.tokens > 0).sort((a, b) => b.tokens - a.tokens)
        const max = ctx.breakdownMax || Math.max(1, ...used.map(r => r.tokens))
        for (const r of used.slice(0, 8)) {
          barRow(` ${cut(r.name, LABEL - 1)}`, r.tokens / max, 'permission', `${padL(fmtTok(r.tokens), 7)}  ${String(Math.round((r.tokens / max) * 100))}%`, Math.max(6, BAR - 6))
        }
      }
    } else {
      dim(`${pad('window', LABEL)}waiting for the first measurement…`)
    }

    // ---- 4. rate limits & cost ------------------------------------------
    if (ctx.rateLimits.length) {
      for (const r of ctx.rateLimits) {
        const label = r.kind === 'five_hour' ? '5h' : r.kind === 'seven_day' ? '7d' : cut(r.kind, LABEL - 1)
        barRow(`limit ${label}`, r.percentUsed / 100, pctColor(r.percentUsed), `${padL(`${String(r.percentUsed)}%`, 5)}  ${untilIso(r.resetsAt, now)}`)
      }
    }
    if (ctx.costUsd !== undefined) {
      rows.push(
        <Text wrap="truncate-end">
          {pad('cost', LABEL)}
          <Text bold>{fmtUsd(ctx.costUsd)}</Text>
          <Text dimColor>
            {main.lastTurnCostUsd !== undefined ? `  (+${fmtUsd(main.lastTurnCostUsd)} last turn)` : ''}
            {main.turns > 0 ? `  ~${fmtUsd(ctx.costUsd / main.turns)}/turn` : ''}
          </Text>
        </Text>,
      )
    }
    rows.push(<Text> </Text>)

    // ---- 5. tokens ------------------------------------------------------
    header('TOKENS')
    const models = Object.entries(usage).sort((a, b) => total(b[1]) - total(a[1]))
    const grand = models.reduce((acc, [, u]) => addUsageInto(acc, u), emptyUsage())
    if (grand.calls === 0) {
      dim(`${pad('', LABEL)}no model calls yet`)
    } else {
      const maxPart = Math.max(1, grand.input, grand.output, grand.cacheRead, grand.cacheWrite)
      barRow('input', grand.input / maxPart, 'warning', padL(fmtTok(grand.input), 7) + '  uncached')
      barRow('cache ←', grand.cacheRead / maxPart, 'success', padL(fmtTok(grand.cacheRead), 7) + '  read')
      barRow('cache →', grand.cacheWrite / maxPart, 'permission', padL(fmtTok(grand.cacheWrite), 7) + '  written')
      barRow('output', grand.output / maxPart, 'claude', padL(fmtTok(grand.output), 7) + '  generated')
      const hit = cacheHit(grand)
      dim(
        `${pad('', LABEL)}${String(grand.calls)} calls · cache hit ${String(Math.round(hit))}% · total ${fmtTok(total(grand))} · out/in ${pct(grand.output, Math.max(1, inputOf(grand))).toFixed(1)}%`,
      )
      if (view.showModels && models.length) {
        const all = Math.max(1, total(grand))
        for (const [name, u] of models.slice(0, 6)) {
          const share = total(u) / all
          barRow(
            cut(shortModel(name), LABEL - 1),
            share,
            'claude',
            `${padL(`${String(Math.round(share * 100))}%`, 4)}  ${String(u.calls)} calls · in ${fmtTok(inputOf(u))} out ${fmtTok(u.output)} · hit ${String(Math.round(cacheHit(u)))}%`,
            Math.max(6, BAR - 6),
          )
        }
      }
    }
    rows.push(<Text> </Text>)

    // ---- 6. orchestration tree -----------------------------------------
    header('ORCHESTRATION')
    const mainActive = active.filter(a => !a.agentId)
    rows.push(
      <Text wrap="truncate-end">
        <Text color={phase.color}>{phase.glyph}</Text> <Text bold>main</Text>
        <Text dimColor>
          {'  '}
          {shortModel(main.model || main.sessionModel)}
          {main.effort ? ` · ${main.effort}` : ''}
          {mainActive.length ? ` · ${mainActive.map(a => toolLabel(a.tool)).join(', ')}` : ''}
        </Text>
      </Text>,
    )
    const childrenOf = (parent: string | undefined): DashAgent[] =>
      agents.filter(a => (a.parentId ?? undefined) === parent || (parent === undefined && a.parentId !== undefined && !agents.some(p => p.id === a.parentId)))
    const drawAgents = (parent: string | undefined, prefix: string, depth: number) => {
      const kids = childrenOf(parent)
      kids.forEach((a, i) => {
        const last = i === kids.length - 1
        const branch = `${prefix}${last ? '└─ ' : '├─ '}`
        const g = statusGlyph(a.status)
        const elapsed = fmtMs((a.endedAt ?? now) - a.startedAt)
        const running = active.filter(t => t.agentId === a.id)
        rows.push(
          <Text wrap="truncate-end">
            <Text dimColor>{branch}</Text>
            <Text color={g.color}>{g.glyph}</Text> <Text bold={!isDoneStatus(a.status)}>{cut(a.name ? `${a.type} "${a.name}"` : a.type, 28)}</Text>
            <Text dimColor>
              {'  '}
              {shortModel(a.model)} · {elapsed} · {fmtTok(total(a.usage))} tok · {String(a.toolCalls)} tools
              {a.background ? ' · bg' : ''}
              {running.length ? ` · ${running.map(t => toolLabel(t.tool)).join(', ')}` : ''}
            </Text>
          </Text>,
        )
        if (a.description) {
          rows.push(
            <Text wrap="truncate-end" dimColor>
              {`${prefix}${last ? '   ' : '│  '}  ${cut(a.description, Math.max(10, W - prefix.length - 6))}`}
            </Text>,
          )
        }
        if (depth < 6) drawAgents(a.id, `${prefix}${last ? '   ' : '│  '}`, depth + 1)
      })
    }
    drawAgents(undefined, '', 0)
    if (agents.length) {
      const byType = new Map<string, { count: number; tokens: number; live: number; ms: number }>()
      for (const a of agents) {
        const t = byType.get(a.type) ?? { count: 0, tokens: 0, live: 0, ms: 0 }
        t.count += 1
        t.tokens += total(a.usage)
        t.live += isDoneStatus(a.status) ? 0 : 1
        t.ms += (a.endedAt ?? now) - a.startedAt
        byType.set(a.type, t)
      }
      const maxTok = Math.max(1, ...[...byType.values()].map(t => t.tokens))
      dim(`${pad('', LABEL)}by agent type (tokens share):`)
      for (const [type, t] of [...byType.entries()].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 6)) {
        barRow(
          ` ${cut(type, LABEL - 1)}`,
          t.tokens / maxTok,
          'planMode',
          `${padL(fmtTok(t.tokens), 7)}  ×${String(t.count)}${t.live ? ` (${String(t.live)} live)` : ''} · avg ${fmtMs(t.ms / t.count)}`,
          Math.max(6, BAR - 6),
        )
      }
    } else {
      dim(`${pad('', LABEL)}no subagents spawned yet`)
    }
    rows.push(<Text> </Text>)

    // ---- 7. active tool calls -------------------------------------------
    if (active.length) {
      header(`ACTIVE TOOLS (${String(active.length)})`)
      for (const t of active.slice(-8)) {
        const who = t.agentId ? agents.find(a => a.id === t.agentId)?.type ?? 'agent' : 'main'
        rows.push(
          <Text wrap="truncate-end">
            <Text color="warning">◆</Text> <Text bold>{pad(cut(toolLabel(t.tool), 22), 22)}</Text>
            <Text dimColor>
              {padL(fmtMs(now - t.startedAt), 7)} · {cut(who, 14)}
              {t.detail ? ` · ${cut(t.detail, Math.max(10, W - 52))}` : ''}
            </Text>
          </Text>,
        )
      }
      rows.push(<Text> </Text>)
    }

    // ---- 8. tool statistics --------------------------------------------
    if (view.showTools) {
      const list = Object.values(tools).sort((a, b) => b.calls - a.calls)
      header(`TOOLS (${String(list.reduce((n, t) => n + t.calls, 0))} calls · ${fmtMs(list.reduce((n, t) => n + t.totalMs, 0))})`)
      if (!list.length) dim(`${pad('', LABEL)}no tool calls yet`)
      const maxCalls = Math.max(1, ...list.map(t => t.calls))
      for (const t of list.slice(0, 10)) {
        barRow(
          cut(toolLabel(t.name), LABEL - 1),
          t.calls / maxCalls,
          t.errors ? 'warning' : 'success',
          `${padL(String(t.calls), 4)}${t.errors ? ` ✗${String(t.errors)}` : '   '}  ${padL(fmtMs(t.totalMs), 7)} · avg ${fmtMs(t.totalMs / t.calls)}`,
          Math.max(6, BAR - 6),
        )
      }
      rows.push(<Text> </Text>)
    }

    // ---- 9. recent model steps -----------------------------------------
    if (view.showSteps && steps.length) {
      header('RECENT MODEL CALLS (in / out)')
      const recent = steps.slice(-8)
      const maxIn = Math.max(1, ...recent.map(s => s.input + s.cacheRead + s.cacheWrite))
      const maxOut = Math.max(1, ...recent.map(s => s.output))
      const half = Math.max(4, Math.floor((BAR - 1) / 2))
      for (const s of recent) {
        const inp = s.input + s.cacheRead + s.cacheWrite
        const bi = barOf(inp / maxIn, half)
        const bo = barOf(s.output / maxOut, half)
        const who = s.agentId ? agents.find(a => a.id === s.agentId)?.type ?? 'agent' : 'main'
        rows.push(
          <Text wrap="truncate-end">
            <Text dimColor>{fmtClock(s.at)} </Text>
            {pad(cut(shortModel(s.model), 10), 10)} <Text color="success">{bi.filled}</Text>
            <Text dimColor>{bi.empty}</Text> <Text color="claude">{bo.filled}</Text>
            <Text dimColor>{bo.empty}</Text>
            <Text dimColor>
              {' '}
              {padL(fmtTok(inp), 6)}/{pad(fmtTok(s.output), 6)} {fmtMs(s.ms)} · {cut(who, 12)}
              {s.stopReason && s.stopReason !== 'end_turn' && s.stopReason !== 'tool_use' ? ` · ${s.stopReason}` : ''}
            </Text>
          </Text>,
        )
      }
      rows.push(<Text> </Text>)
    }

    // ---- 10. log ---------------------------------------------------------
    if (view.showLog) {
      header('LOG')
      if (!events.length) dim(`${pad('', LABEL)}—`)
      for (const ev of events.slice(-8)) {
        const color = ev.kind === 'ok' ? 'success' : ev.kind === 'warn' ? 'warning' : ev.kind === 'error' ? 'error' : 'text'
        rows.push(
          <Text wrap="truncate-end">
            <Text dimColor>{fmtClock(ev.at)} </Text>
            <Text color={color}>{cut(ev.text, Math.max(10, W - 10))}</Text>
          </Text>,
        )
      }
      rows.push(<Text> </Text>)
    }

    // ---- 11. controls -----------------------------------------------------
    return (
      <Box flexDirection="column">
        {rows}
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="pdf" hotkey="p" plain variant="primary" onPress={() => void makeReport($, 'pdf', '').then(t => $.ui.toast(t))}>
            p:pdf report
          </Button>
          <Button key="breakdown" hotkey="b" plain onPress={() => void fetchBreakdown($)}>
            b:breakdown
          </Button>
          <Button key="time" hotkey="i" plain dimColor={!view.showTime} onPress={() => void toggleView($, 'showTime')}>
            i:time
          </Button>
          <Button key="models" hotkey="m" plain dimColor={!view.showModels} onPress={() => void toggleView($, 'showModels')}>
            m:models
          </Button>
          <Button key="tools" hotkey="t" plain dimColor={!view.showTools} onPress={() => void toggleView($, 'showTools')}>
            t:tools
          </Button>
          <Button key="steps" hotkey="s" plain dimColor={!view.showSteps} onPress={() => void toggleView($, 'showSteps')}>
            s:calls
          </Button>
          <Button key="log" hotkey="l" plain dimColor={!view.showLog} onPress={() => void toggleView($, 'showLog')}>
            l:log
          </Button>
          <Button key="reset" hotkey="r" plain onPress={() => void resetAll($)}>
            r:reset
          </Button>
        </Box>
      </Box>
    )
  })
}
