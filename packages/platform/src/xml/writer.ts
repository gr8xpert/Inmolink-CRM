/**
 * The XML writer for documents we publish (S7-07: per-site XML feeds). Every value is escaped here — never
 * concatenated into markup by a caller — and characters XML 1.0 cannot carry (control characters, lone surrogates)
 * are dropped, so user text can never break out of its element or make the document unparseable. Element and
 * attribute names are code, not data: anything but a plain XML name is refused.
 *
 * Streaming: the writer buffers its output; the caller `take()`s it whenever `pending` grows (e.g. into a gzip
 * stream), so a document of any size never sits in memory as one string.
 */

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
/** Not allowed in XML 1.0 text: C0 controls but tab/LF/CR, U+FFFE/U+FFFF, and unpaired surrogates. */
const INVALID = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu;

export type XmlValue = string | number | boolean | null | undefined;
export type XmlAttributes = Readonly<Record<string, XmlValue>>;

/** Text content: `&`, `<`, `>` escaped (`>` too, so `]]>` cannot appear), invalid characters dropped. */
export function escapeXmlText(value: string): string {
  return value.replace(INVALID, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** An attribute value (double-quoted): also `"` and `'`, and tab/LF/CR as character references (kept as written). */
export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;');
}

function assertName(name: string): void {
  if (!NAME.test(name)) throw new TypeError(`XmlWriter: invalid name ${JSON.stringify(name)}`);
}

const show = (value: Exclude<XmlValue, null | undefined>): string =>
  typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : String(value);

export class XmlWriter {
  #parts: string[] = [];
  #pending = 0;
  readonly #stack: string[] = [];

  constructor(options: { declaration?: boolean } = {}) {
    if (options.declaration !== false) this.#push('<?xml version="1.0" encoding="UTF-8"?>\n');
  }

  /** Characters buffered since the last `take()`. */
  get pending(): number {
    return this.#pending;
  }

  /** Open elements, innermost last. */
  get depth(): number {
    return this.#stack.length;
  }

  #push(s: string): void {
    this.#parts.push(s);
    this.#pending += s.length;
  }

  #tag(name: string, attributes: XmlAttributes | undefined): string {
    assertName(name);
    let out = `<${name}`;
    for (const [key, value] of Object.entries(attributes ?? {})) {
      if (value === null || value === undefined) continue;
      assertName(key);
      out += ` ${key}="${escapeXmlAttribute(show(value))}"`;
    }
    return out;
  }

  /** `<name attr="…">`; close it with `close()`. */
  open(name: string, attributes?: XmlAttributes): this {
    this.#push(`${this.#tag(name, attributes)}>`);
    this.#stack.push(name);
    return this;
  }

  /** Closes the innermost open element. */
  close(): this {
    const name = this.#stack.pop();
    if (name === undefined) throw new Error('XmlWriter: nothing to close');
    this.#push(`</${name}>`);
    return this;
  }

  /** Escaped text inside the open element. */
  text(value: XmlValue): this {
    if (value !== null && value !== undefined) this.#push(escapeXmlText(show(value)));
    return this;
  }

  /** `<name>value</name>`; nothing at all when `value` is null or undefined (an empty string writes `<name/>`). */
  leaf(name: string, value: XmlValue, attributes?: XmlAttributes): this {
    if (value === null || value === undefined) return this;
    const text = escapeXmlText(show(value));
    this.#push(text === '' ? `${this.#tag(name, attributes)}/>` : `${this.#tag(name, attributes)}>${text}</${name}>`);
    return this;
  }

  /** A line break between records (readability only). */
  newline(): this {
    this.#push('\n');
    return this;
  }

  /** The output buffered since the last call. */
  take(): string {
    const out = this.#parts.join('');
    this.#parts = [];
    this.#pending = 0;
    return out;
  }

  /** The rest of the output; every element must be closed. */
  end(): string {
    if (this.#stack.length > 0) throw new Error(`XmlWriter: unclosed <${this.#stack.at(-1)}>`);
    return this.take();
  }
}
