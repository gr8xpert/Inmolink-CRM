/**
 * A JSX runtime that renders to an HTML string (S7-F8 embeds, perf review): the embed pages ship no framework
 * JavaScript, and Next forbids `react-dom/server` in app code, so their views use this instead
 * (`/** @jsxImportSource @/embed/html *\/`). Same JSX, eager: every element is its escaped HTML at once.
 *
 * - Text and attribute values are always escaped (`&`, `<`, `>`, `"`, `'`); only `dangerouslySetInnerHTML` (our own
 *   constants) is inserted as is.
 * - React prop names are mapped to HTML (`className`, `htmlFor`, `srcSet`, `defaultValue`, …); `key` is dropped;
 *   `true` booleans are bare attributes, `false` / null / undefined are left out; `style` objects become declarations.
 * - Event handlers are refused: nothing here runs in the browser.
 */

/** Rendered HTML. Only this runtime makes one, so a value of this type is already escaped. */
export class Html {
  constructor(readonly html: string) {}
  toString(): string {
    return this.html;
  }
}

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
    .map(([k, v]) => `${k.startsWith('--') ? k : k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${String(v)}`)
    .join(';');
}

function attributes(props: Props): string {
  let out = '';
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children' || key === 'key' || key === 'dangerouslySetInnerHTML') continue;
    if (/^on[A-Z]/.test(key)) throw new TypeError(`html runtime: no event handlers (${key})`);
    if (value === null || value === undefined || value === false) continue;
    const name = NAMES[key] ?? key;
    if (!/^[a-zA-Z][a-zA-Z0-9:_.-]*$/.test(name)) throw new TypeError(`html runtime: bad attribute ${key}`);
    if (value === true) {
      out += ` ${name}`;
      continue;
    }
    const text =
      name === 'style' && typeof value === 'object' ? style(value as Record<string, unknown>) : String(value);
    out += ` ${name}="${escapeHtml(text)}"`;
  }
  return out;
}

export function jsx(type: string | Component, props: Props): Html {
  if (typeof type === 'function') return (type as (p: Props) => Html | null)(props) ?? new Html('');
  if (!/^[a-z][a-z0-9-]*$/.test(type)) throw new TypeError(`html runtime: bad tag ${type}`);
  // A textarea's value is its content, not an attribute.
  const { defaultValue, ...rest } = props;
  const open = `<${type}${attributes(type === 'textarea' ? rest : props)}>`;
  if (VOID.has(type)) return new Html(open);
  const inner = props.dangerouslySetInnerHTML as { __html: string } | undefined;
  // A textarea's value is its content.
  const content = type === 'textarea' && defaultValue !== undefined ? escapeHtml(String(defaultValue)) : '';
  const body = inner ? inner.__html : content + children(props.children);
  return new Html(`${open}${body}</${type}>`);
}

export const jsxs = jsx;
export const jsxDEV = jsx;

export function Fragment(props: { children?: HtmlNode }): Html {
  return new Html(children(props.children));
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
