#!/usr/bin/env node
// Smoke-test a deployed tool server over MCP, the same way Chord calls it.
// Usage: node scripts/smoke-test.mjs [base-url]   (defaults to PUBLIC_BASE_URL from .env)
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const base = (process.argv[2] || process.env.PUBLIC_BASE_URL || env.PUBLIC_BASE_URL).replace(/\/$/, '');
const token = process.env.MCP_AUTH_TOKEN || env.MCP_AUTH_TOKEN;

const unauth = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
console.log(`unauthenticated /mcp -> HTTP ${unauth.status} (expect 401)`);

const client = new Client({ name: 'smoke-test', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));

const show = (label, r) => console.log(`\n## ${label}${r.isError ? ' (tool error)' : ''}\n${r.content[0].text.slice(0, 1200)}`);

const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));
show('get_menu', await client.callTool({ name: 'get_menu', arguments: {} }));
const created = await client.callTool({
  name: 'create_order',
  arguments: { customer_name: 'Smoke Test', customer_phone: '+2348000000000', items: [{ item_id: 'margherita', size: 'small', quantity: 1 }, { item_id: 'water', quantity: 1 }] },
});
show('create_order', created);
if (!created.isError) {
  const code = JSON.parse(created.content[0].text).order_code;
  show('get_order_status', await client.callTool({ name: 'get_order_status', arguments: { order_code: code } }));
  show('cancel_order', await client.callTool({ name: 'cancel_order', arguments: { order_code: code } }));
}
show('get_order_status (unknown code)', await client.callTool({ name: 'get_order_status', arguments: { order_code: 'MP-0000' } }));
await client.close();
