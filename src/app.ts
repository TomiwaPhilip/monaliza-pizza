import express, { type Express, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcp.js';
import type { OrderService } from './orders.js';
import type { PaymentGateway } from './paystack.js';
import { safeEqual } from './http/html.js';
import { kitchenRouter } from './http/kitchen.js';
import { paymentReturnRouter, paystackWebhookRouter } from './http/payments.js';

export interface AppDeps {
  orders: OrderService;
  gateway: PaymentGateway;
  mcpAuthToken: string;
  kitchenPassword: string;
  paystackSecretKey: string;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.get('/', (_req, res) => {
    res.json({ service: 'monaliza-pizza-tools', mcp: '/mcp', kitchen: '/kitchen', health: '/healthz' });
  });
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', orders: deps.orders.store.orders.size, uptime_s: Math.round(process.uptime()) });
  });

  // Mounted before express.json() so the webhook sees the exact raw bytes Paystack signed.
  app.use('/webhooks/paystack', paystackWebhookRouter(deps.orders, deps.paystackSecretKey));
  app.use('/payment', paymentReturnRouter(deps.orders, deps.gateway));
  app.use('/kitchen', kitchenRouter(deps.orders, deps.kitchenPassword));

  const mcpAuth = (req: Request, res: Response, next: () => void) => {
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const apiKey = req.header('x-api-key');
    const supplied = bearer || apiKey || '';
    if (supplied && safeEqual(supplied, deps.mcpAuthToken)) return next();
    console.warn(`[mcp] rejected unauthenticated request from ${req.ip}`);
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
  };

  // Stateless Streamable HTTP: a fresh MCP server per request, so any instance can answer any call.
  app.post('/mcp', mcpAuth, express.json({ limit: '1mb' }), async (req, res) => {
    const server = createMcpServer(deps.orders);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] request failed', err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  });
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  return app;
}
