/**
 * Loading skeleton for a dashboard page (S1-10): the shape of a title, a line of text and a few rows,
 * shown while the page's data loads. Screen readers get the text label; the shapes are decorative.
 */
export function PageSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="flex animate-pulse flex-col gap-4 motion-reduce:animate-none">
        <div className="h-7 w-48 rounded-md bg-muted" />
        <div className="h-4 w-80 max-w-full rounded-md bg-muted" />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-12 rounded-md bg-muted" />
        ))}
      </div>
    </div>
  );
}
