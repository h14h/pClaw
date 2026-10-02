import { Link } from '@tanstack/react-router'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { WorkerStatus, WorkerSummary } from '../../src/dashboard/types'
import { ago, clock, duration, useNow } from './time'

export function Shell({ children, left, right }: { children: ReactNode; left?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-10 shrink-0 items-center gap-2 overflow-hidden whitespace-nowrap border-b border-line px-3 text-[13px]">
        <Link to="/" className="shrink-0 font-semibold">pclaw</Link>
        {left}
        <span className="flex-1" />
        {right}
      </header>
      {children}
    </div>
  )
}

/**
 * One transcript line: time gutter, who, body. `who` is blank for a continuation by the same party. On narrow
 * screens the who label sits above the body instead of beside it, so the text keeps its width.
 */
export function Row({ at, who, whoClass = 'text-mute', children, className = '' }: { at: number; who?: ReactNode; whoClass?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`grid grid-cols-[2.4rem_minmax(0,1fr)] gap-x-2 py-1 sm:grid-cols-[2.4rem_7rem_minmax(0,1fr)] ${className}`}>
      <span className="font-mono text-[11px] leading-5 text-faint tabular-nums">{clock(at)}</span>
      <span className={`hidden truncate text-[12px] leading-5 sm:block ${whoClass}`}>{who}</span>
      <div className="min-w-0">
        {who && <div className={`text-[12px] leading-5 sm:hidden ${whoClass}`}>{who}</div>}
        {children}
      </div>
    </div>
  )
}

export function DayBreak({ label }: { label: string }) {
  return (
    <div className="my-2 flex items-center gap-3 text-[11px] text-faint">
      <hr className="flex-1 border-line" />
      {label}
      <hr className="flex-1 border-line" />
    </div>
  )
}

export function Tag({ children, tone = 'mute' }: { children: ReactNode; tone?: 'mute' | 'red' | 'amber' }) {
  const color = { mute: 'text-mute border-line', red: 'text-red-600 border-red-300 dark:text-red-400 dark:border-red-900', amber: 'text-amber-700 border-amber-300 dark:text-amber-400 dark:border-amber-900' }[tone]
  return <span className={`inline-block whitespace-nowrap rounded border px-1 align-[1px] text-[10.5px] leading-4 ${color}`}>{children}</span>
}

const dotColor: Record<WorkerStatus, string> = {
  working: 'bg-amber-500 animate-pulse',
  idle: 'bg-faint',
  stopped: 'bg-faint',
  failed: 'bg-red-500',
}

export function Dot({ status }: { status: WorkerStatus }) {
  return <span className={`inline-block size-2 shrink-0 rounded-full ${dotColor[status]}`} />
}

export function Elapsed({ since }: { since: number }) {
  return <>{duration(useNow() - since)}</>
}

/** "working · 2m 14s", "idle · 3m ago", "failed · yesterday". */
export function WorkerState({ worker }: { worker: WorkerSummary }) {
  const now = useNow(worker.status === 'working' ? 1000 : 30_000)
  const tail = worker.status === 'working' ? (worker.startedAt ? duration(now - worker.startedAt) : undefined) : ago(worker.updatedAt, now)
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-mute">
      <Dot status={worker.status} />
      {worker.status}
      {tail && <span className="text-faint">· {tail}</span>}
    </span>
  )
}

/** Caps tall content with a fade and a "more" link; measures, so it only shows the link when needed. */
export function Clamp({ children, max = 'max-h-56' }: { children: ReactNode; max?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && !open) setOverflows(el.scrollHeight > el.clientHeight + 2)
  })
  return (
    <div>
      <div ref={ref} className={`relative overflow-hidden ${open ? '' : max}`}>
        {children}
        {overflows && !open && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-bg to-transparent" />}
      </div>
      {(overflows || open) && (
        <button type="button" onClick={() => setOpen(!open)} className="mt-0.5 text-[11px] text-mute hover:text-fg">
          {open ? 'less' : 'more'}
        </button>
      )}
    </div>
  )
}

const SUMMARY_KEYS = ['command', 'query', 'queries', 'url', 'path', 'note', 'message', 'text', 'brief', 'prompt', 'name']

/** A one-line gist of a tool's arguments: the most telling string in them, ignoring one already shown. */
export function summarize(args: unknown, shown?: string): string {
  if (typeof args === 'string') return args
  if (!args || typeof args !== 'object') return ''
  const obj = args as Record<string, unknown>
  const keys = [...SUMMARY_KEYS.filter((k) => k in obj), ...Object.keys(obj)]
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim() && v !== shown) return v.split('\n')[0]!
    if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return v.join(' · ')
  }
  return JSON.stringify(args)
}

const pretty = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))

export function Args({ args }: { args: unknown }) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return <Pre>{pretty(args)}</Pre>
  const entries = Object.entries(args as Record<string, unknown>)
  return (
    <div className="space-y-1">
      {entries.map(([k, v]) => (
        <div key={k}>
          <span className="font-mono text-[11px] text-faint">{k}</span>
          <Pre>{pretty(v)}</Pre>
        </div>
      ))}
    </div>
  )
}

export function Pre({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <pre className={`max-h-96 overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-[1.4] ${className}`}>{children}</pre>
}

/** A compact tool call: one clickable line, details underneath when open. */
export function ToolCall({ lead, summary, args, result, isError, running }: { lead?: ReactNode; summary: string; args: unknown; result?: string; isError?: boolean; running: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="font-mono text-[12px] leading-5">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-baseline gap-2 text-left">
        <span className="w-2 shrink-0 text-faint">{open ? '▾' : '▸'}</span>
        {lead}
        <span className={`truncate ${lead ? 'text-mute' : ''}`}>{summary}</span>
        {running && <span className="flex shrink-0 items-center gap-1.5 text-amber-600 dark:text-amber-400"><Dot status="working" />running</span>}
        {isError && <Tag tone="red">error</Tag>}
      </button>
      {open && (
        <div className="mt-1 mb-1 ml-4 space-y-2 border-l border-line pl-3">
          <Args args={args} />
          {result !== undefined && (
            <div>
              <span className="text-[11px] text-faint">result</span>
              <Pre className={isError ? 'text-red-600 dark:text-red-400' : ''}>{result || <span className="text-faint">(empty)</span>}</Pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Keeps a scroll container pinned to its bottom as its content grows, unless the user has scrolled up to read. */
export function useStickToBottom<T extends HTMLElement>(enabled = true) {
  const ref = useRef<T>(null)
  const stuck = useRef(true)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    const pin = () => { if (stuck.current) el.scrollTop = el.scrollHeight }
    const onScroll = () => { stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }
    // Expanding a row means the reader is on that row, so stop following until they scroll back down.
    const onClick = () => { stuck.current = false }
    pin()
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('click', onClick)
    const observer = new ResizeObserver(pin)
    for (const child of el.children) observer.observe(child)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('click', onClick)
      observer.disconnect()
    }
  }, [enabled])
  return ref
}

export const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
