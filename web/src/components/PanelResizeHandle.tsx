import type { HTMLAttributes } from "react"

type Props = Omit<HTMLAttributes<HTMLDivElement>, "onChange"> & {
  label: string
  value: number
  min: number
  max: number
  direction?: 1 | -1
  onChange: (width: number) => void
}

export function PanelResizeHandle({
  label,
  value,
  min,
  max,
  direction = 1,
  onChange,
  className,
  ...props
}: Props) {
  const lower = Math.min(min, max)
  const clamp = (width: number) => Math.max(lower, Math.min(max, width))
  return (
    <div
      {...props}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={lower}
      aria-valuemax={max}
      aria-valuenow={clamp(value)}
      title="Drag or use arrow keys to resize"
      className={`${className ?? ""} outline-none focus-visible:bg-ring/30`}
      onKeyDown={(event) => {
        let next: number
        if (event.key === "ArrowLeft") next = clamp(value) - 16 * direction
        else if (event.key === "ArrowRight")
          next = clamp(value) + 16 * direction
        else if (event.key === "Home") next = lower
        else if (event.key === "End") next = max
        else return
        event.preventDefault()
        onChange(clamp(next))
      }}
    />
  )
}
