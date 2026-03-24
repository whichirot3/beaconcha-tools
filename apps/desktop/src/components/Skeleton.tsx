export function SkeletonCard() {
  return (
    <div className="skeleton-card" aria-hidden>
      <div className="skeleton-line skeleton-line--lg" />
      <div className="skeleton-line" />
      <div className="skeleton-line skeleton-line--sm" />
    </div>
  );
}

export function SkeletonTable({ rows = 8 }: { rows?: number }) {
  return (
    <div className="skeleton-table" aria-hidden>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="skeleton-line" />
      ))}
    </div>
  );
}
