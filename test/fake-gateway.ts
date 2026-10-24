import type { InitializeInput, InitializeResult, PaymentGateway, VerifyResult } from '../src/paystack.js';
import { PaystackError } from '../src/paystack.js';

/** In-memory stand-in for Paystack. Tests set the outcome per reference. */
export class FakeGateway implements PaymentGateway {
  initialized: InitializeInput[] = [];
  outcomes = new Map<string, Partial<VerifyResult>>();
  failInitialize?: PaystackError;
  failVerify?: PaystackError;

  async initialize(input: InitializeInput): Promise<InitializeResult> {
    if (this.failInitialize) throw this.failInitialize;
    this.initialized.push(input);
    return { authorization_url: `https://checkout.paystack.com/${input.reference}`, access_code: 'ac', reference: input.reference };
  }

  async verify(reference: string): Promise<VerifyResult> {
    if (this.failVerify) throw this.failVerify;
    const init = this.initialized.find((i) => i.reference === reference);
    const outcome = this.outcomes.get(reference) ?? { status: 'abandoned' };
    return {
      status: outcome.status ?? 'abandoned',
      reference,
      amountNaira: outcome.amountNaira ?? init?.amountNaira ?? 0,
      currency: outcome.currency ?? 'NGN',
      gateway_response: outcome.gateway_response,
    };
  }

  pay(reference: string, overrides: Partial<VerifyResult> = {}) {
    this.outcomes.set(reference, { status: 'success', gateway_response: 'Approved', ...overrides });
  }

  get lastReference(): string {
    return this.initialized[this.initialized.length - 1].reference;
  }
}
