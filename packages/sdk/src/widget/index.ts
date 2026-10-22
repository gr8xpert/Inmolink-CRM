import { connection } from './connection';
import { mountWidget, type WidgetHandle, type WidgetOptions } from './widget';

/**
 * Browser entry (S8-06), the script `inmolink-widget.iife.js`.
 * `<script src=".../inmolink-widget.iife.js" data-api-key="inl_…" data-base-url="https://…" defer>` plus
 * `<div data-inmolink-widget></div>` mounts the widget; `InmolinkWidget.mount(element, options)` does it by hand.
 *
 * The key and the API URL are a pair: both from the script tag, or both from the element (which may also set
 * `data-lang`, `data-page-size`, `data-primary-color`). The script's key is never sent to an element's own URL, so
 * markup an attacker adds to the page cannot redirect it. The API URL must be `https:` (`http://localhost` for tests).
 */
export type { WidgetHandle, WidgetOptions };
export { mountWidget as mount };

/** Read while the script runs: `document.currentScript` is null by the time `DOMContentLoaded` fires. */
const script = document.currentScript as HTMLScriptElement | null;

function autoMount(): void {
  for (const host of document.querySelectorAll<HTMLElement>('[data-inmolink-widget]')) {
    const pair = connection(host.dataset, script?.dataset);
    if (!pair) continue;
    const lang = host.dataset.lang ?? script?.dataset.lang;
    const pageSize = Number(host.dataset.pageSize ?? script?.dataset.pageSize);
    const primaryColor = host.dataset.primaryColor ?? script?.dataset.primaryColor;
    mountWidget(host, {
      ...pair,
      ...(lang ? { lang } : {}),
      ...(pageSize ? { pageSize } : {}),
      ...(primaryColor ? { primaryColor } : {}),
    });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMount);
else autoMount();
