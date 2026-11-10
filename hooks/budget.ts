import type { DashBudget } from '../types'

/**
 * Paces the weekly plan limit over five working days.
 *
 * The week before the reset is cut into slots at the reset hour: the first four days are one slot each, the
 * last three days are one slot together (for a Monday reset: Tue, Wed, Thu, Fri, then Sat–Mon). Each slot may
 * spend DAILY_SHARE percent of the weekly limit and an unused share carries over, so the plan at the end of
 * slot n is n × DAILY_SHARE. The day's spend is the weekly percent minus its value when the slot started.
 *
 * The state is the one-line file the status line script keeps (`<week>:<slot> <base> <last> <notified>`),
 * so the terminal and the desktop app keep one count and raise each notification once.
 */

export const DAILY_SHARE = 20
export const WARN_AT = 15
export const SLOTS = 5

const DAY_S = 86_400

export type BudgetState = {
  /** `<reset rounded to the hour, in hours since the epoch>:<slot>`. */
  key: string
  /** The weekly percent when the slot started. */
  base: number
  /** The weekly percent last seen. */
  last: number
  /** The highest threshold already notified in this slot: 0, WARN_AT or DAILY_SHARE. */
  notified: number
}

export type BudgetStep = {
  budget: DashBudget
  state: BudgetState
  /** The threshold just crossed for the first time in this slot, 0 when none. */
  notify: number
}

/** Reads the state line; anything malformed counts as no state. */
export const parseBudgetState = (text: string): BudgetState | undefined => {
  const [key, base, last, notified] = text.trim().split(/\s+/)
  if (!key || !/^\d+:\d+$/.test(key)) return undefined
  const nums = [base, last, notified].map(Number)
  if (nums.some(n => !Number.isFinite(n))) return undefined
  return { key, base: nums[0]!, last: nums[1]!, notified: nums[2]! }
}

export const formatBudgetState = (s: BudgetState): string => `${s.key} ${String(s.base)} ${String(s.last)} ${String(s.notified)}\n`

/**
 * One measurement: where the week stands against the plan, the next state, and whether to notify.
 *
 * @param percentUsed the weekly window's percent used
 * @param resetsAtMs when the weekly window resets, epoch milliseconds
 * @param nowMs the current time, epoch milliseconds
 * @param prev the stored state, if any
 */
export const stepBudget = (percentUsed: number, resetsAtMs: number, nowMs: number, prev: BudgetState | undefined): BudgetStep => {
  const week = Math.round(percentUsed)
  const resetS = Math.floor(resetsAtMs / 1000)
  const nowS = Math.floor(nowMs / 1000)
  const slot = Math.min(SLOTS, Math.max(1, Math.floor((nowS - (resetS - 7 * DAY_S)) / DAY_S) + 1))
  const plan = slot * DAILY_SHARE
  // The reset rounded to the hour names the week, so a jitter of the reported timestamp keeps the same slot.
  const weekId = String(Math.floor((resetS + 1800) / 3600))
  const key = `${weekId}:${String(slot)}`
  let base: number
  let notified: number
  if (prev && prev.key === key) {
    base = prev.base
    notified = prev.notified
  } else {
    // A slot starts from the last value seen in the previous slot of the same week; a new week starts from zero.
    base = prev && prev.key.split(':')[0] === weekId ? prev.last : 0
    notified = 0
  }
  const day = Math.max(0, week - base)
  const reached = day >= DAILY_SHARE ? DAILY_SHARE : day >= WARN_AT ? WARN_AT : 0
  const notify = reached > notified ? reached : 0
  if (notify) notified = notify
  const level: DashBudget['level'] =
    day >= DAILY_SHARE || week > plan + 5 ? 'over' : day >= WARN_AT || week > plan ? 'warn' : 'ok'
  return {
    budget: { slot, plan, day, week, level, resetsAt: new Date(resetS * 1000).toISOString() },
    state: { key, base, last: week, notified },
    notify,
  }
}

/** The notification text, the same words the status line script sends. */
export const budgetNotice = (b: DashBudget): string =>
  `Сегодня ${String(b.day)}% недельного лимита (план дня ${String(DAILY_SHARE)}%). Неделя ${String(b.week)}% при плане ${String(b.plan)}%.`

export const BUDGET_TITLE = 'Claude Code: бюджет'
