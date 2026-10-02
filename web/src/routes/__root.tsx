import type { QueryClient } from '@tanstack/react-query'
import { Outlet, createRootRouteWithContext } from '@tanstack/react-router'
import { useLiveChanges } from '../api'
import '../styles.css'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Root,
  errorComponent: ({ error }) => <p className="p-4 text-red-600 dark:text-red-400">{error instanceof Error ? error.message : String(error)}</p>,
  notFoundComponent: () => <p className="p-4 text-mute">Not found.</p>,
})

function Root() {
  const { connected } = useLiveChanges()
  return (
    <>
      {!connected && <div className="fixed inset-x-0 top-0 z-10 bg-red-600 py-0.5 text-center text-[11px] text-white">connection lost, retrying</div>}
      <Outlet />
    </>
  )
}
