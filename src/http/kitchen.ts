import express, { type Request, type Response, type NextFunction, type Router } from 'express';
import { MENU } from '../menu.js';
import { OrderError, formatNaira, type OrderService } from '../orders.js';
import type { Order, OrderStatus } from '../store.js';
import { escapeHtml, page, safeEqual } from './html.js';

const NEXT_ACTION: Partial<Record<OrderStatus, { to: OrderStatus; label: string }>> = {
  paid: { to: 'preparing', label: 'Start preparing' },
  preparing: { to: 'ready', label: 'Mark READY' },
  ready: { to: 'collected', label: 'Collected' },
  needs_review: { to: 'paid', label: 'Resolved: accept order' },
};

function basicAuth(password: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const supplied = decoded.slice(decoded.indexOf(':') + 1);
      if (safeEqual(supplied, password)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Monaliza Pizza kitchen"').status(401).send('Kitchen login required');
  };
}

function orderCard(o: Order): string {
  const next = NEXT_ACTION[o.status];
  const items = o.lines.map((l) => `<li>${l.quantity} × ${escapeHtml(l.name)}${l.size ? ` (${l.size})` : ''}</li>`).join('');
  const minsAgo = Math.round((Date.now() - (o.paid_at ?? o.created_at)) / 60000);
  return `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <span class="code">${escapeHtml(o.code)}</span><span class="pill s-${o.status}">${escapeHtml(o.status.replace('_', ' '))}</span>
    </div>
    <div>${escapeHtml(o.customer_name)} <span class="muted">${escapeHtml(o.customer_phone ?? '')}</span></div>
    <ul>${items}</ul>
    ${o.notes ? `<div><strong>Note:</strong> ${escapeHtml(o.notes)}</div>` : ''}
    ${o.review_reason ? `<div style="color:#c0392b"><strong>Check:</strong> ${escapeHtml(o.review_reason)}</div>` : ''}
    <div class="muted">${formatNaira(o.total)} · paid ${minsAgo} min ago${o.ready_notification ? ` · WhatsApp ping: ${o.ready_notification.sent ? 'sent' : 'not sent'}` : ''}</div>
    ${next ? `<form method="post" action="/kitchen/orders/${encodeURIComponent(o.code)}/status"><input type="hidden" name="to" value="${next.to}"><button>${next.label}</button></form>` : ''}
    ${['paid', 'preparing', 'needs_review'].includes(o.status) ? `<form method="post" action="/kitchen/orders/${encodeURIComponent(o.code)}/status" onsubmit="return confirm('Cancel ${escapeHtml(o.code)}? Refund it in the Paystack dashboard.')"><input type="hidden" name="to" value="cancelled"><button class="danger">Cancel</button></form>` : ''}
  </div>`;
}

export function kitchenRouter(orders: OrderService, password: string): Router {
  const router = express.Router();
  router.use(basicAuth(password));
  router.use(express.urlencoded({ extended: false }));
  // Browsers resend basic-auth credentials automatically, so reject cross-site form posts.
  router.use((req, res, next) => {
    const origin = req.headers.origin;
    if (req.method === 'POST' && origin && origin !== 'null') {
      try {
        if (new URL(origin).host !== req.headers.host) return res.status(403).send('Cross-site request blocked');
      } catch {
        return res.status(403).send('Bad origin');
      }
    }
    next();
  });

  router.get('/', (_req, res) => {
    const all = orders.store.allOrders();
    const active = all.filter((o) => ['needs_review', 'paid', 'preparing', 'ready'].includes(o.status));
    const unpaid = all.filter((o) => ['awaiting_payment', 'payment_failed'].includes(o.status));
    const done = all.filter((o) => ['collected', 'cancelled', 'expired'].includes(o.status)).slice(-15).reverse();
    const store = orders.store;

    const menuRows = MENU.map((m) => {
      const out = store.soldOut.has(m.id);
      return `<tr><td>${escapeHtml(m.name)}</td><td>${out ? '<strong style="color:#c0392b">SOLD OUT</strong>' : 'Available'}</td>
        <td><form method="post" action="/kitchen/menu/${m.id}"><input type="hidden" name="sold_out" value="${out ? 'false' : 'true'}"><button class="${out ? '' : 'secondary'}">${out ? 'Back in stock' : 'Mark sold out'}</button></form></td></tr>`;
    }).join('');

    const body = `<header><h1>🍕 Monaliza Pizza · Kitchen</h1>
      <form method="post" action="/kitchen/accepting">
        ${store.acceptingOrders
          ? `<input type="hidden" name="accepting" value="false"><input name="message" placeholder="Reason shown to customers" style="padding:8px;border-radius:6px;border:0"><button class="danger">Pause WhatsApp orders</button>`
          : `<input type="hidden" name="accepting" value="true"><button>Resume WhatsApp orders</button> <span>Paused: ${escapeHtml(store.pauseMessage)}</span>`}
      </form></header>
      <main>
        <h2>To do (${active.length})</h2>
        <div class="grid">${active.map(orderCard).join('') || '<p class="muted">No paid orders waiting. 🎉</p>'}</div>
        <h2>Waiting for payment (${unpaid.length})</h2>
        <p class="muted">${unpaid.map((o) => `${escapeHtml(o.code)} ${escapeHtml(o.customer_name)} ${formatNaira(o.total)} (${o.status.replace('_', ' ')})`).join(' · ') || 'None'}</p>
        <h2>Recently finished</h2>
        <p class="muted">${done.map((o) => `${escapeHtml(o.code)} ${o.status}`).join(' · ') || 'None'}</p>
        <h2>Menu availability</h2>
        <table>${menuRows}</table>
        <p class="muted">This page refreshes every 15 seconds. Orders are kept in memory: restarting the server clears them.</p>
      </main>`;
    res.type('html').send(page('Kitchen · Monaliza Pizza', body, { refreshSeconds: 15 }));
  });

  router.get('/api/orders', (_req, res) => {
    res.json({ orders: orders.store.allOrders() });
  });

  router.post('/orders/:code/status', async (req, res) => {
    const code = String(req.params.code);
    try {
      await orders.kitchenTransition(code, String(req.body?.to ?? req.query.to) as OrderStatus);
      if (req.accepts(['html', 'json']) === 'json') return res.json(orders.view(orders.store.getOrder(code)!));
      res.redirect(303, '/kitchen');
    } catch (err) {
      const status = err instanceof OrderError ? (err.code === 'order_not_found' ? 404 : 409) : 500;
      res.status(status).json({ error: (err as Error).message });
    }
  });

  router.post('/menu/:id', (req, res) => {
    try {
      orders.setSoldOut(String(req.params.id), String(req.body?.sold_out) === 'true');
      res.redirect(303, '/kitchen');
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  router.post('/accepting', (req, res) => {
    orders.setAcceptingOrders(String(req.body?.accepting) === 'true', String(req.body?.message ?? '').slice(0, 200));
    res.redirect(303, '/kitchen');
  });

  return router;
}
