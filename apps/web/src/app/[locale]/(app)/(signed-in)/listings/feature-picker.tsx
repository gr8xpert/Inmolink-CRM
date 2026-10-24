'use client';

import { Button, Input } from '@inmolink/ui';
import { type ReactNode, useId, useMemo, useState } from 'react';
import type { OptionGroup } from './taxonomy';
import { FEATURES_PAGE, featureMatches, GROUPS_PAGE, searchable } from './taxonomy-search';

export interface FeaturePickerLabels {
  search: string;
  /** "{selected} of {total} selected" */
  groupCount: string;
  /** "Show more groups ({count} left)" */
  moreGroups: string;
  /** "Show more ({count} left)" */
  moreFeatures: string;
  /** "{shown} of {total} matching features shown" */
  searchShowing: string;
  noMatch: string;
  /** "Show {group}" / "Hide {group}" */
  open: string;
  close: string;
}

interface Props {
  groups: OptionGroup[];
  selected: readonly string[];
  onToggle: (id: string, on: boolean) => void;
  disabled?: boolean;
  labels: FeaturePickerLabels;
}

const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));

/**
 * Features grouped and lazily rendered (S12-F23): groups with a choice start open, the rest are one header each, and
 * a group lists its features in pages. A search box lists matches across all groups (capped), so a feature is one
 * search away whatever the taxonomy size. Checkbox state is the editor's `featureIds`, nothing is kept here.
 */
export function FeaturePicker(props: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [groupLimit, setGroupLimit] = useState(GROUPS_PAGE);
  const [featureLimit, setFeatureLimit] = useState<Record<string, number>>({});
  const hintId = useId();
  const chosen = useMemo(() => new Set(props.selected), [props.selected]);
  const index = useMemo(
    () => props.groups.map((group) => ({ group, options: searchable(group.options) })),
    [props.groups],
  );
  const l = props.labels;
  const q = query.trim();

  const checkbox = (o: { id: string; label: string }) => (
    <label key={o.id} className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        disabled={props.disabled}
        checked={chosen.has(o.id)}
        onChange={(e) => props.onToggle(o.id, e.target.checked)}
      />
      {o.label}
    </label>
  );

  let body: ReactNode;
  if (q) {
    const { groups, total } = featureMatches(index, q);
    const shown = groups.reduce((n, g) => n + g.options.length, 0);
    body = (
      <>
        <p id={hintId} className="text-xs text-muted-foreground" aria-live="polite">
          {total === 0 ? l.noMatch : fill(l.searchShowing, { shown, total })}
        </p>
        {groups.map((g) => (
          <fieldset key={g.label} className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">{g.label}</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{g.options.map(checkbox)}</div>
          </fieldset>
        ))}
      </>
    );
  } else {
    // Groups holding a choice come first and stay open, so what the listing has is always in view.
    const withChoice = index.filter(({ group }) => group.options.some((o) => chosen.has(o.id)));
    const rest = index.filter((g) => !withChoice.includes(g));
    const ordered = [...withChoice, ...rest];
    const visible = ordered.slice(0, Math.max(groupLimit, withChoice.length));
    body = (
      <>
        {visible.map(({ group }) => {
          const count = group.options.filter((o) => chosen.has(o.id)).length;
          const isOpen = open.has(group.label) || count > 0;
          const limit = featureLimit[group.label] ?? FEATURES_PAGE;
          return (
            <fieldset key={group.label} className="flex flex-col gap-2">
              <legend className="mb-1 flex items-center gap-2 text-sm font-medium">
                <span>{group.label}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {fill(l.groupCount, { selected: count, total: group.options.length })}
                </span>
                {count === 0 ? (
                  <button
                    type="button"
                    className="text-xs font-normal underline-offset-4 hover:underline"
                    aria-expanded={isOpen}
                    onClick={() =>
                      setOpen((s) => {
                        const next = new Set(s);
                        if (!next.delete(group.label)) next.add(group.label);
                        return next;
                      })
                    }
                  >
                    {fill(isOpen ? l.close : l.open, { group: group.label })}
                  </button>
                ) : null}
              </legend>
              {isOpen ? (
                <>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {group.options.slice(0, limit).map(checkbox)}
                  </div>
                  {group.options.length > limit ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setFeatureLimit((m) => ({ ...m, [group.label]: limit + FEATURES_PAGE }))}
                    >
                      {fill(l.moreFeatures, { count: group.options.length - limit })}
                    </Button>
                  ) : null}
                </>
              ) : null}
            </fieldset>
          );
        })}
        {ordered.length > visible.length ? (
          <Button type="button" variant="outline" onClick={() => setGroupLimit((n) => n + GROUPS_PAGE)}>
            {fill(l.moreGroups, { count: ordered.length - visible.length })}
          </Button>
        ) : null}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label={l.search}
        placeholder={l.search}
        autoComplete="off"
      />
      {body}
    </div>
  );
}
