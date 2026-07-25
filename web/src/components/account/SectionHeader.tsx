/** Row of icon + italic title + optional trailing action, shared by the account dialog's sections. */
export function SectionHeader({
  icon,
  title,
  action,
}: {
  icon: React.ReactNode
  title: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex h-7 items-center justify-between">
      <span className="flex items-center gap-2 font-heading text-sm font-medium italic">
        <span className="text-muted-foreground">{icon}</span>
        {title}
      </span>
      {action}
    </div>
  )
}
