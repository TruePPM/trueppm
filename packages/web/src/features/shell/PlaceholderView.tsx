// Temporary placeholder rendered for each view route until real feature views are built.
// Deleted when the corresponding feature issue lands.

interface Props {
  name: string;
}

export function PlaceholderView({ name }: Props) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 select-none">
      {/* Blueprint grid pattern */}
      <svg
        width="48"
        height="48"
        viewBox="0 0 48 48"
        fill="none"
        aria-hidden="true"
        className="text-neutral-border"
      >
        {/* Grid lines */}
        {[8, 16, 24, 32, 40].map((v) => (
          <line key={`h${v}`} x1="4" y1={v} x2="44" y2={v} stroke="currentColor" strokeWidth="1" />
        ))}
        {[8, 16, 24, 32, 40].map((v) => (
          <line key={`v${v}`} x1={v} y1="4" x2={v} y2="44" stroke="currentColor" strokeWidth="1" />
        ))}
        {/* Center dot */}
        <circle cx="24" cy="24" r="3" className="fill-neutral-text-disabled" />
      </svg>
      <p className="text-sm font-medium text-neutral-text-primary">{name}</p>
      <p className="text-xs text-neutral-text-secondary">This view is under construction.</p>
    </div>
  );
}
