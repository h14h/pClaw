import { useMutation, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { Contender, RunRequest, Setup, Thinking } from '../../../src/prose-lab/types'
import { runQuery, runsQuery, setupQuery, startRun } from '../api'
import { Scores, Status, when } from '../ui'

const THINKING: Thinking[] = ['off', 'minimal', 'low', 'medium', 'high']
const DRAFT = 'prose-lab:draft'

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): { from?: string } => (typeof search.from === 'string' ? { from: search.from } : {}),
  loader: ({ context }) => context.queryClient.ensureQueryData(setupQuery()),
  component: Home,
})

type Draft = Omit<RunRequest, 'typed'> & { typed: string }

function initial(setup: Setup): Draft {
  const saved = localStorage.getItem(DRAFT)
  if (saved) {
    const draft = JSON.parse(saved) as Draft
    // Scenarios deleted since the draft was saved would fail the run.
    return { ...draft, scenarios: draft.scenarios.filter((name) => setup.scenarios.some((each) => each.name === name)) }
  }
  return {
    contenders: [{ label: 'live', prompt: setup.live.discord ?? '' }, { label: 'B', prompt: setup.live.discord ?? '' }],
    scenarios: setup.scenarios.map((each) => each.name),
    typed: '',
    runs: 1,
    platform: 'discord',
    judging: true,
    thinking: setup.thinking,
  }
}

function Home() {
  const { from } = Route.useSearch()
  const setup = useSuspenseQuery(setupQuery()).data
  const [draft, setDraft] = useState<Draft>(() => initial(setup))
  const source = useQuery({ ...runQuery(from ?? ''), enabled: from !== undefined })
  const navigate = useNavigate()

  // "Edit and rerun" from a run page: take its prompts and settings once, then drop the search param.
  useEffect(() => {
    const run = source.data
    if (run === undefined) return
    setDraft({ ...run.request, typed: run.request.typed.join('\n\n'), scenarios: run.request.scenarios.filter((name) => setup.scenarios.some((each) => each.name === name)) })
    void navigate({ to: '/', search: {}, replace: true })
  }, [source.data, setup.scenarios, navigate])

  useEffect(() => localStorage.setItem(DRAFT, JSON.stringify(draft)), [draft])

  const typed = draft.typed.split(/\n\s*\n/).map((text) => text.trim()).filter(Boolean)
  const total = draft.contenders.length * (draft.scenarios.length + typed.length) * draft.runs
  const start = useMutation({
    mutationFn: () => startRun({ ...draft, typed }),
    onSuccess: (run) => navigate({ to: '/runs/$id', params: { id: run.id } }),
  })
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }))
  const setContender = (index: number, patch: Partial<Contender>) =>
    set({ contenders: draft.contenders.map((each, at) => (at === index ? { ...each, ...patch } : each)) })

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-5 p-3 sm:p-4">
      <p className="text-[13px] text-mute">
        Each prompt answers the same moments from your Discord history with {setup.model}, pclaw's tools stubbed out. Replies are checked against Discord's rules, then {setup.judge} scores how they read.
      </p>

      <section className="grid gap-3 lg:grid-cols-2">
        {draft.contenders.map((contender, index) => (
          <div key={index} className="flex min-w-0 flex-col gap-1.5">
            <div className="flex items-center gap-2 text-[12px]">
              <span className="font-mono text-faint">{String.fromCharCode(65 + index)}</span>
              <input
                value={contender.label}
                onChange={(event) => setContender(index, { label: event.target.value })}
                placeholder="label"
                className="w-40 rounded border border-line bg-bg px-1.5 py-0.5 text-fg"
              />
              <span className="flex-1" />
              <button className="text-mute hover:text-fg" onClick={() => setContender(index, { prompt: setup.live[draft.platform] ?? '' })}>use live prompt</button>
              <button className="text-mute hover:text-fg" onClick={() => setContender(index, { prompt: '' })}>clear</button>
            </div>
            <textarea
              value={contender.prompt}
              onChange={(event) => setContender(index, { prompt: event.target.value })}
              spellCheck={false}
              placeholder="Empty sends no system prompt at all."
              className="h-[55vh] min-h-48 resize-y rounded border border-line bg-panel p-2 font-mono text-[12px] leading-[1.5] text-fg outline-none focus:border-faint"
            />
            <span className="text-right text-[11px] text-faint tabular-nums">{contender.prompt.length.toLocaleString()} chars</span>
          </div>
        ))}
      </section>

      <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-3 text-[12px]">
            <h2 className="font-semibold text-[13px]">Scenarios</h2>
            <span className="text-faint">{draft.scenarios.length} of {setup.scenarios.length}</span>
            <span className="flex-1" />
            <button className="text-mute hover:text-fg" onClick={() => set({ scenarios: setup.scenarios.map((each) => each.name) })}>all</button>
            <button className="text-mute hover:text-fg" onClick={() => set({ scenarios: [] })}>none</button>
          </div>
          <ul className="max-h-80 overflow-y-auto rounded border border-line">
            {setup.scenarios.map((scenario) => {
              const on = draft.scenarios.includes(scenario.name)
              return (
                <li key={scenario.name} className="border-b border-line last:border-0">
                  <label className="flex cursor-pointer items-baseline gap-2 px-2 py-1 hover:bg-panel">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => set({ scenarios: on ? draft.scenarios.filter((name) => name !== scenario.name) : [...draft.scenarios, scenario.name] })}
                    />
                    <span className="w-44 shrink-0 truncate font-mono text-[11px] text-faint">{scenario.name}</span>
                    <span className="truncate text-[13px]">{scenario.ask.replace(/^\[[^\]]*\]\s*/, '')}</span>
                  </label>
                </li>
              )
            })}
          </ul>
          <label className="mt-2 flex flex-col gap-1 text-[12px] text-mute">
            Your own messages, answered with no history. Leave a blank line between them.
            <textarea
              value={draft.typed}
              onChange={(event) => set({ typed: event.target.value })}
              placeholder={'should i play ac origins or odyssey first?\n\nwhat should i get my mom for her birthday'}
              className="h-28 resize-y rounded border border-line bg-panel p-2 text-[13px] text-fg outline-none focus:border-faint"
            />
          </label>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
            <label className="flex items-center gap-1.5">
              runs per scenario
              <input
                type="number"
                min={1}
                max={10}
                value={draft.runs}
                onChange={(event) => set({ runs: Math.max(1, Math.min(10, Number(event.target.value) || 1)) })}
                className="w-14 rounded border border-line bg-bg px-1.5 py-0.5"
              />
            </label>
            <label className="flex items-center gap-1.5">
              thinking
              <select value={draft.thinking} onChange={(event) => set({ thinking: event.target.value as Thinking })} className="rounded border border-line bg-bg px-1 py-0.5">
                {THINKING.map((level) => <option key={level}>{level}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={draft.judging} onChange={(event) => set({ judging: event.target.checked })} />
              judge
            </label>
            <span className="text-mute">platform: {draft.platform}</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              disabled={total === 0 || start.isPending}
              onClick={() => start.mutate()}
              className="rounded bg-fg px-3 py-1.5 text-[13px] font-medium text-bg disabled:opacity-40"
            >
              {start.isPending ? 'Starting…' : `Run ${total} ${total === 1 ? 'reply' : 'replies'}`}
            </button>
            <span className="text-[12px] text-faint">about a dozen at a time; a full set takes a few minutes</span>
          </div>
          {start.error && <p className="text-[13px] text-red-600 dark:text-red-400">{start.error.message}</p>}
          <PastRuns />
        </div>
      </section>
    </main>
  )
}

function PastRuns() {
  const runs = useQuery(runsQuery()).data ?? []
  if (runs.length === 0) return null
  return (
    <div className="mt-2 flex flex-col gap-1">
      <h2 className="font-semibold text-[13px]">Past runs</h2>
      <ul className="flex flex-col">
        {runs.map((run) => (
          <li key={run.id} className="border-b border-line py-1.5 last:border-0">
            <Link to="/runs/$id" params={{ id: run.id }} className="flex flex-col gap-0.5 hover:opacity-80">
              <span className="flex items-center gap-2 text-[13px]">
                <span className="font-medium">{run.labels.join(' vs ')}</span>
                <Status run={run} />
                <span className="flex-1" />
                <span className="text-[11px] text-faint">{when(run.startedAt)}</span>
              </span>
              {run.scores.length > 0 && <Scores scores={run.scores} labels={run.labels} compact />}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
