import type { OnboardingChecklistDto } from '@inmolink/contracts';
import { getLocale, getTranslations } from 'next-intl/server';
import { TourLauncher } from '@/components/onboarding/tour-launcher';
import { Link } from '@/i18n/navigation';
import { webConfig } from '@/server/env';
import { helpLink, stepHref } from '@/server/onboarding-api';

/**
 * The onboarding checklist on the dashboard home (S13-04): the steps of the member's role, ticked from the agency's
 * events (never by hand), each with where to do it and a help-centre link; a product tour of the same steps. Hidden
 * once every step is done.
 */
export async function OnboardingChecklist({ checklist }: { checklist: OnboardingChecklistDto }) {
  if (checklist.total === 0 || checklist.completed === checklist.total) return null;
  const [t, locale, config] = await Promise.all([getTranslations('onboarding'), getLocale(), webConfig()]);
  const tourSteps = [
    { target: null, title: t('tour.intro.title'), body: t('tour.intro.body') },
    ...checklist.steps.map((s) => ({
      target: stepHref(s.step, checklist.role),
      title: t(`checklist.steps.${s.step}.title`),
      body: t(`tour.steps.${s.step}`),
    })),
    { target: '/support', title: t('tour.support.title'), body: t('tour.support.body') },
  ];
  const percent = Math.round((checklist.completed / checklist.total) * 100);

  return (
    <section
      aria-labelledby="onboarding-heading"
      data-testid="onboarding-checklist"
      className="flex flex-col gap-3 rounded-md border p-4 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="onboarding-heading" className="font-medium">
          {t('checklist.title')}
        </h2>
        <TourLauncher
          tourId="home"
          steps={tourSteps}
          startLabel={t('tour.start')}
          labels={{ next: t('tour.next'), back: t('tour.back'), done: t('tour.done'), close: t('tour.close') }}
          autoStart={checklist.completed === 0}
        />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground">
          {t('checklist.progress', { completed: checklist.completed, total: checklist.total })}
        </p>
        <div
          role="progressbar"
          aria-label={t('checklist.title')}
          aria-valuemin={0}
          aria-valuemax={checklist.total}
          aria-valuenow={checklist.completed}
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
        </div>
      </div>
      <ol className="flex flex-col divide-y rounded-md border">
        {checklist.steps.map((s) => {
          const help = helpLink(config.HELP_CENTER_URL, locale, s.step);
          const isDone = s.completedAt !== null;
          return (
            <li key={s.step} data-testid={`onboarding-step-${s.step}`} className="flex items-start gap-3 p-3">
              <span
                aria-hidden="true"
                className={
                  isDone
                    ? 'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground'
                    : 'mt-0.5 size-5 shrink-0 rounded-full border-2'
                }
              >
                {isDone ? '✓' : null}
              </span>
              <div className="flex flex-1 flex-col gap-1">
                <p className={isDone ? 'font-medium text-muted-foreground line-through' : 'font-medium'}>
                  {t(`checklist.steps.${s.step}.title`)}
                  <span className="sr-only">
                    {' — '}
                    {isDone ? t('checklist.done') : t('checklist.todo')}
                  </span>
                </p>
                {isDone ? null : <p className="text-muted-foreground">{t(`checklist.steps.${s.step}.body`)}</p>}
                {isDone ? null : (
                  <div className="flex flex-wrap gap-3">
                    <Link
                      href={stepHref(s.step, checklist.role)}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {t(`checklist.steps.${s.step}.action`)}
                    </Link>
                    {help ? (
                      <a
                        href={help}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground underline-offset-4 hover:underline"
                      >
                        {t('checklist.help')}
                      </a>
                    ) : null}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
