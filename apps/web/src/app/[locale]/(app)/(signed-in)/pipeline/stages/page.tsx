import { randomUUID } from 'node:crypto';
import type { PipelineStageDto } from '@inmolink/contracts';
import { CRM_PIPELINE_LIMITS, PIPELINE_STAGE_KINDS } from '@inmolink/contracts';
import { Button, Input, Label } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchPipelineStages } from '@/server/crm-api';
import { addStageAction, shiftStageAction, updateStageAction } from '../actions';
import { stageLabel } from '../cards';

const ERRORS = [
  'VERSION_CONFLICT',
  'FORBIDDEN',
  'PIPELINE_STAGE_NOT_FOUND',
  'PIPELINE_STAGE_DUPLICATE',
  'PIPELINE_STAGE_LIMIT',
  'PIPELINE_STAGE_LOCKED',
  'PIPELINE_ORDER_INVALID',
  'VALIDATION_FAILED',
] as const;

const FIELD = 'h-9 rounded-md border bg-background px-2 text-sm';

/**
 * Pipeline stages (S10-03): the agency's stages in board order — rename (or back to the default name), move up or
 * down, archive an empty one, restore, add a stage that counts as open, won or lost. Agency admins change them; the
 * API refuses everyone else (the page says so).
 */
export default async function PipelineStagesPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const params = await searchParams;
  const res = await fetchPipelineStages(sessionRef(session.user), true);
  if (res === 'revoked') redirect('/session/expired');
  const t = await getTranslations('leads.pipeline');
  const error = ERRORS.find((c) => c === params.error) ?? (params.error ? 'generic' : null);
  const stages = res.ok ? res.data.items : [];
  const active = stages.filter((s) => !s.archived);
  const archived = stages.filter((s) => s.archived);
  const labels = new Map(await Promise.all(stages.map(async (s) => [s.id, await stageLabel(s)] as const)));

  const row = (s: PipelineStageDto, i: number) => (
    <li key={s.id} className="flex flex-col gap-2 rounded-md border p-3" data-testid="pipeline-stage">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{labels.get(s.id)}</span>
        <span className="rounded-full bg-muted px-2 text-xs">{t(`kinds.${s.kind}`)}</span>
        {s.entry ? <span className="text-xs text-muted-foreground">{t('settings.entry')}</span> : null}
      </div>
      <form action={updateStageAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="id" value={s.id} />
        <input type="hidden" name="version" value={s.version} />
        <Label htmlFor={`name-${s.id}`} className="sr-only">
          {`${t('settings.name')}: ${labels.get(s.id)}`}
        </Label>
        <Input
          id={`name-${s.id}`}
          name="name"
          defaultValue={s.name ?? ''}
          placeholder={labels.get(s.id)}
          maxLength={CRM_PIPELINE_LIMITS.nameChars}
          className="w-56"
        />
        <Button type="submit" name="intent" value="rename" variant="outline" size="sm">
          {t('settings.rename')}
        </Button>
        {s.key && s.name ? (
          <Button type="submit" name="intent" value="reset" variant="ghost" size="sm">
            {t('settings.resetName')}
          </Button>
        ) : null}
        {s.archived ? (
          <Button type="submit" name="intent" value="restore" variant="outline" size="sm">
            {t('settings.restore')}
          </Button>
        ) : s.entry ? null : (
          <Button type="submit" name="intent" value="archive" variant="ghost" size="sm">
            {t('settings.archive')}
          </Button>
        )}
      </form>
      {s.archived ? null : (
        <div className="flex gap-2">
          <form action={shiftStageAction}>
            <input type="hidden" name="id" value={s.id} />
            <input type="hidden" name="dir" value="up" />
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              disabled={i === 0}
              aria-label={`${t('settings.up')}: ${labels.get(s.id)}`}
            >
              {t('settings.up')}
            </Button>
          </form>
          <form action={shiftStageAction}>
            <input type="hidden" name="id" value={s.id} />
            <input type="hidden" name="dir" value="down" />
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              disabled={i === active.length - 1}
              aria-label={`${t('settings.down')}: ${labels.get(s.id)}`}
            >
              {t('settings.down')}
            </Button>
          </form>
        </div>
      )}
    </li>
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('settings.title')}</h1>
        <Link href="/pipeline" className="text-sm underline-offset-4 hover:underline">
          {t('settings.back')}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">{t('settings.intro')}</p>
      {params.done ? (
        <p role="status" className="text-sm">
          {t('settings.done')}
        </p>
      ) : null}
      {error || !res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${error ?? 'generic'}`)}
        </p>
      ) : null}
      <ol className="flex flex-col gap-2">{active.map(row)}</ol>
      {archived.length > 0 ? (
        <section className="flex flex-col gap-2" aria-labelledby="stages-archived">
          <h2 id="stages-archived" className="text-lg font-semibold">
            {t('settings.archivedTitle')}
          </h2>
          <ul className="flex flex-col gap-2">{archived.map(row)}</ul>
        </section>
      ) : null}
      <section className="flex flex-col gap-3 rounded-md border p-4" aria-labelledby="stage-add-title">
        <h2 id="stage-add-title" className="text-lg font-semibold">
          {t('settings.addTitle')}
        </h2>
        <form action={addStageAction} className="flex flex-wrap items-end gap-3">
          {/* one key per rendered form: a double submit creates the stage once */}
          <input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <div className="flex flex-col gap-1">
            <Label htmlFor="stage-add-name">{t('settings.name')}</Label>
            <Input id="stage-add-name" name="name" required maxLength={CRM_PIPELINE_LIMITS.nameChars} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="stage-add-kind">{t('settings.kind')}</Label>
            <select id="stage-add-kind" name="kind" className={FIELD} defaultValue="OPEN">
              {PIPELINE_STAGE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`kinds.${k}`)}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit">{t('settings.add')}</Button>
        </form>
      </section>
    </div>
  );
}
