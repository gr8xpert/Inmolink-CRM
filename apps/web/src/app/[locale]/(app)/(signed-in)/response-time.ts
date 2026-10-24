/** How a response time reads on the dashboard card (S10-09): seconds below a minute, minutes below an hour, then hours. */
export type DurationParts =
  | { unit: 'seconds'; value: number }
  | { unit: 'minutes'; value: number }
  | { unit: 'hours'; hours: number; minutes: number };

export function durationParts(totalSeconds: number): DurationParts {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return { unit: 'seconds', value: s };
  if (s < 3_600) return { unit: 'minutes', value: Math.round(s / 60) === 60 ? 59 : Math.round(s / 60) };
  const minutes = Math.floor((s % 3_600) / 60);
  return { unit: 'hours', hours: Math.floor(s / 3_600), minutes };
}
