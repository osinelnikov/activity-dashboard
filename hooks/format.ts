import type { ModelUsage } from 'claude-code'

import type { DashUsage } from '../types'

export const fmtTok = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n))

export const fmtMs = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`
  return `${Math.floor(ms / 3_600_000)}h${String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0')}m`
}

export const fmtUsd = (usd: number): string => (usd >= 10 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`)

const two = (n: number): string => String(n).padStart(2, '0')

export const fmtClock = (at: number): string => {
  const d = new Date(at)
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

export const fmtDate = (at: number): string => {
  const d = new Date(at)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

export const fmtDateTime = (at: number): string => `${fmtDate(at)} ${two(new Date(at).getHours())}:${two(new Date(at).getMinutes())}`

/** A file-name stamp: `2026-10-16_0912`. */
export const fmtStamp = (at: number): string => {
  const d = new Date(at)
  return `${fmtDate(at)}_${two(d.getHours())}${two(d.getMinutes())}`
}

export const untilIso = (iso: string | undefined, now: number): string => {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  return t > now ? `resets in ${fmtMs(t - now)}` : 'reset due'
}

/** `claude-opus-5-5` → `opus 5.5`, `us.anthropic.claude-haiku-5-5-20260101` → `haiku 5.5`. */
export const shortModel = (m: string | undefined): string => {
  if (!m) return '?'
  let s = m.replace(/^(us|eu|apac)\./, '').replace(/^anthropic\./, '').replace(/^claude-/, '')
  s = s.replace(/-\d{8}$/, '').replace(/-v\d+(:\d+)?$/, '').replace(/\[1m\]$/, '')
  const parts = s.match(/^([a-z]+)-(\d+)(?:-(\d+))?(.*)$/)
  if (parts) s = `${parts[1]} ${parts[2]}${parts[3] ? `.${parts[3]}` : ''}${parts[4] ?? ''}`
  return s
}

export const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length))
export const padL = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s)
export const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s)
export const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))
export const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

export const barOf = (frac: number, width: number): { filled: string; empty: string } => {
  const f = clamp(Math.round((Number.isFinite(frac) ? frac : 0) * width), 0, width)
  return { filled: '█'.repeat(f), empty: '░'.repeat(width - f) }
}

export const pctColor = (p: number): string => (p >= 85 ? 'error' : p >= 65 ? 'warning' : 'success')

export const pct = (part: number, whole: number): number => (whole > 0 ? (part / whole) * 100 : 0)

export const emptyUsage = (): DashUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 })

export const total = (u: DashUsage): number => u.input + u.output + u.cacheRead + u.cacheWrite

export const inputOf = (u: DashUsage): number => u.input + u.cacheRead + u.cacheWrite

export const cacheHit = (u: DashUsage): number => {
  const inp = inputOf(u)
  return inp > 0 ? (u.cacheRead / inp) * 100 : 0
}

export const addUsage = (u: DashUsage, m: ModelUsage): DashUsage => ({
  input: u.input + (m.input_tokens ?? 0),
  output: u.output + (m.output_tokens ?? 0),
  cacheRead: u.cacheRead + (m.cache_read_input_tokens ?? 0),
  cacheWrite: u.cacheWrite + (m.cache_creation_input_tokens ?? 0),
  calls: u.calls + 1,
})

export const fromModelUsage = (m: ModelUsage): DashUsage => addUsage(emptyUsage(), m)

export const addUsageInto = (acc: DashUsage, u: DashUsage): DashUsage => ({
  input: acc.input + u.input,
  output: acc.output + u.output,
  cacheRead: acc.cacheRead + u.cacheRead,
  cacheWrite: acc.cacheWrite + u.cacheWrite,
  calls: acc.calls + u.calls,
})

export const isDoneStatus = (s: string): boolean => s === 'completed' || s === 'failed' || s === 'killed'

export const statusGlyph = (s: string): { glyph: string; color: string } => {
  switch (s) {
    case 'running':
      return { glyph: '●', color: 'claude' }
    case 'pending':
      return { glyph: '…', color: 'subtle' }
    case 'waiting':
      return { glyph: '◔', color: 'warning' }
    case 'idle':
      return { glyph: '◌', color: 'subtle' }
    case 'completed':
      return { glyph: '✓', color: 'success' }
    case 'failed':
    case 'killed':
      return { glyph: '✗', color: 'error' }
    default:
      return { glyph: '?', color: 'subtle' }
  }
}

/** A short, human line about a tool call's arguments, for the active list. */
export const detailOf = (e: Record<string, unknown>): string => {
  const pick = (k: string): string | undefined => (typeof e[k] === 'string' ? (e[k] as string) : undefined)
  const s =
    pick('description') ??
    pick('command') ??
    pick('file_path') ??
    pick('pattern') ??
    pick('query') ??
    pick('url') ??
    pick('skill') ??
    pick('prompt') ??
    ''
  return oneLine(s).slice(0, 80)
}

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A tool's display name: `mcp__server__tool` → `server:tool`. */
export const toolLabel = (name: string): string => (name.startsWith('mcp__') ? name.slice(5).replace(/__/g, ':') : name)
