'use client';

import { Input } from '@inmolink/ui';
import { useId, useMemo, useState } from 'react';
import type { Option } from './taxonomy';
import { LOCATION_RENDER_LIMIT, locationMatches, searchable } from './taxonomy-search';

export interface LocationPickerLabels {
  /** Accessible name of the search box. */
  search: string;
  /** "Showing {shown} of {total} places: type to narrow the list." */
  showing: string;
  /** Placeholder option (create form), when `placeholder` is set. */
  choose: string;
}

interface Props {
  options: Option[];
  value: string;
  onChange: (id: string) => void;
  labels: LocationPickerLabels;
  /** Shows an empty "Choose…" option (new listing); the editor always has a location. */
  placeholder?: boolean;
  selectClassName: string;
  /** Spread on the `<select>`: id, name, disabled, aria-*. */
  selectProps?: Record<string, unknown>;
  disabled?: boolean;
}

/**
 * A searchable location picker (S12-F23). Spain has thousands of locations; a `<select>` with every one is thousands
 * of accessibility nodes. A search box narrows the list and the select renders at most `LOCATION_RENDER_LIMIT`
 * matches (plus the current choice). Still a native select: keyboard, forms and screen readers work as before.
 */
export function LocationPicker(props: Props) {
  const [query, setQuery] = useState('');
  const hintId = useId();
  const all = useMemo(() => searchable(props.options), [props.options]);
  const { shown, total } = useMemo(
    () => locationMatches(all, query, props.value, LOCATION_RENDER_LIMIT),
    [all, query, props.value],
  );
  const l = props.labels;
  return (
    <div className="flex flex-col gap-1.5">
      <Input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label={l.search}
        aria-describedby={hintId}
        placeholder={l.search}
        disabled={props.disabled}
        autoComplete="off"
      />
      <select
        {...props.selectProps}
        className={props.selectClassName}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      >
        {props.placeholder ? <option value="">{l.choose}</option> : null}
        {shown.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <p id={hintId} className="text-xs text-muted-foreground" aria-live="polite">
        {l.showing.replace('{shown}', String(Math.min(total, LOCATION_RENDER_LIMIT))).replace('{total}', String(total))}
      </p>
    </div>
  );
}
