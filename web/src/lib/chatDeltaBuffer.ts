/** Coalesce token bursts into one text update per paint, preserving wire order. */
export function createChatDeltaBuffer(emit: (text: string) => void) {
  let text = ""
  let frame: number | undefined

  const cancel = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
  }
  const flush = () => {
    cancel()
    if (!text) return
    const pending = text
    text = ""
    emit(pending)
  }

  return {
    push(delta: string) {
      text += delta
      if (frame === undefined) frame = requestAnimationFrame(flush)
    },
    // Flush before actions, replacements and terminal frames, even in a
    // background tab where requestAnimationFrame may be suspended.
    flush,
    discard() {
      cancel()
      text = ""
    },
  }
}
