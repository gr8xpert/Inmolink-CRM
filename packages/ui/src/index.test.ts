import { isValidElement, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { buttonVariants, cn, EmptyState } from './index';

describe('@inmolink/ui', () => {
  it('[S0-08] cn lets later Tailwind utilities win', () => {
    expect(cn('px-2 py-1', false, 'px-4')).toBe('py-1 px-4');
  });

  it('[S0-08] button variants map to theme tokens', () => {
    expect(buttonVariants({ variant: 'outline', size: 'sm' })).toContain('border-input');
    expect(buttonVariants()).toContain('bg-primary');
  });

  it('[S1-10] empty state: title, description and action from the caller; the icon is hidden from assistive tech', () => {
    const el = EmptyState({ title: 'No keys yet', description: 'Create one', icon: 'i', action: 'go', as: 'h2' });
    const children = (el.props as { children: ReactElement[] }).children.filter(isValidElement) as ReactElement<
      Record<string, unknown>
    >[];
    expect(children.map((c) => c.type)).toEqual(['span', 'h2', 'p', 'div']);
    expect(children[0]?.props['aria-hidden']).toBe('true');
    expect(children[1]?.props.children).toBe('No keys yet');
    // Without optional parts only the title is rendered, as a paragraph by default.
    const bare = EmptyState({ title: 'Nothing' });
    expect(
      ((bare.props as { children: unknown[] }).children.filter(isValidElement) as ReactElement[]).map((c) => c.type),
    ).toEqual(['p']);
  });
});
