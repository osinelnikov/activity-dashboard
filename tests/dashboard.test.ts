import { expect, mock, test } from 'claude-code/testing'

import type { DashActiveTool, DashTool, DashTurn } from '../types'
import { buildRecord, chatSummary, parseRecord, recordToHtml, recordToMarkdown } from '../hooks/report'
import type { Snapshot } from '../hooks/report'

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
