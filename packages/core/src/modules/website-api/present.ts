import type { ListingDetailDoc, UnitDetailDoc, WebsiteDetail, WebsitePresenter } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import * as agencies from '../agencies';
import * as search from '../search';
import * as websites from '../websites';
import { viewWith } from './service';

/**
 * S13-F11: public documents presented to a client as an agency's own "site" — the one read behind selections (S12-04)
 * and listing PDFs (S12-05). The read models (`search.publicDocs`, PUBLIC listings only), another agency's document only
 * while it is still presentable by this agency (`search.networkPresentable`: shared with it, not hidden from the
 * network, both agencies listed), presented as on a website of the agency (`websites.sitePresenter` + `viewWith`):
 * its presenter, the agency's own text overrides, the owner's identity, references and the model pass's cached
 * removals white-labelled away (`websites.serializeDetail`). Runs as `app_public` (`withPublicRead`).
 *
 * Statements: the agency's public profile (1), the documents (1), the presentable check (1, only with other agencies'
 * documents), the view (1: overrides and owner identities, only with other agencies' documents) — plus one
 * redis-cache MGET (cached removals).
 */

/** A document row as presenting it needs (`search.publicDocs`). */
export type PresentableDocRow = Pick<
  search.PublicDocRow,
  'targetId' | 'ownerAgencyId' | 'publicCode' | 'developmentCode' | 'developmentOwnRef' | 'doc'
>;

export interface PresentPublicDocsInput {
  /** The presenting agency (the "site"). */
  agencyId: string;
  /** The documents to show (listings or units); unknown, non-public or no longer presentable ones are left out. */
  ids: readonly string[];
  locale: string;
  /** The content locale a document falls back to when it has none in `locale`. */
  fallbackLocale: string;
  /** The presenter's name while the agency has no public profile. */
  fallbackName: string;
  /** Titles the agent gave documents for this client: they take precedence over the agency's own overrides. */
  titles?: ReadonlyMap<string, string>;
}

export interface PresentedPublicDocs {
  presenter: WebsitePresenter;
  /** The view the documents were presented with (owner matchers and cached removals: for the agent's own texts). */
  view: websites.SiteView;
  /** The documents shown (presentable ones only), in read order. */
  rows: search.PublicDocRow[];
  /** Each shown document's detail by target id. */
  details: Map<string, WebsiteDetail>;
}

/** The documents `ids` as `agencyId` presents them to a client (see the module comment). */
export async function presentPublicDocs(tx: Tx, input: PresentPublicDocsInput): Promise<PresentedPublicDocs> {
  const agency = (await agencies.publicAgencies(tx, [input.agencyId])).get(input.agencyId) ?? null;
  const presenter = websites.sitePresenter({ name: agency?.name ?? input.fallbackName, contact: null }, agency);
  const docs = await search.publicDocs(tx, input.ids, 'detail', input.locale, input.fallbackLocale);
  // Re-checked at every read (S12 review): an owner narrowing or withdrawing a listing takes it off at once.
  const others = docs.filter((r) => r.ownerAgencyId !== input.agencyId).map((r) => r.targetId);
  const shared = others.length > 0 ? await search.networkPresentable(tx, input.agencyId, others) : new Set<string>();
  const rows = docs.filter((r) => r.ownerAgencyId === input.agencyId || shared.has(r.targetId));
  const scope = { agencyId: input.agencyId, referencePrefix: null, presenter };
  const { view } = await viewWith(tx, { scope }, input.locale, rows);
  const presented = presentDocs(view, rows, input.titles);
  return { presenter: view.presenter, view: presented.view, rows, details: presented.details };
}

/**
 * The pure half of `presentPublicDocs`: each row's detail on `view`, the agent's `titles` taking precedence over the
 * agency's own listing overrides (their descriptions kept).
 */
export function presentDocs(
  view: websites.SiteView,
  rows: readonly PresentableDocRow[],
  titles?: ReadonlyMap<string, string>,
): { view: websites.SiteView; details: Map<string, WebsiteDetail> } {
  let shown = view;
  if (titles !== undefined) {
    const targets = new Map(view.overrides?.targets ?? []);
    for (const [targetId, title] of titles) {
      targets.set(targetId, { title, description: targets.get(targetId)?.description ?? null });
    }
    shown = { ...view, overrides: { targets, developments: view.overrides?.developments ?? new Map() } };
  }
  const details = new Map<string, WebsiteDetail>();
  for (const r of rows) {
    details.set(
      r.targetId,
      websites.serializeDetail(shown, {
        ownerAgencyId: r.ownerAgencyId,
        publicCode: r.publicCode,
        developmentCode: r.developmentCode,
        developmentOwnRef: r.developmentOwnRef,
        doc: r.doc as ListingDetailDoc | UnitDetailDoc,
      }),
    );
  }
  return { view: shown, details };
}
