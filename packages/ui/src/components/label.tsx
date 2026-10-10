import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';

/** shadcn/ui label (native `<label>`, no Radix dependency). */
export function Label({ className, ...props }: ComponentProps<'label'>) {
  // biome-ignore lint/a11y/noLabelWithoutControl: callers pass htmlFor
  return <label className={cn('text-sm font-medium leading-none', className)} {...props} />;
}
