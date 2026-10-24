# Deployment field notes

Short notes on real problems hit while building and deploying. Each covers what happened, how I found the cause, the fix, and what I'd change.

---

## 1. A "custom tool" on Chord means a remote MCP server, and that shaped the architecture

**What happened.** The brief asks for "a custom tool that calls an external system". The Build-a-teammate guide says only "Teammate settings → Tools … Add tool opens workspace tool settings". It doesn't say what a tool *is*. I had planned a plain REST API.

**How I found the cause.** The docs index lists "Remote tools through MCP", and the [MCP connections](https://api.chordhq.xyz/docs/mcp-servers/) page says Chord is the MCP client, and the server "must support Streamable HTTP at a public HTTPS URL". It must not use private or loopback addresses, and auth is `none`/`bearer`/`api_key`/`oauth`. There is no REST or OpenAPI tool type.

**Fix.** I built the tool as an MCP server using the official TypeScript SDK in **stateless** Streamable HTTP mode (a fresh server per POST, JSON responses), with bearer auth. Stateless MCP plus an in-memory database means exactly one replica, so the Azure app is pinned to `min = max = 1`. I also wrote `scripts/smoke-test.mjs`, which calls the deployed server with a real MCP client, because Chord's own `/health` probe only performs tool discovery and never calls a tool.

**What I'd change in Chord.**
- Put one sentence in Build-a-teammate step 5: "Tools are remote MCP servers. See MCP connections." Link a 30-line minimal server example (Node and Python).
- Add a **"Test tool call"** button or endpoint (`POST …/mcp-servers/{id}/tools/{name}/call` with sample args). Today the only way to prove a tool *executes* is a full chat turn that spends credits and depends on the model choosing the tool.

---

## 2. Azure refused the region: `RequestDisallowedByAzure`

**What happened.** The first deploy to `westeurope` failed while creating the container registry:

```
ERROR: (RequestDisallowedByAzure) Resource 'monalizapizza91fe94' was disallowed by Azure:
The selected region is currently not accepting new customers: https://aka.ms/locationineligible.
```

**How I found the cause.** The resource group had been created fine; only the registry failed. The message points at subscription-type capacity restrictions (this is a Sponsorship subscription), not at a naming or quota problem.

**Fix.** I deleted the resource group and redeployed to `southafricanorth`, which is also closer to Nigeria. The deploy script now takes `AZURE_LOCATION` and defaults to `southafricanorth`.

**Lesson for any builder guide.** Name a fallback region in the deploy docs, and make scripts take region as a parameter from day one.

---

## 3. Azure CLI crashed with a misleading `JSONDecodeError` during a transient outage

**What happened.** `az containerapp env create` died after a few minutes with a long Python traceback ending in:

```
json.decoder.JSONDecodeError: Expecting property name enclosed in double quotes: line 1 column 2 (char 1)
```

**How I found the cause.** Further up the traceback, the real error was `HTTPError: Service Unavailable` with an HTML body ("Our services aren't available right now"). Azure Resource Manager returned a transient 503 while the CLI was *polling* the long-running operation, and the CLI tried to parse the HTML as JSON. The operation itself was still running: `az containerapp env show` reported `provisioningState: Waiting`, and it reached `Succeeded` a few minutes later.

**Fix.** I polled the provisioning state instead of retrying the create, and made the deploy script idempotent (`show || create`), so a re-run picks up where it failed.

**What I'd carry over to Chord.** Chord's MCP `/health` already returns HTTP 200 with `status: "error"`. That's the right idea, but it's easy to miss. Always return a JSON error envelope (even from gateways and proxies), and say clearly in the response when an operation is *still in progress* versus *failed*.

---

## 4. No Paystack test key during the build: deploy anyway and prove the error path

**What happened.** The Paystack test secret key wasn't available while I was deploying.

**How I worked around it.** The server refuses to start without an `sk_test_` key, by design: the brief forbids live keys, so the config guards against them. I deployed with a placeholder `sk_test_…` value. That let me verify the real failure path against the live Paystack API: `create_order` called `POST /transaction/initialize`, Paystack answered 401, the server mapped it to `payment_provider_error` (provider kind `auth`), and **no order was persisted**. The deploy script lets shell variables override `.env`, and it bumps an env var on each run, because changing only a Container Apps *secret* doesn't restart the app.

---

## 5. Who is the customer? The tool can't see the WhatsApp sender

**What happened.** The tools need the customer's WhatsApp number, to find their orders and to push a "ready" message. The MCP connection docs describe only the server-level credential Chord sends (bearer or API key). Nothing documents per-conversation context such as channel, participant or thread id reaching the tool.

**Workaround.** `customer_phone` is an optional tool argument, and the skill tells the agent to use the WhatsApp number if the conversation exposes it, otherwise to ask once. The order code (MP-1234) is the primary key, so the flow works without a phone number.

**What I'd change in Chord.** Forward the conversation context to MCP tools, either as `_meta` on `tools/call` or as signed headers (`X-Chord-Thread-Id`, `X-Chord-Channel`, `X-Chord-Participant`). Tools could then identify the customer without trusting model-supplied arguments, and could reply into the right thread later.

---

## 6. Proactive "your pizza is ready" needs a fake human takeover

**What happened.** The best moment in this product is pinging the customer when the pizza is ready. Chord's thread API has `POST /v1/threads/{id}/messages`, but it only works when the thread is `human_active`. Otherwise it returns `409 INVALID_STATE`.

**Workaround.** `src/notifier.ts` finds the thread by participant phone, then does `take-over → message → hand-back`, which is three calls. The audit log will show a "human takeover" for what is really a system notification. The feature is opt-in (`CHORD_API_KEY`), and the pull-based "status?" flow remains the default.

**What I'd change in Chord.** Add a first-class **"notify"** or **"system message"** endpoint that posts into a thread without changing control state, ideally callable with the thread id passed to the tool (see note 5). Webhook-driven businesses (payments, deliveries, bookings) all need this.
