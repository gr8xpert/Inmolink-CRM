import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';

/**
 * S7-F1 (S6 review L2): the run and error reads authorize the row they loaded, not only the action — a row of another
 * agency (RLS should never return one) is refused, never shown. The repo is replaced so the row can be anyone's.
 */
const repo = vi.hoisted(() => ({
  getConnection: vi.fn(),
  getRun: vi.fn(),
  listRuns: vi.fn(),
  listItemErrors: vi.fn(),
}));
vi.mock('../repo', () => repo);

const { getFeedRun, listFeedItemErrors, listFeedRuns } = await import('../service');

const AGENCY = '01900000-0000-7000-8000-000000000001';
const OTHER = '01900000-0000-7000-8000-000000000002';
const ID = '01900000-0000-7000-8000-0000000000c1';

const ctx: Ctx = {
  tx: {} as Ctx['tx'],
  tenant: { agencyId: AGENCY, verified: true, plan: 'test', locales: ['en'] },
  actor: { kind: 'user', userId: '01900000-0000-7000-8000-0000000000aa', role: 'AGENT' },
  locale: 'en',
  requestId: 'test',
  clientMode: false,
};

const run = (agencyId: string) => ({
  id: ID,
  agencyId,
  connectionId: ID,
  trigger: 'MANUAL',
  state: 'SUCCEEDED',
  attempt: 1,
  itemsTotal: 0,
  itemsValid: 0,
  itemsFailed: 0,
  itemsCreated: 0,
  itemsUpdated: 0,
  itemsUnchanged: 0,
  itemsHeld: 0,
  itemsWithdrawn: 0,
  errorsLogged: 0,
  bytesRead: 0,
  errorCode: null,
  errorDetail: null,
  startedAt: null,
  finishedAt: null,
  createdAt: new Date(0),
});

beforeEach(() => {
  vi.clearAllMocks();
  repo.listRuns.mockResolvedValue({ items: [], hasMore: false });
  repo.listItemErrors.mockResolvedValue({ items: [], hasMore: false });
});

describe('imports reads authorize the loaded row', () => {
  it("[S7-F1] listFeedRuns refuses another agency's connection", async () => {
    repo.getConnection.mockResolvedValue({ id: ID, agencyId: OTHER });
    await expect(listFeedRuns(ctx, ID, { limit: 25 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(repo.listRuns).not.toHaveBeenCalled();
    repo.getConnection.mockResolvedValue({ id: ID, agencyId: AGENCY });
    await expect(listFeedRuns(ctx, ID, { limit: 25 })).resolves.toEqual({ items: [], nextCursor: null });
  });

  it("[S7-F1] getFeedRun refuses another agency's run", async () => {
    repo.getRun.mockResolvedValue(run(OTHER));
    await expect(getFeedRun(ctx, ID)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    repo.getRun.mockResolvedValue(run(AGENCY));
    await expect(getFeedRun(ctx, ID)).resolves.toMatchObject({ id: ID });
  });

  it("[S7-F1] listFeedItemErrors refuses another agency's run", async () => {
    repo.getRun.mockResolvedValue(run(OTHER));
    await expect(listFeedItemErrors(ctx, ID, { limit: 25 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(repo.listItemErrors).not.toHaveBeenCalled();
    repo.getRun.mockResolvedValue(run(AGENCY));
    await expect(listFeedItemErrors(ctx, ID, { limit: 25 })).resolves.toEqual({ items: [], nextCursor: null });
  });
});
