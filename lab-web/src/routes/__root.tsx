import type { QueryClient } from '@tanstack/react-query'
import { Link, Outlet, createRootRouteWithContext } from '@tanstack/react-router'
import '../styles.css'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3 text-[13px]">
        <Link to="/" search={{}} className="font-semibold">prose lab</Link>
      </header>
      <Outlet />
    </div>
  ),
  errorComponent: ({ error }) => <p className="p-4 text-red-600 dark:text-red-400">{error instanceof Error ? error.message : String(error)}</p>,
  notFoundComponent: () => <p className="p-4 text-mute">Not found.</p>,
})
