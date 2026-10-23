/** The widget's stylesheet, inside its shadow root (the host page's CSS cannot reach it, nor this CSS the page). */
export const WIDGET_CSS = `
:host{all:initial;display:block;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1f2937;line-height:1.5;--il-primary:#1e3a5f;--il-accent:#b45309}
*,*::before,*::after{box-sizing:border-box}
:focus-visible{outline:3px solid var(--il-accent);outline-offset:2px}
form{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.75rem;align-items:end;margin:0 0 1rem}
label{display:flex;flex-direction:column;gap:.25rem;font-size:.875rem}
input,select,textarea{border:1px solid #6b7280;border-radius:6px;padding:.5rem;font:inherit;background:#fff;color:inherit;min-width:0}
button{background:var(--il-primary);color:#fff;border:0;border-radius:6px;padding:.6rem 1rem;font:inherit;font-weight:600;cursor:pointer}
button[disabled],button[aria-disabled=true]{opacity:.6;cursor:default}
.muted{color:#4b5563;margin:.25rem 0}
.list{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:1rem}
.card{border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;background:#fff}
.card button{display:block;width:100%;text-align:left;background:none;color:inherit;padding:0;border-radius:0;font-weight:400}
.body>span,.card button>span{display:block}
.media{text-align:center;aspect-ratio:4/3;background:#f3f4f6;display:flex;align-items:center;justify-content:center;color:#4b5563;font-size:.875rem}
.media img{width:100%;height:100%;object-fit:cover;display:block}
.body{padding:.75rem}
.title{font-size:1rem;margin:.25rem 0;font-weight:600}
.price{font-weight:700}
.facts{font-size:.875rem;margin:.25rem 0;color:#374151}
.more{display:block;margin:1rem auto 0}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:1rem;z-index:2147483000}
.modal{background:#fff;border-radius:10px;max-width:760px;width:100%;padding:1rem;position:relative}
.close{position:absolute;top:.5rem;right:.5rem;background:#f3f4f6;color:#1f2937}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:.5rem;margin:1rem 0}
.gallery img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:6px;display:block}
.hero{aspect-ratio:16/9;background:#f3f4f6;border-radius:8px;overflow:hidden;margin:1rem 0 0}
.hero img{width:100%;height:100%;object-fit:cover;display:block}
h2,h3{margin:.75rem 0 .25rem}
h2{font-size:1.25rem;padding-right:3rem}
h3{font-size:1rem}
.features{columns:2 180px;padding-left:1.25rem;margin:0}
.contact{display:flex;flex-wrap:wrap;gap:.5rem 1rem}
.contact a{color:var(--il-primary);font-weight:600}
.error{color:#991b1b}
.lead{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
.wide{grid-column:1/-1}
.check{flex-direction:row;align-items:flex-start;gap:.5rem}
.check input{margin:.2rem 0 0}
textarea{resize:vertical}
[hidden]{display:none!important}
.sent{font-weight:600;color:#166534}
`;
