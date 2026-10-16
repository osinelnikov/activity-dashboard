import { expect, mock, test } from 'claude-code/testing'

import type { DashActiveTool, DashAgent, DashFile, DashNow, DashSkill, DashTool, DashTurn } from '../types'
import { countHunks, describeNow, extractChanges, fmtFilePct, lineCount, mergeFile, relPath } from '../hooks/activity'
import { buildRecord, chatSummary, parseRecord, recordToHtml, recordToMarkdown } from '../hooks/report'
import type { Snapshot } from '../hooks/report'
import { expandPath, isPathLike, labelPath, parseReportArgs } from '../hooks/paths'

const PANE_PROPS = {
  title: 'Activity',
  isFocused: false,
  bodyColumns: 90,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 60 },
  view: {},
} as const

test('a tool call is counted once it settles', async ($, on) => {
  mock.clock(on)
  let tools: Record<string, DashTool> | undefined
  let active: DashActiveTool[] | undefined
  on('state.set', { plugin: 'activity-dashboard', key: 'tools' }, ($, e, next) => {
    tools = e.value as Record<string, DashTool>
    return next(e)
  })
  on('state.set', { plugin: 'activity-dashboard', key: 'active' }, ($, e, next) => {
    active = e.value as DashActiveTool[]
    return next(e)
  })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await $.tool.call({ tool: 'Bash', command: 'true' })
  expect(tools?.Bash?.calls).toBe(1)
  expect(tools?.Bash?.errors).toBe(0)
  expect(active?.length ?? 0).toBe(0)
})

test('the pane draws its sections on every surface', async ($, on) => {
  mock.clock(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'activity-dashboard',
      surface,
      component: 'Pane',
      requestId: 'activity-dashboard',
      props: PANE_PROPS,
    })
    expect(await ui.find({ type: 'Text', text: /TIME/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /CONTEXT/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ORCHESTRATION/ })).toBeDefined()
    expect(await ui.find({ key: 'pdf' })).toBeDefined()
    await ui.unmount()
  }
})

const sample = (): Snapshot => {
  const turns: DashTurn[] = [
    { index: 1, turnId: 't1', startedAt: 1_000, endedAt: 61_000, ms: 60_000, prompt: 'fix the invoice total', usage: { input: 1000, output: 500, cacheRead: 9000, cacheWrite: 200, calls: 3 }, toolCalls: 4, agents: 1, modelMs: 20_000, toolMs: 30_000, costDelta: 0.12, reason: 'answer' },
    { index: 2, turnId: 't2', startedAt: 90_000, endedAt: 120_000, ms: 30_000, prompt: 'now add a test', usage: { input: 400, output: 300, cacheRead: 12_000, cacheWrite: 0, calls: 2 }, toolCalls: 2, agents: 0, modelMs: 15_000, toolMs: 5_000, costDelta: 0.05, reason: 'answer' },
  ]
  return {
    main: { phase: 'idle', sessionId: 'abcdef1234567890', cwd: '/work/app', repo: 'app', branch: 'main', title: 'fix the invoice total', titleIsManual: false, sessionModel: 'claude-opus-5-5', model: 'claude-opus-5-5', stepIndex: 0, messageCount: 10, startedAt: 1_000, turns: 2 },
    usage: { 'claude-opus-5-5': { input: 1400, output: 800, cacheRead: 21_000, cacheWrite: 200, calls: 5 }, 'claude-haiku-5-5': { input: 300, output: 100, cacheRead: 0, cacheWrite: 0, calls: 1 } },
    agents: [{ id: 'a1', type: 'explorer', description: 'find callers', model: 'claude-haiku-5-5', status: 'completed', background: false, startedAt: 5_000, endedAt: 25_000, usage: { input: 300, output: 100, cacheRead: 0, cacheWrite: 0, calls: 1 }, steps: 1, toolCalls: 3 }],
    ctx: { window: 200_000, percent: 42, maxPercent: 55, costUsd: 0.17, rateLimits: [], compactions: 1 },
    tools: { Bash: { name: 'Bash', calls: 4, errors: 1, totalMs: 25_000 }, Read: { name: 'Read', calls: 2, errors: 0, totalMs: 10_000 } },
    turns,
    time: { modelMs: 35_000, toolMs: 35_000, agentMs: 20_000, waitMs: 29_000 },
    events: [{ at: 1_000, text: 'turn: fix the invoice total', kind: 'info' }],
    now: 120_000,
  }
}

test('a session record round-trips and renders in every format', async () => {
  const rec = buildRecord(sample())
  expect(rec.wallMs).toBe(119_000)
  expect(rec.activeMs).toBe(90_000)
  expect(rec.totals.calls).toBe(6)
  expect(rec.totals.cacheRead).toBe(21_000)
  const back = parseRecord(JSON.stringify(rec))
  expect(back?.id).toBe('abcdef1234567890')
  expect(back?.turns.length).toBe(2)
  expect(parseRecord('{"nope":1}')).toBeUndefined()

  const md = recordToMarkdown(rec)
  expect(md).toContain('# Activity report: fix the invoice total')
  expect(md).toContain('## Time')
  expect(md).toContain('waiting for you')
  expect(md).toContain('explorer')
  expect(md).toContain('now add a test')

  const html = recordToHtml(rec)
  expect(html).toContain('<h1>fix the invoice total</h1>')
  expect(html).toContain('Where the time went')
  expect(html).toContain('opus 5.5')

  const chat = chatSummary(rec)
  expect(chat).toContain('**TIME**')
  expect(chat).toContain('**COST** $0.170')
  expect(chat).toContain('LONGEST TURN')
})

test('report arguments and paths are parsed', async () => {
  expect(parseReportArgs(['pdf', 'all', '~/Desktop'])).toEqual({ kind: 'pdf', target: 'all', dir: '~/Desktop' })
  expect(parseReportArgs(['md', 'abcd1234'])).toEqual({ kind: 'md', target: 'abcd1234' })
  expect(parseReportArgs(['./out/'])).toEqual({ kind: 'md', target: '', dir: './out/' })
  expect(isPathLike('abcd1234')).toBe(false)
  expect(expandPath('~/Desktop', '/Users/me', '/work')).toBe('/Users/me/Desktop')
  expect(expandPath('reports', '/Users/me', '/work')).toBe('/work/reports')
  expect(expandPath('/tmp/x/', '/Users/me', '/work')).toBe('/tmp/x')
  expect(labelPath('/Users/me/.claude/activity-dashboard/reports', '/Users/me')).toBe('~/.claude/activity-dashboard/reports')
})

test('the chart button cycles the modes and draws SVG where the surface has it', async ($, on) => {
  mock.clock(on)
  const desktop = await $.ui.mount({ plugin: 'activity-dashboard', surface: 'desktop', component: 'Pane', requestId: 'activity-dashboard', props: PANE_PROPS })
  expect(await desktop.find({ type: 'Text', text: /chart: bars/ })).toBeDefined()
  await desktop.press({ key: 'chart' })
  expect(await desktop.find({ type: 'Text', text: /chart: stacked/ })).toBeDefined()
  await desktop.press({ key: 'chart' })
  expect(await desktop.find({ type: 'Text', text: /chart: donut/ })).toBeDefined()
  await desktop.press({ key: 'chart' })
  expect(await desktop.find({ type: 'Text', text: /chart: bars/ })).toBeDefined()
  await desktop.unmount()

  const terminal = await $.ui.mount({ plugin: 'activity-dashboard', surface: 'terminal', component: 'Pane', requestId: 'activity-dashboard', props: PANE_PROPS })
  await terminal.press({ key: 'chart' })
  await terminal.press({ key: 'chart' })
  expect(await terminal.find({ type: 'Text', text: /chart: donut/ })).toBeDefined()
  expect(await terminal.find({ type: 'Svg' })).toBeUndefined()
  await terminal.unmount()
})

// ---------------------------------------------------------------------------
// 0.3.0: file changes, skills, what each loop is doing
// ---------------------------------------------------------------------------

test('diff hunks, line counts and file shares are counted', async () => {
  expect(countHunks([{ lines: [' a', '-b', '+b2', '+b3', '\\ No newline at end of file'] }])).toEqual({ added: 2, removed: 1 })
  expect(lineCount('')).toBe(0)
  expect(lineCount('one')).toBe(1)
  expect(lineCount('one\ntwo\n')).toBe(2)

  const edit = extractChanges('Edit', { file_path: '/w/a.ts' }, {
    filePath: '/w/a.ts',
    originalFile: 'l1\nl2\nl3\nl4\n',
    structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' l1', '-l2', '+l2b', '+l2c'] }],
  })
  expect(edit).toEqual([{ path: '/w/a.ts', added: 2, removed: 1, baseLines: 4 }])
  expect(extractChanges('Edit', { file_path: '/w/a.ts' }, { filePath: '/w/a.ts', staged: true })).toEqual([])

  const created = extractChanges('Write', { file_path: '/w/new.md', content: 'x\ny\nz\n' }, { type: 'create', filePath: '/w/new.md', content: 'x\ny\nz\n', structuredPatch: [], originalFile: null })
  expect(created).toEqual([{ path: '/w/new.md', added: 3, removed: 0, baseLines: 0, created: true }])

  const bash = extractChanges('Bash', { command: 'sed -i ...' }, {
    stdout: '',
    bashEditDiff: { files: [{ filePath: '/w/b.ts', hunks: [{ lines: ['-old', '+new'] }] }, { filePath: '/w/gone.ts', hunks: [{ lines: ['-x', '-y'] }], deleted: true }], moreFiles: 0 },
  })
  expect(bash.map(c => [c.path, c.added, c.removed, c.deleted === true])).toEqual([['/w/b.ts', 1, 1, false], ['/w/gone.ts', 0, 2, true]])
  expect(extractChanges('Read', { file_path: '/w/a.ts' }, {})).toEqual([])

  const first = mergeFile(undefined, edit[0]!, 'main', 'Edit', 10)
  const second = mergeFile(first, { path: '/w/a.ts', added: 1, removed: 0 }, 'agent-1', 'Write', 20)
  expect(second.added).toBe(3)
  expect(second.removed).toBe(1)
  expect(second.edits).toBe(2)
  expect(second.baseLines).toBe(4)
  expect(second.lines).toBe(6)
  expect(second.loops).toEqual(['main', 'agent-1'])
  expect(second.tools).toEqual(['Edit', 'Write'])
  expect(fmtFilePct(second)).toBe('75%')
  expect(fmtFilePct(mergeFile(undefined, created[0]!, 'main', 'Write', 1))).toBe('new')
  expect(relPath('/w/src/a.ts', '/w', '/Users/me')).toBe('src/a.ts')
  expect(relPath('/Users/me/x.txt', '/w', '/Users/me')).toBe('~/x.txt')
})

test('what a loop is doing reads its tools first, then its stream', async () => {
  const agents: DashAgent[] = [
    { id: 'a1', type: 'explorer', description: 'find callers', model: 'claude-haiku-5-5', status: 'running', background: false, startedAt: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 }, steps: 0, toolCalls: 0 },
  ]
  const live = (a: DashAgent) => a.status === 'running'
  const waiting = describeNow('main', undefined, [{ tool: 'Agent', detail: 'find callers', startedAt: 5 }], agents, 10, live)
  expect(waiting).toEqual({ text: 'waiting for explorer', since: 5 })
  const bash = describeNow('a1', undefined, [{ tool: 'Bash', detail: 'run tests', startedAt: 7, agentId: 'a1' }, { tool: 'Read', detail: 'x', startedAt: 8, agentId: 'a1' }], agents, 10, live)
  expect(bash.text).toBe('Bash: run tests (+1 more)')
  const stream: DashNow = { what: 'preparing', detail: 'Edit', since: 9 }
  expect(describeNow('a1', stream, [], agents, 10, live).text).toBe('preparing Edit')
  expect(describeNow('main', { what: 'answering', detail: '', since: 9 }, [], agents, 10, live).text).toBe('writing the answer')
})

test('an Edit and a Skill are recorded and drawn', async ($, on) => {
  mock.clock(on)
  let files: Record<string, DashFile> | undefined
  let skills: DashSkill[] | undefined
  let now: Record<string, DashNow> | undefined
  on('state.set', { plugin: 'activity-dashboard', key: 'files' }, ($, e, next) => ((files = e.value as Record<string, DashFile>), next(e)))
  on('state.set', { plugin: 'activity-dashboard', key: 'skills' }, ($, e, next) => ((skills = e.value as DashSkill[]), next(e)))
  on('state.set', { plugin: 'activity-dashboard', key: 'now' }, ($, e, next) => ((now = e.value as Record<string, DashNow>), next(e)))
  on('tool.call', { tool: 'Edit' }, () => ({
    result: {
      filePath: '/w/src/a.ts',
      oldString: 'l2',
      newString: 'l2b\nl2c',
      originalFile: 'l1\nl2\nl3\nl4\n',
      structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' l1', '-l2', '+l2b', '+l2c'] }],
      userModified: false,
      replaceAll: false,
    },
  }))
  on('tool.call', { tool: 'Skill' }, () => ({ result: { success: true, commandName: 'engineering-task', status: 'inline' } }))

  await $.tool.call({ tool: 'Edit', file_path: '/w/src/a.ts', old_string: 'l2', new_string: 'l2b\nl2c' })
  expect(files?.['/w/src/a.ts']?.added).toBe(2)
  expect(files?.['/w/src/a.ts']?.removed).toBe(1)
  expect(files?.['/w/src/a.ts']?.loops).toEqual(['main'])

  await $.tool.call({ tool: 'Skill', skill: 'engineering-task' })
  expect(skills?.length).toBe(1)
  expect(skills?.[0]?.name).toBe('engineering-task')
  expect(skills?.[0]?.mode).toBe('inline')
  expect(now?.main?.skill).toBe('engineering-task')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'activity-dashboard', surface, component: 'Pane', requestId: 'activity-dashboard', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /^NOW$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /FILES CHANGED/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\+2$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^50%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^SKILLS$/ })).toBeDefined()
    expect(await ui.find({ key: 'files' })).toBeDefined()
    await ui.unmount()
  }
})

test('the turn.step stream passes through unchanged while the loop is marked', async ($, on) => {
  mock.clock(on)
  const whats: string[] = []
  on('state.set', { plugin: 'activity-dashboard', key: 'now' }, ($, e, next) => {
    const v = e.value as Record<string, DashNow>
    const m = v.main
    if (m) whats.push(m.what === 'preparing' ? `preparing ${m.detail}` : m.what)
    return next(e)
  })
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }
  on('turn.step', async function* () {
    yield { kind: 'thinking', index: 0, text: 'hmm' }
    yield { kind: 'text', index: 1, text: 'Hello' }
    yield { kind: 'text', index: 1, text: ' world' }
    yield { kind: 'tool', index: 2, id: 'tu1', name: 'Read' }
    yield { kind: 'input', index: 2, json: '{"file_path":"/a"}' }
    yield { kind: 'stop', stopReason: 'tool_use', usage }
    return { turnId: 't1', index: 0, answer: 'Hello world', toolUses: [{ name: 'Read', input: { file_path: '/a' } }], stopReason: 'tool_use', usage }
  })
  // read it as the engine does: chunks, then the generator's own return value
  const it = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 })[Symbol.asyncIterator]()
  const got: Array<Record<string, unknown>> = []
  let n = await it.next()
  while (!n.done) {
    got.push(n.value as unknown as Record<string, unknown>)
    n = await it.next()
  }
  const r = n.value
  expect(got.map(c => c.kind)).toEqual(['thinking', 'text', 'text', 'tool', 'input', 'stop'])
  expect(got[1]?.text).toBe('Hello')
  expect(got[2]?.text).toBe(' world')
  expect(got[3]?.name).toBe('Read')
  expect(got[4]?.json).toBe('{"file_path":"/a"}')
  expect(r.answer).toBe('Hello world')
  expect(r.toolUses.length).toBe(1)
  expect(whats.filter((w, i) => w !== whats[i - 1])).toEqual(['thinking', 'answering', 'preparing Read'])
})

test('a stream read only in part is closed beneath', async ($, on) => {
  mock.clock(on)
  let closed = false
  on('turn.step', async function* () {
    try {
      yield { kind: 'text', index: 0, text: 'one' }
      yield { kind: 'text', index: 0, text: 'two' }
      yield { kind: 'text', index: 0, text: 'three' }
      return { turnId: 't2', index: 0, answer: 'one two three', toolUses: [], stopReason: 'end_turn', usage: null }
    } finally {
      closed = true
    }
  })
  const it = $.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', messageCount: 1 })[Symbol.asyncIterator]()
  const first = await it.next()
  expect((first.value as unknown as Record<string, unknown>).text).toBe('one')
  await it.return(undefined as never)
  expect(closed).toBe(true)
})
