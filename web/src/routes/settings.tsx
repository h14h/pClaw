import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, useBlocker } from '@tanstack/react-router'
import { Fragment, useCallback, useEffect, useState } from 'react'
import type { ModelInfo, ModelOption, ModelsUpdate, PromptFile, Settings } from '../../../src/dashboard/types'
import { put, settingsQuery } from '../api'
import { Editor } from '../editor'
import { Shell, Tag } from '../ui'

export const Route = createFileRoute('/settings')({
  loader: ({ context }) => context.queryClient.ensureQueryData(settingsQuery()),
  component: SettingsPage,
})

type Which = 'front' | 'worker'

function SettingsPage() {
  const { data: settings } = useSuspenseQuery(settingsQuery())
  const [dirty, setDirty] = useState<Record<Which, boolean>>({ front: false, worker: false })
  const markDirty = useCallback((which: Which, value: boolean) => setDirty((s) => (s[which] === value ? s : { ...s, [which]: value })), [])
  const anyDirty = dirty.front || dirty.worker
  useBlocker({
    shouldBlockFn: () => anyDirty && !window.confirm('You have unsaved prompt changes. Leave and lose them?'),
    enableBeforeUnload: anyDirty,
  })
  return (
    <Shell left={<><span className="text-faint">/</span><span>settings</span></>}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 px-3 py-4">
          <Models settings={settings} />
          <Prompt which="front" file={settings.prompts.front} onDirty={markDirty} />
          <Prompt which="worker" file={settings.prompts.worker} onDirty={markDirty} />
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

function Prompt({ which, file, onDirty }: { which: Which; file: PromptFile; onDirty: (which: Which, dirty: boolean) => void }) {
  const client = useQueryClient()
  // `origin` is the saved text this draft started from. The draft is left alone once it differs from that.
  const [draft, setDraft] = useState(file.text)
  const [origin, setOrigin] = useState(file.text)
  const dirty = draft !== file.text
  const movedOnDisk = dirty && origin !== file.text
  useEffect(() => {
    if (draft === origin && file.text !== origin) {
      setDraft(file.text)
      setOrigin(file.text)
    }
  }, [file.text, draft, origin])
  useEffect(() => onDirty(which, dirty), [which, dirty, onDirty])

  const save = useMutation({
    mutationFn: (text: string) => put<Settings>(`/api/settings/prompts/${which}`, { text }),
    onSuccess: (data) => {
      client.setQueryData(settingsQuery().queryKey, data)
      setOrigin(data.prompts[which].text)
    },
  })
  const discard = () => {
    setDraft(file.text)
    setOrigin(file.text)
    save.reset()
  }
  const name = which === 'front' ? 'Front prompt' : 'Worker prompt'
  return (
    <section>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-medium">{name}</h2>
        <span className="font-mono text-[12px] text-faint">{file.path}</span>
        <span className="flex-1" />
        {dirty && !save.isPending && <Tag tone="amber">unsaved</Tag>}
        {save.isPending && <span className="text-[12px] text-faint">saving…</span>}
        {dirty && (
          <button type="button" onClick={discard} className="text-[12px] text-mute hover:text-fg">discard</button>
        )}
        <button
          type="button"
          onClick={() => save.mutate(draft)}
          disabled={!dirty || save.isPending}
          title="Ctrl-S or :w"
          className="rounded border border-line px-2 py-0.5 text-[12px] enabled:hover:border-mute disabled:text-faint"
        >
          save
        </button>
      </div>
      <p className="mb-2 text-[12px] text-mute">{file.description}</p>
      {save.isError && <p className="mb-2 text-[12px] text-red-600 dark:text-red-400">Not saved: {save.error.message}</p>}
      {movedOnDisk && <p className="mb-2 text-[12px] text-amber-700 dark:text-amber-400">This file changed on disk while you were editing. Saving overwrites it; discard loads the new version.</p>}
      <Editor text={draft} onChange={setDraft} onSave={() => dirty && save.mutate(draft)} />
    </section>
  )
}
