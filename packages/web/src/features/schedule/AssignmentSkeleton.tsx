export function AssignmentSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading resource assignments">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="flex items-center gap-2 py-1.5 border-b border-neutral-border/40 last:border-b-0"
        >
          {/* Resource name placeholder */}
          <div className="flex-1 h-3.5 animate-pulse bg-neutral-border/50 rounded" />
          {/* Units input placeholder */}
          <div className="w-14 h-6 animate-pulse bg-neutral-border/50 rounded" />
          {/* % label placeholder */}
          <div className="w-3 h-3 animate-pulse bg-neutral-border/50 rounded" />
          {/* Remove button placeholder */}
          <div className="w-6 h-6 animate-pulse bg-neutral-border/50 rounded" />
        </div>
      ))}
    </div>
  );
}
