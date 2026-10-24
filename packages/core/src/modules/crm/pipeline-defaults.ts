/**
 * The default stages, in order: the one definition of an agency's starting pipeline (migration 0124 seeded the agencies
 * then with the same five).
 */
export const DEFAULT_STAGES = ['NEW', 'IN_PROGRESS', 'WON', 'LOST', 'SPAM'] as const;
