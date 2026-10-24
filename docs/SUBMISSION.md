# Submission: Monaliza Pizza WhatsApp ordering teammate

**Role preference:** Forward-deployed Engineering (also interested in Technical Product Management). *Edit before sending.*

**Problem statement.** Monaliza Pizza is a one-person pizza kiosk in Monaliza Park, Abuja. On weekends, families queue for a long time, then walk back and forth across the park to check whether their pizza is ready. The owner loses sales to people who give up on the queue, and loses baking time to taking orders and payments. The Chord teammate takes the whole order on WhatsApp: it shows the menu, collects payment through a Paystack link, confirms payment, and answers "is it ready?" from a live kitchen board. The owner only bakes, and each customer walks to the kiosk once. This is worth paying for because it adds order capacity at peak hours without a second hire, and every WhatsApp order is prepaid, so there are no abandoned orders. I deliberately left out delivery inside the park, cash for WhatsApp orders, refunds and complaints (these go to the owner), loyalty and promos, and a persistent database (in-memory for the prototype).

**Links**
- Agent: live on my Chord account (teammate "Monaliza Pizza"), testable in the WhatsApp simulator
- Code: https://github.com/TomiwaPhilip/monaliza-pizza
- Tool server: https://monaliza-pizza-tools.redbush-948401c2.southafricanorth.azurecontainerapps.io (MCP at `/mcp`)
- Recording: *add link*
- Field notes: [docs/FIELD_NOTES.md](FIELD_NOTES.md)
- Go-live note: [docs/GO_LIVE.md](GO_LIVE.md)

**A measurable outcome to track:** the share of weekend orders placed on WhatsApp, and the median time from payment to pickup. Comparing peak-hour orders per hour before and after launch shows the capacity gain.
