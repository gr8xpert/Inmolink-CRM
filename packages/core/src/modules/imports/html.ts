/**
 * Feed text → plain text (S6-03). Kyero descriptions carry HTML (often escaped inside CDATA). Listing
 * descriptions are plain text in Inmolink (rendered escaped), so nothing of the markup survives except line and
 * list structure: block ends become line breaks, list items "- ", every other tag disappears (also one that entities or nesting only reveal after decoding), `script` and
 * `style` bodies with it. Entities are decoded once, after the tags are gone, so `&lt;script&gt;` stays text.
 */
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  euro: '€',
  copy: '©',
  reg: '®',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  ntilde: 'ñ',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  szlig: 'ß',
  ccedil: 'ç',
  agrave: 'à',
  egrave: 'è',
  Aacute: 'Á',
  Eacute: 'É',
  Iacute: 'Í',
  Oacute: 'Ó',
  Uacute: 'Ú',
  Ntilde: 'Ñ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]{2,8});/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : '';
    }
    return NAMED[body] ?? whole;
  });
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to remove them
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g;

/** At most `max` characters, cut at a word end when one is near. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max - 200 ? cut.slice(0, space) : cut).trimEnd();
}

/** Markup kept per character of output: anything past it could not survive `clip` anyway. */
const INPUT_PER_OUTPUT_CHAR = 4;
/** Strip passes after decoding; a feed nesting tags deeper than this loses its remaining `<` (below). */
const STRIP_PASSES = 4;
const HIDDEN_OPEN = /<!--|<(script|style|iframe|object|embed)\b/gi;
const CLOSERS: Record<string, RegExp> = Object.fromEntries(
  ['script', 'style', 'iframe', 'object', 'embed'].map((name) => [name, new RegExp(`</${name}`, 'gi')]),
);

/** The next match of a global regex at or after `from`, or -1. */
function search(re: RegExp, text: string, from: number): RegExpExecArray | null {
  re.lastIndex = from;
  return re.exec(text);
}

/**
 * Removes comments and `script`/`style`/`iframe`/`object`/`embed` elements with their bodies in one forward scan
 * (S6 review): an opener without its closer drops the rest of the text. Lazy regexes with a backreference rescanned
 * to the end for every unclosed opener — quadratic, minutes of blocked event loop for a 2 MB description.
 */
function dropHidden(text: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const open = search(HIDDEN_OPEN, text, at);
    if (!open) return out + text.slice(at);
    out += text.slice(at, open.index);
    let end = -1;
    const name = open[1]?.toLowerCase();
    if (name === undefined) {
      const close = text.indexOf('-->', open.index + 4);
      if (close !== -1) end = close + 3;
    } else {
      const close = search(CLOSERS[name] as RegExp, text, open.index + open[0].length);
      const gt = close ? text.indexOf('>', close.index) : -1;
      if (gt !== -1) end = gt + 1;
    }
    if (end === -1) return out;
    at = end;
  }
}

export function htmlToPlainText(input: string, max = 20_000): string {
  let s = dropHidden(input.slice(0, max * INPUT_PER_OUTPUT_CHAR))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|ul|ol|tr|table|blockquote|section)\s*>/gi, '\n\n')
    // `[^<>]` stops at the next tag, so many unterminated `<li` stay linear.
    .replace(/<li\b[^<>]*>/gi, '\n- ')
    .replace(/<\/li\s*>/gi, '')
    // Any other tag (and an unterminated one at the end).
    .replace(/<\/?[A-Za-z][^>]*>?/g, '');
  s = decodeEntities(s).replace(CONTROL, '').replace(/\r\n?/g, '\n');
  // Decoding can reveal tags (`&lt;script&gt;`) and removing one can join the rest into another: repeat a few times,
  // then drop every `<` run that still starts tag-like text (a run is removed whole, so it cannot join a new one).
  for (let pass = 0; pass < STRIP_PASSES; pass++) {
    const stripped = s.replace(/<\/?[A-Za-z][^>]*>?/g, '');
    if (stripped === s) break;
    s = stripped;
  }
  // The lookbehind starts a match only at a run's first `<`, so a long run of `<` is scanned once, not once per `<`.
  s = s.replace(/(?<!<)<+(?=\/?[A-Za-z])/g, '');
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clip(s, max);
}
