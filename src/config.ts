export interface Config {
  port: number;
  publicBaseUrl: string;
  mcpAuthToken: string;
  kitchenPassword: string;
  paystackSecretKey: string;
  paystackBaseUrl: string;
  paymentExpiryMinutes: number;
  chord: {
    apiKey?: string;
    baseUrl: string;
    workspaceId?: string;
  };
}

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const paystackSecretKey = required('PAYSTACK_SECRET_KEY', env);
  // The brief forbids live keys; refuse to start rather than take real money by accident.
  if (!paystackSecretKey.startsWith('sk_test_') && env.ALLOW_LIVE_PAYSTACK !== 'true') {
    throw new Error('PAYSTACK_SECRET_KEY must be a Paystack test key (sk_test_...)');
  }
  const port = Number(env.PORT ?? 8080);
  return {
    port,
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    mcpAuthToken: required('MCP_AUTH_TOKEN', env),
    kitchenPassword: required('KITCHEN_PASSWORD', env),
    paystackSecretKey,
    paystackBaseUrl: env.PAYSTACK_BASE_URL ?? 'https://api.paystack.co',
    paymentExpiryMinutes: Number(env.PAYMENT_EXPIRY_MINUTES ?? 30),
    chord: {
      apiKey: env.CHORD_API_KEY?.trim() || undefined,
      baseUrl: (env.CHORD_BASE_URL ?? 'https://api.chordhq.xyz').replace(/\/$/, ''),
      workspaceId: env.CHORD_WORKSPACE_ID?.trim() || undefined,
    },
  };
}
