import { randomInt } from 'node:crypto';
import { MENU, PIZZA_SIZES, SHOP, findMenuItem, priceFor, type PizzaSize } from './menu.js';
import { PaystackError, type PaymentGateway, type VerifyResult } from './paystack.js';
import { normalizeCode, normalizePhone, type Order, type OrderLine, type OrderStatus, type PaymentAttempt, Store } from './store.js';

/** Business rules for a one-person kiosk with one oven. */
export const KITCHEN = {
  ovenCapacity: 4,
  bakeBatchMinutes: 8,
  basePrepMinutes: 10,
  maxQuantityPerLine: 10,
  maxPizzasPerOrder: 12,
};

export type OrderErrorCode =
  | 'invalid_item'
  | 'size_required'
  | 'sold_out'
  | 'too_large'
  | 'not_accepting_orders'
  | 'order_not_found'
  | 'invalid_state'
  | 'payment_provider_error';

/** Errors carry a message meant to be relayed to the customer (or acted on by the agent). */
export class OrderError extends Error {
  constructor(
    public code: OrderErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OrderError';
  }
}

export interface CreateOrderInput {
  customer_name: string;
  customer_phone?: string;
  customer_email?: string;
  items: { item_id: string; size?: PizzaSize; quantity: number }[];
  notes?: string;
}

export interface Notifier {
  notifyReady(order: Order): Promise<{ sent: boolean; detail: string }>;
}

const ACTIVE_KITCHEN: OrderStatus[] = ['paid', 'preparing'];

const KITCHEN_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  awaiting_payment: ['cancelled'],
  payment_failed: ['cancelled'],
  expired: ['cancelled'],
  paid: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['collected'],
  collected: [],
  cancelled: [],
  needs_review: ['paid', 'cancelled'],
};

export function formatNaira(amount: number): string {
  return `₦${amount.toLocaleString('en-NG')}`;
}

export class OrderService {
  constructor(
    public store: Store,
    private gateway: PaymentGateway,
    private opts: { publicBaseUrl: string; paymentExpiryMinutes: number; notifier?: Notifier; now?: () => number },
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  // ---------- Menu ----------

  getMenu() {
    const pizzasInQueue = this.pizzasAhead();
    return {
      shop: SHOP,
      accepting_orders: this.store.acceptingOrders,
      pause_message: this.store.acceptingOrders ? undefined : this.store.pauseMessage || 'The kitchen is not taking WhatsApp orders right now.',
      estimated_wait_minutes_for_new_order: this.estimateMinutes(pizzasInQueue + 1),
      pizza_sizes: PIZZA_SIZES,
      currency: 'NGN',
      items: MENU.map((m) => ({
        id: m.id,
        name: m.name,
        category: m.category,
        description: m.description,
        ...('single' in m.prices ? { price: m.prices.single } : { prices_by_size: m.prices }),
        available: !this.store.soldOut.has(m.id),
      })),
    };
  }

  // ---------- Orders ----------

  async createOrder(input: CreateOrderInput) {
    if (!this.store.acceptingOrders) {
      throw new OrderError('not_accepting_orders', this.store.pauseMessage || 'The kitchen is not taking WhatsApp orders right now. Please try again a bit later.');
    }
    const lines = this.priceLines(input.items);
    const total = lines.reduce((sum, l) => sum + l.line_total, 0);
    const now = this.now();
    const order: Order = {
      code: this.newCode(),
      customer_name: input.customer_name.trim(),
      customer_phone: normalizePhone(input.customer_phone),
      customer_email: input.customer_email?.trim() || undefined,
      lines,
      notes: input.notes?.trim() || undefined,
      total,
      currency: 'NGN',
      status: 'awaiting_payment',
      payments: [],
      created_at: now,
      updated_at: now,
    };

    // Only persist the order once Paystack has given us a link, so a failed
    // initialisation never leaves a half-made order behind.
    const attempt = await this.startPayment(order);
    order.payments.push(attempt);
    this.store.saveOrder(order);
    return this.view(order);
  }

  async getOrderStatus(code: string) {
    const order = this.requireOrder(code);
    await this.refreshPayment(order);
    return this.view(order);
  }

  async findOrdersByPhone(phone: string) {
    const normalized = normalizePhone(phone);
    if (!normalized) return [];
    const matches = this.store.allOrders().filter((o) => o.customer_phone === normalized);
    for (const o of matches) await this.refreshPayment(o);
    return matches.slice(-5).reverse().map((o) => this.view(o));
  }

  async retryPayment(code: string) {
    const order = this.requireOrder(code);
    await this.refreshPayment(order);
    if (!['awaiting_payment', 'payment_failed', 'expired'].includes(order.status)) {
      throw new OrderError('invalid_state', `Order ${order.code} is ${order.status.replace('_', ' ')}; a new payment link is not needed.`, { order: this.view(order) });
    }
    if (!this.store.acceptingOrders) {
      throw new OrderError('not_accepting_orders', this.store.pauseMessage || 'The kitchen is not taking WhatsApp orders right now.');
    }
    const unavailable = order.lines.filter((l) => this.store.soldOut.has(l.item_id));
    if (unavailable.length) {
      throw new OrderError('sold_out', `Sorry, ${unavailable.map((l) => l.name).join(', ')} sold out since this order was placed. Please place a new order.`);
    }
    for (const p of order.payments) if (p.status === 'pending') p.status = 'abandoned';
    const attempt = await this.startPayment(order);
    order.payments.push(attempt);
    order.status = 'awaiting_payment';
    this.store.saveOrder(order);
    return this.view(order);
  }

  async cancelOrder(code: string) {
    const order = this.requireOrder(code);
    await this.refreshPayment(order);
    if (!['awaiting_payment', 'payment_failed', 'expired'].includes(order.status)) {
      throw new OrderError(
        'invalid_state',
        `Order ${order.code} is already ${order.status.replace('_', ' ')}, so it can't be cancelled on WhatsApp. Please speak to the staff at the kiosk.`,
        { order: this.view(order) },
      );
    }
    order.status = 'cancelled';
    for (const p of order.payments) if (p.status === 'pending') p.status = 'abandoned';
    this.store.saveOrder(order);
    return this.view(order);
  }

  // ---------- Payments ----------

  /** Apply a Paystack verification result (from the webhook, the callback page or a status check). */
  applyVerification(order: Order, result: VerifyResult): void {
    const attempt = order.payments.find((p) => p.reference === result.reference);
    if (!attempt) return;
    attempt.gateway_response = result.gateway_response ?? attempt.gateway_response;

    if (result.status === 'success') {
      attempt.status = 'success';
      if (['paid', 'preparing', 'ready', 'collected', 'needs_review'].includes(order.status)) {
        this.store.saveOrder(order);
        return; // idempotent: webhook and polling can both report the same payment
      }
      order.amount_paid = result.amountNaira;
      order.paid_at = this.now();
      if (result.currency !== 'NGN' || result.amountNaira < order.total) {
        order.status = 'needs_review';
        order.review_reason = `Paid ${result.currency} ${result.amountNaira} but order total is NGN ${order.total}`;
      } else if (order.status === 'cancelled') {
        order.status = 'needs_review';
        order.review_reason = 'Payment arrived after the order was cancelled. Honour the order or refund it.';
      } else {
        order.status = 'paid';
      }
    } else if (result.status === 'failed' || result.status === 'reversed') {
      attempt.status = 'failed';
      if (order.status === 'awaiting_payment' && this.latestAttempt(order) === attempt) order.status = 'payment_failed';
    }
    // "abandoned", "ongoing", "pending", "queued": the customer has not finished paying yet.
    this.store.saveOrder(order);
  }

  async handleWebhookCharge(reference: string): Promise<Order | undefined> {
    const order = this.store.getByReference(reference);
    if (!order) return undefined;
    // Never trust the webhook body for the amount; confirm with Paystack directly.
    const result = await this.gateway.verify(reference);
    this.applyVerification(order, result);
    return order;
  }

  /** Re-check unpaid orders with Paystack so a missed webhook never strands a paid customer. */
  async refreshPayment(order: Order): Promise<void> {
    if (!['awaiting_payment', 'payment_failed', 'expired', 'cancelled'].includes(order.status)) return;
    const attempt = this.latestAttempt(order);
    if (attempt && attempt.status !== 'success' && attempt.status !== 'failed') {
      try {
        this.applyVerification(order, await this.gateway.verify(attempt.reference));
      } catch (err) {
        // A Paystack outage must not break status checks; report what we know.
        console.warn(`[payments] verify failed for ${order.code}: ${(err as Error).message}`);
      }
    }
    if (order.status === 'awaiting_payment' && this.now() > this.paymentDeadline(order)) {
      order.status = 'expired';
      this.store.saveOrder(order);
    }
  }

  async sweepExpired(): Promise<void> {
    for (const order of this.store.allOrders()) {
      if (order.status === 'awaiting_payment') await this.refreshPayment(order);
    }
  }

  private async startPayment(order: Order): Promise<PaymentAttempt> {
    const reference = `${order.code}-${order.payments.length + 1}-${randomInt(100000, 999999)}`;
    try {
      const res = await this.gateway.initialize({
        email: order.customer_email ?? `${order.code.toLowerCase()}@example.com`,
        amountNaira: order.total,
        reference,
        callbackUrl: `${this.opts.publicBaseUrl}/payment/complete`,
        metadata: {
          order_code: order.code,
          customer_name: order.customer_name,
          custom_fields: [{ display_name: 'Order', variable_name: 'order_code', value: order.code }],
        },
      });
      return { reference: res.reference || reference, authorization_url: res.authorization_url, created_at: this.now(), status: 'pending' };
    } catch (err) {
      if (err instanceof PaystackError) {
        console.error(`[payments] initialize failed (${err.kind}): ${err.message}`);
        throw new OrderError(
          'payment_provider_error',
          'Our payment system (Paystack) is having a problem right now, so I could not create a payment link. Nothing has been charged. Please try again in a minute.',
          { provider_error: err.kind },
        );
      }
      throw err;
    }
  }

  // ---------- Kitchen ----------

  async kitchenTransition(code: string, to: OrderStatus): Promise<Order> {
    const order = this.requireOrder(code);
    const allowed = KITCHEN_TRANSITIONS[order.status];
    if (!allowed.includes(to)) {
      throw new OrderError('invalid_state', `Cannot move ${order.code} from ${order.status} to ${to}`);
    }
    order.status = to;
    if (to === 'ready') order.ready_at = this.now();
    if (to === 'collected') order.collected_at = this.now();
    if (to === 'paid' && !order.paid_at) order.paid_at = this.now();
    this.store.saveOrder(order);

    if (to === 'ready' && this.opts.notifier && !order.ready_notification) {
      const result = await this.opts.notifier.notifyReady(order).catch((e: Error) => ({ sent: false, detail: e.message }));
      order.ready_notification = { ...result, at: this.now() };
      this.store.saveOrder(order);
    }
    return order;
  }

  setSoldOut(itemId: string, soldOut: boolean): void {
    const item = findMenuItem(itemId);
    if (!item) throw new OrderError('invalid_item', `Unknown item ${itemId}`);
    if (soldOut) this.store.soldOut.add(item.id);
    else this.store.soldOut.delete(item.id);
  }

  setAcceptingOrders(accepting: boolean, message = ''): void {
    this.store.acceptingOrders = accepting;
    this.store.pauseMessage = accepting ? '' : message;
  }

  // ---------- Helpers ----------

  /** Customer-facing order view with guidance the agent can relay directly. */
  view(order: Order) {
    const queue = this.queueInfo(order);
    const latest = this.latestAttempt(order);
    return {
      order_code: order.code,
      status: order.status,
      what_to_tell_customer: this.explain(order, queue),
      customer_name: order.customer_name,
      items: order.lines.map((l) => ({
        item: l.name,
        size: l.size,
        quantity: l.quantity,
        line_total: formatNaira(l.line_total),
      })),
      notes: order.notes,
      total: formatNaira(order.total),
      total_naira: order.total,
      payment_link: order.status === 'awaiting_payment' ? latest?.authorization_url : undefined,
      payment_link_expires_in_minutes:
        order.status === 'awaiting_payment'
          ? Math.max(0, Math.round((this.paymentDeadline(order) - this.now()) / 60_000))
          : undefined,
      last_payment_message: latest?.gateway_response,
      queue_position: queue?.position,
      estimated_ready_in_minutes: queue?.minutes,
      pickup_point: ['paid', 'preparing', 'ready'].includes(order.status) ? SHOP.pickup_point : undefined,
    };
  }

  private explain(order: Order, queue?: { position: number; minutes: number }): string {
    switch (order.status) {
      case 'awaiting_payment':
        return `Waiting for payment of ${formatNaira(order.total)}. Send the payment link. The kitchen starts the order once payment is confirmed.`;
      case 'payment_failed':
        return `The last payment attempt failed${this.latestAttempt(order)?.gateway_response ? ` (${this.latestAttempt(order)?.gateway_response})` : ''}. Nothing was charged. Offer a new payment link with retry_payment.`;
      case 'expired':
        return 'The payment link expired before payment was made. Offer a fresh link with retry_payment, or a new order.';
      case 'paid':
        return `Payment confirmed. The order is in the queue (position ${queue?.position}). Estimated ready in about ${queue?.minutes} minutes. Tell the customer they will not need to wait at the kiosk.`;
      case 'preparing':
        return `The pizza is in the oven. Estimated ready in about ${queue?.minutes} minutes.`;
      case 'ready':
        return `Ready for pickup now at the ${SHOP.pickup_point}. Show order code ${order.code} at the window.`;
      case 'collected':
        return 'This order has already been collected. Enjoy!';
      case 'cancelled':
        return 'This order was cancelled. Nothing was charged for it.';
      case 'needs_review':
        return 'There is a problem with this payment that needs a staff member to check. Tell the customer the team will sort it out at the kiosk and to quote their order code. Do not promise a refund or a time.';
    }
  }

  private queueInfo(order: Order): { position: number; minutes: number } | undefined {
    if (!ACTIVE_KITCHEN.includes(order.status)) return undefined;
    const queue = this.store
      .allOrders()
      .filter((o) => ACTIVE_KITCHEN.includes(o.status))
      .sort((a, b) => (a.paid_at ?? 0) - (b.paid_at ?? 0));
    const idx = queue.findIndex((o) => o.code === order.code);
    const pizzasUpToMine = queue.slice(0, idx + 1).reduce((n, o) => n + this.pizzaCount(o), 0);
    const minutes = order.status === 'preparing' ? KITCHEN.bakeBatchMinutes : this.estimateMinutes(Math.max(1, pizzasUpToMine));
    return { position: idx + 1, minutes };
  }

  private estimateMinutes(pizzas: number): number {
    return KITCHEN.basePrepMinutes + Math.ceil(pizzas / KITCHEN.ovenCapacity) * KITCHEN.bakeBatchMinutes;
  }

  private pizzasAhead(): number {
    return this.store
      .allOrders()
      .filter((o) => ACTIVE_KITCHEN.includes(o.status))
      .reduce((n, o) => n + this.pizzaCount(o), 0);
  }

  private pizzaCount(order: Order): number {
    return order.lines.filter((l) => l.size).reduce((n, l) => n + l.quantity, 0);
  }

  /** Each new payment link restarts the payment window. */
  private paymentDeadline(order: Order): number {
    const start = this.latestAttempt(order)?.created_at ?? order.created_at;
    return start + this.opts.paymentExpiryMinutes * 60_000;
  }

  private latestAttempt(order: Order): PaymentAttempt | undefined {
    return order.payments[order.payments.length - 1];
  }

  private requireOrder(code: string): Order {
    const order = this.store.getOrder(code);
    if (!order) {
      throw new OrderError('order_not_found', `I couldn't find order ${normalizeCode(code)}. Please check the code (it looks like MP-1234).`);
    }
    return order;
  }

  private priceLines(items: CreateOrderInput['items']): OrderLine[] {
    if (!items.length) throw new OrderError('invalid_item', 'The order has no items.');
    const lines: OrderLine[] = [];
    for (const req of items) {
      const item = findMenuItem(req.item_id);
      if (!item) {
        throw new OrderError('invalid_item', `"${req.item_id}" is not on the menu.`, { valid_item_ids: MENU.map((m) => m.id) });
      }
      if (this.store.soldOut.has(item.id)) {
        throw new OrderError('sold_out', `Sorry, ${item.name} is sold out right now.`, { sold_out_item: item.id });
      }
      const isPizza = item.category === 'pizza';
      if (isPizza && !req.size) {
        throw new OrderError('size_required', `Which size for the ${item.name}: small, medium or large?`, { item_id: item.id, sizes: PIZZA_SIZES });
      }
      const size = isPizza ? req.size : undefined;
      const unit = priceFor(item, size);
      if (unit === undefined) throw new OrderError('invalid_item', `${item.name} is not available in size ${req.size}.`);
      if (!Number.isInteger(req.quantity) || req.quantity < 1 || req.quantity > KITCHEN.maxQuantityPerLine) {
        throw new OrderError('too_large', `Quantity for ${item.name} must be between 1 and ${KITCHEN.maxQuantityPerLine}.`);
      }
      const existing = lines.find((l) => l.item_id === item.id && l.size === size);
      if (existing) {
        existing.quantity += req.quantity;
        existing.line_total = existing.quantity * existing.unit_price;
      } else {
        lines.push({ item_id: item.id, name: item.name, size, quantity: req.quantity, unit_price: unit, line_total: unit * req.quantity });
      }
    }
    const pizzas = lines.filter((l) => l.size).reduce((n, l) => n + l.quantity, 0);
    if (pizzas > KITCHEN.maxPizzasPerOrder) {
      throw new OrderError('too_large', `We can take up to ${KITCHEN.maxPizzasPerOrder} pizzas per WhatsApp order. For bigger group orders please speak to the staff at the kiosk.`);
    }
    return lines;
  }

  private newCode(): string {
    for (;;) {
      const code = `MP-${randomInt(1000, 10000)}`;
      if (!this.store.orders.has(code)) return code;
    }
  }
}
