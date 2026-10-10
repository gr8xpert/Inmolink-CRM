import { describe, expect, it } from 'vitest';
import { buttonVariants, cn } from './index';

describe('@inmolink/ui', () => {
  it('[S0-08] cn lets later Tailwind utilities win', () => {
    expect(cn('px-2 py-1', false, 'px-4')).toBe('py-1 px-4');
  });

  it('[S0-08] button variants map to theme tokens', () => {
    expect(buttonVariants({ variant: 'outline', size: 'sm' })).toContain('border-input');
    expect(buttonVariants()).toContain('bg-primary');
  });
});
