import express, { type Router } from 'express';
import { SHOP } from '../menu.js';
import { formatNaira, type OrderService } from '../orders.js';
import { PaystackError, type PaymentGateway, verifyPaystackSignature } from '../paystack.js';
import { escapeHtml, page } from './html.js';

/** Paystack server-to-server webhook. Needs the raw body for signature verification. */
export function paystackWebhookRouter(orders: OrderService, secretKey: string): Router {
  const router = express.Router();
  router.post('/', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!verifyPaystackSignature(raw, req.header('x-paystack-signature'), secretKey)) {
      console.warn('[webhook] rejected: bad Paystack signature');
      return res.status(401).send('invalid signature');
    }
    let event: { event?: string; data?: { reference?: string } };
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.status(400).send('invalid json');
    }
    // Acknowledge immediately; Paystack retries on slow or non-200 responses.
    res.status(200).send('ok');

    const reference = event.data?.reference;
    if (!reference || !event.event?.startsWith('charge.')) return;
    orders
      .handleWebhookCharge(reference)
      .then((order) => console.log(`[webhook] ${event.event} ${reference} -> ${order ? `${order.code} ${order.status}` : 'unknown reference'}`))
      .catch((err) => console.error(`[webhook] processing ${reference} failed: ${(err as Error).message}`));
  });
  return router;
}

/** Where Paystack sends the customer's browser after checkout. */
export function paymentReturnRouter(orders: OrderService, gateway: PaymentGateway): Router {
  const router = express.Router();
  router.get('/complete', async (req, res) => {
    const reference = String(req.query.reference ?? req.query.trxref ?? '');
    const order = reference ? orders.store.getByReference(reference) : undefined;
    if (!order) {
      return res.status(404).type('html').send(page('Payment', `<main><div class="card"><h2>We couldn't find that payment</h2><p>Please go back to WhatsApp and ask for your order status.</p></div></main>`));
    }
    let message: string;
    try {
      orders.applyVerification(order, await gateway.verify(reference));
    } catch (err) {
      console.warn(`[payment-return] verify failed: ${(err as PaystackError).message}`);
    }
    if (['paid', 'preparing', 'ready'].includes(order.status)) {
      message = `<h2>✅ Payment received</h2><p>Order <strong>${escapeHtml(order.code)}</strong> (${formatNaira(order.total)}) is in the kitchen queue.</p>
        <p>Go back to WhatsApp and enjoy the park. Ask us "is my pizza ready?" any time. Collect it at the ${escapeHtml(SHOP.pickup_point)}.</p>`;
    } else if (order.status === 'payment_failed') {
      message = `<h2>❌ Payment didn't go through</h2><p>You have not been charged for order <strong>${escapeHtml(order.code)}</strong>. Go back to WhatsApp and ask for a new payment link.</p>`;
    } else if (order.status === 'needs_review') {
      message = `<h2>⚠️ We need to check this payment</h2><p>Please show order code <strong>${escapeHtml(order.code)}</strong> at the kiosk and the team will sort it out.</p>`;
    } else {
      message = `<h2>⏳ Payment still processing</h2><p>Order <strong>${escapeHtml(order.code)}</strong>. Go back to WhatsApp and ask "did my payment go through?" in a minute.</p>`;
    }
    res.type('html').send(page('Payment · Monaliza Pizza', `<header><h1>🍕 Monaliza Pizza</h1></header><main><div class="card">${message}</div></main>`));
  });
  return router;
}
