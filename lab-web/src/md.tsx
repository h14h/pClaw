import type { ReactNode } from 'react'

/**
 * Just enough markdown for assistant text: paragraphs, bullet and numbered lists, fenced code, `code`, **bold**,
 * [links](url) and bare URLs. Renders to elements, never HTML, so page text a worker fetched can't inject anything.
 */
export function Md({ text, className = '' }: { text: string; className?: string }) {
  return <div className={`md ${className}`}>{blocks(text)}</div>
}

const LIST = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/

function blocks(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.trim() === '') { i++; continue }
    if (line.startsWith('```')) {
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i]!.startsWith('```')) code.push(lines[i++]!)
      i++
      out.push(<pre key={out.length}><code>{code.join('\n')}</code></pre>)
      continue
    }
    const list = LIST.exec(line)
    if (list) {
      const items: ReactNode[] = []
      const ordered = list[1] !== undefined
      const start = ordered ? Number(list[1]) : undefined
      while (i < lines.length) {
        const m = LIST.exec(lines[i]!)
        if (!m) {
          // A wrapped continuation line belongs to the previous item.
          if (items.length && lines[i]!.trim() !== '' && /^\s+/.test(lines[i]!)) {
            items[items.length - 1] = <li key={items.length - 1}>{items[items.length - 1]}{' '}{inline(lines[i]!.trim())}</li>
            i++
            continue
          }
          break
        }
        items.push(<li key={items.length}>{inline(m[2]!)}</li>)
        i++
      }
      out.push(ordered ? <ol key={out.length} start={start}>{items}</ol> : <ul key={out.length}>{items}</ul>)
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      out.push(<p key={out.length} className="font-semibold">{inline(heading[1]!)}</p>)
      i++
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i]!.trim() !== '' && !lines[i]!.startsWith('```') && !LIST.test(lines[i]!)) para.push(lines[i++]!)
    out.push(<p key={out.length}>{inline(para.join('\n'))}</p>)
  }
  return out
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+)/g

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const key = out.length
    if (m[1]) out.push(<code key={key}>{m[1].slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={key}>{m[2].slice(2, -2)}</strong>)
    else if (m[3]) out.push(<a key={key} href={m[4]} target="_blank" rel="noreferrer">{m[3]}</a>)
    else {
      // Bare URLs often end in punctuation that isn't part of them.
      const url = m[5]!.replace(/[.,;:!?'"]+$/, '')
      out.push(<a key={key} href={url} target="_blank" rel="noreferrer">{url}</a>)
      out.push(m[5]!.slice(url.length))
    }
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
