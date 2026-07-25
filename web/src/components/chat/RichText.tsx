import type { ReactNode } from "react"
import { EventChip } from "@/components/AgentChat"

/** Matches the [Title](event:id) grammar the system prompt asks for. */
export const EVENT_LINK_RE = /\[([^\]]+)\]\(event:([^)\s]+)\)/g

// ---------- rich text: paragraphs, "- " bullets, **bold**, event chips ------

export function RichText({ text }: { text: string }) {
  // local models sometimes double-bracket citations: [[name](url)] → [name](url)
  const cleaned = text.replace(/\[(\[[^\]]+\]\(https?:\/\/[^)\s]+\))\]/g, "$1")
  const blocks = cleaned.split(/\n+/).filter((l) => l.trim())
  return (
    <div className="space-y-1.5 text-sm leading-relaxed">
      {blocks.map((line, i) => {
        const bullet = /^\s*[-•*]\s+/.test(line)
        const content = renderInline(
          bullet ? line.replace(/^\s*[-•*]\s+/, "") : line
        )
        return bullet ? (
          <div key={i} className="flex gap-2 pl-1">
            <span className="text-muted-foreground">•</span>
            <span className="min-w-0">{content}</span>
          </div>
        ) : (
          <p key={i}>{content}</p>
        )
      })}
    </div>
  )
}

function renderInline(line: string): ReactNode[] {
  const out: ReactNode[] = []
  // event chips | web citations | bold
  const re = new RegExp(
    `${EVENT_LINK_RE.source}|\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)|\\*\\*([^*]+)\\*\\*`,
    "g"
  )
  let idx = 0
  let key = 0
  for (const m of line.matchAll(re)) {
    if (m.index! > idx) out.push(line.slice(idx, m.index))
    if (m[2]) out.push(<EventChip key={key++} id={m[2]} label={m[1]} />)
    else if (m[4])
      out.push(
        <a
          key={key++}
          href={m[4]}
          target="_blank"
          rel="noreferrer"
          className="text-wine underline underline-offset-2 hover:opacity-80"
        >
          {m[3]}
        </a>
      )
    // Bold wins the alternation when the model writes **[Title](event:id)** —
    // recurse so links inside bold still render as chips, not raw markdown.
    // Bold content can't contain "*", so this terminates after one level.
    else out.push(<strong key={key++}>{renderInline(m[5])}</strong>)
    idx = m.index! + m[0].length
  }
  if (idx < line.length) out.push(line.slice(idx))
  return out
}
