import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

const cache = new Map<string, string>()

/**
 * models.dev logos are currentColor SVGs, so they're inlined (not <img>)
 * to inherit the theme's foreground color on the dark UI.
 */
export function ProviderLogo({
  id,
  className,
}: {
  id: string
  className?: string
}) {
  const [, setLoaded] = useState(0)
  const svg = cache.get(id) ?? ""

  useEffect(() => {
    if (cache.has(id)) return
    let alive = true
    api
      .providerLogo(id)
      .then((text) => {
        cache.set(id, text)
        if (alive) setLoaded((n) => n + 1)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [id])

  return (
    <span
      aria-hidden
      className={cn("inline-flex size-5 shrink-0 [&_svg]:size-full", className)}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
