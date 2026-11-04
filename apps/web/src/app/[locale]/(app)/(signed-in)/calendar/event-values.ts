import { CreateCalendarEventBody } from '@inmolink/contracts';
import { parseLocalDateTime } from '../tasks/time';

/** Durations the form offers, in minutes (the create and edit forms share them). */
export const DURATIONS = [15, 30, 45, 60, 90, 120, 180] as const;
/** Reminder offsets the form offers: `none`, or minutes before the start. */
export const REMINDERS = ['none', '0', '15', '30', '60', '1440'] as const;

/** What the event form shows: text as typed, the start as a `datetime-local` value in the agency time zone. */
export interface EventFormValues {
  type: string;
  title: string;
  location: string;
  startsAt: string;
  duration: string;
  remind: string;
}

/** The edit form state: a refusal comes back with what was typed, so nothing is lost (as the contact edit does). */
export interface EditEventState {
  values?: EventFormValues;
  error?: string;
}

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

export function eventFormValues(form: FormData): EventFormValues {
  return {
    type: text(form, 'type'),
    title: text(form, 'title'),
    location: text(form, 'location'),
    startsAt: text(form, 'startsAt'),
    duration: text(form, 'duration'),
    remind: text(form, 'remind'),
  };
}

/** The form values as the API body fields (create and edit alike); null when they are not valid. */
export function eventFormBody(values: EventFormValues, timeZone: string) {
  const startsAt = parseLocalDateTime(values.startsAt, timeZone);
  const duration = Number(values.duration);
  if (!startsAt || !(DURATIONS as readonly number[]).includes(duration)) return null;
  const parsed = CreateCalendarEventBody.safeParse({
    type: values.type,
    title: values.title,
    ...(values.location ? { location: values.location } : {}),
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + duration * 60_000).toISOString(),
    remindMinutes: values.remind === 'none' ? null : Number(values.remind),
  });
  return parsed.success ? parsed.data : null;
}

/** A `datetime-local` value (`2026-10-24T09:30`) for the instant, as the wall clock reads in the zone. */
export function toLocalInput(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(iso));
  const p = (type: string) => parts.find((x) => x.type === type)?.value ?? '00';
  return `${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}`;
}

/** The form values for an existing event. */
export function eventToValues(
  e: {
    type: string;
    title: string;
    location: string | null;
    startsAt: string;
    endsAt: string;
    remindMinutes: number | null;
  },
  timeZone: string,
): EventFormValues {
  return {
    type: e.type,
    title: e.title,
    location: e.location ?? '',
    startsAt: toLocalInput(e.startsAt, timeZone),
    duration: String(Math.round((new Date(e.endsAt).getTime() - new Date(e.startsAt).getTime()) / 60_000)),
    remind: e.remindMinutes === null ? 'none' : String(e.remindMinutes),
  };
}
