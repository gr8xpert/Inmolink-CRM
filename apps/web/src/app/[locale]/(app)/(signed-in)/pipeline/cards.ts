import type { PipelineLeadDto, PipelineStageDto } from '@inmolink/contracts';
import { getFormatter, getTranslations } from 'next-intl/server';

/** A board card as the client draws it: ids and version, and its texts already in the member's language. */
export interface BoardCard {
  id: string;
  version: number;
  name: string;
  source: string;
  assigned: boolean;
  since: string;
}

/** A stage's label: the agency's name, else the default stage's translated name. */
export async function stageLabel(stage: Pick<PipelineStageDto, 'name' | 'key'>): Promise<string> {
  if (stage.name) return stage.name;
  const t = await getTranslations('leads.pipeline');
  return stage.key ? t(`stages.${stage.key}`) : '';
}

export function contactName(c: PipelineLeadDto['contact'], fallback: string): string {
  const full = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  return full || c.primaryEmail || c.primaryPhone || fallback;
}

export async function toBoardCards(items: PipelineLeadDto[]): Promise<BoardCard[]> {
  const t = await getTranslations('leads.pipeline');
  const format = await getFormatter();
  return items.map((l) => ({
    id: l.id,
    version: l.version,
    name: contactName(l.contact, t('board.noName')),
    source: t(`sources.${l.source}`),
    assigned: l.assignedUserId !== null,
    since: t('board.since', { date: format.dateTime(new Date(l.stageEnteredAt), { dateStyle: 'medium' }) }),
  }));
}
