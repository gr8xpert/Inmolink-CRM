import type { ProspectDto } from '@inmolink/contracts';
import { getFormatter, getTranslations } from 'next-intl/server';

/** A board card as the client draws it: ids and version, and its texts already in the member's language. */
export interface ProspectCard {
  id: string;
  version: number;
  title: string;
  seller: string;
  /** Estimated price, formatted; empty without one. */
  price: string;
  /** "Follow up 24 Oct 2026", or empty. */
  followUp: string;
  converted: boolean;
}

export function sellerName(p: Pick<ProspectDto, 'contactId' | 'contactName'>, fallback: string): string {
  return p.contactName ?? (p.contactId ? fallback : '');
}

export async function toProspectCards(items: ProspectDto[]): Promise<ProspectCard[]> {
  const t = await getTranslations('acquisition');
  const format = await getFormatter();
  return items.map((p) => ({
    id: p.id,
    version: p.version,
    title: p.title,
    seller: sellerName(p, t('board.noName')),
    price: p.estimatedPrice
      ? format.number(p.estimatedPrice.amountCents / 100, {
          style: 'currency',
          currency: p.estimatedPrice.currency,
          maximumFractionDigits: 0,
        })
      : '',
    followUp: p.nextFollowUpAt
      ? t('board.followUp', { date: format.dateTime(new Date(p.nextFollowUpAt), { dateStyle: 'medium' }) })
      : '',
    converted: p.listingId !== null,
  }));
}
