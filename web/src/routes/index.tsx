import { createFileRoute, redirect } from '@tanstack/react-router'
import { overviewQuery } from '../api'
import { Shell } from '../ui'

export const Route = createFileRoute('/')({
  loader: async ({ context }) => {
    const { conversations } = await context.queryClient.ensureQueryData(overviewQuery())
    // The DM is home; the others are reachable from its aside.
    const home = conversations.find((c) => c.address.startsWith('discord:dm')) ?? conversations[0]
    if (home) throw redirect({ to: '/c/$id', params: { id: home.id } })
  },
  component: () => (
    <Shell>
      <p className="p-4 text-mute">No conversations yet. Message the bot to start one.</p>
    </Shell>
  ),
})
