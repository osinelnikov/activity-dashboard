import type { DashAgent, DashFile, DashNow } from '../types'
import { cut, fmtMs, toolLabel } from './format'

// ---------------------------------------------------------------------------
// File changes: what a tool's result says it changed
// ---------------------------------------------------------------------------

type Hunk = { readonly lines?: readonly string[] }

/** Added and removed lines of unified-diff hunks (`+x`, `-x`; context and markers ignored). */
export const countHunks = (hunks: readonly Hunk[] | undefined): { added: number; removed: number } => {
  let added = 0
  let removed = 0
  for (const h of hunks ?? []) {
    for (const l of h.lines ?? []) {
      if (l.startsWith('+')) added += 1
      else if (l.startsWith('-')) removed += 1
    }
  }
  return { added, removed }
}

/** Lines of a text: `''` is 0, a trailing newline does not open a line. */
export const lineCount = (text: string | null | undefined): number => {
  if (!text) return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

export type FileChange = {
  path: string
  added: number
  removed: number
  baseLines?: number
  created?: boolean
  deleted?: boolean
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

const fromGitDiff = (r: Record<string, unknown>): { added: number; removed: number } | undefined => {
  const g = obj(r.gitDiff)
  const a = num(g.additions)
  const d = num(g.deletions)
  return a !== undefined && d !== undefined ? { added: a, removed: d } : undefined
}

/**
 * The files a finished tool call changed, read off its input and its result:
 * Edit, Write and NotebookEdit by their own records, Bash by the engine's
 * working-tree diff of the command (when it has one). A staged or failed
 * write changed nothing.
 */
export const extractChanges = (tool: string, input: Record<string, unknown>, result: unknown): FileChange[] => {
  const r = obj(result)
  if (r.staged === true) return []
  if (tool === 'Edit') {
    const path = str(r.filePath) ?? str(input.file_path)
    if (!path) return []
    const patch = Array.isArray(r.structuredPatch) ? (r.structuredPatch as Hunk[]) : []
    let c = countHunks(patch)
    if (c.added === 0 && c.removed === 0) c = fromGitDiff(r) ?? { added: lineCount(str(input.new_string)), removed: lineCount(str(input.old_string)) }
    const original = r.originalFile
    return [{ path, ...c, baseLines: typeof original === 'string' ? lineCount(original) : undefined }]
  }
  if (tool === 'Write') {
    const path = str(r.filePath) ?? str(input.file_path)
    if (!path) return []
    const content = str(r.content) ?? str(input.content) ?? ''
    if (r.type === 'create') return [{ path, added: lineCount(content), removed: 0, baseLines: 0, created: true }]
    const patch = Array.isArray(r.structuredPatch) ? (r.structuredPatch as Hunk[]) : []
    let c = countHunks(patch)
    const original = r.originalFile
    if (c.added === 0 && c.removed === 0) c = fromGitDiff(r) ?? (typeof original === 'string' ? { added: lineCount(content), removed: lineCount(original) } : c)
    return [{ path, ...c, baseLines: typeof original === 'string' ? lineCount(original) : undefined }]
  }
  if (tool === 'NotebookEdit') {
    const path = str(r.notebook_path) ?? str(input.notebook_path)
    if (!path || str(r.error)) return []
    const mode = str(r.edit_mode) ?? str(input.edit_mode) ?? 'replace'
    const added = mode === 'delete' ? 0 : lineCount(str(r.new_source) ?? str(input.new_source))
    const removed = mode === 'insert' ? 0 : lineCount(str(r.old_source))
    return [{ path, added, removed }]
  }
  if (tool === 'Bash') {
    const d = obj(r.bashEditDiff)
    if (!Array.isArray(d.files)) return []
    return (d.files as unknown[]).flatMap(f => {
      const o = obj(f)
      const path = str(o.filePath)
      if (!path) return []
      const c = countHunks(Array.isArray(o.hunks) ? (o.hunks as Hunk[]) : [])
      return [{ path, ...c, created: o.created === true, deleted: o.deleted === true, baseLines: o.created === true ? 0 : undefined }]
    })
  }
  return []
}

/** Folds one change into the file's running total. */
export const mergeFile = (prev: DashFile | undefined, ch: FileChange, loop: string, tool: string, at: number): DashFile => {
  const added = (prev?.added ?? 0) + ch.added
  const removed = (prev?.removed ?? 0) + ch.removed
  const baseLines = prev ? prev.baseLines : ch.baseLines
  const before = prev?.lines ?? ch.baseLines
  const lines = ch.deleted ? 0 : before !== undefined ? Math.max(0, before + ch.added - ch.removed) : undefined
  return {
    path: ch.path,
    added,
    removed,
    edits: (prev?.edits ?? 0) + 1,
    baseLines,
    lines,
    created: prev ? prev.created : ch.created === true,
    deleted: ch.deleted === true ? true : prev?.deleted === true && !ch.created ? true : false,
    tools: prev?.tools.includes(tool) ? prev.tools : [...(prev?.tools ?? []), tool],
    loops: prev?.loops.includes(loop) ? prev.loops : [...(prev?.loops ?? []), loop],
    firstAt: prev?.firstAt ?? at,
    lastAt: at,
  }
}

/** Changed lines ≈ max(+, −): a modified line is one − and one +. */
export const changedLines = (f: DashFile): number => Math.max(f.added, f.removed)

/** Share of the file's original lines the session changed; `undefined` for a new file or an unknown size. */
export const filePct = (f: DashFile): number | undefined => {
  if (f.created || !f.baseLines) return undefined
  return (changedLines(f) / f.baseLines) * 100
}

export const fmtFilePct = (f: DashFile): string => {
  if (f.deleted) return 'deleted'
  if (f.created) return 'new'
  const p = filePct(f)
  if (p === undefined) return '—'
  if (p > 0 && p < 1) return '<1%'
  return p > 100 ? '>100%' : `${String(Math.round(p))}%`
}

/** A path for display: under the session's folder relative, under home as `~/…`. */
export const relPath = (path: string, cwd: string, home: string): string => {
  const c = cwd.replace(/\/+$/, '')
  if (c && path.startsWith(`${c}/`)) return path.slice(c.length + 1)
  const h = home.replace(/\/+$/, '')
  if (h && path.startsWith(`${h}/`)) return `~${path.slice(h.length)}`
  return path
}

// ---------------------------------------------------------------------------
// Loops: who is who, and what each is doing
// ---------------------------------------------------------------------------

export const MAIN = 'main'

export const agentLabel = (a: DashAgent | undefined): string => (a ? (a.name ? `${a.type} "${a.name}"` : a.type) : 'agent')

/** `main`, or the agent's type (and name) for an agent id. */
export const loopLabel = (loop: string, agents: readonly DashAgent[]): string =>
  loop === MAIN ? 'main' : agentLabel(agents.find(a => a.id === loop))

const NOW_TEXT: Record<DashNow['what'], string> = {
  starting: 'starting',
  thinking: 'thinking',
  answering: 'writing the answer',
  preparing: 'preparing a call',
  tool: 'running',
  idle: 'idle',
}

export type ActiveCall = { tool: string; detail: string; startedAt: number; agentId?: string }

/**
 * One line on what a loop is doing: its running tool calls first (the Agent
 * tool read as waiting for the agents it started), else what its stream says.
 */
export const describeNow = (
  loop: string,
  now: DashNow | undefined,
  active: readonly ActiveCall[],
  agents: readonly DashAgent[],
  at: number,
  live: (a: DashAgent) => boolean,
): { text: string; since?: number } => {
  const mine = active.filter(x => (x.agentId ?? MAIN) === loop)
  if (mine.length) {
    const first = mine[0]!
    const waits = first.tool === 'Agent'
      ? agents.filter(a => (a.parentId ?? MAIN) === loop && live(a) && !a.background).map(a => agentLabel(a))
      : []
    const head = waits.length ? `waiting for ${waits.join(', ')}` : `${toolLabel(first.tool)}${first.detail ? `: ${first.detail}` : ''}`
    return { text: `${head}${mine.length > 1 ? ` (+${String(mine.length - 1)} more)` : ''}`, since: first.startedAt }
  }
  if (!now) return { text: loop === MAIN ? 'idle' : 'starting' }
  const base = NOW_TEXT[now.what]
  return { text: now.what === 'preparing' && now.detail ? `preparing ${toolLabel(now.detail)}` : base, since: now.since }
}

export const sinceText = (since: number | undefined, at: number): string => (since === undefined ? '' : fmtMs(Math.max(0, at - since)))

export const skillBadge = (name: string | undefined): string => (name ? `skill ${cut(name, 28)}` : '')
