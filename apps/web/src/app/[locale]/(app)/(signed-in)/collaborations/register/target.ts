import { type DevelopmentDto, type ListingContentDto, type ListingDto, RegistrationTarget } from '@inmolink/contracts';
import type { TermsFacts } from '../terms-text';

/** What the register page shows of the target (S17-F56): only what the API gives the viewer's agency. */
export interface RegisterTarget {
  kind: RegistrationTarget['kind'];
  id: string;
  reference: string | null;
  title: string | null;
  /** The viewer's agency owns it: there is nobody to register a client with. */
  own: boolean;
  /** Null when the target publishes no commission: registering works, a viewing is then refused. */
  terms: TermsFacts | null;
}

/** The page's query as a target; null for anything the API would not take. */
export function parseTargetParams(p: {
  kind?: string | undefined;
  id?: string | undefined;
}): RegistrationTarget | null {
  const parsed = RegistrationTarget.safeParse({ kind: p.kind, id: p.id });
  return parsed.success ? parsed.data : null;
}

type Commission = NonNullable<DevelopmentDto['commission']>;

function terms(total: Commission | null | undefined, splitBp: number | null | undefined): TermsFacts | null {
  if (!total) return null;
  return {
    commissionBp: total.type === 'PCT' ? total.basisPoints : null,
    commissionFixed: total.type === 'FIXED' ? total.amount : null,
    splitBp: splitBp ?? null,
    includesVat: total.includesVat,
  };
}

export function listingTarget(l: ListingDto, content: ListingContentDto | null, locale: string): RegisterTarget {
  const translations = content?.translations ?? [];
  return {
    kind: 'LISTING',
    id: l.id,
    reference: l.ref,
    title: (translations.find((tr) => tr.locale === locale) ?? translations[0])?.title ?? null,
    own: l.private !== null,
    terms: terms(l.commission?.total, l.commission?.splitBp),
  };
}

export function developmentTarget(d: DevelopmentDto): RegisterTarget {
  return {
    kind: 'DEVELOPMENT',
    id: d.id,
    reference: d.ref,
    title: d.name,
    own: d.access !== null,
    terms: terms(d.commission, d.commissionSplitBp),
  };
}
