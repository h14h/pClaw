import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute, redirect } from '@tanstack/react-router'
import { overviewQuery } from '../api'
import { Shell } from '../ui'

export const Route = createFileRoute('/')({
  loader: async ({ context }) => {
    const overview = await context.queryClient.ensureQueryData(overviewQuery())
    // One conversation is the normal case; go straight to it.
    if (overview.conversations.length === 1) throw redirect({ to: '/c/$id', params: { id: overview.conversations[0]!.id } })
  },
  component: Index,
})

function Index() {
  const { data } = useSuspenseQuery(overviewQuery())
  return (
    <Shell>
      <div className="mx-auto w-full max-w-3xl px-3 py-4">
        {data.conversations.length === 0 && <p className="text-mute">No conversations yet. Message the bot to start one.</p>}
        {data.conversations.map((c) => (
          <Link key={c.id} to="/c/$id" params={{ id: c.id }} className="flex items-baseline gap-3 py-1.5 hover:underline">
            <span>{c.label}</span>
            <span className="font-mono text-[12px] text-faint">{c.address}</span>
            {c.busy && <span className="text-[12px] text-amber-600 dark:text-amber-400">replying</span>}
            {c.workersRunning > 0 && <span className="text-[12px] text-amber-600 dark:text-amber-400">{c.workersRunning} working</span>}
          </Link>
        ))}
      </div>
    </Shell>
  )
}
