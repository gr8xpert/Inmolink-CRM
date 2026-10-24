import { LEAD_SOURCES, type LeadSource } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import { routeLead } from '../routing';

/** PLAN §3 #12 lead routing, source by source (S10-02). */

const PRESENTING = '01900000-0000-7000-8000-00000000000a';
const OWNER = '01900000-0000-7000-8000-00000000000b';

type Case = {
  source: LeadSource;
  presenting: string | null;
  owner: string | null;
  holder: string;
  introduced: string | null;
};

/** A partner's network listing (owner ≠ presenting), the presenting agency's own listing, and no presenting agency. */
const TABLE: Case[] = [
  // marketplace → the listing owner, whoever showed it
  { source: 'MARKETPLACE', presenting: null, owner: OWNER, holder: OWNER, introduced: null },
  { source: 'MARKETPLACE', presenting: PRESENTING, owner: OWNER, holder: OWNER, introduced: null },
  // agency website / iFrame / selection / portfolio → the presenting agency; the owner sees the introducer
  ...(['WEBSITE', 'IFRAME', 'SELECTION', 'PORTFOLIO', 'PORTAL', 'CHATBOT', 'WHATSAPP', 'MANUAL'] as const).flatMap(
    (source): Case[] => [
      { source, presenting: PRESENTING, owner: OWNER, holder: PRESENTING, introduced: OWNER },
      { source, presenting: PRESENTING, owner: null, holder: PRESENTING, introduced: null },
    ],
  ),
  // developer portal → the presenting agency, and the developer (introduced: never the client)
  { source: 'DEVELOPER_PORTAL', presenting: PRESENTING, owner: OWNER, holder: PRESENTING, introduced: OWNER },
  // the developer's own portal (nobody presenting): the developer holds it
  { source: 'DEVELOPER_PORTAL', presenting: null, owner: OWNER, holder: OWNER, introduced: null },
];

describe('lead routing (PLAN §3 #12)', () => {
  it('[S10-02] routing follows §3 #12 for each source', () => {
    for (const c of TABLE) {
      expect(
        routeLead({ source: c.source, presentingAgencyId: c.presenting, ownerAgencyId: c.owner }),
        `${c.source} presenting=${c.presenting ? 'yes' : 'no'} owner=${c.owner ? 'other' : 'none'}`,
      ).toEqual({ holderAgencyId: c.holder, introducedAgencyId: c.introduced });
    }
    // every source is in the table
    expect(new Set(TABLE.map((c) => c.source))).toEqual(new Set(LEAD_SOURCES));
  });

  it('[S10-02] a lead with neither a presenting agency nor an owner has no inbox', () => {
    expect(() => routeLead({ source: 'WEBSITE', presentingAgencyId: null, ownerAgencyId: null })).toThrow();
  });
});
