import { beforeEach, describe, expect, it } from 'vitest';
import { OrderError, OrderService, checkoutAmountWithFees, type Notifier } from '../src/orders.js';
import { PaystackError } from '../src/paystack.js';
import { Store, normalizeCode, normalizePhone } from '../src/store.js';
import { FakeGateway } from './fake-gateway.js';

let gateway: FakeGateway;
let service: OrderService;
let clock: number;

const pizzaOrder = {
  customer_name: 'Tomi',
  customer_phone: '08031234567',
  items: [
    { item_id: 'pepperoni', size: 'large' as const, quantity: 1 },
    { item_id: 'coke', quantity: 2 },
  ],
};

beforeEach(() => {
  gateway = new FakeGateway();
  clock = 1_800_000_000_000;
  service = new OrderService(new Store(), gateway, { publicBaseUrl: 'https://pizza.test', paymentExpiryMinutes: 30, now: () => clock });
});

async function expectOrderError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof OrderError && e.code === code);
}

describe('create_order', () => {
  it('prices server-side and returns a Paystack link', async () => {
    const order = await service.createOrder(pizzaOrder);
    expect(order.total_naira).toBe(14500 + 2 * 800);
    expect(order.status).toBe('awaiting_payment');
    expect(order.payment_link).toMatch(/^https:\/\/checkout\.paystack\.com\//);
    expect(order.order_code).toMatch(/^MP-\d{4}$/);
    expect(gateway.initialized[0]).toMatchObject({ amountNaira: 16100, callbackUrl: 'https://pizza.test/payment/complete' });
    expect(gateway.initialized[0].email).toMatch(/@example\.com$/);
  });

  it('merges duplicate lines', async () => {
    const order = await service.createOrder({ customer_name: 'A', items: [{ item_id: 'coke', quantity: 1 }, { item_id: 'COKE', quantity: 2 }] });
    expect(order.items).toEqual([expect.objectContaining({ item: 'Coca-Cola 50cl', quantity: 3 })]);
  });

  it('rejects unknown items, missing sizes, sold out items and oversize orders', async () => {
    await expectOrderError(service.createOrder({ customer_name: 'A', items: [{ item_id: 'shawarma', quantity: 1 }] }), 'invalid_item');
    await expectOrderError(service.createOrder({ customer_name: 'A', items: [{ item_id: 'margherita', quantity: 1 }] }), 'size_required');
    service.setSoldOut('suya-special', true);
    await expectOrderError(service.createOrder({ customer_name: 'A', items: [{ item_id: 'suya-special', size: 'small', quantity: 1 }] }), 'sold_out');
    await expectOrderError(
      service.createOrder({ customer_name: 'A', items: [{ item_id: 'margherita', size: 'small', quantity: 10 }, { item_id: 'pepperoni', size: 'small', quantity: 5 }] }),
      'too_large',
    );
  });

  it('refuses orders while the kitchen has paused WhatsApp orders', async () => {
    service.setAcceptingOrders(false, 'Oven maintenance, back at 4pm');
    await expect(service.createOrder(pizzaOrder)).rejects.toThrow('Oven maintenance');
    expect(service.getMenu().accepting_orders).toBe(false);
  });

  it('does not keep an order when Paystack is down', async () => {
    gateway.failInitialize = new PaystackError('timeout', 'Paystack did not respond');
    await expectOrderError(service.createOrder(pizzaOrder), 'payment_provider_error');
    expect(service.store.orders.size).toBe(0);
  });
});

describe('payments', () => {
  it('marks paid only after Paystack verification succeeds', async () => {
    const order = await service.createOrder(pizzaOrder);
    expect((await service.getOrderStatus(order.order_code)).status).toBe('awaiting_payment');
    gateway.pay(gateway.lastReference);
    const after = await service.getOrderStatus(order.order_code.toLowerCase());
    expect(after.status).toBe('paid');
    expect(after.queue_position).toBe(1);
    expect(after.estimated_ready_in_minutes).toBeGreaterThan(0);
    expect(after.payment_link).toBeUndefined();
  });

  it('webhook handling is idempotent', async () => {
    const order = await service.createOrder(pizzaOrder);
    gateway.pay(gateway.lastReference);
    await service.handleWebhookCharge(gateway.lastReference);
    await service.handleWebhookCharge(gateway.lastReference);
    expect(service.store.getOrder(order.order_code)?.status).toBe('paid');
  });

  it('flags underpayment for staff review instead of accepting it', async () => {
    const order = await service.createOrder(pizzaOrder);
    gateway.pay(gateway.lastReference, { amountNaira: 100 });
    const status = await service.getOrderStatus(order.order_code);
    expect(status.status).toBe('needs_review');
  });

  it('handles a failed payment and a successful retry', async () => {
    const order = await service.createOrder(pizzaOrder);
    gateway.outcomes.set(gateway.lastReference, { status: 'failed', gateway_response: 'Declined' });
    const failed = await service.getOrderStatus(order.order_code);
    expect(failed.status).toBe('payment_failed');
    expect(failed.what_to_tell_customer).toContain('Declined');

    const retried = await service.retryPayment(order.order_code);
    expect(retried.status).toBe('awaiting_payment');
    expect(gateway.initialized).toHaveLength(2);
    gateway.pay(gateway.lastReference);
    expect((await service.getOrderStatus(order.order_code)).status).toBe('paid');
  });

  it('retry_payment does not issue a second link if the first was actually paid', async () => {
    const order = await service.createOrder(pizzaOrder);
    gateway.pay(gateway.lastReference);
    await expectOrderError(service.retryPayment(order.order_code), 'invalid_state');
    expect(gateway.initialized).toHaveLength(1);
  });

  it('expires unpaid orders after the payment window', async () => {
    const order = await service.createOrder(pizzaOrder);
    clock += 31 * 60_000;
    expect((await service.getOrderStatus(order.order_code)).status).toBe('expired');
  });

  it('keeps answering status checks when Paystack verification is down', async () => {
    const order = await service.createOrder(pizzaOrder);
    gateway.failVerify = new PaystackError('network', 'down');
    expect((await service.getOrderStatus(order.order_code)).status).toBe('awaiting_payment');
  });

  it('cannot cancel a paid order but can cancel an unpaid one', async () => {
    const a = await service.createOrder(pizzaOrder);
    gateway.pay(gateway.lastReference);
    await expectOrderError(service.cancelOrder(a.order_code), 'invalid_state');
    const b = await service.createOrder(pizzaOrder);
    expect((await service.cancelOrder(b.order_code)).status).toBe('cancelled');
  });

  it('flags a payment that lands after cancellation', async () => {
    const order = await service.createOrder(pizzaOrder);
    const ref = gateway.lastReference;
    await service.cancelOrder(order.order_code);
    gateway.pay(ref);
    await service.handleWebhookCharge(ref);
    expect(service.store.getOrder(order.order_code)?.status).toBe('needs_review');
  });
});

describe('kitchen flow and lookups', () => {
  it('moves through the kitchen states and notifies once when ready', async () => {
    const sent: string[] = [];
    const notifier: Notifier = { notifyReady: async (o) => (sent.push(o.code), { sent: true, detail: 'ok' }) };
    service = new OrderService(new Store(), gateway, { publicBaseUrl: 'x', paymentExpiryMinutes: 30, notifier });
    const order = await service.createOrder(pizzaOrder);
    gateway.pay(gateway.lastReference);
    await service.getOrderStatus(order.order_code);

    await expectOrderError(service.kitchenTransition(order.order_code, 'collected'), 'invalid_state');
    await service.kitchenTransition(order.order_code, 'preparing');
    await service.kitchenTransition(order.order_code, 'ready');
    const ready = await service.getOrderStatus(order.order_code);
    expect(ready.status).toBe('ready');
    expect(ready.what_to_tell_customer).toContain(order.order_code);
    expect(sent).toEqual([order.order_code]);
    await service.kitchenTransition(order.order_code, 'collected');
  });

  it('queue position reflects payment order', async () => {
    const first = await service.createOrder(pizzaOrder);
    gateway.pay(gateway.lastReference);
    await service.getOrderStatus(first.order_code);
    clock += 1000;
    const second = await service.createOrder({ ...pizzaOrder, customer_phone: '+2348099999999' });
    gateway.pay(gateway.lastReference);
    const status = await service.getOrderStatus(second.order_code);
    expect(status.queue_position).toBe(2);
  });

  it('finds orders by phone in any common format', async () => {
    await service.createOrder(pizzaOrder);
    expect(await service.findOrdersByPhone('+234 803 123 4567')).toHaveLength(1);
    expect(await service.findOrdersByPhone('08000000000')).toHaveLength(0);
  });

  it('returns a helpful error for unknown codes', async () => {
    await expectOrderError(service.getOrderStatus('MP-0000'), 'order_not_found');
  });
});

describe('normalisers', () => {
  it('estimates the Paystack checkout amount when fees are passed to the customer', async () => {
    // Observed on a real test checkout: a ₦6,500 order showed "Pay NGN 6,700.51".
    expect(checkoutAmountWithFees(6500)).toBe(6700.51);
    expect(checkoutAmountWithFees(2000)).toBe(2030.46); // ₦100 flat fee waived under ₦2,500
    expect(checkoutAmountWithFees(200000)).toBe(202000); // fee capped at ₦2,000
    const withFees = new OrderService(new Store(), gateway, { publicBaseUrl: 'x', paymentExpiryMinutes: 30, feesPassedToCustomer: true });
    const order = await withFees.createOrder({ customer_name: 'A', items: [{ item_id: 'margherita', size: 'small', quantity: 1 }] });
    expect(order.amount_to_pay_at_checkout).toBe('₦6,700.51');
    expect(order.what_to_tell_customer).toContain('₦6,700.51');
  });

  it('normalises codes and phones', () => {
    expect(normalizeCode(' mp 4821 ')).toBe('MP-4821');
    expect(normalizeCode('4821')).toBe('MP-4821');
    expect(normalizePhone('0803 123 4567')).toBe('2348031234567');
    expect(normalizePhone('+234-803-123-4567')).toBe('2348031234567');
  });
});
