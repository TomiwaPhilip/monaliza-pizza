import { SHOP } from './menu.js';
import type { Notifier } from './orders.js';
import { normalizePhone, type Order } from './store.js';

interface ChordThread {
  id: string;
  channel_id?: string;
  channel_participant_id?: string;
  control_state?: string;
}

/**
 * Best-effort WhatsApp "your order is ready" push through Chord's thread API.
 * Chord only lets an operator post into a thread it has taken over, so this
 * does take-over -> message -> hand-back to put the conversation back with the teammate.
 */
export class ChordNotifier implements Notifier {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private workspaceId: string,
  ) {}

  async notifyReady(order: Order): Promise<{ sent: boolean; detail: string }> {
    if (!order.customer_phone) return { sent: false, detail: 'No phone number on the order' };
    const thread = await this.findThread(order.customer_phone);
    if (!thread) return { sent: false, detail: `No open Chord thread for ${order.customer_phone}` };

    const text = `🍕 ${order.customer_name}, your order ${order.code} is READY! Please come to the ${SHOP.pickup_point} and show the code ${order.code}.`;
    const wasAgent = thread.control_state !== 'human_active';
    if (wasAgent) await this.call('POST', `/v1/threads/${thread.id}/take-over`, { reason: `Order ${order.code} ready notification` });
    try {
      await this.call('POST', `/v1/threads/${thread.id}/messages`, { text });
    } finally {
      if (wasAgent) await this.call('POST', `/v1/threads/${thread.id}/hand-back`, { reason: 'Ready notification sent' }).catch(() => undefined);
    }
    return { sent: true, detail: `Sent on thread ${thread.id} (${thread.channel_id ?? 'unknown channel'})` };
  }

  private async findThread(phone: string): Promise<ChordThread | undefined> {
    const params = new URLSearchParams({ workspace_id: this.workspaceId, status: 'open', limit: '200' });
    const res = (await this.call('GET', `/v1/threads?${params}`)) as { threads?: ChordThread[] };
    return res.threads?.find((t) => normalizePhone(t.channel_participant_id) === phone);
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Chord ${method} ${path.split('?')[0]} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
}
