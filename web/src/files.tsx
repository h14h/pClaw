import { Link } from '@tanstack/react-router'
import type { FileSummary } from '../../src/dashboard/types'
import { ago, useNow } from './time'
import { k } from './ui'

const GROUPS: [FileSummary['group'], string][] = [
  ['prompts', 'Prompts'],
  ['formatting', 'Formatting'],
  ['skills', 'Skills'],
]

function grouped(files: FileSummary[]) {
  return GROUPS.map(([group, label]) => ({ group, label, files: files.filter((f) => f.group === group) })).filter((g) => g.files.length)
}

/** A file's label. Skill files carry their skill's name, faint, so the list stays flat: "web-page/SKILL.md". */
export function FileName({ file }: { file: FileSummary }) {
  return (
    <>
      {file.skill && <span className="text-faint">{file.skill}/</span>}
      {file.name}
    </>
  )
}

/** The settings page's file lists: one section per group, one line per file, each a link to its editor. */
export function FileSections({ files }: { files: FileSummary[] }) {
  const now = useNow(30_000)
  return grouped(files).map(({ group, label, files }) => (
    <section key={group}>
      <h2 className="mb-1 text-[11px] font-medium text-faint">{label}</h2>
      <div className="-mx-2">
        {files.map((f) => (
          <Link
            key={f.id}
            to="/settings/files/$"
            params={{ _splat: f.id }}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 rounded px-2 py-1 hover:bg-panel sm:grid-cols-[15rem_minmax(0,1fr)_2.5rem_5.5rem]"
          >
            <span className="truncate"><FileName file={f} /></span>
            <span className="col-span-2 row-start-2 truncate text-[12px] text-mute sm:col-span-1 sm:col-start-2 sm:row-start-1">{f.description}</span>
            <span className="hidden text-right font-mono text-[11px] text-faint tabular-nums sm:col-start-3 sm:row-start-1 sm:block">{k(f.size)}</span>
            <span className="col-start-2 row-start-1 whitespace-nowrap text-right text-[11px] text-faint sm:col-start-4">{ago(f.modifiedAt, now)}</span>
          </Link>
        ))}
      </div>
    </section>
  ))
}

/** The narrow file list beside an open editor (desktop only). The current file is highlighted. */
export function FileSide({ files, current }: { files: FileSummary[]; current: string }) {
  return (
    <nav className="hidden w-60 shrink-0 overflow-y-auto border-r border-line px-2 py-3 text-[13px] sm:block">
      {grouped(files).map(({ group, label, files }) => (
        <div key={group} className="mb-3">
          <h2 className="mb-0.5 px-2 text-[11px] font-medium text-faint">{label}</h2>
          {files.map((f) => (
            <Link
              key={f.id}
              to="/settings/files/$"
              params={{ _splat: f.id }}
              title={f.description}
              className={`block truncate rounded px-2 py-0.5 ${f.id === current ? 'bg-panel text-fg' : 'text-mute hover:text-fg'}`}
            >
              <FileName file={f} />
            </Link>
          ))}
        </div>
      ))}
    </nav>
  )
}
