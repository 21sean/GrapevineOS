import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * A URL safe to use as a link target: http(s) only, else null. Event fields
 * like ticketUrl are LLM-extracted from untrusted newsletter/web content, so a
 * javascript:/data: value must never reach an <a href>. Server-side ingest
 * already filters these; this is the render-time backstop (and covers rows
 * stored before that filter existed).
 */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw, window.location.origin)
    return u.protocol === "http:" || u.protocol === "https:" ? raw : null
  } catch {
    return null
  }
}
