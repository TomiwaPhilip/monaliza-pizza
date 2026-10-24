import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { ChordNotifier } from './notifier.js';
import { OrderService } from './orders.js';
import { PaystackClient } from './paystack.js';
import { Store } from './store.js';

const config = loadConfig();
const gateway = new PaystackClient(config.paystackSecretKey, config.paystackBaseUrl);
const notifier =
  config.chord.apiKey && config.chord.workspaceId
    ? new ChordNotifier(config.chord.baseUrl, config.chord.apiKey, config.chord.workspaceId)
    : undefined;

const orders = new OrderService(new Store(), gateway, {
  publicBaseUrl: config.publicBaseUrl,
  paymentExpiryMinutes: config.paymentExpiryMinutes,
  feesPassedToCustomer: config.paystackFeesPassedToCustomer,
  notifier,
});

const app = createApp({
  orders,
  gateway,
  mcpAuthToken: config.mcpAuthToken,
  kitchenPassword: config.kitchenPassword,
  paystackSecretKey: config.paystackSecretKey,
});

setInterval(() => {
  orders.sweepExpired().catch((err) => console.error('[sweep] failed', err));
}, 60_000).unref();

app.listen(config.port, () => {
  console.log(`Monaliza Pizza tools listening on :${config.port} (public ${config.publicBaseUrl})`);
  console.log(`Ready notifications via Chord: ${notifier ? 'enabled' : 'disabled (set CHORD_API_KEY and CHORD_WORKSPACE_ID)'}`);
});
