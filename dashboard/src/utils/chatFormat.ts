/**
 * Minimal chat-message formatter for assistant replies.
 *
 * The assistant emits a small Markdown subset (bold, inline code, bullets,
 * fenced blocks). This parses that subset into plain blocks so the UI can
 * render them as React elements without a Markdown dependency or raw HTML.
 * Anything outside the subset passes through as literal text.
 */

export type Span = { t: 'text' | 'bold' | 'code'; s: string }

export type Block =
  | { t: 'para'; spans: Span[] }
  | { t: 'list'; items: Array<{ level: number; spans: Span[] }> }
  | { t: 'code'; lang: string; text: string }

function parseSpans(line: string): Span[] {
  const spans: Span[] = []
  let rest = line
  while (rest.length > 0) {
    const bold = rest.match(/\*\*(.+?)\*\*/)
    const code = rest.match(/`([^`]+?)`/)
    const pick =
      bold && code
        ? (bold.index! <= code.index! ? { m: bold, t: 'bold' as const } : { m: code, t: 'code' as const })
        : bold
          ? { m: bold, t: 'bold' as const }
          : code
            ? { m: code, t: 'code' as const }
            : null
    if (!pick || pick.m.index === undefined) {
      spans.push({ t: 'text', s: rest })
      break
    }
    if (pick.m.index > 0) spans.push({ t: 'text', s: rest.slice(0, pick.m.index) })
    spans.push({ t: pick.t, s: pick.m[1] })
    rest = rest.slice(pick.m.index + pick.m[0].length)
  }
  return spans.length > 0 ? spans : [{ t: 'text', s: '' }]
}

export function parseChatMessage(src: string): Block[] {
  const blocks: Block[] = []
  const lines = src.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }
    const fence = line.match(/^```(\S*)\s*$/)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].match(/^```\s*$/)) {
        body.push(lines[i])
        i++
      }
      if (i < lines.length) i++
      blocks.push({ t: 'code', lang: fence[1], text: body.join('\n') })
      continue
    }
    const bullet = line.match(/^(\s*)[*+-]\s+(.*)$/)
    if (bullet) {
      const items: Array<{ level: number; spans: Span[] }> = []
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)[*+-]\s+(.*)$/)
        if (!m) break
        items.push({ level: Math.floor(m[1].length / 2), spans: parseSpans(m[2]) })
        i++
      }
      blocks.push({ t: 'list', items })
      continue
    }
    blocks.push({ t: 'para', spans: parseSpans(line) })
    i++
  }
  return blocks
}
