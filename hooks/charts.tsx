import type { Elements, RenderNode } from 'claude-code'

import type { DashChartMode } from '../types'
import { clamp, cut, pad, padL } from './format'

// ---------------------------------------------------------------------------
// Palette: the dataviz reference palette, validated for adjacent pairs in both
// modes. Hues are assigned in fixed slot order and never cycled.
// ---------------------------------------------------------------------------

export const LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'] as const
export const DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'] as const
const TRACK = { light: '#e6e5e1', dark: '#383835' }
const INK = { light: '#0b0b0b', dark: '#ffffff' }
const INK2 = { light: '#52514e', dark: '#c3c2b7' }

export const paletteOf = (dark: boolean): readonly string[] => (dark ? DARK : LIGHT)

/** One item of a share chart: what it is, how much, how to print it, which fixed palette slot it wears. */
export type Slice = { label: string; value: number; text: string; slot: number }

export type ChartTable = {
  Box: Elements['terminal']['Box']
  Text: Elements['terminal']['Text']
  Svg?: Elements['desktop']['Svg']
}

export type ChartOptions = {
  /** Columns the chart may take. */
  width: number
  dark: boolean
  /** What the donut's centre says (the total). */
  center?: string
  /** Rows beyond this fold into "other". */
  maxRows?: number
  /** A line under the legend (a caveat, a note). */
  note?: string
}

const fold = (slices: Slice[], maxRows: number): Slice[] => {
  if (slices.length <= maxRows) return slices
  const head = slices.slice(0, maxRows - 1)
  const rest = slices.slice(maxRows - 1)
  const value = rest.reduce((n, s) => n + s.value, 0)
  return [...head, { label: `other (${rest.length})`, value, text: rest[0]?.text ? '' : '', slot: 7 }]
}

const pctOf = (v: number, total: number): string => `${padL(String(Math.round(total > 0 ? (v / total) * 100 : 0)), 3)}%`

// ---------------------------------------------------------------------------
// Text pieces (every surface)
// ---------------------------------------------------------------------------

/** A text bar: `filled` colored cells of `width`, the rest dim track. */
export const textBar = (t: ChartTable, frac: number, width: number, color: string): RenderNode => {
  const { Text } = t
  const f = clamp(Math.round((Number.isFinite(frac) ? frac : 0) * width), 0, width)
  return (
    <Text>
      <Text color={color}>{'█'.repeat(f)}</Text>
      <Text dimColor>{'░'.repeat(width - f)}</Text>
    </Text>
  )
}

/** One stacked text bar of `width` cells, each slice its palette color, the remainder dim. */
const textStacked = (t: ChartTable, slices: Slice[], total: number, width: number, palette: readonly string[]): RenderNode => {
  const { Text } = t
  const parts: RenderNode[] = []
  let used = 0
  slices.forEach((s, i) => {
    const isLast = i === slices.length - 1
    const cells = isLast ? clamp(Math.round((slices.reduce((n, x) => n + x.value, 0) / Math.max(1, total)) * width) - used, 0, width - used) : clamp(Math.round((s.value / Math.max(1, total)) * width), 0, width - used)
    if (cells > 0) parts.push(<Text color={palette[s.slot % palette.length]}>{'█'.repeat(cells)}</Text>)
    used += cells
  })
  if (used < width) parts.push(<Text dimColor>{'░'.repeat(width - used)}</Text>)
  return <Text>{parts}</Text>
}

/** `■ label        value   42%` on a Box grid, so columns line up on every surface. */
const legendRow = (t: ChartTable, s: Slice, total: number, labelW: number, valueW: number, color: string, bar?: RenderNode, barW?: number): RenderNode => {
  const { Box, Text } = t
  return (
    <Box flexDirection="row" gap={1}>
      <Box width={1}>
        <Text color={color}>■</Text>
      </Box>
      <Box width={labelW}>
        <Text wrap="truncate-end">{cut(s.label, labelW)}</Text>
      </Box>
      {bar !== undefined && barW !== undefined ? <Box width={barW}>{bar}</Box> : <Box width={0}> </Box>}
      <Box width={valueW} justifyContent="flex-end">
        <Text dimColor>{padL(cut(s.text, valueW), valueW)}</Text>
      </Box>
      <Box width={4} justifyContent="flex-end">
        <Text dimColor>{pctOf(s.value, total)}</Text>
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// SVG pieces (desktop, vscode, mobile)
// ---------------------------------------------------------------------------

const svgStacked = (Svg: NonNullable<ChartTable['Svg']>, slices: Slice[], total: number, palette: readonly string[], dark: boolean, alt: string): RenderNode => {
  const W = 600
  const H = 16
  const gap = 2
  let x = 0
  const rects: string[] = []
  const sum = Math.max(total, slices.reduce((n, s) => n + s.value, 0), 1)
  for (const s of slices) {
    const w = (s.value / sum) * W
    if (w <= 0) continue
    const draw = Math.max(0, Math.min(w, W - x) - gap)
    if (draw > 0) rects.push(`<rect x="${x.toFixed(1)}" y="0" width="${draw.toFixed(1)}" height="${H}" rx="3" fill="${palette[s.slot % palette.length]}"/>`)
    x += w
  }
  const track = dark ? TRACK.dark : TRACK.light
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect x="0" y="0" width="${W}" height="${H}" rx="3" fill="${track}"/>${rects.join('')}</svg>`
  return <Svg source={source} alt={alt} height={H} />
}

const svgDonut = (Svg: NonNullable<ChartTable['Svg']>, slices: Slice[], total: number, palette: readonly string[], dark: boolean, center: string, alt: string): RenderNode => {
  const size = 132
  const r = 50
  const stroke = 18
  const c = size / 2
  const circ = 2 * Math.PI * r
  const sum = Math.max(total, slices.reduce((n, s) => n + s.value, 0), 1)
  const gapFrac = slices.filter(s => s.value > 0).length > 1 ? 0.012 : 0
  let offset = 0
  const arcs: string[] = []
  for (const s of slices) {
    const frac = s.value / sum
    if (frac <= 0) continue
    const len = Math.max(0, (frac - gapFrac) * circ)
    arcs.push(
      `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${palette[s.slot % palette.length]}" stroke-width="${stroke}" stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}" stroke-dashoffset="${(-offset * circ).toFixed(2)}" transform="rotate(-90 ${c} ${c})"/>`,
    )
    offset += frac
  }
  const track = dark ? TRACK.dark : TRACK.light
  const ink = dark ? INK.dark : INK.light
  const ink2 = dark ? INK2.dark : INK2.light
  const label = center.replace(/[<>&"]/g, '')
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${track}" stroke-width="${stroke}"/>` +
    arcs.join('') +
    `<text x="${c}" y="${c + 1}" text-anchor="middle" dominant-baseline="middle" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif" font-size="15" font-weight="600" fill="${ink}">${label}</text>` +
    `<text x="${c}" y="${c + 17}" text-anchor="middle" dominant-baseline="middle" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif" font-size="9" fill="${ink2}">total</text>` +
    `</svg>`
  return <Svg source={source} alt={alt} width={size} height={size} />
}

// ---------------------------------------------------------------------------
// The chart: one call, three modes
// ---------------------------------------------------------------------------

/**
 * Draws `slices` as a share of `total` in the mode asked: a bar per row, one
 * stacked bar over a legend, or a donut beside a legend. Legend rows carry the
 * marker, label, value and percent on a Box grid; text stands in for SVG where
 * the surface has none.
 */
export const shareChart = (t: ChartTable, mode: DashChartMode, input: Slice[], total: number, o: ChartOptions): RenderNode => {
  const { Box, Text } = t
  const palette = paletteOf(o.dark)
  const slices = fold(input.filter(s => s.value > 0 || input.length <= 2), o.maxRows ?? 7)
  const sum = Math.max(total, 1)
  const valueW = clamp(Math.max(5, ...slices.map(s => s.text.length)), 5, 12)
  const labelW = clamp(Math.max(6, ...slices.map(s => s.label.length)), 6, 18)
  const fixed = 1 + labelW + valueW + 4 + 4
  const barW = clamp(o.width - fixed - 1, 6, 40)
  const alt = slices.map(s => `${s.label} ${s.text} ${Math.round((s.value / sum) * 100)}%`).join(', ')

  if (!slices.length) {
    return <Text dimColor>nothing yet</Text>
  }

  const legend = (withBars: boolean): RenderNode[] =>
    slices.map(s => {
      const color = palette[s.slot % palette.length] ?? '#888888'
      return withBars ? legendRow(t, s, sum, labelW, valueW, color, textBar(t, s.value / sum, barW, color), barW) : legendRow(t, s, sum, labelW, valueW, color)
    })

  const note = o.note ? <Text dimColor>{cut(o.note, o.width)}</Text> : undefined

  if (mode === 'bars') {
    return (
      <Box flexDirection="column">
        {legend(true)}
        {note}
      </Box>
    )
  }

  if (mode === 'stacked') {
    const bar = t.Svg ? svgStacked(t.Svg, slices, sum, palette, o.dark, alt) : textStacked(t, slices, sum, clamp(o.width - 2, 10, 80), palette)
    return (
      <Box flexDirection="column">
        <Box marginBottom={t.Svg ? 0 : 0}>{bar}</Box>
        {legend(false)}
        {note}
      </Box>
    )
  }

  // donut
  if (t.Svg) {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2} alignItems="center">
          <Box width={18}>{svgDonut(t.Svg, slices, sum, palette, o.dark, o.center ?? '', alt)}</Box>
          <Box flexDirection="column" flexGrow={1}>
            {legend(false)}
          </Box>
        </Box>
        {note}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{o.center ?? ''}</Text>
        <Text dimColor>{o.center ? '  total · ' : ''}donut needs a graphical surface; showing a stacked bar</Text>
      </Text>
      {textStacked(t, slices, sum, clamp(o.width - 2, 10, 80), palette)}
      {legend(false)}
      {note}
    </Box>
  )
}

/** A meter: `label  ████░░  value` for one ratio against a limit, colored by threshold. */
export const meterRow = (t: ChartTable, label: string, frac: number, color: string, value: string, labelW: number, barW: number): RenderNode => {
  const { Box, Text } = t
  return (
    <Box flexDirection="row" gap={1}>
      <Box width={labelW}>
        <Text wrap="truncate-end">{pad(cut(label, labelW), labelW)}</Text>
      </Box>
      <Box width={barW}>{textBar(t, frac, barW, color)}</Box>
      <Box flexGrow={1}>
        <Text dimColor wrap="truncate-end">
          {value}
        </Text>
      </Box>
    </Box>
  )
}

export const nextChartMode = (m: DashChartMode): DashChartMode => (m === 'bars' ? 'stacked' : m === 'stacked' ? 'donut' : 'bars')
