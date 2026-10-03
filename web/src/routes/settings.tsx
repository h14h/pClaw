import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Fragment } from 'react'
import type { ModelInfo, ModelOption, ModelsUpdate, SearchUpdate, Settings } from '../../../src/dashboard/types'
import { put, settingsQuery } from '../api'
import { FileSections } from '../files'
import { Shell } from '../ui'

export const Route = createFileRoute('/settings')({
  loader: ({ context }) => context.queryClient.ensureQueryData(settingsQuery()),
  component: SettingsPage,
})

type Which = 'front' | 'worker'

function SettingsPage() {
  const { data: settings } = useSuspenseQuery(settingsQuery())
  return (
    <Shell left={<><span className="text-faint">/</span><span>settings</span></>}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-7 px-3 py-4">
          <Models settings={settings} />
          <Search settings={settings} />
          <FileSections files={settings.files} />
        </div>
      </div>
    </Shell>
  )
}

const select = 'rounded border border-line bg-bg px-1.5 py-0.5 text-[13px]'
const key = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`

/** The new model's level nearest to the old one: the same level if it has it, else the same rung on its ladder. */
function nearestLevel(from: ModelOption | undefined, level: string, to: ModelOption) {
  if (to.thinkingLevels.includes(level)) return level
  const rung = from ? from.thinkingLevels.indexOf(level) : -1
  return to.thinkingLevels[rung < 0 ? Math.ceil((to.thinkingLevels.length - 1) / 2) : Math.min(rung, to.thinkingLevels.length - 1)]!
}

function Models({ settings }: { settings: Settings }) {
  const client = useQueryClient()
  const save = useMutation({
    mutationFn: (update: ModelsUpdate) => put<Settings>('/api/settings/models', update),
    onSuccess: (data) => {
      client.setQueryData(settingsQuery().queryKey, data)
      client.invalidateQueries({ queryKey: ['overview'] })
    },
  })
  const rows: [Which, string, string][] = [
    ['front', 'front', 'talks to you'],
    ['worker', 'workers', 'do the real work'],
  ]
  return (
    <section>
      <h2 className="mb-2 text-[11px] font-medium text-faint">Models</h2>
      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 sm:grid-cols-[4.5rem_auto_auto_minmax(0,1fr)]">
        {rows.map(([which, label, hint]) => {
          const current = settings[which]
          const option = settings.models.find((m) => key(m) === `${current.provider}/${current.model}`)
          // Keep an unlisted current model selectable rather than showing the wrong one.
          const options = option ? settings.models : [...settings.models, { provider: current.provider, id: current.model, name: current.model, thinkingLevels: [current.thinkingLevel] }]
          const levels = option?.thinkingLevels ?? [current.thinkingLevel]
          const change = (info: ModelInfo) => save.mutate({ [which]: info })
          return (
            <Fragment key={which}>
              <span className="text-mute">{label}</span>
              <select
                className={`${select} justify-self-start`}
                value={`${current.provider}/${current.model}`}
                onChange={(e) => {
                  const next = options.find((m) => key(m) === e.target.value)!
                  change({ provider: next.provider, model: next.id, thinkingLevel: nearestLevel(option, current.thinkingLevel, next) })
                }}
              >
                {options.map((m) => <option key={key(m)} value={key(m)}>{m.name}</option>)}
              </select>
              <label className="col-start-2 flex items-center gap-1.5 text-[12px] text-faint sm:col-start-3">
                <select className={`${select} text-fg`} value={current.thinkingLevel} onChange={(e) => change({ ...current, thinkingLevel: e.target.value })}>
                  {levels.map((l) => <option key={l}>{l}</option>)}
                </select>
                reasoning
              </label>
              <span className="hidden text-[12px] text-faint sm:block">{hint}</span>
            </Fragment>
          )
        })}
      </div>
      <p className="mt-2 min-h-5 text-[12px]">
        {save.isPending && <span className="text-faint">saving…</span>}
        {save.isError && <span className="text-red-600 dark:text-red-400">{save.error.message}</span>}
        {!save.isPending && !save.isError && <span className="text-faint">Changes apply to the next request.</span>}
      </p>
    </section>
  )
}

/** Which service searches the web and which reads pages. A service without an API key is listed but can't be picked. */
function Search({ settings }: { settings: Settings }) {
  const client = useQueryClient()
  const save = useMutation({
    mutationFn: (update: SearchUpdate) => put<Settings>('/api/settings/search', update),
    onSuccess: (data) => client.setQueryData(settingsQuery().queryKey, data),
  })
  const rows: [keyof SearchUpdate, string, string][] = [
    ['search', 'search', 'web searches'],
    ['pages', 'pages', 'reading pages'],
  ]
  return (
    <section>
      <h2 className="mb-2 text-[11px] font-medium text-faint">Search</h2>
      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 sm:grid-cols-[4.5rem_auto_minmax(0,1fr)]">
        {rows.map(([field, label, hint]) => (
          <Fragment key={field}>
            <span className="text-mute">{label}</span>
            <select className={`${select} justify-self-start`} value={settings.search[field]} onChange={(e) => save.mutate({ [field]: e.target.value })}>
              {settings.search.services.map((s) => (
                <option key={s.id} value={s.id} disabled={!s.ready}>{s.name}{s.ready ? '' : ' (no key)'}</option>
              ))}
            </select>
            <span className="hidden text-[12px] text-faint sm:block">{hint}</span>
          </Fragment>
        ))}
      </div>
      {save.isPending && <p className="mt-2 text-[12px] text-faint">saving…</p>}
      {save.isError && <p className="mt-2 text-[12px] text-red-600 dark:text-red-400">{save.error.message}</p>}
    </section>
  )
}
