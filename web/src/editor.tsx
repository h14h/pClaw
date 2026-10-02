import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { HighlightStyle, Language, defineLanguageFacet, syntaxHighlighting } from '@codemirror/language'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, drawSelection, keymap } from '@codemirror/view'
import { Vim, vim } from '@replit/codemirror-vim'
import { tags } from '@lezer/highlight'
import { parser } from '@lezer/markdown'
import { useEffect, useRef } from 'react'

// :w saves whichever editor the command was typed in. Ex commands are global to the vim extension, so define it once.
const savers = new WeakMap<EditorView, () => void>()
Vim.defineEx('write', 'w', (cm) => savers.get(cm.cm6)?.())

// Plain CommonMark. @codemirror/lang-markdown would also bundle the HTML, JS and CSS parsers for fenced code.
const markdown = new Language(defineLanguageFacet(), parser, [], 'markdown')

// Highest precedence, listed before vim(): at equal precedence the earlier extension's styles win, and the vim
// extension's own highest-precedence theme paints the cursor pink.
const theme = Prec.highest(EditorView.theme({
  '&': { fontSize: '14px', color: 'var(--fg)', backgroundColor: 'var(--bg)', maxHeight: '70vh' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-sans)', lineHeight: '1.6' },
  '.cm-content': { padding: '10px 0', caretColor: 'var(--fg)' },
  '.cm-line': { padding: '0 14px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: 'var(--sel)' },
  '.cm-fat-cursor': { backgroundColor: 'var(--mute)', color: 'var(--bg) !important' },
  '&:not(.cm-focused) .cm-fat-cursor': { backgroundColor: 'transparent', outline: 'solid 1px var(--mute)' },
  '.cm-vim-panel': { fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--mute)', backgroundColor: 'var(--panel)', borderTop: '1px solid var(--line)', padding: '2px 8px' },
  '.cm-vim-panel input': { color: 'var(--fg)', background: 'none', border: 'none', outline: 'none', font: 'inherit' },
  '.cm-panels': { backgroundColor: 'transparent', color: 'inherit' },
}))

const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '600' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, textDecoration: 'underline', textDecorationColor: 'var(--faint)', textUnderlineOffset: '2px' },
  { tag: tags.url, color: 'var(--mute)' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.9em', backgroundColor: 'var(--panel)' },
  { tag: tags.quote, color: 'var(--mute)' },
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.labelName, tags.comment], color: 'var(--faint)' },
])

/**
 * A vim-enabled markdown editor for long prose. Uncontrolled while typing: `text` only replaces the buffer when it
 * differs from what's in it, which is how discarding or an outside change gets in without disturbing the cursor.
 */
export function Editor({ text, onChange, onSave }: { text: string; onChange: (text: string) => void; onSave: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView>(null)
  const handlers = useRef({ onChange, onSave })
  handlers.current = { onChange, onSave }

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: text,
        extensions: [
          theme,
          vim({ status: true }),
          Prec.high(keymap.of([{ key: 'Mod-s', run: () => (handlers.current.onSave(), true) }])),
          history(),
          drawSelection(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown,
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => u.docChanged && handlers.current.onChange(u.state.doc.toString())),
        ],
      }),
    })
    savers.set(editor, () => handlers.current.onSave())
    view.current = editor
    return () => editor.destroy()
    // The initial text is only the starting buffer; later values go through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const editor = view.current
    if (editor && editor.state.doc.toString() !== text) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } })
  }, [text])

  return <div ref={host} className="overflow-hidden rounded border border-line" />
}
