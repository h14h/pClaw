import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import type { Result, RunView, ScenarioSummary } from '../../../src/prose-lab/types'
import { runQuery, stopRun } from '../api'
import { Md } from '../md'
import { Scores, Status, Tag, when } from '../ui'

export const Route = createFileRoute('/runs/$id')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(runQuery(params.id)),
  component: RunPage,
})

function RunPage() {
  const { id } = Route.useParams()
  const run = useSuspenseQuery(runQuery(id)).data
  const client = useQueryClient()
  const stop = useMutation({ mutationFn: () => stopRun(id), onSuccess: () => client.invalidateQueries({ queryKey: ['run', id] }) })
  const [raw, setRaw] = useState(false)
  const [onlyFailing, setOnlyFailing] = useState(false)

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        <h1 className="text-[15px] font-semibold">{run.labels.join(' vs ')}</h1>
        <Status run={run} />
        <span className="text-faint">
          {when(run.startedAt)} · {run.model}, {run.request.thinking} thinking · {run.request.runs} per scenario{run.request.judging ? '' : ' · not judged'}
        </span>
        <span className="flex-1" />
        {run.status === 'running' && (
          <button onClick={() => stop.mutate()} disabled={stop.isPending} className="text-mute hover:text-fg">stop</button>
        )}
        <Link to="/" search={{ from: run.id }} className="text-mute hover:text-fg">edit and rerun</Link>
      </div>
      {run.status === 'running' && (
        <div className="h-1 overflow-hidden rounded bg-panel">
          <div className="h-full bg-amber-500 transition-[width]" style={{ width: `${(run.done / run.total) * 100}%` }} />
        </div>
      )}
      {run.error && <p className="text-[13px] text-red-600 dark:text-red-400">{run.error}</p>}

      {run.scores.length > 0 ? <Scores scores={run.scores} labels={run.labels} /> : <p className="text-[13px] text-mute">Waiting for the first replies…</p>}

      <details className="text-[13px]">
        <summary className="cursor-pointer text-mute">prompts</summary>
        <div className="mt-2 grid gap-3 lg:grid-cols-2">
          {run.request.contenders.map((contender, index) => (
            <div key={index} className="min-w-0">
              <div className="mb-1 text-[12px] font-medium">{run.labels[index]}</div>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-panel p-2 font-mono text-[11.5px]">{contender.prompt || '(no system prompt)'}</pre>
            </div>
          ))}
        </div>
      </details>

      <div className="flex items-center gap-4 border-b border-line pb-2 text-[12px] text-mute">
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={raw} onChange={(event) => setRaw(event.target.checked)} /> show markdown as typed</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={onlyFailing} onChange={(event) => setOnlyFailing(event.target.checked)} /> only scenarios with a failed check</label>
      </div>

      {run.scenarios
        .filter((scenario) => !onlyFailing || run.results.some((result) => result.scenario === scenario.name && result.checks.length > 0))
        .map((scenario) => <ScenarioBlock key={scenario.name} run={run} scenario={scenario} raw={raw} />)}
    </main>
  )
}

function ScenarioBlock({ run, scenario, raw }: { run: RunView; scenario: ScenarioSummary; raw: boolean }) {
  const results = run.results.filter((result) => result.scenario === scenario.name)
  const ask = scenario.ask.replace(/^\[[^\]]*\]\s*/, '')
  return (
    <section className="flex flex-col gap-2 border-b border-line pb-4">
      <div className="flex flex-col gap-1">
        <span className="font-mono text-[11px] text-faint">{scenario.name} · {scenario.messages} messages of history</span>
        <p className="whitespace-pre-wrap rounded bg-you px-2 py-1 text-[13px]">{ask.length > 600 ? `${ask.slice(0, 600)}…` : ask}</p>
        {scenario.live !== undefined && (
          <details className="text-[12px]">
            <summary className="cursor-pointer text-mute">what pclaw actually sent ({scenario.live.length} chars)</summary>
            <Reply text={scenario.live} raw={raw} />
          </details>
        )}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {run.request.contenders.map((_, index) => (
          <div key={index} className="flex min-w-0 flex-col gap-2">
            <span className="text-[12px] font-medium">{run.labels[index]}</span>
            {results
              .filter((result) => result.variant === String(index))
              .sort((a, b) => a.run - b.run)
              .map((result) => <ResultCard key={result.run} result={result} raw={raw} />)}
            {run.status === 'running' && results.filter((result) => result.variant === String(index)).length < run.request.runs && (
              <span className="text-[12px] text-faint">writing…</span>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

function ResultCard({ result, raw }: { result: Result; raw: boolean }) {
  return (
    <div className="flex flex-col gap-1 rounded border border-line p-2">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
        <span className="tabular-nums">{result.reply === undefined ? 'no reply' : `${result.reply.length} chars`}</span>
        {result.checks.length === 0 && result.reply !== undefined && <Tag tone="green">passes</Tag>}
        {result.checks.map((check) => (
          <span key={check.rule} title={check.detail}><Tag tone="red">{check.rule}</Tag></span>
        ))}
        {result.tools.map((tool, index) => <Tag key={index}>{tool}</Tag>)}
        {result.judge && (
          <span className="tabular-nums" title="natural / economy / substance">
            judge {result.judge.natural}/{result.judge.economy}/{result.judge.substance}
          </span>
        )}
      </div>
      {result.error && <p className="text-[12px] text-red-600 dark:text-red-400">{result.error}</p>}
      {result.reply !== undefined && <Reply text={result.reply} raw={raw} />}
      {result.judge && <p className="text-[12px] italic text-mute">{result.judge.note}</p>}
    </div>
  )
}

function Reply({ text, raw }: { text: string; raw: boolean }) {
  return raw ? <pre className="whitespace-pre-wrap font-mono text-[12px]">{text}</pre> : <Md text={text} className="text-[13.5px]" />
}
