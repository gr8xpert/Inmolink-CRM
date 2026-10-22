/**
 * The embed pages' stylesheet (S7-F8), inlined in each page's `<style>` (one small sheet: no render-blocking request
 * before the first paint). Themed by the presenting agency's checked colours (`--embed-*`, core `brandStyle`).
 */
export const EMBED_CSS = `
*,*::before,*::after{box-sizing:border-box}
.embed{margin:0;background:#fff;color:#1f2937;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.5}
.embed a{color:inherit}
.embed :focus-visible{outline:3px solid var(--embed-accent);outline-offset:2px}
.embed-header{background:var(--embed-primary);color:var(--embed-on-primary);padding:.75rem 1rem}
.embed-brand{margin:0;font-weight:600}
.embed-main{max-width:960px;margin:0 auto;padding:1rem}
.embed-h1{font-size:1.5rem;margin:.5rem 0}
.embed-h2{font-size:1.125rem;margin:0 0 .5rem}
.embed-muted{color:#4b5563;margin:0}
.embed-small{font-size:.8125rem}
.embed-link{text-decoration:underline;text-underline-offset:3px}
.embed-search{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.75rem;align-items:end;margin-bottom:1rem}
.embed-field{display:flex;flex-direction:column;gap:.25rem;font-size:.875rem}
.embed-field input,.embed-field select,.embed-field textarea{border:1px solid #6b7280;border-radius:6px;padding:.5rem;font:inherit;background:#fff;color:#111827}
.embed-button{background:var(--embed-accent);color:var(--embed-on-accent);border:0;border-radius:6px;padding:.6rem 1rem;font:inherit;font-weight:600;cursor:pointer;min-height:44px}
.embed-button[disabled]{opacity:.7}
.embed-results{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:1rem}
.embed-card{border:1px solid #e5e7eb;border-radius:8px;overflow:hidden}
.embed-card-link{display:block;text-decoration:none}
.embed-card-media{aspect-ratio:4/3;background:#f3f4f6;display:flex;align-items:center;justify-content:center}
.embed-card-media img,.embed-hero img,.embed-thumbs img{width:100%;height:100%;object-fit:cover;display:block}
.embed-card-body{padding:.75rem}
.embed-card-title{font-size:1rem;margin:.25rem 0}
.embed-price{font-weight:700;margin:0}
.embed-price-lg{font-size:1.25rem}
.embed-facts{margin:.25rem 0;font-size:.875rem}
.embed-hero{aspect-ratio:16/9;background:#f3f4f6;border-radius:8px;overflow:hidden;margin:1rem 0}
.embed-thumbs{list-style:none;padding:0;margin:0 0 1rem;display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:.5rem}
.embed-thumbs li{aspect-ratio:4/3;border-radius:6px;overflow:hidden}
.embed-panel{border-top:1px solid #e5e7eb;padding:1rem 0}
.embed-facts-list,.embed-contact{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;margin:0}
.embed-facts-list dt,.embed-contact dt{font-weight:600}
.embed-facts-list dd,.embed-contact dd{margin:0}
.embed-features{columns:2 200px;padding-left:1.25rem;margin:0}
.embed-text{white-space:pre-line;margin:0 0 .75rem}
.embed-form{display:flex;flex-direction:column;gap:.75rem;max-width:560px}
.embed-check{display:flex;gap:.5rem;align-items:flex-start;font-size:.875rem}
.embed-check input{margin-top:.2rem;width:1.1rem;height:1.1rem}
.embed-error{color:#b91c1c;margin:0}
.embed-notice{font-weight:600}
.embed-pager{display:flex;gap:1rem;margin-top:1rem}
`;
