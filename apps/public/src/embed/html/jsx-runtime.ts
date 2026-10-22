/**
 * A JSX runtime that renders to an HTML string (S7-F8 embeds, perf review): the embed pages ship no framework
 * JavaScript, and Next forbids `react-dom/server` in app code, so their views use this instead
 * (`/** @jsxImportSource @/embed/html *\/`). Same JSX, eager: every element is its escaped HTML at once.
 *
 * - Text and attribute values are always escaped (`&`, `<`, `>`, `"`, `'`). Raw HTML only on `<style>`
 *   (`dangerouslySetInnerHTML`, our own constant stylesheet) and never containing `</style`.
 * - React prop names are mapped to HTML (`className`, `htmlFor`, `srcSet`, `defaultValue`, …); `key` is dropped;
 *   `true` booleans are bare attributes, `false` / null / undefined are left out; `style` objects become declarations
 *   (custom properties only — `--x`, or a `-vendor-` name; values without `;{}()\<>`, else refused).
 * - Event-handler attributes (`on…`, any case) are refused: nothing here runs in the browser.
 * - URL attributes (`href`, `src`, `action`, `formAction`, `srcSet`, `poster`) keep only `https:`, relative, `mailto:`
 *   and `tel:` URLs — and `http:` to a loopback host (local stacks); anything else (`javascript:`, `data:`,
 *   `vbscript:`, any case or leading whitespace) is **dropped**: the attribute is left out, the page still renders.
 */

/** Only this module can make an `Html` (the constructor checks this token). */
const MADE_HERE: unique symbol = Symbol('html-runtime');

/** Rendered HTML. Only this runtime makes one, so a value of this type is already escaped. */
export class Html {
  readonly html: string;
  constructor(token: typeof MADE_HERE, html: string) {
    if (token !== MADE_HERE) throw new TypeError('html runtime: Html is made by the runtime only');
    this.html = html;
  }
  toString(): string {
    return this.html;
  }
}
const html = (s: string) => new Html(MADE_HERE, s);

export type HtmlNode = Html | string | number | bigint | boolean | null | undefined | readonly HtmlNode[];
type Props = Record<string, unknown> & { children?: HtmlNode };
type Component = (props: never) => Html | null;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);
const NAMES: Record<string, string> = {
  className: 'class',
  htmlFor: 'for',
  charSet: 'charset',
  srcSet: 'srcset',
  fetchPriority: 'fetchpriority',
  autoComplete: 'autocomplete',
  inputMode: 'inputmode',
  maxLength: 'maxlength',
  defaultValue: 'value',
  defaultChecked: 'checked',
  tabIndex: 'tabindex',
  crossOrigin: 'crossorigin',
  referrerPolicy: 'referrerpolicy',
};

function children(node: HtmlNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (node instanceof Html) return node.html;
  if (Array.isArray(node)) return node.map((n) => children(n as HtmlNode)).join('');
  return escapeHtml(String(node));
}

function style(value: Record<string, unknown>): string {
  return Object.entries(value)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => {
      const name = k.startsWith('--') ? k : k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      const text = String(v);
      if (!/^--?[a-z-]+$/.test(name)) throw new TypeError(`html runtime: bad style property ${k}`);
      if (/[;{}()\\<>]/.test(text)) throw new TypeError(`html runtime: bad style value for ${k}`);
      return `${name}:${text}`;
    })
    .join(';');
}

/** Attributes holding URLs (lower-case HTML names). */
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'srcset', 'poster']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether a URL may be put in a URL attribute (module comment). */
export function safeUrl(value: string): boolean {
  const v = value.trim();
  // Control characters and whitespace inside a scheme are how `java\tscript:` slips past naive checks: refuse them.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point.
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(v)?.[1]?.toLowerCase();
  // Relative: a path, query or fragment — never a network path (`//host`, `/\host` read as one by browsers).
  if (scheme === undefined) return !/^[\\/][\\/]/.test(v);
  if (scheme === 'https' || scheme === 'mailto' || scheme === 'tel') return true;
  if (scheme === 'http') {
    try {
      return LOOPBACK.has(new URL(v).hostname);
    } catch {
      return false;
    }
  }
  return false;
}

function urlAllowed(name: string, value: string): boolean {
  if (name !== 'srcset') return safeUrl(value);
  return value.split(',').every((candidate) => safeUrl(candidate.trim().split(/\s+/)[0] ?? ''));
}

function attributes(props: Props): string {
  let out = '';
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children' || key === 'key' || key === 'dangerouslySetInnerHTML') continue;
    if (/^on/i.test(key)) throw new TypeError(`html runtime: no event handlers (${key})`);
    if (value === null || value === undefined || value === false) continue;
    const name = NAMES[key] ?? key;
    if (!/^[a-zA-Z][a-zA-Z0-9:_.-]*$/.test(name)) throw new TypeError(`html runtime: bad attribute ${key}`);
    if (value === true) {
      out += ` ${name}`;
      continue;
    }
    const text =
      name === 'style' && typeof value === 'object' ? style(value as Record<string, unknown>) : String(value);
    // A URL with a scheme other than the allowed ones is dropped (module comment).
    if (URL_ATTRIBUTES.has(name.toLowerCase()) && !urlAllowed(name.toLowerCase(), text)) continue;
    out += ` ${name}="${escapeHtml(text)}"`;
  }
  return out;
}

export function jsx(type: string | Component, props: Props): Html {
  if (typeof type === 'function') return (type as (p: Props) => Html | null)(props) ?? html('');
  if (!/^[a-z][a-z0-9-]*$/.test(type)) throw new TypeError(`html runtime: bad tag ${type}`);
  // A textarea's value is its content, not an attribute.
  const { defaultValue, ...rest } = props;
  const open = `<${type}${attributes(type === 'textarea' ? rest : props)}>`;
  if (VOID.has(type)) return html(open);
  const inner = props.dangerouslySetInnerHTML as { __html: string } | undefined;
  if (inner !== undefined && (type !== 'style' || /<\/style/i.test(inner.__html))) {
    throw new TypeError(`html runtime: raw HTML only inside <style>, without </style (${type})`);
  }
  // A textarea's value is its content.
  const content = type === 'textarea' && defaultValue !== undefined ? escapeHtml(String(defaultValue)) : '';
  const body = inner ? inner.__html : content + children(props.children);
  return html(`${open}${body}</${type}>`);
}

export const jsxs = jsx;
export const jsxDEV = jsx;

export function Fragment(props: { children?: HtmlNode }): Html {
  return html(children(props.children));
}

export declare namespace JSX {
  type Element = Html;
  interface ElementChildrenAttribute {
    children: unknown;
  }
  interface IntrinsicAttributes {
    key?: string | number;
  }
  type IntrinsicElements = Record<string, Record<string, unknown>>;
}
