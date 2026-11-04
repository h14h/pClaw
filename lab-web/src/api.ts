import { queryOptions } from '@tanstack/react-query'
import type { RunRequest, RunSummary, RunView, Setup } from '../../src/prose-lab/types'

async function request<T>(path: string, init?: { method: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, init && { method: init.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body ?? {}) })
  if (!res.ok) {
    const detail = await res.json().catch(() => undefined)
    throw new Error(detail?.error ?? `${res.status} ${res.statusText}`)
  }
  return res.json()
}

export const setupQuery = () => queryOptions({ queryKey: ['setup'], queryFn: () => request<Setup>('/api/setup') })

export const runsQuery = () =>
  queryOptions({
    queryKey: ['runs'],
    queryFn: () => request<RunSummary[]>('/api/runs'),
    refetchInterval: (query) => (query.state.data?.some((run) => run.status === 'running') ? 3000 : false),
  })

export const runQuery = (id: string) =>
  queryOptions({
    queryKey: ['run', id],
    queryFn: () => request<RunView>(`/api/runs/${encodeURIComponent(id)}`),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 2000 : false),
  })

export const startRun = (body: RunRequest) => request<RunSummary>('/api/runs', { method: 'POST', body })

export const stopRun = (id: string) => request<RunSummary>(`/api/runs/${encodeURIComponent(id)}/stop`, { method: 'POST' })
