export type DashUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  calls: number
}

export type DashPhase = 'idle' | 'model' | 'tool'

export type DashMain = {
  phase: DashPhase
  sessionId: string
  cwd: string
  repo?: string
  branch?: string
  /** The task this chat is about: the first prompt's head, or what `title <text>` set. */
  title: string
  titleIsManual: boolean
  sessionModel: string
  model: string
  effort?: string
  turnId?: string
  stepIndex: number
  messageCount: number
  startedAt: number
  turnStartedAt?: number
  turns: number
  lastTurnMs?: number
  lastTurnUsage?: DashUsage
  lastTurnCostUsd?: number
  costAtTurnStart?: number
}

export type DashModelUsage = Record<string, DashUsage>

export type DashAgent = {
  id: string
  type: string
  description: string
  model: string
  parentId?: string
  name?: string
  status: string
  background: boolean
  startedAt: number
  endedAt?: number
  usage: DashUsage
  steps: number
  toolCalls: number
}

export type DashRateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type DashBreakdownRow = { name: string; tokens: number; kind: string; color: string }

export type DashContext = {
  tokens?: number
  window: number
  percent?: number
  maxPercent?: number
  costUsd?: number
  rateLimits: DashRateLimit[]
  compactions: number
  lastCompaction?: { before?: number; after?: number; at: number }
  breakdown?: DashBreakdownRow[]
  breakdownMax?: number
  autoCompactThreshold?: number
  measuredAt?: number
}

export type DashTool = { name: string; calls: number; errors: number; totalMs: number }

export type DashActiveTool = {
  id: string
  tool: string
  agentId?: string
  startedAt: number
  detail: string
}

export type DashStep = {
  at: number
  model: string
  agentId?: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  stopReason?: string
  ms: number
}

export type DashEvent = { at: number; text: string; kind: 'info' | 'ok' | 'warn' | 'error' }

export type DashView = {
  showTools: boolean
  showLog: boolean
  showSteps: boolean
  showModels: boolean
  showTime: boolean
}

/** One main-loop turn of this chat, with what it cost in time and tokens. */
export type DashTurn = {
  index: number
  turnId: string
  startedAt: number
  endedAt?: number
  ms?: number
  prompt: string
  usage?: DashUsage
  toolCalls: number
  agents: number
  modelMs: number
  toolMs: number
  costDelta?: number
  reason?: string
}

/** Where the session's wall time went, in milliseconds. */
export type DashTime = {
  /** Main-loop model requests (the model thinking and answering). */
  modelMs: number
  /** Main-loop tool calls, the Agent tool excluded. */
  toolMs: number
  /** Subagents' own wall time, from spawn to completion. */
  agentMs: number
  /** Idle between a turn's end and the next prompt: the person's time. */
  waitMs: number
  idleSince?: number
}

/** What the mod writes to `<home>/.claude/activity-dashboard/sessions/<id>.json`. */
export type SessionRecord = {
  version: 1
  id: string
  title: string
  cwd: string
  repo?: string
  branch?: string
  sessionModel: string
  startedAt: number
  updatedAt: number
  endedAt?: number
  wallMs: number
  activeMs: number
  time: DashTime
  turns: DashTurn[]
  usage: DashModelUsage
  totals: DashUsage
  costUsd?: number
  tools: DashTool[]
  agents: DashAgent[]
  compactions: number
  maxContextPercent?: number
  events: DashEvent[]
}

declare module 'claude-code' {
  interface PluginState {
    'activity-dashboard': {
      main: DashMain
      usage: DashModelUsage
      agents: DashAgent[]
      context: DashContext
      tools: Record<string, DashTool>
      active: DashActiveTool[]
      steps: DashStep[]
      events: DashEvent[]
      view: DashView
      turns: DashTurn[]
      time: DashTime
    }
  }
}
