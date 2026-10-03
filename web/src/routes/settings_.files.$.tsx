import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute, useBlocker } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { FileContent } from '../../../src/dashboard/types'
import { fileQuery, fileUrl, put, settingsQuery } from '../api'
import { Editor } from '../editor'
import { FileName, FileSide } from '../files'
import { Shell, Tag } from '../ui'

// One file open at a time, filling the window. The id is the rest of the URL: /settings/files/skills/web-page/STYLE.md.
export const Route = createFileRoute('/settings_/files/$')({
  loader: ({ context, params }) =>
    Promise.all([context.queryClient.ensureQueryData(settingsQuery()), context.queryClient.ensureQueryData(fileQuery(params._splat ?? ''))]),
  component: FilePage,
})

function FilePage() {
  const id = Route.useParams()._splat ?? ''
  const { data: settings } = useSuspenseQuery(settingsQuery())
  const { data: file } = useSuspenseQuery(fileQuery(id))
  return (
    <Shell
      left={
        <>
          <span className="text-faint">/</span>
          <Link to="/settings" className="text-mute hover:text-fg">settings</Link>
          <span className="text-faint">/</span>
          <span className="truncate"><FileName file={file} /></span>
        </>
      }
    >
      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1">
        <FileSide files={settings.files} current={id} />
        {/* Keyed so a different file starts a fresh draft; the blocker below asks first if this one is unsaved. */}
        <FileEditor key={id} file={file} />
      </div>
    </Shell>
  )
}

function FileEditor({ file }: { file: FileContent }) {
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
  useBlocker({
    shouldBlockFn: () => dirty && !window.confirm(`${file.name} has unsaved changes. Leave and lose them?`),
    enableBeforeUnload: dirty,
  })

  const save = useMutation({
    mutationFn: (text: string) => put<FileContent>(fileUrl(file.id), { text }),
    onSuccess: (data) => {
      client.setQueryData(fileQuery(file.id).queryKey, data)
      setOrigin(data.text)
      // The list shows size and time.
      client.invalidateQueries({ queryKey: ['settings'] })
    },
  })
  const discard = () => {
    setDraft(file.text)
    setOrigin(file.text)
    save.reset()
  }
  return (
    <div className="flex min-w-0 flex-1 flex-col px-3 pb-3 pt-2">
      <div className="flex items-center gap-x-3 whitespace-nowrap">
        <span className="min-w-0 truncate font-mono text-[12px] text-faint">{file.path}</span>
        <span className="flex-1" />
        {dirty && !save.isPending && <span className="shrink-0"><Tag tone="amber">unsaved</Tag></span>}
        {save.isPending && <span className="shrink-0 text-[12px] text-faint">saving…</span>}
        {dirty && (
          <button type="button" onClick={discard} className="shrink-0 text-[12px] text-mute hover:text-fg">discard</button>
        )}
        <button
          type="button"
          onClick={() => save.mutate(draft)}
          disabled={!dirty || save.isPending}
          title="Ctrl-S or :w"
          className="shrink-0 rounded border border-line px-2 py-0.5 text-[12px] enabled:hover:border-mute disabled:text-faint"
        >
          save
        </button>
      </div>
      <p className="mb-2 mt-0.5 truncate text-[12px] text-mute" title={file.description}>{file.description}</p>
      {save.isError && <p className="mb-2 text-[12px] text-red-600 dark:text-red-400">Not saved: {save.error.message}</p>}
      {movedOnDisk && <p className="mb-2 text-[12px] text-amber-700 dark:text-amber-400">This file changed on disk while you were editing. Saving overwrites it; discard loads the new version.</p>}
      <div className="min-h-0 flex-1">
        <Editor text={draft} onChange={setDraft} onSave={() => dirty && save.mutate(draft)} />
      </div>
    </div>
  )
}
