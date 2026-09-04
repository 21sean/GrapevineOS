import { describe, expect, it } from "vitest"
import { readNdjson } from "@/lib/ndjson"

function streamed(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
  return new Response(body, { status: 200, ...init })
}

describe("readNdjson", () => {
  it("delivers one frame per line even when chunks split lines", async () => {
    const frames: unknown[] = []
    await readNdjson(
      streamed([
        '{"type":"del',
        'ta","text":"a"}\n{"type":"de',
        'lta","text":"b"}\n',
      ]),
      (f) => frames.push(f)
    )
    expect(frames).toEqual([
      { type: "delta", text: "a" },
      { type: "delta", text: "b" },
    ])
  })

  it("delivers a final line that has no trailing newline", async () => {
    const frames: unknown[] = []
    await readNdjson(streamed(['{"type":"done"}']), (f) => frames.push(f))
    expect(frames).toEqual([{ type: "done" }])
  })

  it("skips blank and malformed lines but lets the caller's errors through", async () => {
    const frames: unknown[] = []
    await readNdjson(streamed(['\n{"ok":1}\nnot json\n{"ok":2}\n']), (f) =>
      frames.push(f)
    )
    expect(frames).toEqual([{ ok: 1 }, { ok: 2 }])
    await expect(
      readNdjson(streamed(['{"error":"bad"}\n']), (f) => {
        if ((f as { error?: string }).error) throw new Error("bad")
      })
    ).rejects.toThrow("bad")
  })

  it("throws the body text of a failed response", async () => {
    await expect(
      readNdjson(new Response("nope", { status: 503 }), () => {})
    ).rejects.toThrow("nope")
  })
})
