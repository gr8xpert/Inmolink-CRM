import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/cn';

export type EmptyStateProps = Omit<ComponentProps<'div'>, 'title'> & {
  /** Short, plain statement of what is missing ("No keys yet"). */
  title: ReactNode;
  /** One sentence on what will appear here, or how to start. */
  description?: ReactNode;
  /** Decorative icon (rendered `aria-hidden`). */
  icon?: ReactNode;
  /** The next step: usually a link or button. */
  action?: ReactNode;
  /** Heading level of the title, so it fits the page outline. Defaults to a paragraph (no heading). */
  as?: 'h2' | 'h3' | 'p';
};

/**
 * Empty state for lists and panels (S1-10): a muted box with a title, an optional explanation and an
 * optional next step. Server-safe (no hooks); all text comes from the caller (i18n).
 */
export function EmptyState({ title, description, icon, action, as = 'p', className, ...props }: EmptyStateProps) {
  const Title = as;
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'flex flex-col items-center gap-2 rounded-md border border-dashed px-6 py-8 text-center text-sm',
        className,
      )}
      {...props}
    >
      {icon ? (
        <span aria-hidden="true" className="text-muted-foreground [&>svg]:size-6">
          {icon}
        </span>
      ) : null}
      <Title className="font-medium text-foreground">{title}</Title>
      {description ? <p className="max-w-prose text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
