import { describe, expect, it } from 'vitest';
import { Fragment, Html, jsx, safeUrl } from './jsx-runtime';

/** The embed pages' HTML runtime (S7-F8): text and attributes always escaped, React prop names mapped. */

describe('embed HTML runtime (S7-F8)', () => {
  it('[S7-F8] escapes every text and attribute value; only our own dangerouslySetInnerHTML is raw', () => {
    const html = String(
      jsx('a', {
        href: 'https://x.example/?a=1&b="2"',
        title: "it's <b>",
        children: ['<script>alert(1)</script>', 3, null, false, jsx('b', { children: 'ok' })],
      }),
    );
    expect(html).toBe(
      '<a href="https://x.example/?a=1&amp;b=&quot;2&quot;" title="it&#39;s &lt;b&gt;">&lt;script&gt;alert(1)&lt;/script&gt;3<b>ok</b></a>',
    );
    expect(String(jsx('style', { dangerouslySetInnerHTML: { __html: 'a>b{}' } }))).toBe('<style>a>b{}</style>');
  });

  it('[S7-F8] maps React props to HTML: booleans, void elements, style objects, textarea values; refuses handlers', () => {
    expect(
      String(jsx('input', { className: 'c', defaultValue: 'v"', maxLength: 3, required: true, hidden: false })),
    ).toBe('<input class="c" value="v&quot;" maxlength="3" required>');
    expect(String(jsx('textarea', { name: 'm', defaultValue: '<x>' }))).toBe('<textarea name="m">&lt;x&gt;</textarea>');
    expect(String(jsx('body', { style: { '--embed-primary': '#112233', '--embed-size': '1px' }, key: 'k' }))).toBe(
      '<body style="--embed-primary:#112233;--embed-size:1px"></body>',
    );
    expect(String(jsx(Fragment, { children: ['a', jsx('br', {})] }))).toBe('a<br>');
    expect(() => jsx('a', { onClick: () => {} })).toThrow(/event handlers/);
    expect(() => jsx('a', { 'x" onload="y': 1 })).toThrow(/bad attribute/);
    expect(() => jsx('scr ipt', {})).toThrow(/bad tag/);
  });

  it('[S7-F8] event-handler attributes are refused in any case', () => {
    for (const name of ['onClick', 'onclick', 'ONLOAD', 'OnError', 'onfocusin']) {
      expect(() => jsx('img', { [name]: 'alert(1)' }), name).toThrow(/event handlers/);
    }
  });

  it('[S7-F8] URL attributes keep https, relative, mailto and tel only; javascript:, data:, vbscript: are dropped', () => {
    for (const ok of [
      'https://wa.me/34600',
      '/embed/x/en',
      '?q=1',
      '#top',
      'mailto:a@b.example',
      'tel:+34600',
      'http://127.0.0.1:59000/m.webp',
    ]) {
      expect(safeUrl(ok), ok).toBe(true);
    }
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      '  javascript:alert(1)',
      '\tjavascript:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'DATA:image/svg+xml,x',
      'vbscript:msgbox(1)',
      ' VBScript:x',
      'http://evil.example/x',
      '//evil.example/x',
      '/\\evil.example/x',
    ]) {
      expect(safeUrl(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(String(jsx('a', { href: 'jaVaScRiPt:alert(1)', children: 'x' }))).toBe('<a>x</a>');
    expect(String(jsx('img', { src: 'data:image/png;base64,AAAA', alt: '' }))).toBe('<img alt="">');
    expect(String(jsx('form', { action: ' vbscript:x' }))).toBe('<form></form>');
    expect(String(jsx('img', { srcSet: 'https://cdn.example/a.webp 640w, javascript:x 1280w' }))).toBe('<img>');
    expect(String(jsx('a', { href: 'https://wa.me/34600', children: 'w' }))).toBe(
      '<a href="https://wa.me/34600">w</a>',
    );
  });

  it('[S7-F8] raw HTML only on <style> and never closing it; style objects take safe names and values; Html is the runtime’s', () => {
    expect(() => jsx('div', { dangerouslySetInnerHTML: { __html: '<b>x</b>' } })).toThrow(/raw HTML/);
    expect(() => jsx('style', { dangerouslySetInnerHTML: { __html: 'a{}</STYLE><script>x</script>' } })).toThrow(
      /raw HTML/,
    );
    expect(() => jsx('p', { style: { 'background:url(x);': 'red' } })).toThrow(/style property/);
    // Custom properties only (the brand variables): no plain CSS property can be set from data.
    expect(() => jsx('p', { style: { color: 'red' } })).toThrow(/style property/);
    for (const bad of ['red;color:blue', 'url(x)', 'a}b', 'x\\y', '<b>']) {
      expect(() => jsx('p', { style: { '--embed-primary': bad } }), bad).toThrow(/style value/);
    }
    expect(() => new Html(Symbol('html-runtime') as never, '<script>')).toThrow(/runtime only/);
  });
});
