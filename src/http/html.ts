import { timingSafeEqual } from 'node:crypto';

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function page(title: string, body: string, opts: { refreshSeconds?: number } = {}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${opts.refreshSeconds ? `<meta http-equiv="refresh" content="${opts.refreshSeconds}">` : ''}
<title>${escapeHtml(title)}</title>
<style>
  :root { --green:#0b7a3e; --red:#c0392b; --amber:#d68910; --ink:#1d1d1f; --muted:#666; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; color: var(--ink); background: #faf7f2; }
  header { background: var(--green); color: #fff; padding: 12px 16px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px }
  header h1 { margin: 0; font-size: 1.2rem; }
  main { padding: 16px; max-width: 1100px; margin: 0 auto; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
  .card { background: #fff; border-radius: 10px; padding: 12px 14px; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
  .code { font-size: 1.4rem; font-weight: 700; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:.8rem; font-weight:600; color:#fff; background:var(--muted) }
  .s-paid { background: var(--amber) } .s-preparing { background: #2e86c1 } .s-ready { background: var(--green) } .s-needs_review { background: var(--red) }
  ul { padding-left: 18px; margin: 6px 0; }
  button { font-size: 1rem; padding: 10px 14px; border-radius: 8px; border: 0; background: var(--green); color: #fff; cursor: pointer; margin: 4px 4px 0 0; }
  button.secondary { background: #888 } button.danger { background: var(--red) }
  form { display: inline; }
  .muted { color: var(--muted); font-size: .9rem; }
  h2 { margin: 24px 0 8px; font-size: 1.05rem; }
  table { border-collapse: collapse; width: 100%; background:#fff } td, th { padding: 6px 8px; border-bottom: 1px solid #eee; text-align: left; font-size: .9rem }
</style></head><body>${body}</body></html>`;
}
