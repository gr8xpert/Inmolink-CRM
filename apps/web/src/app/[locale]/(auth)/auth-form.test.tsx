import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/** Field-level messages of the shared auth form (S17-F50): each invalid field says so, linked by aria-describedby. */

const state = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('react', async (orig) => ({
  ...(await orig<typeof import('react')>()),
  useActionState: () => [state.value, () => undefined, false],
}));
vi.mock('./turnstile', () => ({ Turnstile: () => null }));

const errors = {
  invalidInput: 'Please check the highlighted fields.',
  fieldInvalid: 'Check “{field}”: it is empty or not valid.',
} as never;
const fields = [
  { name: 'name', label: 'Your name' },
  { name: 'email', label: 'Email', type: 'email' as const, hint: 'Work address' },
];

describe('AuthForm field messages', () => {
  it('[S17-F50] every invalid field gets its own message, described by aria-describedby', async () => {
    const { AuthForm } = await import('./auth-form');
    state.value = { error: 'invalidInput', fields: ['name', 'email'] };
    const html = renderToStaticMarkup(
      <AuthForm action={async () => ({})} fields={fields} submitLabel="Go" errors={errors} />,
    );
    expect(html).toContain('id="name-error"');
    expect(html).toContain('Check “Your name”: it is empty or not valid.');
    expect(html).toContain('aria-describedby="name-error"');
    expect(html).toContain('aria-describedby="email-hint email-error"');
  });

  it('[S17-F50] a form without field errors (login: wrong password) shows none', async () => {
    const { AuthForm } = await import('./auth-form');
    state.value = { error: 'invalidInput' };
    const html = renderToStaticMarkup(
      <AuthForm action={async () => ({})} fields={fields} submitLabel="Go" errors={errors} />,
    );
    expect(html).not.toContain('field-error');
  });
});
