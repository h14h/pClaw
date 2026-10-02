import { useEffect, useState } from 'react'

const clockFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

export const clock = (ms: number) => clockFmt.format(ms)
export const dayKey = (ms: number) => new Date(ms).toDateString()

export function day(ms: number, now = Date.now()) {
  const key = dayKey(ms)
  if (key === dayKey(now)) return 'today'
  if (key === dayKey(now - 86_400_000)) return 'yesterday'
  if (key === dayKey(now + 86_400_000)) return 'tomorrow'
  return dayFmt.format(ms)
}

const pad = (n: number) => String(n).padStart(2, '0')

/** "48s", "2m 14s", "1h 03m". */
export function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${pad(s % 60)}s`
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`
}

export function ago(ms: number, now = Date.now()) {
  const s = Math.round((now - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return day(ms, now)
}

/** The current time, re-rendering every `every` ms. Keep it in small leaf components. */
export function useNow(every = 1000) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(t)
  }, [every])
  return now
}
