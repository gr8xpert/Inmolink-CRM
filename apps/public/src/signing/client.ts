import { createHash } from 'node:crypto';

/**
 * The signing page's only script (R2-05b): no framework, no hydration — a few hundred bytes from 'self' as a static,
 * content-hashed, immutable file (`SIGNING_SCRIPT_PATH`). It
 * - lets the signer draw a signature in the `canvas[data-sign-pad]` (pointer events: mouse, pen, finger), clear it,
 *   and puts it in the form's `drawing` field as a PNG data URL when the form is posted;
 * - shows the pad only while "draw my signature" is chosen.
 * Without JavaScript the signer types their name (the default), and the page works the same.
 *
 * Self-contained: only browser globals, so `signingClient.toString()` is the shipped source.
 */
export function signingClient(): void {
  const form = document.querySelector<HTMLFormElement>('form[data-sign-form]');
  const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-sign-pad]');
  const pad = document.querySelector<HTMLElement>('[data-sign-drawn]');
  if (!form || !canvas || !pad) return;
  const field = form.querySelector<HTMLInputElement>('input[name=drawing]');
  const clear = form.querySelector<HTMLButtonElement>('button[data-sign-clear]');
  const kinds = Array.from(form.querySelectorAll<HTMLInputElement>('input[name=kind]'));
  const ctx = canvas.getContext('2d');
  if (!ctx || !field) return;
  for (const k of kinds) if (k.value === 'DRAWN') k.disabled = false;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#111827';
  let drawing = false;
  let drawn = false;
  const at = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * canvas.width) / r.width, y: ((e.clientY - r.top) * canvas.height) / r.height };
  };
  canvas.addEventListener('pointerdown', (e) => {
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    const p = at(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = at(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    drawn = true;
    e.preventDefault();
  });
  const stop = () => {
    drawing = false;
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  clear?.addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawn = false;
  });
  const show = () => {
    const chosen = kinds.find((k) => k.checked)?.value;
    pad.hidden = chosen !== 'DRAWN';
  };
  for (const k of kinds) k.addEventListener('change', show);
  show();
  form.addEventListener('submit', () => {
    const chosen = kinds.find((k) => k.checked)?.value;
    field.value = chosen === 'DRAWN' && drawn ? canvas.toDataURL('image/png') : '';
  });
}

export const SIGNING_SCRIPT = `(${signingClient.toString()})();\n`;
/** Its content-hashed path: a new script is a new URL, so it is cached for a year (`immutable`). */
export const SIGNING_SCRIPT_PATH = `/sign-assets/sign.${createHash('sha256').update(SIGNING_SCRIPT).digest('hex').slice(0, 12)}.js`;
