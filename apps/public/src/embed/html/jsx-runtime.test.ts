import { describe, expect, it } from 'vitest';
import { Fragment, jsx } from './jsx-runtime';

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
    expect(String(jsx('body', { style: { '--embed-primary': '#112233', fontSize: '1px' }, key: 'k' }))).toBe(
      '<body style="--embed-primary:#112233;font-size:1px"></body>',
    );
    expect(String(jsx(Fragment, { children: ['a', jsx('br', {})] }))).toBe('a<br>');
    expect(() => jsx('a', { onClick: () => {} })).toThrow(/event handlers/);
    expect(() => jsx('a', { 'x" onload="y': 1 })).toThrow(/bad attribute/);
    expect(() => jsx('scr ipt', {})).toThrow(/bad tag/);
  });
});
