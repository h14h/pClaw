// Dev-only stand-in for the pclaw API, served by the Vite dev server when PCLAW_FIXTURE is set. Never bundled.
//   PCLAW_FIXTURE=done   the whole scenario has happened
//   PCLAW_FIXTURE=mid    a worker is mid-run
//   PCLAW_FIXTURE=gen    the front model is mid-reply
//   PCLAW_FIXTURE=live   plays the scenario forward, one step every couple of seconds, over SSE
import type { ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import type { Change } from '../../src/dashboard/types.ts'
import { CONVERSATION_ID, GEN, LAST, MID, type Clock, conversation, overview, stepTimes, workerDetail } from './scenario.ts'

export function fixture(mode: string): Plugin {
	const live = mode === 'live'
	const cutoff = { done: LAST, mid: MID, gen: GEN }[mode] ?? 0
	const now = Date.now()
	// Finite modes end at "now" so elapsed times and "ago" look right. Live mode stamps each step when it appears.
	const revealed = new Map<number, number>()
	const clock: Clock = { base: now - cutoff * 1000, cutoff, at: (t) => revealed.get(t) ?? clock.base + t * 1000 }
	const clients = new Set<ServerResponse>()
	const send = (change: Change) => {
		for (const res of clients) res.write(`data: ${JSON.stringify(change)}\n\n`)
	}

	return {
		name: 'pclaw-fixture',
		configureServer(server) {
			if (live) {
				let i = 0
				const tick = () => {
					if (i >= stepTimes.length) return
					clock.cutoff = stepTimes[i++]!
					revealed.set(clock.cutoff, Date.now())
					send({ scope: 'conversation', id: CONVERSATION_ID })
					send({ scope: 'worker', conversationId: CONVERSATION_ID, name: 'nas-case' })
					send({ scope: 'overview' })
					setTimeout(tick, 2500)
				}
				setTimeout(tick, 3000)
			}
			server.middlewares.use((req, res, next) => {
				const path = req.url?.split('?')[0] ?? ''
				if (!path.startsWith('/api/')) return next()
				if (path === '/api/events') {
					res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
					res.write(': hello\n\n')
					clients.add(res)
					req.on('close', () => clients.delete(res))
					return
				}
				const [, , resource, id, sub, name] = path.split('/')
				const body =
					resource === 'overview' ? overview(clock)
					: resource === 'conversations' && id === CONVERSATION_ID && !sub ? conversation(clock)
					: resource === 'conversations' && id === CONVERSATION_ID && sub === 'workers' && name ? workerDetail(clock, name)
					: undefined
				res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' })
				res.end(JSON.stringify(body ?? { error: 'not found' }))
			})
		},
	}
}
