'use client';

import { Button } from '@inmolink/ui';
import { useRouter } from 'next/navigation';
import { type DragEvent, useEffect, useId, useRef, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { loadColumnAction, moveProspectAction } from './actions';
import type { ProspectCard } from './cards';

/** A board column as the page hands it over (texts already translated). */
export interface ProspectColumn {
  stage: string;
  label: string;
  count: number;
  countCapped: boolean;
  cards: ProspectCard[];
  nextCursor: string | null;
}

export interface ProspectBoardLabels {
  board: string;
  empty: string;
  more: string;
  dragHint: string;
  moveTo: string;
  up: string;
  down: string;
  open: string;
  converted: string;
  /** `{name}` moved to `{stage}`. */
  moved: string;
  saving: string;
  /** Error messages by code, `generic` included. */
  errors: Record<string, string>;
}

/** The stage reached only by converting (and a converted prospect never leaves). */
const LISTED = 'LISTED';

const fill = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');

/**
 * The acquisition board (S10-07), the pipeline board's pattern: one column per stage; a card moves by drag-and-drop
 * (native HTML5) or from the keyboard (its "Move to" picker, Up / Down), the outcome announced. A move is shown at once
 * and sent with the card's version and the card it now follows; a refusal puts it back, says why and reloads. `Listed`
 * is reached by converting a prospect (its page), so it accepts no drop from another column, and a converted card stays
 * there. Loaded with `next/dynamic` (its own chunk).
 */
export default function ProspectBoard(props: { columns: ProspectColumn[]; labels: ProspectBoardLabels }) {
  const { labels } = props;
  const router = useRouter();
  const [columns, setColumns] = useState(props.columns);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(0);
  const [over, setOver] = useState<string | null>(null);
  const dragged = useRef<{ cardId: string; from: string; converted: boolean } | null>(null);
  const hintId = useId();
  useEffect(() => setColumns(props.columns), [props.columns]);

  const columnOf = (stage: string) => columns.find((c) => c.stage === stage);
  const canDrop = (from: string, to: string, converted: boolean) =>
    from === to || (to !== LISTED && !converted && from !== LISTED);

  async function move(cardId: string, from: string, to: string, toIndex: number) {
    const source = columnOf(from);
    const target = columnOf(to);
    const card = source?.cards.find((c) => c.id === cardId);
    if (!source || !target || !card || !canDrop(from, to, card.converted)) return;
    const rest = target.cards.filter((c) => c.id !== cardId);
    const at = Math.max(0, Math.min(toIndex, rest.length));
    if (from === to && source.cards.findIndex((c) => c.id === cardId) === at) return;
    const afterId = at > 0 ? (rest[at - 1]?.id ?? null) : null;
    const before = columns;
    setColumns((cols) =>
      cols.map((c) => {
        if (c.stage === to) {
          const cards = c.cards.filter((x) => x.id !== cardId);
          cards.splice(at, 0, card);
          return { ...c, cards, count: from === to ? c.count : c.count + 1 };
        }
        if (c.stage === from) return { ...c, cards: c.cards.filter((x) => x.id !== cardId), count: c.count - 1 };
        return c;
      }),
    );
    setError('');
    setPending((n) => n + 1);
    try {
      const res = await moveProspectAction(cardId, { version: card.version, stage: to, afterId });
      if (res.ok) {
        setColumns((cols) =>
          cols.map((c) => ({
            ...c,
            cards: c.cards.map((x) => (x.id === cardId ? { ...x, version: res.data.version } : x)),
          })),
        );
        setStatus(fill(labels.moved, { name: card.title, stage: target.label }));
        return;
      }
      setColumns(before);
      if (res.code === 'SESSION_REVOKED') {
        router.push('/session/expired');
        return;
      }
      setError(labels.errors[res.code] ?? labels.errors.generic ?? '');
      if (
        res.code === 'VERSION_CONFLICT' ||
        res.code === 'PROSPECT_NOT_FOUND' ||
        res.code === 'PROSPECT_STAGE_INVALID'
      ) {
        router.refresh();
      }
    } finally {
      setPending((n) => n - 1);
    }
  }

  async function loadMore(stage: string, cursor: string) {
    const res = await loadColumnAction(stage, cursor);
    if (!res.ok) {
      setError(labels.errors[res.code] ?? labels.errors.generic ?? '');
      return;
    }
    setColumns((cols) =>
      cols.map((c) =>
        c.stage === stage
          ? {
              ...c,
              cards: [...c.cards, ...res.data.cards.filter((n) => !c.cards.some((x) => x.id === n.id))],
              nextCursor: res.data.nextCursor,
            }
          : c,
      ),
    );
  }

  const dropIndex = (e: DragEvent, column: ProspectColumn): number => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-card-id]');
    if (!el) return column.cards.length;
    const i = column.cards.findIndex((c) => c.id === el.dataset.cardId);
    if (i < 0) return column.cards.length;
    const box = el.getBoundingClientRect();
    return e.clientY > box.top + box.height / 2 ? i + 1 : i;
  };

  return (
    <div className="flex flex-col gap-2">
      <p id={hintId} className="text-xs text-muted-foreground">
        {labels.dragHint}
      </p>
      <p role="status" aria-live="polite" className="min-h-5 text-sm" data-testid="acquisition-status">
        {pending > 0 ? labels.saving : status}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <section
        aria-label={labels.board}
        aria-describedby={hintId}
        className="flex gap-3 overflow-x-auto pb-2"
        data-testid="acquisition-board"
      >
        {columns.map((column) => (
          <section
            key={column.stage}
            aria-labelledby={`stage-${column.stage}`}
            className={`flex w-72 shrink-0 flex-col gap-2 rounded-md border bg-muted/40 p-2 ${
              over === column.stage ? 'ring-2 ring-primary' : ''
            }`}
            onDragOver={(e) => {
              const d = dragged.current;
              if (!d || !canDrop(d.from, column.stage, d.converted)) return;
              e.preventDefault();
              setOver(column.stage);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const d = dragged.current;
              dragged.current = null;
              if (d) void move(d.cardId, d.from, column.stage, dropIndex(e, column));
            }}
          >
            <h2 id={`stage-${column.stage}`} className="flex items-center justify-between px-1 text-sm font-semibold">
              <span>{column.label}</span>
              <span className="rounded-full bg-background px-2 text-xs tabular-nums">
                {column.count}
                {column.countCapped ? '+' : ''}
              </span>
            </h2>
            {column.cards.length === 0 ? <p className="px-1 text-xs text-muted-foreground">{labels.empty}</p> : null}
            <ol className="flex flex-col gap-2">
              {column.cards.map((card, i) => {
                const targets = columns.filter(
                  (c) => c.stage !== column.stage && canDrop(column.stage, c.stage, card.converted),
                );
                return (
                  <li
                    key={card.id}
                    data-card-id={card.id}
                    draggable
                    onDragStart={(e) => {
                      dragged.current = { cardId: card.id, from: column.stage, converted: card.converted };
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', card.id);
                    }}
                    onDragEnd={() => {
                      dragged.current = null;
                      setOver(null);
                    }}
                    className="flex cursor-grab flex-col gap-1 rounded-md border bg-background p-2 text-sm shadow-sm"
                  >
                    <Link href={`/acquisition/${card.id}`} className="font-medium underline-offset-4 hover:underline">
                      {card.title}
                    </Link>
                    {card.seller ? <span className="text-xs text-muted-foreground">{card.seller}</span> : null}
                    {card.price || card.followUp ? (
                      <span className="text-xs text-muted-foreground">
                        {[card.price, card.followUp].filter(Boolean).join(' · ')}
                      </span>
                    ) : null}
                    {card.converted ? <span className="text-xs font-medium">{labels.converted}</span> : null}
                    <div className="flex flex-wrap items-center gap-1 pt-1">
                      {targets.length > 0 ? (
                        <>
                          <label className="sr-only" htmlFor={`move-${card.id}`}>
                            {`${labels.moveTo}: ${card.title}`}
                          </label>
                          <select
                            id={`move-${card.id}`}
                            className="h-7 rounded-md border bg-background px-1 text-xs"
                            defaultValue={column.stage}
                            onChange={(e) => {
                              const to = e.target.value;
                              e.target.value = column.stage;
                              if (to !== column.stage) void move(card.id, column.stage, to, 0);
                            }}
                          >
                            <option value={column.stage}>{column.label}</option>
                            {targets.map((c) => (
                              <option key={c.stage} value={c.stage}>
                                {c.label}
                              </option>
                            ))}
                          </select>
                        </>
                      ) : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={i === 0}
                        aria-label={`${labels.up}: ${card.title}`}
                        onClick={() => void move(card.id, column.stage, column.stage, i - 1)}
                      >
                        ↑
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={i === column.cards.length - 1}
                        aria-label={`${labels.down}: ${card.title}`}
                        onClick={() => void move(card.id, column.stage, column.stage, i + 1)}
                      >
                        ↓
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ol>
            {column.nextCursor ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void loadMore(column.stage, column.nextCursor ?? '')}
              >
                {labels.more}
              </Button>
            ) : null}
          </section>
        ))}
      </section>
    </div>
  );
}
