import { describe, expect, it } from 'vitest';
import { eventFormBody, eventFormValues, eventToValues, toLocalInput } from './event-values';

const ZONE = 'Europe/Madrid';

describe('calendar event form values (S17-F42)', () => {
  it('[S17-F42] shows an instant as the wall clock reads in the agency time zone, summer and winter', () => {
    expect(toLocalInput('2026-07-10T07:30:00.000Z', ZONE)).toBe('2026-07-10T09:30');
    expect(toLocalInput('2026-12-10T08:30:00.000Z', ZONE)).toBe('2026-12-10T09:30');
    expect(toLocalInput('2026-12-10T23:30:00.000Z', ZONE)).toBe('2026-12-11T00:30');
  });

  it('[S17-F42] the edit form round-trips an event unchanged: values in, the same instants out', () => {
    const event = {
      type: 'MEETING',
      title: 'Handover',
      location: null,
      startsAt: '2026-07-10T07:30:00.000Z',
      endsAt: '2026-07-10T09:00:00.000Z',
      remindMinutes: 15,
    };
    const values = eventToValues(event, ZONE);
    expect(values).toEqual({
      type: 'MEETING',
      title: 'Handover',
      location: '',
      startsAt: '2026-07-10T09:30',
      duration: '90',
      remind: '15',
    });
    expect(eventFormBody(values, ZONE)).toMatchObject({
      type: 'MEETING',
      title: 'Handover',
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      remindMinutes: 15,
    });
  });

  it('[S17-F42] a no-reminder event stays without one, and invalid input is refused', () => {
    const base = {
      type: 'CALL',
      title: 'Ring',
      location: '',
      startsAt: '2026-07-10T09:30',
      duration: '30',
      remind: 'none',
    };
    expect(eventFormBody(base, ZONE)?.remindMinutes).toBeNull();
    expect(eventFormBody({ ...base, title: '' }, ZONE)).toBeNull();
    expect(eventFormBody({ ...base, duration: '31' }, ZONE)).toBeNull();
    expect(eventFormBody({ ...base, startsAt: 'tomorrow' }, ZONE)).toBeNull();
  });

  it('[S17-F42] reads the posted form, trimmed, so a refused save can show it back', () => {
    const form = new FormData();
    form.set('title', '  Visit  ');
    form.set('startsAt', '2026-07-10T09:30');
    expect(eventFormValues(form)).toMatchObject({ title: 'Visit', startsAt: '2026-07-10T09:30', location: '' });
  });
});
