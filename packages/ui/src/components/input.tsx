import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';

/** shadcn/ui input. Pair with `Label` (`htmlFor` = `id`); invalid state via `aria-invalid`. */
export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      className={cn(
        'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ' +
          'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 ' +
          'focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ' +
          'aria-[invalid=true]:border-destructive',
        className,
      )}
      {...props}
    />
  );
}
