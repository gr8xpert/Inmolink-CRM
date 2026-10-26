import type { Crumb } from '../seo';

/** The page's trail (its JSON-LD twin is `breadcrumbJsonLd`); the last crumb is the page itself. */
export function Breadcrumbs(props: { label: string; crumbs: readonly Crumb[] }) {
  return (
    <nav aria-label={props.label} className="text-sm text-stone">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {props.crumbs.map((c, i) => {
          const last = i === props.crumbs.length - 1;
          return (
            <li key={c.path ?? c.name} className="flex items-center gap-2">
              {last || !c.path ? (
                <span aria-current={last ? 'page' : undefined} className={last ? 'text-ink' : undefined}>
                  {c.name}
                </span>
              ) : (
                <a href={c.path} className="hover:text-sea">
                  {c.name}
                </a>
              )}
              {last ? null : (
                <span aria-hidden="true" className="text-mist">
                  /
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Inline JSON-LD (`serializeJsonLd` output only: nothing in it can close the script). */
export function JsonLd(props: { json: string }) {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD serialized by serializeJsonLd (escapes <, >, &).
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: props.json }} />;
}
