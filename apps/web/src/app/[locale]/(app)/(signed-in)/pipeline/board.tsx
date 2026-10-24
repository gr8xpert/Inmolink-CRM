'use client';

import { Button } from '@inmolink/ui';
import { useRouter } from 'next/navigation';
import { type DragEvent, useEffect, useId, useRef, useState } from 'react';
import { loadColumnAction, moveLeadAction } from './actions';
import type { BoardCard } from './cards';

/** A board column as the page hands it over (texts already translated). */
export interface BoardColumn {
  stageId: string;
  label: string;
  kind: 'OPEN' | 'WON' | 'LOST';
  count: number;
  countCapped: boolean;
  cards: BoardCard[];
  nextCursor: string | null;
}

export interface BoardLabels {
  board: string;
  empty: string;
  assigned: string;
  unassigned: string;
  justMoved: string;
  more: string;
  dragHint: string;
  moveTo: string;
  move: string;
  up: string;
  down: string;
  /** `{name}` moved to `{stage}`. */
  moved: string;
  saving: string;
  /** Error messages by code, `generic` included. */
  errors: Record<string, string>;
}

const fill = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');

/**
 * The pipeline board (S10-03): one column per active stage. A card moves by drag-and-drop (native HTML5, no library)
 * or from the keyboard — its own "Move to" stage picker and Up / Down buttons — and the outcome is announced. A move is
 * shown at once and sent with the card's version and the card it now follows; a refusal (someone else moved it, the
 * stage is gone) puts it back, says why and reloads the board. Loaded with `next/dynamic` (its own chunk).
 */
export default function PipelineBoard(props: {
  columns: BoardColumn[];
  assigned: 'me' | 'unassigned' | undefined;
  labels: BoardLabels;
}) {
  const { labels } = props;
  const router = useRouter();
  const [columns, setColumns] = useState(props.columns);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(0);
  const [over, setOver] = useState<string | null>(null);
  const dragged = useRef<{ cardId: string; from: string } | null>(null);
  const hintId = useId();
  // a refresh (after a refused move) hands over the server's columns again
  useEffect(() => setColumns(props.columns), [props.columns]);

  const columnOf = (stageId: string) => columns.find((c) => c.stageId === stageId);

  async function move(cardId: string, from: string, to: string, toIndex: number) {
    const source = columnOf(from);
    const target = columnOf(to);
    const card = source?.cards.find((c) => c.id === cardId);
    if (!source || !target || !card) return;
    const rest = target.cards.filter((c) => c.id !== cardId);
    const at = Math.max(0, Math.min(toIndex, rest.length));
    if (from === to && source.cards.findIndex((c) => c.id === cardId) === at) return;
    const afterLeadId = at > 0 ? (rest[at - 1]?.id ?? null) : null;
    const before = columns;
    const placed: BoardCard = from === to ? card : { ...card, since: labels.justMoved };
    setColumns((cols) =>
      cols.map((c) => {
        if (c.stageId === to) {
          const cards = c.cards.filter((x) => x.id !== cardId);
          cards.splice(at, 0, placed);
          return { ...c, cards, count: from === to ? c.count : c.count + 1 };
        }
        if (c.stageId === from) return { ...c, cards: c.cards.filter((x) => x.id !== cardId), count: c.count - 1 };
        return c;
      }),
    );
    setError('');
    setPending((n) => n + 1);
    try {
      const res = await moveLeadAction(cardId, { version: card.version, stageId: to, afterLeadId });
      if (res.ok) {
        setColumns((cols) =>
          cols.map((c) => ({
            ...c,
            cards: c.cards.map((x) => (x.id === cardId ? { ...x, version: res.data.version } : x)),
          })),
        );
        setStatus(fill(labels.moved, { name: card.name, stage: target.label }));
        return;
      }
      setColumns(before);
      if (res.code === 'SESSION_REVOKED') {
        router.push('/session/expired');
        return;
      }
      setError(labels.errors[res.code] ?? labels.errors.generic ?? '');
      if (res.code === 'VERSION_CONFLICT' || res.code === 'PIPELINE_STAGE_NOT_FOUND' || res.code === 'LEAD_NOT_FOUND') {
        router.refresh();
      }
    } finally {
      setPending((n) => n - 1);
    }
  }

  async function loadMore(stageId: string, cursor: string) {
    const res = await loadColumnAction(stageId, cursor, props.assigned);
    if (!res.ok) {
      setError(labels.errors[res.code] ?? labels.errors.generic ?? '');
      return;
    }
    setColumns((cols) =>
      cols.map((c) =>
        c.stageId === stageId
          ? {
              ...c,
              cards: [...c.cards, ...res.data.cards.filter((n) => !c.cards.some((x) => x.id === n.id))],
              nextCursor: res.data.nextCursor,
            }
          : c,
      ),
    );
  }

  const dropIndex = (e: DragEvent, column: BoardColumn): number => {
    // the card under the pointer: drop before it when on its upper half, after it otherwise
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
      <p role="status" aria-live="polite" className="min-h-5 text-sm" data-testid="pipeline-status">
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
        data-testid="pipeline-board"
      >
        {columns.map((column) => (
          <section
            key={column.stageId}
            aria-labelledby={`stage-${column.stageId}`}
            className={`flex w-72 shrink-0 flex-col gap-2 rounded-md border bg-muted/40 p-2 ${
              over === column.stageId ? 'ring-2 ring-primary' : ''
            }`}
            onDragOver={(e) => {
              if (!dragged.current) return;
              e.preventDefault();
              setOver(column.stageId);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const d = dragged.current;
              dragged.current = null;
              if (d) void move(d.cardId, d.from, column.stageId, dropIndex(e, column));
            }}
          >
            <h2 id={`stage-${column.stageId}`} className="flex items-center justify-between px-1 text-sm font-semibold">
              <span>{column.label}</span>
              <span className="rounded-full bg-background px-2 text-xs tabular-nums">
                {column.count}
                {column.countCapped ? '+' : ''}
              </span>
            </h2>
            {column.cards.length === 0 ? <p className="px-1 text-xs text-muted-foreground">{labels.empty}</p> : null}
            <ol className="flex flex-col gap-2">
              {column.cards.map((card, i) => (
                <li
                  key={card.id}
                  data-card-id={card.id}
                  draggable
                  onDragStart={(e) => {
                    dragged.current = { cardId: card.id, from: column.stageId };
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', card.id);
                  }}
                  onDragEnd={() => {
                    dragged.current = null;
                    setOver(null);
                  }}
                  className="flex cursor-grab flex-col gap-1 rounded-md border bg-background p-2 text-sm shadow-sm"
                >
                  <span className="font-medium">{card.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {card.source} · {card.assigned ? labels.assigned : labels.unassigned}
                  </span>
                  <span className="text-xs text-muted-foreground">{card.since}</span>
                  <div className="flex flex-wrap items-center gap-1 pt-1">
                    <label className="sr-only" htmlFor={`move-${card.id}`}>
                      {`${labels.moveTo}: ${card.name}`}
                    </label>
                    <select
                      id={`move-${card.id}`}
                      className="h-7 rounded-md border bg-background px-1 text-xs"
                      defaultValue={column.stageId}
                      onChange={(e) => {
                        const to = e.target.value;
                        e.target.value = column.stageId;
                        if (to !== column.stageId) void move(card.id, column.stageId, to, 0);
                      }}
                    >
                      {columns.map((c) => (
                        <option key={c.stageId} value={c.stageId}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={i === 0}
                      aria-label={`${labels.up}: ${card.name}`}
                      onClick={() => void move(card.id, column.stageId, column.stageId, i - 1)}
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={i === column.cards.length - 1}
                      aria-label={`${labels.down}: ${card.name}`}
                      onClick={() => void move(card.id, column.stageId, column.stageId, i + 1)}
                    >
                      ↓
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
            {column.nextCursor ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void loadMore(column.stageId, column.nextCursor ?? '')}
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
