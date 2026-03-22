// Temporary placeholder rendered for each view route until real feature views are built.
// Deleted when the corresponding feature issue lands.

interface Props {
  name: string;
}

export function PlaceholderView({ name }: Props) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-neutral-text-secondary">{name} view — coming soon</p>
    </div>
  );
}
