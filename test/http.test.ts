import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { OrderService } from '../src/orders.js';
import { Store } from '../src/store.js';
import { FakeGateway } from './fake-gateway.js';

const SECRET = 'sk_test_fake';
const TOKEN = 'mcp-token';
const KITCHEN = 'kitchen-pass';

const gateway = new FakeGateway();
const orders = new OrderService(new Store(), gateway, { publicBaseUrl: 'https://pizza.test', paymentExpiryMinutes: 30 });
const app = createApp({ orders, gateway, mcpAuthToken: TOKEN, kitchenPassword: KITCHEN, paystackSecretKey: SECRET });

let server: Server;
let client: Client;

function parse(result: unknown) {
  const r = result as { content: { text: string }[]; isError?: boolean };
  return { data: JSON.parse(r.content[0].text), isError: !!r.isError };
}

beforeAll(async () => {
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }),
  );
});

afterAll(async () => {
  await client?.close();
  server?.close();
});

describe('MCP endpoint', () => {
  it('rejects requests without the bearer token', async () => {
    const res = await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
  });

  it('accepts the token as X-API-Key too', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('X-API-Key', TOKEN)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
    expect(res.status).toBe(200);
  });

  it('lists the ordering tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['cancel_order', 'create_order', 'find_my_orders', 'get_menu', 'get_order_status', 'retry_payment']);
  });

  it('runs a full order -> pay -> kitchen -> ready conversation', async () => {
    const menu = parse(await client.callTool({ name: 'get_menu', arguments: {} }));
    expect(menu.data.items.length).toBeGreaterThan(5);

    const created = parse(
      await client.callTool({
        name: 'create_order',
        arguments: { customer_name: 'Tomi', customer_phone: '+2348031234567', items: [{ item_id: 'suya-special', size: 'medium', quantity: 1 }] },
      }),
    );
    expect(created.isError).toBe(false);
    expect(created.data.total).toBe('₦12,500');
    const code = created.data.order_code;

    // Paystack calls the webhook (signed) after the customer pays.
    const reference = gateway.lastReference;
    gateway.pay(reference);
    const body = JSON.stringify({ event: 'charge.success', data: { reference } });
    const sig = createHmac('sha512', SECRET).update(body).digest('hex');
    await request(app).post('/webhooks/paystack').set('x-paystack-signature', sig).set('Content-Type', 'application/json').send(body).expect(200);
    await new Promise((r) => setTimeout(r, 20));

    const paid = parse(await client.callTool({ name: 'get_order_status', arguments: { order_code: code } }));
    expect(paid.data.status).toBe('paid');

    const auth = `Basic ${Buffer.from(`staff:${KITCHEN}`).toString('base64')}`;
    await request(app).post(`/kitchen/orders/${code}/status`).set('Authorization', auth).type('form').send({ to: 'preparing' }).expect(303);
    await request(app).post(`/kitchen/orders/${code}/status`).set('Authorization', auth).type('form').send({ to: 'ready' }).expect(303);

    const ready = parse(await client.callTool({ name: 'find_my_orders', arguments: { customer_phone: '08031234567' } }));
    expect(ready.data.orders[0]).toMatchObject({ order_code: code, status: 'ready' });
  });

  it('returns tool errors the agent can relay', async () => {
    const res = parse(await client.callTool({ name: 'create_order', arguments: { customer_name: 'A', items: [{ item_id: 'pepperoni', quantity: 1 }] } }));
    expect(res.isError).toBe(true);
    expect(res.data.error).toBe('size_required');
    const missing = parse(await client.callTool({ name: 'get_order_status', arguments: { order_code: 'MP-0001' } }));
    expect(missing.data.error).toBe('order_not_found');
  });
});

describe('Paystack webhook + return page', () => {
  it('rejects bad signatures', async () => {
    await request(app).post('/webhooks/paystack').set('x-paystack-signature', 'nope').send('{"event":"charge.success"}').expect(401);
  });

  it('payment return page verifies with Paystack', async () => {
    const order = await orders.createOrder({ customer_name: 'B', items: [{ item_id: 'water', quantity: 1 }] });
    gateway.pay(gateway.lastReference);
    const res = await request(app).get(`/payment/complete?reference=${gateway.lastReference}`).expect(200);
    expect(res.text).toContain('Payment received');
    expect(orders.store.getOrder(order.order_code)?.status).toBe('paid');
  });
});

describe('Kitchen board', () => {
  it('requires the kitchen password', async () => {
    await request(app).get('/kitchen').expect(401);
    const auth = `Basic ${Buffer.from(`x:${KITCHEN}`).toString('base64')}`;
    const res = await request(app).get('/kitchen').set('Authorization', auth).expect(200);
    expect(res.text).toContain('Kitchen');
  });

  it('blocks cross-site form posts', async () => {
    const auth = `Basic ${Buffer.from(`x:${KITCHEN}`).toString('base64')}`;
    await request(app).post('/kitchen/accepting').set('Authorization', auth).set('Origin', 'https://evil.example').type('form').send({ accepting: 'false' }).expect(403);
  });
});
