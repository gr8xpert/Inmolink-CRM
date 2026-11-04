export interface Option {
  value: string;
  label: string;
}

export interface EventFieldsLabels {
  type: string;
  title: string;
  startsAt: string;
  duration: string;
  location: string;
  remind: string;
  types: Option[];
  durations: Option[];
  reminders: Option[];
}

const field = 'h-9 rounded-md border bg-background px-2';

/** The event fields (S10-06), shared by the create form and the edit form (S17-F42); no state of its own. */
export function EventFields({
  labels: l,
  values,
}: {
  labels: EventFieldsLabels;
  values: { type: string; title: string; location: string; startsAt: string; duration: string; remind: string };
}) {
  return (
    <>
      <label className="flex flex-col gap-1">
        <span>{l.type}</span>
        <select name="type" className={field} defaultValue={values.type}>
          {l.types.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-60 flex-1 flex-col gap-1">
        <span>{l.title}</span>
        <input name="title" required maxLength={200} defaultValue={values.title} className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span>{l.startsAt}</span>
        <input name="startsAt" type="datetime-local" required defaultValue={values.startsAt} className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span>{l.duration}</span>
        <select name="duration" className={field} defaultValue={values.duration}>
          {l.durations.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-48 flex-col gap-1">
        <span>{l.location}</span>
        <input name="location" maxLength={300} defaultValue={values.location} className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span>{l.remind}</span>
        <select name="remind" className={field} defaultValue={values.remind}>
          {l.reminders.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
