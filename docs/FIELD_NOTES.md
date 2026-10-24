# Deployment field notes

Real problems hit while building, deploying and testing. Each note covers what happened, how I found the cause, the fix, and what I'd change. The Chord notes come first, because they're the ones the Chord team can act on.

---

## 1. Uploading the skill *folder* as a ZIP silently breaks every reference path

**What happened.** The docs show a skill as a folder (`builder-support/SKILL.md`, `builder-support/references/faq.md`), so I zipped the folder `monaliza-pizza-ordering/` and uploaded it. The review screen listed the files as `monaliza-pizza-ordering/SKILL.md` and `monaliza-pizza-ordering/references/policies.md`. My `SKILL.md` says "Read `references/policies.md`", and the docs say "The path in the instructions must match the uploaded file". With the folder prefix, they don't match, and **nothing warns you**. The upload succeeds and the agent would simply fail to find its references at runtime.

**How I found it.** I read the "Review your source material" dialog line by line before creating the teammate, and compared the stored paths with the paths written in `SKILL.md`.

**Fix.** I re-zipped with `SKILL.md` and `references/` at the ZIP root (`cd skill && zip -r ../skill.zip SKILL.md references`). Side effect: the skill was then named "Untitled skill", because the name seems to come from the folder. I renamed it through the Skills API when publishing v2.

**What I'd change in Chord.**
- Strip a single common top-level folder from uploaded ZIPs (most tools that zip a folder add one), or keep the prefix but resolve paths relative to `SKILL.md`.
- At review time, lint the instructions: find backticked paths in `SKILL.md` that don't exist in the package and show "`references/policies.md` is mentioned but not uploaded".

---

## 2. Tools: the API docs say MCP only, the app has more, and there's no way to test a tool call

**What happened.** The brief asks for "a custom tool". The API docs only describe remote MCP servers ("Your server must support Streamable HTTP at a public HTTPS URL"), so I built an MCP server. Then the app's **Admin → Channels & Tools → Tools** page showed three options: **Catalogues** (menu/price lists), **Custom tools (MCP)** and **Custom tools (API)** with *Import OpenAPI*. The last two aren't in the API docs at all. A Catalogue would have fit a pizza menu perfectly.

**How I found it.** Teammate settings → *Add tool* links to `/admin/channels?tab=tools`, which lists all three.

**What worked well.** Registering the MCP server in the app took a minute. Discovery found all 6 tools, and the health probe returned `{"status":"ok","latency_ms":226}`. I ran both through the app's own API proxy (`/api/proxy/v1/workspaces/{ws}/mcp-servers/{id}/tools` and `/health`), so this check cost no credits.

**What I'd change in Chord.**
- Document Catalogues and REST/OpenAPI tools next to MCP, with a short "which one should I use?" table. Build-a-teammate step 5 should link to it.
- Add a **"Test tool call"** button or endpoint with sample arguments. Today the health probe only performs discovery. The only way to prove a tool *executes* is a real chat turn, which costs credits and depends on the model choosing the tool. With 50 credits for the whole exercise, that matters.

---

## 3. The default autonomy, "Suggest, I approve", is wrong for a customer-facing ordering agent

**What happened.** The create-teammate form defaults Autonomy to **"Suggest, I approve"**. For a WhatsApp ordering agent, a human approving each `create_order` would stall every customer at the payment step. That's exactly the bottleneck the agent exists to remove.

**Fix.** I set **"Act independently"** at creation. The server then enforces the rules that matter: it prices orders itself, confirms payment only through Paystack, and lets only the kitchen board move an order to preparing or ready.

**What I'd change in Chord.** Explain on the form what each autonomy level does to *tool calls*, or ask "Will this teammate talk to customers?" and suggest a level. One sentence like "Suggest, I approve: tool actions wait for your approval in Activity" would prevent a confusing first test.

---

## 4. The tool can't see who the customer is, and a proactive "ready" message needs a fake takeover

**What happened.** The tools need the customer's WhatsApp number, to find their orders and push "your pizza is ready". Nothing in the MCP docs passes conversation context (channel, participant, thread) to the tool. The simulator collects only a name ("no phone number is needed"). Separately, `POST /v1/threads/{id}/messages` only works on a `human_active` thread and otherwise returns `409 INVALID_STATE`.

**Workaround.** The order code (MP-1234) is the primary key, and the phone number is an optional tool argument. The optional notifier (`src/notifier.ts`) does `take-over → message → hand-back`, which logs a fake "human takeover". Pull-based "status?" is the default, and in testing the agent answered it correctly.

**What I'd change in Chord.**
- Forward context to MCP tools (`_meta` or signed `X-Chord-Thread-Id` / `X-Chord-Participant` headers), so tools can identify the customer without trusting model-supplied arguments.
- Add a **system "notify" message** that posts into a thread without changing control state. Payment, delivery and booking businesses all need it.

---

## 5. Live test: the agent quoted ₦6,500, and Paystack charged ₦6,700.51

**What happened.** The first real end-to-end order (through Chord, then the Paystack test checkout) showed **"Pay NGN 6,700.51"** for a ₦6,500 order. The server accepted the payment correctly (it only flags *under*payment), but the customer had been quoted a different amount than they were charged.

**How I found the cause.** (6,500 + 100) / (1 − 0.015) = 6,700.51 exactly, which is Paystack's local fee (1.5% + ₦100) grossed up. The Paystack account is set to pass fees to the customer.

**Fix.** A new `PAYSTACK_FEES_PASSED_TO_CUSTOMER` setting makes the tools return `amount_to_pay_at_checkout`, and the skill tells the customer both numbers up front. I re-tested in the simulator: "Total: ₦16,100. Paystack adds a small processing fee, so the checkout page will show about ₦16,446.70." The go-live note tells the owner to choose either absorbing the fee or passing it on.

---

## 6. Infrastructure: an Azure region refusal and two transient network failures

- **`RequestDisallowedByAzure: The selected region is currently not accepting new customers`** in `westeurope` (Sponsorship subscription) while creating the container registry. I moved everything to `southafricanorth`, which is also closer to Nigeria. The deploy script takes `AZURE_LOCATION`.
- **`az containerapp env create` crashed with `JSONDecodeError`.** Further up the traceback was the real cause: an ARM **503** HTML page, returned while the CLI polled a long-running operation. The environment was still provisioning (`provisioningState: Waiting` → `Succeeded`). I made the deploy script idempotent (`show || create`) and re-ran it.
- **Local DNS flapped** (`nodename nor servname provided`) during two deploys. The extension check is now non-fatal, and the deploy is wrapped in a retry. A Container Apps secret change alone doesn't restart the app, so the script also bumps a `DEPLOYED_AT` env var to force a new revision.
