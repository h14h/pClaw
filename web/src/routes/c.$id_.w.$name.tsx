import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import type { WorkerDetail, WorkerItem } from '../../../src/dashboard/types'
import { conversationQuery, workerQuery } from '../api'
import { Md } from '../md'
import { Clamp, Row, Shell, Tag, ToolCall, WorkerState, summarize, useStickToBottom } from '../ui'

export const Route = createFileRoute('/c/$id_/w/$name')({
  loader: ({ context, params }) =>
    Promise.all([context.queryClient.ensureQueryData(workerQuery(params.id, params.name)), context.queryClient.ensureQueryData(conversationQuery(params.id))]),
  component: Worker,
})

function Worker() {
  const { id, name } = Route.useParams()
  const { data: w } = useSuspenseQuery(workerQuery(id, name))
  const { data: c } = useSuspenseQuery(conversationQuery(id))
  const working = w.status === 'working'
  // Follow along while it works; a finished transcript opens at the top, with the brief.
  const ref = useStickToBottom<HTMLDivElement>(working)
  const lastText = w.transcript.filter((t) => t.kind === 'text').at(-1)
  return (
    <Shell
      left={
        <>
          <span className="text-faint">/</span>
          <Link to="/c/$id" params={{ id }} className="truncate text-mute hover:text-fg">{c.label}</Link>
          <span className="text-faint">/</span>
          <span className="truncate font-mono text-[12px]">{w.name}</span>
          <span className="shrink-0 text-[12px]"><WorkerState worker={w} /></span>
        </>
      }
      right={<span className="hidden text-[11px] text-faint sm:inline">{w.model.model} · {w.model.thinkingLevel}</span>}
    >
      <div ref={ref} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-2 py-2 sm:px-3">
          {w.transcript.map((item, i) => (
            <Item key={i} item={item} worker={w} isReport={!working && item === lastText} />
          ))}
          {working && <p className="py-2 pl-[3rem] text-[12px] text-faint sm:pl-[6.5rem]">…</p>}
        </div>
      </div>
    </Shell>
  )
}

function Item({ item, worker, isReport }: { item: WorkerItem; worker: WorkerDetail; isReport: boolean }) {
  switch (item.kind) {
    case 'from-pclaw':
      return (
        <Row at={item.at} who="pclaw" whoClass="text-sky-700 dark:text-sky-400">
          <Md text={item.text} className="rounded bg-you px-2 py-1" />
        </Row>
      )
    case 'text':
      return (
        <Row at={item.at} who={isReport ? <>{worker.name} <Tag>report</Tag></> : worker.name}>
          <Md text={item.text} />
        </Row>
      )
    case 'thinking':
      return (
        <Row at={item.at} who="thinking" whoClass="text-faint">
          <Clamp max="max-h-10">
            <p className="whitespace-pre-wrap text-[13px] text-mute">{item.text}</p>
          </Clamp>
        </Row>
      )
    case 'tool':
      return (
        <Row at={item.at} who={item.name} whoClass="font-mono text-mute">
          <ToolCall summary={summarize(item.args)} args={item.args} result={item.result} isError={item.isError} running={item.result === undefined && worker.status === 'working'} />
        </Row>
      )
  }
}
