import { StarIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export function StarRating({
  rating,
  className,
  showNumber = false,
}: {
  rating: number
  className?: string
  showNumber?: boolean
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span className="relative inline-flex" aria-label={`${rating} out of 5`}>
        <span className="inline-flex text-muted-foreground/40">
          {Array.from({ length: 5 }, (_, i) => (
            <StarIcon key={i} className="size-3.5" />
          ))}
        </span>
        <span
          className="absolute inset-0 inline-flex overflow-hidden text-live"
          style={{ width: `${(Math.min(rating, 5) / 5) * 100}%` }}
        >
          {Array.from({ length: 5 }, (_, i) => (
            <StarIcon key={i} className="size-3.5 shrink-0 fill-current" />
          ))}
        </span>
      </span>
      {showNumber && (
        <span className="font-mono text-xs text-muted-foreground">
          {rating.toFixed(1)}
        </span>
      )}
    </span>
  )
}
