import type { SelectionShareDto } from '@inmolink/contracts';
import { buttonVariants } from '@inmolink/ui';

export interface ShareLabels {
  title: string;
  once: string;
  link: string;
  open: string;
  whatsapp: string;
  email: string;
}

/**
 * The new link of a selection (shown once, the token is never stored) with the WhatsApp and e-mail buttons. Plain
 * anchors: they work without JavaScript. Without `PUBLIC_PAGES_URL` the API gives the path only.
 */
export function ShareLinks({ share, labels }: { share: SelectionShareDto; labels: ShareLabels }) {
  const button = buttonVariants({ variant: 'outline', size: 'sm' });
  return (
    <section
      aria-labelledby="share-title"
      className="flex flex-col gap-3 rounded-md border bg-muted p-4"
      data-testid="selection-share"
    >
      <h2 id="share-title" className="font-medium">
        {labels.title}
      </h2>
      <p className="text-xs text-muted-foreground">{labels.once}</p>
      <input
        readOnly
        aria-label={labels.link}
        value={share.url ?? share.path}
        className="h-9 rounded-md border bg-background px-2 font-mono text-xs"
        data-testid="selection-link"
      />
      <div className="flex flex-wrap gap-2">
        {share.url ? (
          <a className={button} href={share.url} target="_blank" rel="noopener noreferrer">
            {labels.open}
          </a>
        ) : null}
        {share.whatsappUrl ? (
          <a className={button} href={share.whatsappUrl} target="_blank" rel="noopener noreferrer">
            {labels.whatsapp}
          </a>
        ) : null}
        {share.emailUrl ? (
          <a className={button} href={share.emailUrl}>
            {labels.email}
          </a>
        ) : null}
      </div>
    </section>
  );
}
