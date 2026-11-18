/**
 * Read a streaming NDJSON response one frame at a time. Three endpoints
 * stream this way (the agent, the eval runner, Ollama pulls) and used to
 * carry three copies of the same loop.
 *
 * A line that is not JSON is skipped rather than fatal: a stream that dies
 * mid-line still delivered every line before it, and the caller sees those.
 * Errors thrown by `onFrame` are the caller's and propagate.
 */
/** A refused request answers { error } as JSON: show the sentence, not the JSON. */
async function refusalText(res: Response): Promise<string> {
  const text = await res.text()
  try {
    const body = JSON.parse(text) as { error?: unknown }
    if (typeof body?.error === "string") return body.error
  } catch {
    // Not JSON: the text is the message.
  }
  return text
}

export async function readNdjson(
  res: Response,
  onFrame: (frame: unknown) => void
): Promise<void> {
  if (!res.ok || !res.body) throw new Error(await refusalText(res))
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const deliver = (line: string) => {
    if (!line.trim()) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    onFrame(parsed)
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) deliver(line)
  }
  buffer += decoder.decode()
  deliver(buffer)
}
