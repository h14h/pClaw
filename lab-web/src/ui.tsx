import type { ReactNode } from 'react'
import type { RunSummary, Score } from '../../src/prose-lab/types'

const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
export const when = (ms: number) => fmt.format(ms)

export function Tag({ children, tone = 'mute' }: { children: ReactNode; tone?: 'mute' | 'red' | 'amber' | 'green' }) {
  const color = {
    mute: 'text-mute border-line',
    red: 'text-red-600 border-red-300 dark:text-red-400 dark:border-red-900',
    amber: 'text-amber-700 border-amber-300 dark:text-amber-400 dark:border-amber-900',
    green: 'text-green-700 border-green-300 dark:text-green-400 dark:border-green-900',
  }[tone]
  return <span className={`inline-block whitespace-nowrap rounded border px-1 align-[1px] text-[10.5px] leading-4 ${color}`}>{children}</span>
}

export function Status({ run }: { run: RunSummary }) {
  if (run.status === 'running') return <Tag tone="amber">{run.done}/{run.total}</Tag>
  if (run.status === 'failed') return <Tag tone="red">failed</Tag>
  if (run.status === 'stopped') return <Tag>stopped at {run.done}/{run.total}</Tag>
  return null
}

const share = (score: Score) => (score.replied === 0 ? 0 : score.clean / score.replied)
const mean = (value: number | undefined) => (value === undefined ? '–' : value.toFixed(1))

/** Who wins each column, so the better number stands out. Ties highlight nobody. */
function best(scores: Score[], pick: (score: Score) => number | undefined): number | undefined {
  const values = scores.map(pick)
  const top = Math.max(...values.map((value) => value ?? -Infinity))
  const winners = values.filter((value) => value === top)
  return winners.length === 1 && scores.length > 1 ? values.indexOf(top) : undefined
}

export function Scores({ scores, labels, compact = false }: { scores: Score[]; labels: string[]; compact?: boolean }) {
  const label = (score: Score) => labels[Number(score.variant)] ?? score.variant
  const winners = {
    clean: best(scores, share),
    natural: best(scores, (score) => score.natural),
    economy: best(scores, (score) => score.economy),
    substance: best(scores, (score) => score.substance),
  }
  const cell = (index: number, column: keyof typeof winners) => (winners[column] === index ? 'font-semibold text-fg' : 'text-mute')
  if (compact) {
    return (
      <span className="flex flex-col text-[12px] tabular-nums">
        {scores.map((score, index) => (
          <span key={score.variant} className="flex gap-3">
            <span className="w-28 truncate text-mute">{label(score)}</span>
            <span className={cell(index, 'clean')}>{score.clean}/{score.replied} clean</span>
            {score.natural !== undefined && (
              <span className="text-mute">
                <span className={cell(index, 'natural')}>{mean(score.natural)}</span> / <span className={cell(index, 'economy')}>{mean(score.economy)}</span> /{' '}
                <span className={cell(index, 'substance')}>{mean(score.substance)}</span>
              </span>
            )}
          </span>
        ))}
      </span>
    )
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[13px] tabular-nums">
        <thead className="text-[11px] text-faint">
          <tr className="border-b border-line">
            <th className="py-1 pr-4 font-normal">prompt</th>
            <th className="py-1 pr-4 font-normal" title="Replies with no table, heading, --- line, bold labels, unwrapped links, or overflow">passes Discord checks</th>
            <th className="py-1 pr-4 font-normal">median chars</th>
            <th className="py-1 pr-4 font-normal">median words</th>
            <th className="py-1 pr-4 font-normal" title="Reads like a person texting, not a report (1–5)">natural</th>
            <th className="py-1 pr-4 font-normal" title="No word vomit; length fits the moment (1–5)">economy</th>
            <th className="py-1 pr-4 font-normal" title="Answers the question, keeps the key facts, invents nothing (1–5)">substance</th>
            <th className="py-1 font-normal">failed checks</th>
          </tr>
        </thead>
        <tbody>
          {scores.map((score, index) => (
            <tr key={score.variant} className="border-b border-line last:border-0">
              <td className="py-1.5 pr-4 font-medium">{label(score)}</td>
              <td className={`py-1.5 pr-4 ${cell(index, 'clean')}`}>
                {score.clean}/{score.replied}
                {score.replied > 0 && <span className="text-faint"> · {Math.round(share(score) * 100)}%</span>}
              </td>
              <td className="py-1.5 pr-4 text-mute">{score.medianChars}</td>
              <td className="py-1.5 pr-4 text-mute">{score.medianWords}</td>
              <td className={`py-1.5 pr-4 ${cell(index, 'natural')}`}>{mean(score.natural)}</td>
              <td className={`py-1.5 pr-4 ${cell(index, 'economy')}`}>{mean(score.economy)}</td>
              <td className={`py-1.5 pr-4 ${cell(index, 'substance')}`}>{mean(score.substance)}</td>
              <td className="py-1.5 text-[12px] text-mute">
                {Object.entries(score.failed).map(([rule, count]) => `${rule} ${count}`).join(', ') || '–'}
                {score.errors > 0 && <span className="text-red-600 dark:text-red-400"> · {score.errors} errors</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
