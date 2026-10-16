/** `~` and `~/x` → the home directory; a relative path → under `cwd`; absolute stays. */
export const expandPath = (p: string, home: string, cwd: string): string => {
  const s = p.trim().replace(/\/+$/, '')
  if (s === '~') return home
  if (s.startsWith('~/')) return `${home}${s.slice(1)}`
  if (s.startsWith('/')) return s
  return `${cwd.replace(/\/+$/, '')}/${s.replace(/^\.\//, '')}`
}

/** Whether a command argument names a folder rather than a kind or a session id. */
export const isPathLike = (s: string): boolean => s === '~' || s.startsWith('~/') || s.startsWith('/') || s.startsWith('./') || s.startsWith('../') || s.endsWith('/')

export type ReportKind = 'pdf' | 'html' | 'md'

export type ReportArgs = { kind: ReportKind; target: string; dir?: string }

/** `report [pdf|html|md] [all|<id>] [<folder>]` in any order. */
export const parseReportArgs = (rest: readonly string[]): ReportArgs => {
  const out: ReportArgs = { kind: 'pdf', target: '' }
  for (const r of rest) {
    const low = r.toLowerCase()
    if (low === 'pdf' || low === 'html' || low === 'md') out.kind = low
    else if (isPathLike(r)) out.dir = r
    else out.target = r
  }
  return out
}

/** Shortens a path for a dialog label: the home directory as `~`, long middles elided. */
export const labelPath = (p: string, home: string, max = 48): string => {
  let s = home && p.startsWith(home) ? `~${p.slice(home.length)}` : p
  if (s.length > max) s = `${s.slice(0, Math.floor(max / 2) - 1)}…${s.slice(-(Math.ceil(max / 2) - 1))}`
  return s
}
