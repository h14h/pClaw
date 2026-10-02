// A scripted day with pclaw, used by the dev fixture (see fixture.ts). Offsets are seconds from the start of the
// scenario; `cutoff` decides how much of it has happened yet, so the same data can play back live.
import type {
	ConversationView,
	FollowUp,
	Overview,
	TimelineItem,
	WorkerDetail,
	WorkerItem,
	WorkerSummary,
} from '../../src/dashboard/types.ts'

export const CONVERSATION_ID = 'discord-dm-180942'
const WORKER = 'nas-case'
const DAY = 24 * 3600
const MODEL = 'grok-4.5'
/** Omit that distributes over a union. */
type Without<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never
const usage = (input: number, output: number, cacheRead = 0) => ({ input, output, cacheRead })

const brief = `Find a quiet case for a home NAS that will sit in Henry's living room.

Requirements:
- 4 to 6 3.5" drive bays, mini-ITX or micro-ATX.
- As quiet as possible: big slow fans, nothing 40mm. Noise matters more than looks, but it sits next to a TV stand so it can't be ugly.
- Under about $250. He's in the US.

Give 2 or 3 options with the current price, where to buy, and the main tradeoff of each. Take noise and drive-cooling claims from reviews, not spec sheets. Keep the report short; he'll pick from it.`

const report = `Three that fit, quietest first:

1. **Jonsbo N3**, $150 at Amazon. 8 bays, mini-ITX, two 100mm fans on the drive cage. Reviews put it around 30 dB at idle on the stock fans; swap in Noctua NF-A10s if the hum bothers you. Tradeoff: SFX power supply only, and the cage runs warm with all 8 bays filled (fine with 4 to 6). https://www.amazon.com/dp/B0C4JQX1N3

2. **Fractal Node 304**, $110 at Newegg. 6 bays, mini-ITX, three fans on a built-in controller. Older design, proven, very quiet on low. Tradeoff: cramped build, and the drive brackets hang from the top, so swapping a drive means opening the whole thing. https://www.newegg.com/p/N82E16811352027

3. **Sliger CX3701**, $240 direct. 10 bays in a short-depth 3U, micro-ATX. Best drive cooling of the three and the cleanest look, but the stock 120mm fans are louder than the other two; budget $40 more for quiet ones. https://sliger.com/products/rackmount/3u/cx3701/

I'd lean N3 for a living room. Prices checked today.`

const relay = `Jonsbo N3, $150 on Amazon. Eight bays so you've got room to grow, mini-ITX, and the quietest of the three in reviews. Needs an SFX power supply, which is the one catch.

Runner-up is the Fractal Node 304 at $110 if you'd rather spend less and don't mind a fiddly build. Want the links?`

type Step = { t: number; item: Without<TimelineItem, 'at'> }

const steps: Step[] = [
	{ t: 0, item: { kind: 'message', id: 'm1', text: "rough week. the dog's been sick since tuesday and work is a mess", images: 0 } },
	{
		t: 7,
		item: { kind: 'reply', id: 'r1', text: "That's a lot at once. What's going on with the dog?", delivered: true, model: MODEL, usage: usage(2140, 18, 1900) },
	},
	{ t: 41, item: { kind: 'message', id: 'm2', text: 'vomiting, not eating much. vet tomorrow at 9', images: 1 } },
	{ t: 46, item: { kind: 'tool', id: 't1', name: 'remember', args: { note: 'Dog (she) sick since Tue; vet Wed 9am.' }, result: 'Saved.' } },
	{
		t: 47,
		item: { kind: 'tool', id: 't2', name: 'follow_up', args: { at: 'tomorrow 10:30', note: 'ask how the vet went' }, result: 'Scheduled for tomorrow at 10:30.' },
	},
	{
		t: 51,
		item: {
			kind: 'reply',
			id: 'r2',
			text: "Vet tomorrow at 9 is the right call. I'll check in after.\n\nAnything you want off your plate today?",
			delivered: true,
			model: MODEL,
			usage: usage(2410, 44, 2100),
		},
	},
	{
		t: 600,
		item: { kind: 'message', id: 'm3', text: 'yeah actually. I want a quiet case for a home NAS, 4-6 drives, it lives in the living room. can you look?', images: 0 },
	},
	{ t: 605, item: { kind: 'reply', id: 'r3', text: "I'll check.", delivered: false, held: 'superseded', model: MODEL, usage: usage(2520, 4, 2100) } },
	{ t: 606, item: { kind: 'tool', id: 't3', name: 'delegate', args: { name: WORKER, brief }, result: 'Started nas-case.', worker: WORKER } },
	{ t: 609, item: { kind: 'reply', id: 'r4', text: 'On it. Give me a few minutes.', delivered: true, model: MODEL, usage: usage(2790, 9, 2500) } },
	{ t: 790, item: { kind: 'event', id: 'e1', event: 'worker-report', worker: WORKER, ok: true, text: report } },
	{ t: 798, item: { kind: 'reply', id: 'r5', text: relay, delivered: true, model: MODEL, usage: usage(3410, 96, 2800) } },
	{ t: 851, item: { kind: 'message', id: 'm4', text: 'nice, the N3 it is. thanks', images: 0 } },
	{ t: 852, item: { kind: 'tool', id: 't4', name: 'remember', args: { note: 'Building a home NAS; picked the Jonsbo N3.' }, result: 'Saved.' } },
	{ t: 856, item: { kind: 'reply', id: 'r6', text: 'Good pick. The links are above if you want to compare later.', delivered: true, model: MODEL, usage: usage(3600, 14, 3400) } },
	{ t: 15.6 * 3600, item: { kind: 'message', id: 'm5', text: "vet says it's just a stomach bug, she's already eating again", images: 0 } },
	{ t: 15.6 * 3600 + 6, item: { kind: 'reply', id: 'r7', text: 'Good news. Stomach bugs clear fast once they start eating. Glad it was nothing worse.', delivered: true, model: MODEL, usage: usage(3700, 22, 3600) } },
	{ t: 16.5 * 3600, item: { kind: 'event', id: 'e2', event: 'follow-up', text: 'ask how the vet went' } },
	{ t: 16.5 * 3600 + 4, item: { kind: 'reply', id: 'r8', text: 'NO_REPLY', delivered: false, held: 'silent', model: MODEL, usage: usage(3760, 3, 3700) } },
]

const workerSteps: { t: number; item: Without<WorkerItem, 'at'> }[] = [
	{ t: 606, item: { kind: 'from-pclaw', text: brief } },
	{
		t: 609,
		item: {
			kind: 'thinking',
			text: 'Living room NAS, 4-6 bays, quiet, under $250. The usual candidates are the Jonsbo N-series, Fractal Node 304/804, and Sliger. Prices move, so check current listings rather than trusting memory. Noise claims should come from reviews with measurements.',
		},
	},
	{ t: 611, item: { kind: 'tool', name: 'bash', args: { command: 'cat AGENTS.md && ls' }, result: '# Workers\n\nYou work for pclaw on behalf of Henry. Keep reports short...\n\nnotes/  scratch/' } },
	{
		t: 616,
		item: {
			kind: 'tool',
			name: 'web_search',
			args: { query: 'quiet NAS case 4-6 bay mini-ITX 2026 review noise' },
			result:
				'1. Jonsbo N3 review: the small NAS case to beat - servethehome.com\n2. Fractal Node 304 long-term review - techpowerup.com\n3. Sliger CX3701 hands-on - level1techs.com\n4. Best NAS cases 2026 - tomshardware.com\n5. r/DataHoarder: quietest 6 bay case?',
		},
	},
	{
		t: 641,
		item: {
			kind: 'tool',
			name: 'fetch',
			args: { url: 'https://www.servethehome.com/jonsbo-n3-review/' },
			result:
				'Jonsbo N3 Review\n\n...two 100mm fans on the rear of the drive cage. At idle we measured 30-31 dBA at one meter with stock fans... with 8 drives the cage reached 44C under sustained load; six drives sat at 39C... requires an SFX PSU...\n\n[12,400 more characters]',
		},
	},
	{
		t: 668,
		item: {
			kind: 'tool',
			name: 'fetch',
			args: { url: 'https://www.techpowerup.com/review/fractal-node-304/' },
			result: 'Fractal Node 304\n\n...three fans with a 3-step controller on the back. On low the case is near silent... drive brackets hang from the roof, so you remove the whole bracket to swap one drive... six 3.5" bays...\n\n[9,800 more characters]',
		},
	},
	{ t: 701, item: { kind: 'tool', name: 'fetch', args: { url: 'https://forum.level1techs.com/t/sliger-cx3701/' }, result: 'Sliger CX3701 hands-on\n\n...ten bays, short depth 3U... stock 120mm fans are audible from across the room, swapping to Noctua redux fixed it... best drive temps of anything I have tested...\n\n[6,200 more characters]' } },
	{ t: 728, item: { kind: 'thinking', text: 'Need live prices. Amazon blocks curl; use fetch for the product pages.' } },
	{
		t: 731,
		item: { kind: 'tool', name: 'bash', args: { command: "curl -sL 'https://www.amazon.com/dp/B0C4JQX1N3' | grep -o 'a-price-whole\">[0-9]*' | head -1" }, result: 'curl: (22) The requested URL returned error: 503', isError: true },
	},
	{ t: 739, item: { kind: 'tool', name: 'fetch', args: { url: 'https://www.amazon.com/dp/B0C4JQX1N3' }, result: 'JONSBO N3 Mini-ITX NAS Case, 8 Bay... $149.99 ... In Stock ...' } },
	{ t: 752, item: { kind: 'tool', name: 'fetch', args: { url: 'https://www.newegg.com/p/N82E16811352027' }, result: 'Fractal Design Node 304 Black ... $109.99 ... In stock ...' } },
	{ t: 764, item: { kind: 'tool', name: 'fetch', args: { url: 'https://sliger.com/products/rackmount/3u/cx3701/' }, result: 'CX3701 ... $239.00 ... Ships in 2-3 weeks ...' } },
	{ t: 788, item: { kind: 'text', text: report } },
]
const WORKER_DONE = 790

const notes = `# Notes

## Henry
- US, Pacific time.
- Has a dog (she). Sick since Tue; vet Wed 9am. Turned out to be a stomach bug, recovering.
- Building a home NAS; picked the Jonsbo N3.

## Preferences
- Short replies. No bullet lists in chat.
`

export const LAST = steps[steps.length - 1]!.t + 1
/** Points in the scenario worth freezing at: mid-worker-run, and with the front model mid-reply. */
export const MID = 705
export const GEN = 795
export const stepTimes = [...new Set([...steps.map((s) => s.t), ...workerSteps.map((s) => s.t), WORKER_DONE])].sort((a, b) => a - b)

export type Clock = { base: number; cutoff: number; at: (t: number) => number }

function worker(clock: Clock): WorkerSummary | undefined {
	if (clock.cutoff < 606) return
	const working = clock.cutoff < WORKER_DONE
	const last = workerSteps.filter((s) => s.t <= clock.cutoff).at(-1)!
	return { name: WORKER, status: working ? 'working' : 'idle', brief, startedAt: clock.at(606), updatedAt: clock.at(working ? last.t : WORKER_DONE) }
}

export function overview(clock: Clock): Overview {
	const w = worker(clock)
	return {
		front: { provider: 'xai', model: MODEL, thinkingLevel: 'medium' },
		worker: { provider: 'xai', model: 'grok-4.7', thinkingLevel: 'high' },
		conversations: [{ id: CONVERSATION_ID, address: 'discord:dm:180942', label: 'Discord DM', busy: generating(clock) !== undefined, workersRunning: w?.status === 'working' ? 1 : 0 }],
		notes: clock.cutoff < 852 ? notes.replace('\n- Building a home NAS; picked the Jonsbo N3.', '') : notes,
	}
}

/** The next reply, if the front model would be writing it right now. */
function generating(clock: Clock) {
	const next = steps.find((s) => s.t > clock.cutoff)
	if (next?.item.kind === 'reply' && next.t - clock.cutoff < 10) return next.item
}

export function conversation(clock: Clock): ConversationView {
	const w = worker(clock)
	const gen = generating(clock)
	const followUps: FollowUp[] = []
	if (clock.cutoff >= 47 && clock.cutoff < 16.5 * 3600) followUps.push({ id: 'f1', at: clock.at(16.5 * 3600), note: 'ask how the vet went' })
	followUps.push({ id: 'f2', at: clock.base + 3 * DAY + 9 * 3600, note: 'see if the N3 arrived and the build went OK' })
	followUps.push({ id: 'f3', at: clock.base + 7 * DAY + 20 * 3600, note: 'weekly check-in', repeat: 'weekly' })
	return {
		id: CONVERSATION_ID,
		address: 'discord:dm:180942',
		label: 'Discord DM',
		live: gen ? { state: 'generating', since: clock.at(clock.cutoff - 2), text: gen.text.slice(0, Math.floor(gen.text.length * 0.6)) } : { state: 'idle' },
		timeline: steps.filter((s) => s.t <= clock.cutoff).map((s) => ({ ...s.item, at: clock.at(s.t) }) as TimelineItem),
		workers: w ? [w] : [],
		followUps,
		usage: { input: 184320, output: 6210, cacheRead: 120400, cost: 0.41 },
	}
}

export function workerDetail(clock: Clock, name: string): WorkerDetail | undefined {
	const w = worker(clock)
	if (!w || name !== WORKER) return
	return {
		...w,
		model: { provider: 'xai', model: 'grok-4.7', thinkingLevel: 'high' },
		transcript: workerSteps.filter((s) => s.t <= clock.cutoff).map((s) => ({ ...s.item, at: clock.at(s.t) }) as WorkerItem),
	}
}
