import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OrderError, type OrderService } from './orders.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

async function run(name: string, fn: () => Promise<unknown> | unknown): Promise<ToolResult> {
  try {
    const result = await fn();
    console.log(`[mcp] ${name} ok`);
    return ok(result);
  } catch (err) {
    if (err instanceof OrderError) {
      console.log(`[mcp] ${name} -> ${err.code}: ${err.message}`);
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: err.code, message: err.message, ...err.details }, null, 2) }] };
    }
    console.error(`[mcp] ${name} crashed`, err);
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: 'internal_error', message: 'Something went wrong on our side. Apologise and ask the customer to try again in a minute.' }) }],
    };
  }
}

const orderCode = z.string().min(3).describe('Order code given to the customer, e.g. MP-4821');

export function createMcpServer(orders: OrderService): McpServer {
  const server = new McpServer({ name: 'monaliza-pizza', version: '1.0.0' });

  server.registerTool(
    'get_menu',
    {
      title: 'Get menu',
      description:
        "Get Monaliza Pizza's live menu with prices in Naira, which items are sold out, shop details (location, pickup point, hours) and the current estimated wait for a new order. Call this before quoting any price or taking an order.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => run('get_menu', () => orders.getMenu()),
  );

  server.registerTool(
    'create_order',
    {
      title: 'Create order and payment link',
      description:
        'Create a pickup order and a Paystack payment link. Only call after the customer has confirmed the exact items, sizes and quantities. The server calculates the total; never calculate it yourself. Returns the order code, total and payment_link to send to the customer.',
      inputSchema: {
        customer_name: z.string().min(1).max(80).describe("Customer's first name, used at pickup"),
        customer_phone: z
          .string()
          .max(20)
          .optional()
          .describe("Customer's WhatsApp number if known, e.g. +2348031234567. Used to find their orders later and to message them when the pizza is ready."),
        customer_email: z.string().email().optional().describe('Optional email for the Paystack receipt. Do not ask for it unless the customer offers it.'),
        items: z
          .array(
            z.object({
              item_id: z.string().describe('Menu item id from get_menu, e.g. "pepperoni"'),
              size: z.enum(['small', 'medium', 'large']).optional().describe('Required for pizzas, omit for sides and drinks'),
              quantity: z.number().int().min(1).max(10),
            }),
          )
          .min(1)
          .max(15),
        notes: z.string().max(200).optional().describe('Kitchen notes, e.g. "extra pepper", "no onions"'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => run('create_order', () => orders.createOrder(args)),
  );

  server.registerTool(
    'get_order_status',
    {
      title: 'Get order status',
      description:
        "Check an order's live status: payment confirmed or not, position in the kitchen queue, estimated ready time, or ready for pickup. Re-checks Paystack if payment is still pending. Use when the customer asks 'is my pizza ready?' or says they have paid.",
      inputSchema: { order_code: orderCode },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ order_code }) => run('get_order_status', () => orders.getOrderStatus(order_code)),
  );

  server.registerTool(
    'find_my_orders',
    {
      title: 'Find orders by phone',
      description: "List the customer's recent orders (newest first) by WhatsApp number. Use when they ask about their order but don't have the order code.",
      inputSchema: { customer_phone: z.string().min(7).max(20).describe('WhatsApp number, e.g. +2348031234567 or 08031234567') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ customer_phone }) =>
      run('find_my_orders', async () => {
        const found = await orders.findOrdersByPhone(customer_phone);
        return found.length ? { orders: found } : { orders: [], message: 'No orders found for that number. Ask for the order code instead.' };
      }),
  );

  server.registerTool(
    'retry_payment',
    {
      title: 'New payment link',
      description: 'Create a fresh Paystack payment link for an unpaid order whose payment failed or whose link expired. Checks first that the customer has not already paid.',
      inputSchema: { order_code: orderCode },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ order_code }) => run('retry_payment', () => orders.retryPayment(order_code)),
  );

  server.registerTool(
    'cancel_order',
    {
      title: 'Cancel unpaid order',
      description: 'Cancel an order that has NOT been paid. Paid orders cannot be cancelled here; the customer must speak to staff at the kiosk.',
      inputSchema: { order_code: orderCode },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ order_code }) => run('cancel_order', () => orders.cancelOrder(order_code)),
  );

  return server;
}
