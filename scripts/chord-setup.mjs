#!/usr/bin/env node
// Register the deployed tool server with Chord and (optionally) upload + publish the skill.
// Usage: node scripts/chord-setup.mjs [--skip-skill]
// Needs in .env: CHORD_API_KEY, CHORD_WORKSPACE_ID, CHORD_TEAMMATE_ID, MCP_AUTH_TOKEN, PUBLIC_BASE_URL
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = new URL('..', import.meta.url).pathname;
for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { CHORD_API_KEY, CHORD_WORKSPACE_ID, CHORD_TEAMMATE_ID, MCP_AUTH_TOKEN, PUBLIC_BASE_URL } = process.env;
const BASE = (process.env.CHORD_BASE_URL || 'https://api.chordhq.xyz').replace(/\/$/, '');
for (const [k, v] of Object.entries({ CHORD_API_KEY, CHORD_WORKSPACE_ID, CHORD_TEAMMATE_ID, MCP_AUTH_TOKEN, PUBLIC_BASE_URL })) {
  if (!v) throw new Error(`Set ${k} in .env`);
}
if (!PUBLIC_BASE_URL.startsWith('https://')) throw new Error('PUBLIC_BASE_URL must be the public HTTPS URL of the deployed server');

async function chord(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${CHORD_API_KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return data;
}

const ws = `/v1/workspaces/${CHORD_WORKSPACE_ID}/mcp-servers`;
const NAME = 'Monaliza Pizza tools';
const URL_ = `${PUBLIC_BASE_URL.replace(/\/$/, '')}/mcp`;

// 1. Register (or update) the MCP server.
const servers = await chord('GET', ws);
let server = (Array.isArray(servers) ? servers : servers?.servers ?? []).find((s) => s.name === NAME);
if (server) {
  server = await chord('PUT', `${ws}/${server.id}`, { url: URL_, auth_token: MCP_AUTH_TOKEN, enabled: true });
  console.log(`Updated MCP server ${server.id}`);
} else {
  server = await chord('POST', ws, { name: NAME, url: URL_, auth_type: 'bearer', auth_token: MCP_AUTH_TOKEN, transport: 'streamable_http', enabled: false });
  console.log(`Registered MCP server ${server.id}`);
}

// 2. Scope it to our teammate, then enable.
await chord('PUT', `/v1/teammates/${CHORD_TEAMMATE_ID}`, { add_mcp_server_ids: [server.id] });
await chord('PUT', `${ws}/${server.id}`, { enabled: true });

// 3. Discover tools and probe health (a 200 can still carry status: "error").
const tools = await chord('POST', `${ws}/${server.id}/tools`);
console.log('Tools:', tools.map((t) => t.name).join(', '));
const health = await chord('POST', `${ws}/${server.id}/health`);
console.log('Health:', JSON.stringify(health));
if (health.status !== 'ok') process.exitCode = 1;

// 4. Upload and publish the skill package.
if (!process.argv.includes('--skip-skill')) {
  const dir = join(root, 'skills', 'monaliza-pizza-ordering');
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  const files = walk(dir).map((f) => ({ path: relative(dir, f), content: readFileSync(f, 'utf8') }));
  const skillsPath = `/v1/teammates/${CHORD_TEAMMATE_ID}/skills`;
  const existing = (await chord('GET', skillsPath)).skills?.find((s) => s.name === 'Monaliza Pizza ordering');
  let skill;
  if (existing) {
    skill = await chord('PUT', `${skillsPath}/${existing.id}/draft`, {
      name: 'Monaliza Pizza ordering', entrypoint: 'SKILL.md', files, expected_version: existing.version,
      idempotency_key: randomUUID(),
    });
  } else {
    skill = await chord('POST', skillsPath, { name: 'Monaliza Pizza ordering', entrypoint: 'SKILL.md', files, idempotency_key: randomUUID() });
  }
  const s = skill.skill ?? skill;
  await chord('POST', `${skillsPath}/${s.id}/publish`, { expected_version: s.version, summary: 'Monaliza Pizza ordering skill', idempotency_key: randomUUID() });
  console.log(`Published skill ${s.id}`);
}
