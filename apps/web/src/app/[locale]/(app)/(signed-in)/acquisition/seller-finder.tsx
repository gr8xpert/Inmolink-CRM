import type { ContactListItemDto } from '@inmolink/contracts';
import { getTranslations } from 'next-intl/server';
import type { SessionRef } from '@/server/api';
import { lookupContacts } from '@/server/contacts-api';
import { lookupBody } from '../contacts/lookup';

/**
 * The seller picker's search (S11-F14), replacing the list of the 100 newest sellers: a GET form (`?find=`) that looks a
 * contact up by exact e-mail or phone. The value is sent to the API in a request body, never put in a URL by the API
 * call; the matches go into the prospect form's seller select.
 */
export async function findSellers(
  ref: SessionRef,
  find: unknown,
): Promise<{ query: string; items: ContactListItemDto[]; searched: boolean } | 'revoked'> {
  const query = typeof find === 'string' ? find.trim().slice(0, 254) : '';
  const body = query ? lookupBody(query) : null;
  if (!body) return { query, items: [], searched: false };
  const res = await lookupContacts(ref, body);
  if (res === 'revoked') return 'revoked';
  return { query, items: res.ok ? res.data.items : [], searched: true };
}

export async function SellerFinder({ query, searched, count }: { query: string; searched: boolean; count: number }) {
  const t = await getTranslations('acquisition.form');
  return (
    <form method="get" className="flex flex-wrap items-end gap-3 rounded-md border p-3 text-sm">
      <label className="flex min-w-60 flex-1 flex-col gap-1">
        <span>{t('sellerFind')}</span>
        <input
          name="find"
          type="search"
          defaultValue={query}
          maxLength={254}
          autoComplete="off"
          className="h-9 rounded-md border bg-background px-2"
        />
      </label>
      <button type="submit" className="h-9 rounded-md border px-3 font-medium">
        {t('sellerFindSubmit')}
      </button>
      {searched && count === 0 ? <p className="basis-full text-muted-foreground">{t('sellerFindNone')}</p> : null}
    </form>
  );
}
