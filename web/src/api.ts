import { queryOptions, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { Change, ConversationView, Overview, Settings, WorkerDetail } from '../../src/dashboard/types'

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`)
  return res.json()
}

/** PUT JSON; a 400's `{ error }` becomes the thrown message. */
export async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) {
    const detail = await res.json().catch(() => undefined)
    throw new Error(detail?.error ?? `${res.status} ${res.statusText}`)
  }
  return res.json()
}

const enc = encodeURIComponent

export const overviewQuery = () => queryOptions({ queryKey: ['overview'], queryFn: () => get<Overview>('/api/overview') })

export const settingsQuery = () => queryOptions({ queryKey: ['settings'], queryFn: () => get<Settings>('/api/settings') })

export const conversationQuery = (id: string) =>
  queryOptions({ queryKey: ['conversation', id], queryFn: () => get<ConversationView>(`/api/conversations/${enc(id)}`) })

export const workerQuery = (id: string, name: string) =>
  queryOptions({ queryKey: ['worker', id, name], queryFn: () => get<WorkerDetail>(`/api/conversations/${enc(id)}/workers/${enc(name)}`) })

function keyFor(change: Change) {
  switch (change.scope) {
    case 'overview': return ['overview']
    case 'settings': return ['settings']
    case 'conversation': return ['conversation', change.id]
    case 'worker': return ['worker', change.conversationId, change.name]
  }
}

/** The app's one EventSource. Refetches whatever a change touches, and everything after a reconnect. */
export function useLiveChanges(): { connected: boolean } {
  const client = useQueryClient()
  const [connected, setConnected] = useState(true)
  useEffect(() => {
    let source: EventSource | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let dropped = false
    let stopped = false
    const open = () => {
      source = new EventSource('/api/events')
      source.onopen = () => {
        setConnected(true)
        if (dropped) client.invalidateQueries()
        dropped = false
      }
      source.onmessage = (e) => client.invalidateQueries({ queryKey: keyFor(JSON.parse(e.data) as Change) })
      source.onerror = () => {
        dropped = true
        setConnected(false)
        // EventSource retries on its own unless the connection was refused outright.
        if (source?.readyState === EventSource.CLOSED && !stopped) retry = setTimeout(open, 3000)
      }
    }
    open()
    return () => {
      stopped = true
      source?.close()
      clearTimeout(retry)
    }
  }, [client])
  return { connected }
}
