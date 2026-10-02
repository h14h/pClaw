import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import type { ConversationView, LiveStatus, Overview, WorkerSummary } from '../../../src/dashboard/types'
import { conversationQuery, overviewQuery } from '../api'
import { Timeline } from '../timeline'
import { clock, day } from '../time'
import { Dot, Elapsed, Shell, WorkerState, k } from '../ui'

export const Route = createFileRoute('/c/$id')({
  loader: ({ context, params }) =>
    Promise.all([context.queryClient.ensureQueryData(conversationQuery(params.id)), context.queryClient.ensureQueryData(overviewQuery())]),
  component: Conversation,
})

function Conversation() {
  const { id } = Route.useParams()
  const { data: c } = useSuspenseQuery(conversationQuery(id))
  const { data: overview } = useSuspenseQuery(overviewQuery())
  const [showAside, setShowAside] = useState(false)
  const others = overview.conversations.filter((o) => o.id !== id)
  return (
    <Shell
      left={
        <>
          <span className="text-faint">/</span>
          <span className="truncate">{c.label}</span>
          {others.map((o) => (
            <Link key={o.id} to="/c/$id" params={{ id: o.id }} className="text-mute hover:text-fg">{o.label}</Link>
          ))}
        </>
      }
      right={
        <button type="button" onClick={() => setShowAside(!showAside)} className="shrink-0 text-mute hover:text-fg lg:hidden">
          {showAside ? 'transcript' : 'details'}
        </button>
      }
    >
      <div className="flex min-h-0 flex-1">
        <main className={`min-h-0 flex-1 flex-col ${showAside ? 'hidden lg:flex' : 'flex'}`}>
          <Timeline items={c.timeline} workers={c.workers} conversationId={id} />
          <Now live={c.live} workers={c.workers} conversationId={id} />
        </main>
        <Aside c={c} overview={overview} className={showAside ? 'flex' : 'hidden lg:flex'} />
      </div>
    </Shell>
  )
}

/** What's happening right now, pinned under the transcript like a typing indicator. */
function Now({ live, workers, conversationId }: { live: LiveStatus; workers: WorkerSummary[]; conversationId: string }) {
  const running = workers.filter((w) => w.status === 'working')
  const quiet = live.state === 'idle' && running.length === 0
  return (
    <div className="shrink-0 border-t border-line">
      <div className="mx-auto max-w-3xl space-y-1 px-3 py-2 text-[13px]">
        {running.map((w) => (
          <Link key={w.name} to="/c/$id/w/$name" params={{ id: conversationId, name: w.name }} className="flex items-center gap-2 hover:underline">
            <Dot status="working" />
            <span className="font-mono text-[12px]">{w.name}</span>
            <span className="text-mute">working{w.startedAt && <> · <Elapsed since={w.startedAt} /></>}</span>
          </Link>
        ))}
        {live.state === 'generating' && (
          <div className="flex items-start gap-2">
            <Dot status="working" />
            <span className="-mt-0.5 shrink-0 text-mute">writing{live.since && <> · <Elapsed since={live.since} /></>}</span>
            {live.text && <span className="-mt-0.5 line-clamp-2 min-w-0 text-mute">{tail(live.text)}</span>}
          </div>
        )}
        {live.state === 'tools' && (
          <div className="flex items-center gap-2">
            <Dot status="working" />
            <span className="text-mute">running <span className="font-mono text-[12px] text-fg">{live.tools.join(', ')}</span></span>
          </div>
        )}
        {quiet && <div className="text-faint">idle</div>}
      </div>
    </div>
  )
}

/** The end of a partial reply, which is where the writing is happening. */
const tail = (text: string, max = 240) => (text.length > max ? `…${text.slice(-max)}` : text)

function Aside({ c, overview, className }: { c: ConversationView; overview: Overview; className: string }) {
  const notes = overview.notes.trim()
  return (
    <aside className={`${className} w-full shrink-0 flex-col gap-5 overflow-y-auto border-line px-3 py-3 text-[13px] lg:w-72 lg:border-l`}>
      <Section title="Workers">
        {c.workers.length === 0 && <p className="text-faint">none yet</p>}
        {c.workers.map((w) => (
          <Link key={w.name} to="/c/$id/w/$name" params={{ id: c.id, name: w.name }} className="flex items-baseline justify-between gap-2 py-0.5 hover:underline">
            <span className="truncate font-mono text-[12px]">{w.name}</span>
            <span className="text-[11px]"><WorkerState worker={w} /></span>
          </Link>
        ))}
      </Section>
      <Section title="Follow-ups">
        {c.followUps.length === 0 && <p className="text-faint">none scheduled</p>}
        {c.followUps.map((f) => (
          <div key={f.id} className="py-0.5">
            <span className="text-mute">{day(f.at)} {clock(f.at)}</span>
            {f.repeat && <span className="text-faint"> · {f.repeat}</span>}
            <div>{f.note}</div>
          </div>
        ))}
      </Section>
      <Section title="Notes">
        {notes ? <pre className="whitespace-pre-wrap font-mono text-[12px] leading-[1.4] text-mute">{notes}</pre> : <p className="text-faint">empty</p>}
      </Section>
      <div className="mt-auto space-y-0.5 pt-4 text-[11px] text-faint">
        <div>front {overview.front.model} · {overview.front.thinkingLevel}</div>
        <div>workers {overview.worker.model} · {overview.worker.thinkingLevel}</div>
        <div>{k(c.usage.input)} in · {k(c.usage.output)} out · {k(c.usage.cacheRead)} cached · ${c.usage.cost.toFixed(2)}</div>
      </div>
    </aside>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-1 text-[11px] font-medium text-faint">{title}</h2>
      {children}
    </section>
  )
}
