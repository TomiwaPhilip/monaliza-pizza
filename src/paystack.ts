import { createHmac, timingSafeEqual } from 'node:crypto';

export type PaystackErrorKind = 'timeout' | 'network' | 'auth' | 'rejected' | 'not_found' | 'bad_response';

export class PaystackError extends Error {
  constructor(
    public kind: PaystackErrorKind,
    message: string,
    public httpStatus?: number,
  ) {
    super(message);
    this.name = 'PaystackError';
  }
}

export interface InitializeInput {
  email: string;
  amountNaira: number;
  reference: string;
  callbackUrl: string;
  metadata: Record<string, unknown>;
}

export interface InitializeResult {
  authorization_url: string;
  access_code: string;
  reference: string;
}

/** Paystack transaction statuses we care about. */
export type PaystackTxStatus = 'success' | 'failed' | 'abandoned' | 'ongoing' | 'pending' | 'processing' | 'queued' | 'reversed';

export interface VerifyResult {
  status: PaystackTxStatus | string;
  reference: string;
  amountNaira: number;
  currency: string;
  gateway_response?: string;
  paid_at?: string | null;
}

export interface PaymentGateway {
  initialize(input: InitializeInput): Promise<InitializeResult>;
  verify(reference: string): Promise<VerifyResult>;
}

export class PaystackClient implements PaymentGateway {
  constructor(
    private secretKey: string,
    private baseUrl = 'https://api.paystack.co',
    private timeoutMs = 10_000,
  ) {}

  async initialize(input: InitializeInput): Promise<InitializeResult> {
    const body = {
      email: input.email,
      // Paystack takes the smallest currency unit (kobo).
      amount: Math.round(input.amountNaira * 100),
      currency: 'NGN',
      reference: input.reference,
      callback_url: input.callbackUrl,
      metadata: input.metadata,
    };
    const data = await this.request<InitializeResult>('POST', '/transaction/initialize', body);
    if (!data?.authorization_url) throw new PaystackError('bad_response', 'Paystack did not return a payment link');
    return data;
  }

  async verify(reference: string): Promise<VerifyResult> {
    const data = await this.request<{
      status: string;
      reference: string;
      amount: number;
      currency: string;
      gateway_response?: string;
      paid_at?: string | null;
    }>('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    if (!data || typeof data.amount !== 'number') throw new PaystackError('bad_response', 'Paystack returned an empty verification');
    return {
      status: data.status,
      reference: data.reference,
      amountNaira: data.amount / 100,
      currency: data.currency,
      gateway_response: data.gateway_response,
      paid_at: data.paid_at,
    };
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        throw new PaystackError('timeout', `Paystack did not respond within ${this.timeoutMs / 1000}s`);
      }
      throw new PaystackError('network', `Could not reach Paystack: ${e.message}`);
    }

    let json: { status?: boolean; message?: string; data?: T } | undefined;
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new PaystackError('bad_response', `Paystack returned a non-JSON response (HTTP ${res.status})`, res.status);
    }

    if (res.status === 401) throw new PaystackError('auth', `Paystack rejected the API key: ${json?.message ?? 'unauthorised'}`, 401);
    if (res.status === 404) throw new PaystackError('not_found', json?.message ?? 'Not found on Paystack', 404);
    if (!res.ok || json?.status !== true) {
      throw new PaystackError('rejected', json?.message ?? `Paystack error (HTTP ${res.status})`, res.status);
    }
    return json.data as T;
  }
}

/** Paystack signs webhooks with HMAC-SHA512 of the raw body using the secret key. */
export function verifyPaystackSignature(rawBody: Buffer, signature: string | undefined, secretKey: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha512', secretKey).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
