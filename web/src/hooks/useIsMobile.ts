import { useEffect, useState } from "react"

// Tailwind's md boundary: below it the desktop rail/carousel chrome swaps for
// the phone dock. Must stay in sync with the md: variants those components use.
const QUERY = "(max-width: 767px)"

export function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.matchMedia(QUERY).matches)
  useEffect(() => {
    const mql = window.matchMedia(QUERY)
    const onChange = (e: MediaQueryListEvent) => setMobile(e.matches)
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])
  return mobile
}
