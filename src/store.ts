import type { PizzaSize } from './menu.js';

export type OrderStatus =
  | 'awaiting_payment'
  | 'payment_failed'
  | 'paid'
  | 'preparing'
  | 'ready'
  | 'collected'
  | 'cancelled'
  | 'expired'
  | 'needs_review';

export interface OrderLine {
  item_id: string;
  name: string;
  size?: PizzaSize;
  quantity: number;
  unit_price: number;
  line_total: number;
}

export interface PaymentAttempt {
  reference: string;
  authorization_url: string;
  created_at: number;
  status: 'pending' | 'success' | 'failed' | 'abandoned';
  gateway_response?: string;
}

export interface Order {
  code: string;
  customer_name: string;
  customer_phone?: string;
  customer_email?: string;
  lines: OrderLine[];
  notes?: string;
  total: number;
  currency: 'NGN';
  status: OrderStatus;
  payments: PaymentAttempt[];
  amount_paid?: number;
  review_reason?: string;
  created_at: number;
  updated_at: number;
  paid_at?: number;
  ready_at?: number;
  collected_at?: number;
  /** Set when the "ready" WhatsApp push was attempted, so it is not repeated. */
  ready_notification?: { sent: boolean; detail: string; at: number };
}

/**
 * Runtime in-memory database. Everything is lost on restart; that is an
 * accepted limit of this prototype and is called out in the go-live note.
 */
export class Store {
  orders = new Map<string, Order>();
  /** Payment reference -> order code, for webhook lookups. */
  references = new Map<string, string>();
  soldOut = new Set<string>();
  acceptingOrders = true;
  pauseMessage = '';

  saveOrder(order: Order): void {
    order.updated_at = Date.now();
    this.orders.set(order.code, order);
    for (const p of order.payments) this.references.set(p.reference, order.code);
  }

  getOrder(code: string): Order | undefined {
    return this.orders.get(normalizeCode(code));
  }

  getByReference(reference: string): Order | undefined {
    const code = this.references.get(reference);
    return code ? this.orders.get(code) : undefined;
  }

  allOrders(): Order[] {
    return [...this.orders.values()].sort((a, b) => a.created_at - b.created_at);
  }

  deleteOrder(code: string): void {
    const order = this.orders.get(code);
    if (!order) return;
    for (const p of order.payments) this.references.delete(p.reference);
    this.orders.delete(code);
  }
}

export function normalizeCode(code: string): string {
  const cleaned = code.trim().toUpperCase().replace(/\s+/g, '');
  const digits = cleaned.replace(/^MP-?/, '');
  return /^\d+$/.test(digits) ? `MP-${digits}` : cleaned;
}

/** Normalise Nigerian numbers to 234XXXXXXXXXX so "0803..." and "+234803..." match. */
export function normalizePhone(phone?: string): string | undefined {
  if (!phone) return undefined;
  let digits = phone.replace(/\D/g, '');
  if (!digits) return undefined;
  if (digits.startsWith('0') && digits.length === 11) digits = `234${digits.slice(1)}`;
  return digits;
}
