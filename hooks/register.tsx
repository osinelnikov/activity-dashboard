import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, RenderNode, SessionUsage } from 'claude-code'

import type {
  DashActiveTool,
  DashAgent,
  DashContext,
  DashEvent,
  DashFile,
  DashMain,
  DashModelUsage,
  DashNow,
  DashSkill,
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
import { MAIN, agentLabel, changedLines, describeNow, extractChanges, fmtFilePct, lineCount, loopLabel, mergeFile, relPath, sinceText, skillBadge } from './activity'
import { meterRow, nextChartMode, paletteOf, shareChart, textBar } from './charts'
import type { ChartOptions, ChartTable, Slice } from './charts'
import { expandPath, labelPath, parseReportArgs } from './paths'
import type { ReportKind } from './paths'
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
const filesAtom = atom({ plugin: 'activity-dashboard', key: 'files' } as const, {} as Record<string, DashFile>)
const skillsAtom = atom({ plugin: 'activity-dashboard', key: 'skills' } as const, [] as DashSkill[])
const nowAtom = atom({ plugin: 'activity-dashboard', key: 'now' } as const, {} as Record<string, DashNow>)

const MAX_SKILLS = 200
const MAX_FILES = 400
const viewAtom = atom({ plugin: 'activity-dashboard', key: 'view' } as const, {
  showTools: true,
  showLog: true,
  showSteps: true,
  showModels: true,
  showTime: true,
  chart: 'bars',
  dark: false,
} as DashView)

/** Fixed palette slots by name, alphabetical, so a tool or model keeps its color whatever its rank. */
const slotsByName = (names: readonly string[]): Map<string, number> => {
  const m = new Map<string, number>()
  ;[...new Set(names)].sort((a, b) => a.localeCompare(b)).forEach((n, i) => m.set(n, i % 8))
  return m
}

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
  await update($, filesAtom, () => ({}))
  await update($, skillsAtom, () => [])
  await update($, nowAtom, () => ({}))
  await update($, contextAtom, c => (keepSession ? { ...c, compactions: 0, lastCompaction: undefined, maxPercent: c.percent } : emptyContext()))
}

const resetAll = async ($: EngineInterface) => {
  const now = await $.clock.now()
  await clearStats($, true)
  await update($, mainAtom, m => ({ ...emptyMain(), sessionId: m.sessionId, cwd: m.cwd, repo: m.repo, branch: m.branch, title: m.title, titleIsManual: m.titleIsManual, sessionModel: m.sessionModel, startedAt: now }))
  await pushEvent($, now, 'statistics reset', 'info')
}

type ViewFlag = 'showTools' | 'showLog' | 'showSteps' | 'showModels' | 'showTime' | 'showFiles' | 'showSkills'

/** Flips a section's flag; a flag never set reads as shown. */
const toggleView = async ($: EngineInterface, key: ViewFlag) => {
  await update($, viewAtom, v => ({ ...v, [key]: !(v[key] ?? true) }))
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
// Loops: what each is doing, the agents nobody announced, skills, file changes
// ---------------------------------------------------------------------------

/** Sets what a loop is doing; keeps the loop's skill unless the patch names one. */
const setNow = async ($: EngineInterface, loop: string, patch: Omit<DashNow, 'skill'> & { skill?: string | null }) => {
  await update($, nowAtom, map => {
    const prev = map[loop]
    const skill = patch.skill === null ? undefined : (patch.skill ?? prev?.skill)
    return { ...map, [loop]: { what: patch.what, detail: patch.detail, since: patch.since, skill } }
  })
}

const dropNow = async ($: EngineInterface, loop: string) => {
  await update($, nowAtom, map => {
    if (!(loop in map)) return map
    const { [loop]: _gone, ...rest } = map
    return rest
  })
}

/** Agent ids already looked up in `$.agent.list()`, and when: an unknown id is asked again after 5s. */
const lookedUp = new Map<string, number>()

/**
 * Adds an agent the session runs that no `agent.spawn` announced (a forked
 * skill, a loop the engine tracks on its own), from `$.agent.list()`. With
 * `placeholder`, one the list does not know is added too, as `agent`.
 */
const ensureAgent = async ($: EngineInterface, id: string, placeholder: boolean, via?: string) => {
  const agents = await read($, agentsAtom)
  if (agents.some(a => a.id === id)) return
  const at = await $.clock.now()
  const last = lookedUp.get(id)
  if (!placeholder && last !== undefined && at - last < 5000) return
  lookedUp.set(id, at)
  let info: Awaited<ReturnType<EngineInterface['agent']['list']>>[number] | undefined
  try {
    info = (await $.agent.list()).find(a => a.id === id)
  } catch {
    info = undefined
  }
  if (!info && !placeholder) return
  const agent: DashAgent = {
    id,
    type: info?.type ?? 'agent',
    description: cut(oneLine(info?.description ?? ''), 80),
    model: '',
    parentId: info?.parentId,
    name: info?.name,
    status: info?.status ?? 'running',
    background: false,
    startedAt: at,
    usage: emptyUsage(),
    steps: 0,
    toolCalls: 0,
    via: via ?? 'untracked',
  }
  await update($, agentsAtom, list => (list.some(a => a.id === id) ? list : [...list, agent].slice(-MAX_AGENTS)))
}

/** Skill tool calls in flight, by skill name: `skill.prompt` adds its source to them. */
const pendingSkills = new Map<string, number>()
const pendingSource = new Map<string, { source: string; plugin?: string }>()

const pushSkill = async ($: EngineInterface, s: DashSkill) => {
  await update($, skillsAtom, list => [...list, s].slice(-MAX_SKILLS))
}

const noteFileChanges = async ($: EngineInterface, tool: string, input: Record<string, unknown>, result: unknown, loop: string) => {
  const changes = extractChanges(tool, input, result)
  if (!changes.length) return
  const at = await $.clock.now()
  const unknownSize: string[] = []
  await update($, filesAtom, map => {
    const next = { ...map }
    for (const ch of changes) {
      const f = mergeFile(next[ch.path], ch, loop, tool, at)
      next[ch.path] = f
      if (f.lines === undefined && !f.deleted) unknownSize.push(ch.path)
    }
    const keys = Object.keys(next)
    if (keys.length > MAX_FILES) {
      for (const k of keys.sort((a, b) => (next[a]?.lastAt ?? 0) - (next[b]?.lastAt ?? 0)).slice(0, keys.length - MAX_FILES)) delete next[k]
    }
    return next
  })
  // a Bash change says nothing of the file's size: read it once to size the share
  for (const path of unknownSize.slice(0, 20)) {
    let lines: number | undefined
    try {
      lines = lineCount(await $.fs.read(path))
    } catch {
      lines = undefined
    }
    if (lines === undefined) continue
    const n = lines
    await update($, filesAtom, map => {
      const f = map[path]
      if (!f || f.lines !== undefined) return map
      return { ...map, [path]: { ...f, lines: n, baseLines: f.baseLines ?? Math.max(0, n - f.added + f.removed) } }
    })
  }
  const label = loop === MAIN ? 'main' : loopLabel(loop, await read($, agentsAtom))
  const sum = changes.reduce((acc, c) => ({ added: acc.added + c.added, removed: acc.removed + c.removed }), { added: 0, removed: 0 })
  const cwd = (await read($, mainAtom)).cwd
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  const what = changes.length === 1 ? relPath(changes[0]!.path, cwd, home) : `${String(changes.length)} files`
  await pushEvent($, at, `✎ ${label}: ${cut(what, 48)} +${String(sum.added)} −${String(sum.removed)}`, 'info')
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
  const [main, usage, agents, ctx, tools, turns, time, events, files, skills, now] = await Promise.all([
    read($, mainAtom),
    read($, usageAtom),
    read($, agentsAtom),
    read($, contextAtom),
    read($, toolsAtom),
    read($, turnsAtom),
    read($, timeAtom),
    read($, eventsAtom),
    read($, filesAtom),
    read($, skillsAtom),
    $.clock.now(),
  ])
  return { main, usage, agents, ctx, tools, turns, time, events, files, skills, now, ended }
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
// Where a report goes: a folder argument, else a dialog (remembered), else the default
// ---------------------------------------------------------------------------

/** The manifest's userConfig, as `register` received it; a reload brings new values. */
let config: { reportDir: string; askReportDir: boolean } = { reportDir: '', askReportDir: true }

const STORE_LAST_DIR = 'reportDir:last'

const homeDir = async ($: EngineInterface): Promise<string> => {
  try {
    return (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? (await $.session.cwd())
  } catch {
    return $.session.cwd()
  }
}

const defaultReportDir = async ($: EngineInterface): Promise<string> => {
  if (config.reportDir.trim()) return expandPath(config.reportDir, await homeDir($), await $.session.cwd())
  return `${await baseDir($)}/reports`
}

const rememberReportDir = async ($: EngineInterface, dir: string) => {
  try {
    await $.store.set(STORE_LAST_DIR, dir)
  } catch {
    // a store that refuses is no reason to lose the report
  }
}

const lastReportDir = async ($: EngineInterface): Promise<string | undefined> => {
  try {
    const v = await $.store.get(STORE_LAST_DIR)
    return typeof v === 'string' && v.trim() ? v : undefined
  } catch {
    return undefined
  }
}

const CANCELLED = Symbol('cancelled')

/**
 * Resolves the folder a report is written to. `explicit` (a command argument)
 * wins; else, with `askReportDir` on, a dialog offers the remembered folder,
 * the default, the project's `reports/` and the Desktop, plus a typed path
 * under "Other"; a dismissed dialog cancels; where nobody can be asked (a
 * `-p` run) the default is used.
 */
const chooseReportDir = async ($: EngineInterface, explicit: string | undefined): Promise<string | typeof CANCELLED> => {
  const home = await homeDir($)
  const cwd = await $.session.cwd()
  if (explicit) {
    const dir = expandPath(explicit, home, cwd)
    await rememberReportDir($, dir)
    return dir
  }
  const fallback = await defaultReportDir($)
  if (!config.askReportDir) return fallback
  const last = await lastReportDir($)
  const candidates: string[] = []
  const add = (d: string | undefined) => {
    if (d && !candidates.includes(d)) candidates.push(d)
  }
  add(last)
  add(fallback)
  add(`${cwd.replace(/\/+$/, '')}/reports`)
  add(`${home}/Desktop`)
  const options = candidates.slice(0, 4)
  const labels = options.map(d => labelPath(d, home))
  let answer: string
  try {
    answer = await $.ui.ask('Where should the report be saved? (pick a folder, or type a path under Other)', { options: labels, header: 'Report dir' })
  } catch {
    // dismissed, or nobody to ask: a -p run uses the default, a person who closed the dialog cancels
    let interactive = true
    try {
      interactive = (await $.session.surfaces()).length > 0
    } catch {
      interactive = true
    }
    return interactive ? CANCELLED : fallback
  }
  const picked = labels.indexOf(answer)
  const dir = picked >= 0 ? (options[picked] ?? fallback) : expandPath(answer, home, cwd)
  await rememberReportDir($, dir)
  return dir
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

const makeReport = async ($: EngineInterface, kind: ReportKind, target: string, explicitDir?: string): Promise<string> => {
  const now = await $.clock.now()
  const dir = await baseDir($)
  const chosen = await chooseReportDir($, explicitDir)
  if (chosen === CANCELLED) return 'Report cancelled: no folder chosen.'
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
  const reports = chosen
  const stemPath = `${reports}/${stem}`
  if (kind === 'md') {
    await $.fs.write(`${stemPath}.md`, md)
    return `Report written: ${stemPath}.md`
  }
  if (kind === 'html') {
    await $.fs.write(`${stemPath}.html`, html)
    return `Report written: ${stemPath}.html`
  }
  // pdf: the html and the text it is printed from live in the mod's work folder and go once the pdf exists
  const work = `${dir}/.work`
  const htmlPath = `${work}/${stem}.html`
  const mdPath = `${work}/${stem}.md`
  const pdfPath = `${stemPath}.pdf`
  await $.fs.write(mdPath, md)
  await $.fs.write(htmlPath, html)
  const out = await toPdf($, htmlPath, mdPath, pdfPath, title, `${dir}/.browser-profile`)
  if (out.path) {
    await removeFiles($, [htmlPath, mdPath])
    $.ui.toast(`PDF report: ${out.path}`)
    return `PDF report written: ${out.path} (via ${out.via})`
  }
  await $.fs.write(`${stemPath}.html`, html)
  await removeFiles($, [htmlPath, mdPath])
  return `Could not render a PDF: ${out.reason}. The HTML report is at ${stemPath}.html; open it in a browser and print to PDF.`
}

const removeFiles = async ($: EngineInterface, files: string[]) => {
  try {
    await $.process.run(['rm', '-f', ...files], { timeoutMs: 5000 })
  } catch {
    // leftovers in the work folder do no harm
  }
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

export const register: Register = (on, options) => {
  config = {
    reportDir: typeof options.reportDir === 'string' ? options.reportDir : '',
    askReportDir: options.askReportDir !== false,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Activity dashboard: live model, agents, orchestration, time, tokens, cost; summary and PDF reports',
      argumentHint: '[summary|sessions|report [md|pdf|html] [all|<id>] [<folder>]|reportdir [<folder>]|chart [bars|stacked|donut]|title <text>|reset|close|breakdown|files|skills|tools|log|steps|models|time]',
    })
    const now = await $.clock.now()
    const model = await learnSession($)
    await update($, mainAtom, m => ({ ...m, startedAt: m.startedAt || now, phase: 'idle' as const }))
    try {
      const settings = (await $.settings.read()) as Record<string, unknown>
      const theme = typeof settings.theme === 'string' ? settings.theme : ''
      await update($, viewAtom, v => ({ ...v, chart: v.chart ?? 'bars', dark: theme.startsWith('dark') }))
    } catch {
      // no settings to read: the light palette stands
    }
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
        const a = parseReportArgs(rest)
        return { text: await makeReport($, a.kind, a.target, a.dir) }
      }
      case 'reportdir': {
        const wanted = rest.join(' ').trim()
        const home = await homeDir($)
        if (wanted) {
          const dir = expandPath(wanted, home, await $.session.cwd())
          await rememberReportDir($, dir)
          return { text: `Reports will be offered in ${dir} first. (The dialog still asks; set askReportDir to false in /config to skip it.)` }
        }
        const last = await lastReportDir($)
        return { text: `Default report folder: ${await defaultReportDir($)}${last ? `\nLast chosen: ${last}` : ''}\nAsk each time: ${config.askReportDir ? 'yes' : 'no'} (userConfig askReportDir)` }
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
      case 'files':
        await toggleView($, 'showFiles')
        return { text: 'Activity dashboard: files section toggled.' }
      case 'skills':
        await toggleView($, 'showSkills')
        return { text: 'Activity dashboard: skills section toggled.' }
      case 'chart': {
        const wanted = (rest[0] ?? '').toLowerCase()
        const pick = wanted === 'bars' || wanted === 'stacked' || wanted === 'donut' ? wanted : undefined
        const v = await update($, viewAtom, x => ({ ...x, chart: pick ?? nextChartMode(x.chart) }))
        return { text: `Activity dashboard: charts drawn as ${v.chart}.` }
      }
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
    await setNow($, MAIN, { what: 'thinking', detail: '', since: now, skill: null })
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
    const loop = e.agentId ?? MAIN
    if (e.agentId) await ensureAgent($, e.agentId, false)
    // the engine's own forks (compaction, memory) step too: mark only loops the dashboard shows
    const tracked = !e.agentId || (await read($, agentsAtom)).some(a => a.id === e.agentId)
    if (tracked) await setNow($, loop, { what: 'thinking', detail: '', since: started })
    // pass every chunk on unchanged and return what beneath returned (read off
    // the iterator itself, as yield* does); note only when the kind of work changes
    const it = next(e)[Symbol.asyncIterator]()
    let lastKind = 'thinking'
    let finished = false
    let step = await it.next()
    try {
      while (!step.done) {
        const chunk = step.value
        yield chunk
        const kind = chunk.kind === 'text' ? 'answering' : chunk.kind === 'thinking' ? 'thinking' : chunk.kind === 'tool' ? `tool:${chunk.name}` : undefined
        if (tracked && kind !== undefined && kind !== lastKind) {
          lastKind = kind
          try {
            const at = await $.clock.now()
            if (chunk.kind === 'tool') await setNow($, loop, { what: 'preparing', detail: chunk.name, since: at })
            else await setNow($, loop, { what: kind === 'answering' ? 'answering' : 'thinking', detail: '', since: at })
          } catch {
            // bookkeeping never stands in the stream's way
          }
        }
        step = await it.next()
      }
      finished = true
    } finally {
      // read no further (an interrupt, a consumer that stopped): close what is beneath
      if (!finished) await it.return(undefined as never)
    }
    const r = step.value
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
      await dropNow($, id)
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
      await setNow($, MAIN, { what: 'idle', detail: '', since: now })
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
        via: e.workflow ? 'workflow' : e.isTeammate ? 'teammate' : e.fork ? 'fork' : 'Agent tool',
      }
      await update($, agentsAtom, list => [...list.filter(a => a.id !== agent.id), agent].slice(-MAX_AGENTS))
      await setNow($, agent.id, { what: 'starting', detail: '', since: now })
      if (!e.parentAgentId) await bumpTurn($, t => ({ ...t, agents: t.agents + 1 }))
      const parent = e.parentAgentId ? loopLabel(e.parentAgentId, await read($, agentsAtom)) : 'main'
      await pushEvent($, now, `▶ ${parent} → ${agent.type} (${shortModel(agent.model)}): ${cut(agent.description, 44)}`, 'info')
    }
    return r
  })

  // --- tools ---------------------------------------------------------------

  on('tool.call', async ($, e, next) => {
    const started = await $.clock.now()
    const tool = String(e.tool)
    const id = e.tool_use_id
    const agentId = e.agentId
    const input = e as unknown as Record<string, unknown>
    const detail = detailOf(input)
    const loop = agentId ?? MAIN
    if (agentId) await ensureAgent($, agentId, true)
    await update($, activeAtom, list => [...list, { id, tool, agentId, startedAt: started, detail }].slice(-MAX_ACTIVE))
    await setNow($, loop, { what: 'tool', detail: `${toolLabel(tool)}${detail ? `: ${detail}` : ''}`, since: started })
    if (!agentId) await update($, mainAtom, m => ({ ...m, phase: 'tool' as const }))
    const skillName = tool === 'Skill' && typeof input.skill === 'string' ? input.skill : undefined
    if (skillName) pendingSkills.set(skillName, started)
    let isError = false
    try {
      const r = await next(e)
      isError = r.deny !== undefined || r.isError === true
      if (!isError) {
        try {
          await noteFileChanges($, tool, input, r.result, loop)
        } catch {
          // a result of an unexpected shape counts no lines
        }
      }
      if (skillName) {
        const res = (r.result ?? {}) as Record<string, unknown>
        const forked = res.status === 'forked' && typeof res.agentId === 'string' ? res.agentId : undefined
        const at = await $.clock.now()
        const source = pendingSource.get(skillName)
        pendingSource.delete(skillName)
        await pushSkill($, {
          at: started,
          name: typeof res.commandName === 'string' && res.commandName ? res.commandName : skillName,
          loop,
          mode: forked ? 'forked' : 'inline',
          args: typeof input.args === 'string' && input.args ? cut(oneLine(input.args), 120) : undefined,
          agentId: forked,
          source: source?.source,
          plugin: source?.plugin,
          ok: !isError && res.success !== false,
          ms: at - started,
        })
        if (forked) {
          await ensureAgent($, forked, true, `skill:${skillName}`)
          await update($, agentsAtom, list => list.map(a => (a.id === forked ? { ...a, via: `skill:${skillName}`, parentId: a.parentId ?? agentId, type: a.type === 'agent' ? `skill:${skillName}` : a.type } : a)))
        } else if (!isError) {
          await setNow($, loop, { what: 'thinking', detail: '', since: at, skill: skillName })
        }
        await pushEvent($, at, `★ ${loop === MAIN ? 'main' : loopLabel(loop, await read($, agentsAtom))} loaded skill ${skillName}${forked ? ' (forked)' : ''}`, isError ? 'error' : 'info')
      }
      return r
    } catch (err) {
      isError = true
      throw err
    } finally {
      if (skillName) pendingSkills.delete(skillName)
      const now = await $.clock.now()
      const ms = now - started
      await update($, activeAtom, list => list.filter(a => a.id !== id))
      const stillRunning = (await read($, activeAtom)).some(a => (a.agentId ?? MAIN) === loop)
      if (!stillRunning) await setNow($, loop, { what: 'thinking', detail: '', since: now })
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

  // --- skills ------------------------------------------------------------------

  on('skill.prompt', async ($, e, next) => {
    const r = await next(e)
    try {
      const info = { source: String(e.source), plugin: e.pluginName }
      if (pendingSkills.has(e.skill)) {
        pendingSource.set(e.skill, info)
      } else {
        const at = await $.clock.now()
        await pushSkill($, { at, name: e.skill, loop: MAIN, mode: 'command', source: info.source, plugin: info.plugin, ok: true })
        await setNow($, MAIN, { what: 'thinking', detail: '', since: at, skill: e.skill })
        await pushEvent($, at, `★ skill ${e.skill} loaded (${info.plugin ? `plugin ${info.plugin}` : info.source})`, 'info')
      }
    } catch {
      // the skill's text goes through whatever the bookkeeping does
    }
    return r
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
    const t: ChartTable = e.surface === 'terminal' ? { Box, Text } : { Box, Text, Svg: $.ui.resolve(e).Svg }
    const now = await $.clock.now()
    const [main, usage, agents, ctx, tools, active, steps, events, view, turns, time, files, skills, nowMap] = await Promise.all([
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
      read($, filesAtom),
      read($, skillsAtom),
      read($, nowAtom),
    ])
    let home = ''
    try {
      home = (await $.env.get('HOME')) ?? ''
    } catch {
      home = ''
    }
    const isLive = (a: DashAgent) => !isDoneStatus(a.status) && a.endedAt === undefined
    const filesOf = (loop: string) => Object.values(files).filter(f => f.loops.includes(loop))

    const W = clamp(e.props.bodyColumns ?? e.viewport?.columns ?? 80, 36, 160)
    const inner = W - 4
    const LABEL = 9
    const BAR = clamp(inner - LABEL - 26, 8, 36)
    const mode = view.chart
    const blocks: RenderNode[] = []

    const section = (title: string, right: string | undefined, children: RenderNode[]) =>
      blocks.push(
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Text bold color="claude">
              {title}
            </Text>
            <Text dimColor wrap="truncate-start">
              {right ?? ''}
            </Text>
          </Box>
          {children}
        </Box>,
      )
    const dimLine = (s: string): RenderNode => (
      <Text dimColor wrap="truncate-end">
        {cut(s, inner)}
      </Text>
    )
    const labelRow = (label: string, value: RenderNode): RenderNode => (
      <Box flexDirection="row" gap={1}>
        <Box width={LABEL}>
          <Text dimColor>{pad(label, LABEL)}</Text>
        </Box>
        <Box flexGrow={1}>{value}</Box>
      </Box>
    )
    const subTitle = (s: string): RenderNode => (
      <Text bold dimColor>
        {s}
      </Text>
    )
    const opts = (center?: string, note?: string): ChartOptions => ({ width: inner, dark: view.dark, center, note })

    // ---- 1. header ------------------------------------------------------
    const uptime = main.startedAt ? fmtMs(now - main.startedAt) : '—'
    const phase =
      main.phase === 'idle'
        ? { glyph: '○', text: 'idle', color: 'subtle' }
        : main.phase === 'tool'
          ? { glyph: '◆', text: `tools${active.length ? ` (${active.length})` : ''}`, color: 'warning' }
          : { glyph: '●', text: 'thinking', color: 'claude' }
    const inTurn = main.phase !== 'idle' && main.turnStartedAt ? ` ${fmtMs(now - main.turnStartedAt)}` : ''
    const effort = main.effort ? ` · effort ${main.effort}` : ''
    const stepInfo = main.phase !== 'idle' ? ` · step ${String(main.stepIndex + 1)} · ${String(main.messageCount)} msgs` : ''
    const headerRows: RenderNode[] = [
      labelRow(
        'status',
        <Text wrap="truncate-end">
          <Text color={phase.color} bold>
            {phase.glyph} {phase.text}
            {inTurn}
          </Text>
          <Text dimColor>
            {'  '}turns {String(main.turns)} · up {uptime}
          </Text>
        </Text>,
      ),
      labelRow(
        'model',
        <Text wrap="truncate-end">
          <Text bold color="claude">
            {shortModel(main.model || main.sessionModel)}
          </Text>
          <Text dimColor>
            {main.model && main.sessionModel && main.model !== main.sessionModel ? ` (session: ${shortModel(main.sessionModel)})` : ''}
            {effort}
            {stepInfo}
          </Text>
        </Text>,
      ),
    ]
    if (main.title) headerRows.push(labelRow('task', <Text wrap="truncate-end">{cut(main.title, inner - LABEL - 1)}</Text>))
    headerRows.push(
      labelRow(
        'where',
        <Text dimColor wrap="truncate-end">
          {`${main.repo ?? cut(main.cwd, 40)}${main.branch ? ` @ ${main.branch}` : ''}${main.sessionId ? ` · ${main.sessionId.slice(0, 8)}` : ''}`}
        </Text>,
      ),
    )
    if (main.lastTurnMs !== undefined) {
      const lu = main.lastTurnUsage
      headerRows.push(
        labelRow(
          'last turn',
          <Text dimColor wrap="truncate-end">
            {`${fmtMs(main.lastTurnMs)}${lu ? ` · in ${fmtTok(inputOf(lu))} out ${fmtTok(lu.output)} · ${String(lu.calls)} calls` : ''}${main.lastTurnCostUsd !== undefined ? ` · +${fmtUsd(main.lastTurnCostUsd)}` : ''}`}
          </Text>,
        ),
      )
    }
    section('ACTIVITY', `chart: ${mode}`, headerRows)

    // ---- 1b. now: one row per live loop ------------------------------------
    {
      const live = agents.filter(isLive)
      const loops = [MAIN, ...live.map(a => a.id)]
      const nowRows = loops.map(loop => {
        const a = loop === MAIN ? undefined : agents.find(x => x.id === loop)
        const d = describeNow(loop, nowMap[loop], active, agents, now, isLive)
        const isIdle = loop === MAIN && main.phase === 'idle' && !active.some(x => !x.agentId)
        const sg = statusGlyph(a?.status ?? 'running')
        const glyph = loop === MAIN ? phase : { glyph: sg.glyph, color: sg.color }
        let depth = 0
        let p = a?.parentId
        while (p && depth < 6) {
          depth += 1
          p = agents.find(x => x.id === p)?.parentId
        }
        const who = loop === MAIN ? 'main' : `${'  '.repeat(depth)}↳ ${agentLabel(a)}`
        const skill = nowMap[loop]?.skill
        const since = isIdle ? (time.idleSince !== undefined ? sinceText(time.idleSince, now) : '') : sinceText(d.since, now)
        const text = isIdle ? 'idle · waiting for you' : d.text
        return (
          <Box flexDirection="row" gap={1}>
            <Box width={1}>
              <Text color={glyph.color}>{glyph.glyph}</Text>
            </Box>
            <Box width={20}>
              <Text bold={loop === MAIN} wrap="truncate-end">
                {cut(who, 20)}
              </Text>
            </Box>
            <Box width={9}>
              <Text dimColor wrap="truncate-end">
                {cut(shortModel(loop === MAIN ? main.model || main.sessionModel : a?.model), 9)}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end">
                {skill ? <Text color="planMode">{`★ ${cut(skill, 24)} · `}</Text> : ''}
                <Text color={isIdle ? 'subtle' : 'text'}>{text}</Text>
              </Text>
            </Box>
            <Box width={7} justifyContent="flex-end">
              <Text dimColor>{since}</Text>
            </Box>
          </Box>
        )
      })
      section('NOW', `${String(loops.length)} loop${loops.length === 1 ? '' : 's'} · ${fmtClock(now)}`, nowRows)
    }

    // ---- 2. time ----------------------------------------------------------
    if (view.showTime) {
      const wall = Math.max(1, now - (main.startedAt || now))
      const waiting = time.waitMs + (time.idleSince !== undefined ? Math.max(0, now - time.idleSince) : 0)
      const fgAgents = agents.filter(a => !a.background && !a.parentId).reduce((n, a) => n + ((a.endedAt ?? now) - a.startedAt), 0)
      const bgAgents = agents.filter(a => a.background && !a.parentId).reduce((n, a) => n + ((a.endedAt ?? now) - a.startedAt), 0)
      const other = Math.max(0, wall - time.modelMs - time.toolMs - waiting - fgAgents)
      const activeMs = turns.reduce((n, x) => n + (x.ms ?? now - x.startedAt), 0)
      const slices: Slice[] = [
        { label: 'model', value: time.modelMs, text: fmtMs(time.modelMs), slot: 0 },
        { label: 'tools', value: time.toolMs, text: fmtMs(time.toolMs), slot: 1 },
        { label: 'agents', value: fgAgents, text: fmtMs(fgAgents), slot: 2 },
        { label: 'waiting', value: waiting, text: fmtMs(waiting), slot: 3 },
        { label: 'other', value: other, text: fmtMs(other), slot: 6 },
      ]
      const done = turns.filter(x => x.ms !== undefined)
      const longest = done.reduce<DashTurn | undefined>((b, x) => ((x.ms ?? 0) > (b?.ms ?? -1) ? x : b), undefined)
      const avg = done.length ? done.reduce((n, x) => n + (x.ms ?? 0), 0) / done.length : 0
      section('TIME', `wall ${fmtMs(wall)} · active ${fmtMs(activeMs)}`, [
        shareChart(t, mode, slices, wall, opts(fmtMs(wall), bgAgents > 0 ? `background agents ${fmtMs(bgAgents)} ran alongside the above` : undefined)),
        dimLine(`${String(turns.length)} turns · avg ${fmtMs(avg)}${longest ? ` · longest #${String(longest.index)} ${fmtMs(longest.ms ?? 0)}: ${cut(longest.prompt, 36)}` : ''}`),
      ])
    }

    // ---- 3. context, limits, cost ---------------------------------------
    {
      const rows: RenderNode[] = []
      const palette = paletteOf(view.dark)
      if (ctx.window > 0) {
        const p = ctx.percent ?? (ctx.tokens !== undefined ? (ctx.tokens / ctx.window) * 100 : 0)
        rows.push(meterRow(t, 'window', p / 100, pctColor(p), `${padL(`${Math.round(p)}%`, 4)}  ${fmtTok(ctx.tokens ?? 0)} / ${fmtTok(ctx.window)}`, LABEL, BAR))
        const extra: string[] = []
        if (ctx.autoCompactThreshold !== undefined) {
          extra.push(`autocompact at ${ctx.autoCompactThreshold <= 100 ? `${String(ctx.autoCompactThreshold)}%` : fmtTok(ctx.autoCompactThreshold)}`)
        }
        if (ctx.maxPercent !== undefined && ctx.maxPercent > 0) extra.push(`peak ${String(Math.round(ctx.maxPercent))}%`)
        if (ctx.compactions > 0) {
          const lc = ctx.lastCompaction
          extra.push(`compactions ${String(ctx.compactions)}${lc && lc.before !== undefined && lc.after !== undefined ? ` (last ${fmtTok(lc.before)} → ${fmtTok(lc.after)})` : ''}`)
        }
        if (extra.length) rows.push(dimLine(`${pad('', LABEL)} ${extra.join(' · ')}`))
        if (ctx.breakdown && ctx.breakdown.length) {
          const used = ctx.breakdown.filter(r => r.kind === 'used' && r.tokens > 0).sort((a, b) => b.tokens - a.tokens)
          const max = ctx.breakdownMax || Math.max(1, ...used.map(r => r.tokens))
          rows.push(subTitle('what fills it'))
          rows.push(
            shareChart(
              t,
              mode === 'bars' ? 'bars' : 'stacked',
              used.map((r, i) => ({ label: r.name.toLowerCase(), value: r.tokens, text: fmtTok(r.tokens), slot: i })),
              max,
              { width: inner, dark: view.dark, maxRows: 8 },
            ),
          )
        }
      } else {
        rows.push(dimLine('waiting for the first measurement…'))
      }
      for (const r of ctx.rateLimits) {
        const label = r.kind === 'five_hour' ? 'limit 5h' : r.kind === 'seven_day' ? 'limit 7d' : cut(r.kind, LABEL)
        rows.push(meterRow(t, label, r.percentUsed / 100, pctColor(r.percentUsed), `${padL(`${String(r.percentUsed)}%`, 5)}  ${untilIso(r.resetsAt, now)}`, LABEL, BAR))
      }
      if (ctx.costUsd !== undefined) {
        rows.push(
          labelRow(
            'cost',
            <Text wrap="truncate-end">
              <Text bold>{fmtUsd(ctx.costUsd)}</Text>
              <Text dimColor>
                {main.lastTurnCostUsd !== undefined ? `  (+${fmtUsd(main.lastTurnCostUsd)} last turn)` : ''}
                {main.turns > 0 ? `  ~${fmtUsd(ctx.costUsd / main.turns)}/turn` : ''}
              </Text>
            </Text>,
          ),
        )
      }
      void palette
      section('CONTEXT & COST', ctx.measuredAt ? `measured ${fmtClock(ctx.measuredAt)}` : undefined, rows)
    }

    // ---- 4. tokens --------------------------------------------------------
    {
      const models = Object.entries(usage).sort((a, b) => total(b[1]) - total(a[1]))
      const grand = models.reduce((acc, [, u]) => addUsageInto(acc, u), emptyUsage())
      const rows: RenderNode[] = []
      if (grand.calls === 0) rows.push(dimLine('no model calls yet'))
      else {
        const slices: Slice[] = [
          { label: 'input (uncached)', value: grand.input, text: fmtTok(grand.input), slot: 1 },
          { label: 'cache read', value: grand.cacheRead, text: fmtTok(grand.cacheRead), slot: 2 },
          { label: 'cache write', value: grand.cacheWrite, text: fmtTok(grand.cacheWrite), slot: 6 },
          { label: 'output', value: grand.output, text: fmtTok(grand.output), slot: 0 },
        ]
        rows.push(shareChart(t, mode, slices, total(grand), opts(fmtTok(total(grand)))))
        rows.push(dimLine(`${String(grand.calls)} calls · cache hit ${String(Math.round(cacheHit(grand)))}% · out/in ${pct(grand.output, Math.max(1, inputOf(grand))).toFixed(1)}%`))
        if (view.showModels && models.length) {
          const slotOf = slotsByName(models.map(([n]) => shortModel(n)))
          rows.push(subTitle('by model'))
          rows.push(
            shareChart(
              t,
              mode,
              models.map(([name, u]) => ({ label: shortModel(name), value: total(u), text: `${fmtTok(total(u))} · ${String(u.calls)}×`, slot: slotOf.get(shortModel(name)) ?? 7 })),
              total(grand),
              opts(fmtTok(total(grand)), models.map(([name, u]) => `${shortModel(name)} hit ${String(Math.round(cacheHit(u)))}%`).join(' · ')),
            ),
          )
        }
      }
      section('TOKENS', grand.calls ? `${fmtTok(total(grand))} total` : undefined, rows)
    }

    // ---- 5. orchestration -------------------------------------------------
    {
      const rows: RenderNode[] = []
      const mainActive = active.filter(a => !a.agentId)
      rows.push(
        <Text wrap="truncate-end">
          <Text color={phase.color}>{phase.glyph}</Text> <Text bold>main</Text>
          <Text dimColor>
            {'  '}
            {shortModel(main.model || main.sessionModel)}
            {main.effort ? ` · ${main.effort}` : ''}
            {nowMap[MAIN]?.skill ? ` · ${skillBadge(nowMap[MAIN]?.skill)}` : ''}
            {filesOf(MAIN).length ? ` · ${String(filesOf(MAIN).length)} files` : ''}
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
          const running = active.filter(x => x.agentId === a.id)
          rows.push(
            <Text wrap="truncate-end">
              <Text dimColor>{branch}</Text>
              <Text color={g.color}>{g.glyph}</Text> <Text bold={!isDoneStatus(a.status)}>{cut(a.name ? `${a.type} "${a.name}"` : a.type, 28)}</Text>
              <Text dimColor>
                {'  '}
                {shortModel(a.model)} · {elapsed} · {fmtTok(total(a.usage))} tok · {String(a.toolCalls)} tools
                {filesOf(a.id).length ? ` · ${String(filesOf(a.id).length)} files` : ''}
                {a.via && a.via !== 'Agent tool' ? ` · via ${a.via}` : ''}
                {a.background ? ' · bg' : ''}
              </Text>
            </Text>,
          )
          if (isLive(a)) {
            const d = describeNow(a.id, nowMap[a.id], running.length ? running : active, agents, now, isLive)
            const sk = nowMap[a.id]?.skill
            rows.push(
              <Text wrap="truncate-end">
                <Text dimColor>{`${prefix}${last ? '   ' : '│  '}  `}</Text>
                <Text color="claude">now </Text>
                {sk ? <Text color="planMode">{`★ ${cut(sk, 20)} · `}</Text> : ''}
                <Text>{cut(d.text, Math.max(10, inner - prefix.length - 16))}</Text>
                <Text dimColor>{d.since !== undefined ? ` · ${sinceText(d.since, now)}` : ''}</Text>
              </Text>,
            )
          }
          if (a.description) {
            rows.push(
              <Text wrap="truncate-end" dimColor>
                {`${prefix}${last ? '   ' : '│  '}  ${cut(a.description, Math.max(10, inner - prefix.length - 6))}`}
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
          const x = byType.get(a.type) ?? { count: 0, tokens: 0, live: 0, ms: 0 }
          x.count += 1
          x.tokens += total(a.usage)
          x.live += isDoneStatus(a.status) ? 0 : 1
          x.ms += (a.endedAt ?? now) - a.startedAt
          byType.set(a.type, x)
        }
        const slotOf = slotsByName([...byType.keys()])
        const sum = [...byType.values()].reduce((n, x) => n + x.tokens, 0)
        rows.push(subTitle('by agent type (tokens)'))
        rows.push(
          shareChart(
            t,
            mode,
            [...byType.entries()].sort((a, b) => b[1].tokens - a[1].tokens).map(([type, x]) => ({ label: type, value: x.tokens, text: `${fmtTok(x.tokens)} · ×${String(x.count)}${x.live ? ` (${String(x.live)} live)` : ''}`, slot: slotOf.get(type) ?? 7 })),
            sum,
            opts(fmtTok(sum), [...byType.entries()].map(([type, x]) => `${type} avg ${fmtMs(x.ms / x.count)}`).join(' · ')),
          ),
        )
      } else rows.push(dimLine('no subagents spawned yet'))
      section('ORCHESTRATION', agents.length ? `${String(agents.filter(a => !isDoneStatus(a.status)).length)} live / ${String(agents.length)}` : undefined, rows)
    }

    // ---- 5b. skills ---------------------------------------------------------
    if (view.showSkills !== false && skills.length) {
      const counts = new Map<string, number>()
      for (const sk of skills) counts.set(sk.name, (counts.get(sk.name) ?? 0) + 1)
      const rowsSk: RenderNode[] = skills.slice(-8).map(sk => (
        <Box flexDirection="row" gap={1}>
          <Box width={8}>
            <Text dimColor>{fmtClock(sk.at)}</Text>
          </Box>
          <Box width={1}>
            <Text color={sk.ok ? 'planMode' : 'error'}>{sk.ok ? '★' : '✗'}</Text>
          </Box>
          <Box width={24}>
            <Text bold wrap="truncate-end">
              {cut(sk.name, 24)}
            </Text>
          </Box>
          <Box width={16}>
            <Text dimColor wrap="truncate-end">
              {cut(loopLabel(sk.loop, agents), 16)}
            </Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor wrap="truncate-end">
              {`${sk.mode}${sk.plugin ? ` · plugin ${sk.plugin}` : sk.source ? ` · ${sk.source}` : ''}${sk.ms !== undefined ? ` · ${fmtMs(sk.ms)}` : ''}${sk.args ? ` · ${sk.args}` : ''}`}
            </Text>
          </Box>
        </Box>
      ))
      rowsSk.push(dimLine([...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ×${String(c)}`).join(' · ')))
      section('SKILLS', `${String(skills.length)} loads · ${String(counts.size)} skills`, rowsSk)
    }

    // ---- 5c. files changed -------------------------------------------------
    if (view.showFiles !== false && Object.keys(files).length) {
      const list = Object.values(files).sort((a, b) => b.lastAt - a.lastAt)
      const totalAdd = list.reduce((n, f) => n + f.added, 0)
      const totalDel = list.reduce((n, f) => n + f.removed, 0)
      const pathW = clamp(inner - 48, 14, 60)
      const mini = 8
      const rowsF: RenderNode[] = [
        <Box flexDirection="row" gap={1}>
          <Box width={pathW}>
            <Text dimColor>file</Text>
          </Box>
          <Box width={6} justifyContent="flex-end">
            <Text dimColor>+</Text>
          </Box>
          <Box width={6} justifyContent="flex-end">
            <Text dimColor>−</Text>
          </Box>
          <Box width={mini}>
            <Text dimColor>diff</Text>
          </Box>
          <Box width={7} justifyContent="flex-end">
            <Text dimColor>of file</Text>
          </Box>
          <Box flexGrow={1}>
            <Text dimColor>edits · by</Text>
          </Box>
        </Box>,
        ...list.slice(0, 12).map(f => {
          const tot = Math.max(1, f.added + f.removed)
          const plus = f.added ? clamp(Math.round((f.added / tot) * mini), 1, mini) : 0
          const minus = f.removed ? clamp(mini - plus, 1, mini) : 0
          const by = f.loops.map(l => loopLabel(l, agents)).join(', ')
          return (
            <Box flexDirection="row" gap={1}>
              <Box width={pathW}>
                <Text wrap="truncate-start">{relPath(f.path, main.cwd, home)}</Text>
              </Box>
              <Box width={6} justifyContent="flex-end">
                <Text color="success">{`+${String(f.added)}`}</Text>
              </Box>
              <Box width={6} justifyContent="flex-end">
                <Text color="error">{`−${String(f.removed)}`}</Text>
              </Box>
              <Box width={mini}>
                <Text>
                  <Text color="success">{'■'.repeat(plus)}</Text>
                  <Text color="error">{'■'.repeat(Math.min(minus, mini - plus))}</Text>
                  <Text dimColor>{'·'.repeat(Math.max(0, mini - plus - minus))}</Text>
                </Text>
              </Box>
              <Box width={7} justifyContent="flex-end">
                <Text dimColor>{fmtFilePct(f)}</Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text dimColor wrap="truncate-end">
                  {`${String(f.edits)}× · ${by} · ${fmtClock(f.lastAt)}`}
                </Text>
              </Box>
            </Box>
          )
        }),
      ]
      if (list.length > 12) rowsF.push(dimLine(`+${String(list.length - 12)} more files`))
      rowsF.push(dimLine('of file: changed lines, max of + and −, over the file lines before the first change'))
      section('FILES CHANGED', `${String(list.length)} files · +${String(totalAdd)} −${String(totalDel)}`, rowsF)
    }

    // ---- 6. active tool calls -------------------------------------------
    if (active.length) {
      section(
        `ACTIVE TOOLS`,
        String(active.length),
        active.slice(-8).map(x => {
          const who = x.agentId ? agents.find(a => a.id === x.agentId)?.type ?? 'agent' : 'main'
          return (
            <Box flexDirection="row" gap={1}>
              <Box width={1}>
                <Text color="warning">◆</Text>
              </Box>
              <Box width={20}>
                <Text bold wrap="truncate-end">
                  {cut(toolLabel(x.tool), 20)}
                </Text>
              </Box>
              <Box width={7} justifyContent="flex-end">
                <Text dimColor>{padL(fmtMs(now - x.startedAt), 7)}</Text>
              </Box>
              <Box flexGrow={1}>
                <Text dimColor wrap="truncate-end">
                  {`${cut(who, 14)}${x.detail ? ` · ${x.detail}` : ''}`}
                </Text>
              </Box>
            </Box>
          )
        }),
      )
    }

    // ---- 7. tools ---------------------------------------------------------
    if (view.showTools) {
      const list = Object.values(tools).sort((a, b) => b.calls - a.calls)
      const calls = list.reduce((n, x) => n + x.calls, 0)
      const errors = list.reduce((n, x) => n + x.errors, 0)
      const slotOf = slotsByName(list.map(x => toolLabel(x.name)))
      section('TOOLS', list.length ? `${String(calls)} calls · ${fmtMs(list.reduce((n, x) => n + x.totalMs, 0))}${errors ? ` · ${String(errors)} failed` : ''}` : undefined, [
        list.length
          ? shareChart(
              t,
              mode,
              list.map(x => ({ label: toolLabel(x.name), value: x.calls, text: `${String(x.calls)}×${x.errors ? ` ✗${String(x.errors)}` : ''} · ${fmtMs(x.totalMs / x.calls)}`, slot: slotOf.get(toolLabel(x.name)) ?? 7 })),
              calls,
              { ...opts(String(calls)), maxRows: 8 },
            )
          : dimLine('no tool calls yet'),
      ])
    }

    // ---- 8. recent model calls ------------------------------------------
    if (view.showSteps && steps.length) {
      const recent = steps.slice(-8)
      const maxIn = Math.max(1, ...recent.map(s => s.input + s.cacheRead + s.cacheWrite))
      const maxOut = Math.max(1, ...recent.map(s => s.output))
      const half = clamp(Math.floor((inner - 44) / 2), 4, 16)
      const palette = paletteOf(view.dark)
      section('RECENT MODEL CALLS', 'in ■ out ■', [
        <Box flexDirection="row" gap={1}>
          <Box width={8}>
            <Text dimColor>time</Text>
          </Box>
          <Box width={10}>
            <Text dimColor>model</Text>
          </Box>
          <Box width={half}>
            <Text color={palette[2]}>in</Text>
          </Box>
          <Box width={half}>
            <Text color={palette[0]}>out</Text>
          </Box>
          <Box flexGrow={1}>
            <Text dimColor>in/out · time · who</Text>
          </Box>
        </Box>,
        ...recent.map(s => {
          const inp = s.input + s.cacheRead + s.cacheWrite
          const who = s.agentId ? agents.find(a => a.id === s.agentId)?.type ?? 'agent' : 'main'
          return (
            <Box flexDirection="row" gap={1}>
              <Box width={8}>
                <Text dimColor>{fmtClock(s.at)}</Text>
              </Box>
              <Box width={10}>
                <Text wrap="truncate-end">{cut(shortModel(s.model), 10)}</Text>
              </Box>
              <Box width={half}>{textBar(t, inp / maxIn, half, palette[2] ?? 'success')}</Box>
              <Box width={half}>{textBar(t, s.output / maxOut, half, palette[0] ?? 'claude')}</Box>
              <Box flexGrow={1}>
                <Text dimColor wrap="truncate-end">
                  {`${fmtTok(inp)}/${fmtTok(s.output)} · ${fmtMs(s.ms)} · ${cut(who, 12)}${s.stopReason && s.stopReason !== 'end_turn' && s.stopReason !== 'tool_use' ? ` · ${s.stopReason}` : ''}`}
                </Text>
              </Box>
            </Box>
          )
        }),
      ])
    }

    // ---- 9. log -----------------------------------------------------------
    if (view.showLog) {
      section(
        'LOG',
        undefined,
        events.length
          ? events.slice(-8).map(ev => {
              const color = ev.kind === 'ok' ? 'success' : ev.kind === 'warn' ? 'warning' : ev.kind === 'error' ? 'error' : 'text'
              return (
                <Box flexDirection="row" gap={1}>
                  <Box width={8}>
                    <Text dimColor>{fmtClock(ev.at)}</Text>
                  </Box>
                  <Box flexGrow={1}>
                    <Text color={color} wrap="truncate-end">
                      {ev.text}
                    </Text>
                  </Box>
                </Box>
              )
            })
          : [dimLine('—')],
      )
    }

    // ---- 10. controls -----------------------------------------------------
    return (
      <Box flexDirection="column">
        {blocks}
        <Box flexDirection="row" gap={1} flexWrap="wrap" paddingX={1}>
          <Button key="chart" hotkey="c" plain variant="primary" onPress={() => void update($, viewAtom, v => ({ ...v, chart: nextChartMode(v.chart) }))}>
            c:chart {nextChartMode(mode)}
          </Button>
          <Button key="pdf" hotkey="p" plain onPress={() => void makeReport($, 'pdf', '').then(x => $.ui.toast(x))}>
            p:pdf report
          </Button>
          <Button key="breakdown" hotkey="b" plain onPress={() => void fetchBreakdown($)}>
            b:breakdown
          </Button>
          <Button key="time" hotkey="i" plain dimColor={!view.showTime} onPress={() => void toggleView($, 'showTime')}>
            i:time
          </Button>
          <Button key="files" hotkey="f" plain dimColor={view.showFiles === false} onPress={() => void toggleView($, 'showFiles')}>
            f:files
          </Button>
          <Button key="skills" hotkey="k" plain dimColor={view.showSkills === false} onPress={() => void toggleView($, 'showSkills')}>
            k:skills
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
