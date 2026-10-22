import { RESALES_API_KEY_MAX, resalesConnectionInput } from '@inmolink/contracts';

/**
 * The Resales Online connection form's fields (S7-F14). The shape of the connection body lives in
 * `resalesConnectionInput` (contracts), shared with the tests; the action only reads the form and calls the API.
 */
export const RESALES_ALIASES = ['1', '2', '3', '4'] as const;
export { RESALES_API_KEY_MAX };

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

export function resalesFormInput(form: FormData, editing: boolean): ReturnType<typeof resalesConnectionInput> {
  return resalesConnectionInput(
    {
      clientId: text(form, 'clientId'),
      apiKey: text(form, 'apiKey'),
      filterAlias: text(form, 'filterAlias'),
      languages: text(form, 'languages'),
    },
    editing,
  );
}
