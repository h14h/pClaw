import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import type { TimelineItem, WorkerSummary } from '../../src/dashboard/types'
import { Md } from './md'
import { day, dayKey } from './time'
import { Clamp, DayBreak, Row, Tag, ToolCall, WorkerState, k, summarize, useStickToBottom } from './ui'

const who = (item: TimelineItem) => (item.kind === 'message' ? 'you' : item.kind === 'event' ? (item.worker ?? 'follow-up') : 'pclaw')

export function Timeline({ items, workers, conversationId }: { items: TimelineItem[]; workers: WorkerSummary[]; conversationId: string }) {
  const ref = useStickToBottom<HTMLDivElement>()
  const byName = new Map(workers.map((w) => [w.name, w]))
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-2 py-2 sm:px-3">
        {items.length === 0 && <p className="py-6 text-center text-mute">Nothing here yet.</p>}
        {items.map((item, i) => {
          const prev = items[i - 1]
          return (
            <div key={item.id}>
              {(!prev || dayKey(prev.at) !== dayKey(item.at)) && <DayBreak label={day(item.at)} />}
              <Item item={item} who={!prev || who(prev) !== who(item) ? who(item) : undefined} worker={item.kind === 'tool' && item.worker ? byName.get(item.worker) : undefined} conversationId={conversationId} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Item({ item, who, worker, conversationId }: { item: TimelineItem; who?: string; worker?: WorkerSummary; conversationId: string }) {
  switch (item.kind) {
    case 'message':
      return (
        <Row at={item.at} who={who} whoClass="text-sky-700 dark:text-sky-400">
          <Md text={item.text} className="rounded bg-you px-2 py-1" />
          {item.images > 0 && <div className="mt-0.5 text-[11px] text-faint">{item.images === 1 ? '1 image' : `${item.images} images`}</div>}
        </Row>
      )
    case 'reply':
      return (
        <Row at={item.at} who={who}>
          <Reply item={item} />
        </Row>
      )
    case 'tool':
      return (
        <Row at={item.at} who={who}>
          <ToolCall
            lead={
              <>
                <span className="shrink-0 text-mute">{item.name}</span>
                {item.worker && (
                  <>
                    <Link to="/c/$id/w/$name" params={{ id: conversationId, name: item.worker }} className="shrink-0 underline decoration-faint underline-offset-2 hover:decoration-current">
                      {item.worker}
                    </Link>
                    {worker && <span className="shrink-0 text-[11px]"><WorkerState worker={worker} /></span>}
                  </>
                )}
              </>
            }
            summary={summarize(item.args, item.worker)}
            args={item.args}
            result={item.result}
            isError={item.isError}
            running={item.result === undefined}
          />
        </Row>
      )
    case 'event':
      return (
        <Row at={item.at} who={who} whoClass="text-mute">
          <div className="border-l-2 border-line pl-2">
            <div className="mb-0.5 text-[11px] text-faint">
              {item.event === 'worker-report' ? 'report' : 'follow-up fired'}
              {item.ok === false && <> <Tag tone="red">failed</Tag></>}
            </div>
            <Clamp>
              <Md text={item.text} />
            </Clamp>
          </div>
        </Row>
      )
  }
}

function Reply({ item }: { item: Extract<TimelineItem, { kind: 'reply' }> }) {
  const [open, setOpen] = useState(false)
  const held = !item.delivered
  return (
    <div onClick={() => setOpen(!open)} className="cursor-default">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <Md text={item.text} className={`min-w-0 ${held ? 'text-mute' : ''}`} />
        {item.held && <Tag>{item.held}</Tag>}
        {item.error && <Tag tone="red">error</Tag>}
      </div>
      {item.error && <div className="mt-0.5 text-[12px] text-red-600 dark:text-red-400">{item.error}</div>}
      {open && (
        <div className="mt-0.5 text-[11px] text-faint">
          {item.model} · {k(item.usage.input)} in · {k(item.usage.output)} out · {k(item.usage.cacheRead)} cached
          {item.held === 'superseded' && ' · written before a tool call, replaced by the next reply'}
          {item.held === 'silent' && ' · the model chose NO_REPLY'}
        </div>
      )}
    </div>
  )
}
