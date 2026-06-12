import { useCallback, useEffect, useRef, useState } from "react"

/**
 * Dictation via the browser's Web Speech API (webkit-prefixed in
 * Chrome/Edge/Safari) — keyless and local to the browser, no audio ever
 * touches our server. Firefox has no implementation, so callers should hide
 * the mic button when `supported` is false.
 *
 * One utterance per start(): interim results stream into onText while the
 * user speaks, the engine finalizes on a pause, and onend flips `listening`
 * back off.
 */

interface SpeechResultEvent {
  results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>
}

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: SpeechResultEvent) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error: string }) => void) | null
  start(): void
  abort(): void
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function getCtor(): SpeechRecognitionCtor | undefined {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

export function useSpeechInput(opts: {
  /** Full transcript so far (interim + final), fired on every update. */
  onText: (text: string, isFinal: boolean) => void
  onError?: (error: string) => void
}) {
  const [listening, setListening] = useState(false)
  const recRef = useRef<SpeechRecognitionLike | null>(null)
  // Keep callbacks fresh without re-creating the recognition instance.
  const optsRef = useRef(opts)
  optsRef.current = opts

  const supported = typeof window !== "undefined" && !!getCtor()

  const stop = useCallback(() => {
    recRef.current?.abort()
    recRef.current = null
    setListening(false)
  }, [])

  const start = useCallback(() => {
    const Ctor = getCtor()
    if (!Ctor || recRef.current) return
    const rec = new Ctor()
    rec.lang = navigator.language || "en-US"
    rec.continuous = false
    rec.interimResults = true
    rec.onresult = (e) => {
      let text = ""
      let isFinal = false
      for (let i = 0; i < e.results.length; i++) {
        text += e.results[i][0].transcript
        isFinal = e.results[i].isFinal
      }
      optsRef.current.onText(text.trim(), isFinal)
    }
    rec.onend = () => {
      recRef.current = null
      setListening(false)
    }
    rec.onerror = (e) => {
      // "no-speech"/"aborted" are routine ends, not failures worth surfacing.
      if (e.error !== "no-speech" && e.error !== "aborted") {
        optsRef.current.onError?.(e.error)
      }
    }
    recRef.current = rec
    setListening(true)
    rec.start()
  }, [])

  const toggle = useCallback(() => {
    if (recRef.current) stop()
    else start()
  }, [start, stop])

  // Don't leave the mic hot after the palette unmounts.
  useEffect(() => stop, [stop])

  return { supported, listening, start, stop, toggle }
}
