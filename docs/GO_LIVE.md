# Go-live note: Monaliza Pizza WhatsApp ordering

*For the owner of Monaliza Pizza.*

**What it does.** Customers message your WhatsApp number from anywhere in the park. The assistant shows today's menu and prices, takes their order, and sends a Paystack link to pay by card, transfer or USSD. Once Paystack confirms the payment, the order appears on your **kitchen board**, a web page you open on your phone or tablet (`https://<your-server>/kitchen`, protected by a password we give you; see the [screenshot](kitchen-board.png)). You tap **Start preparing**, then **Ready**, then **Collected** when they pick it up with their order code (e.g. MP-4821). When customers ask "is it ready?", the assistant answers from your board, so you don't have to. From the board you can also mark an item **sold out**, or **pause WhatsApp orders** when you're overwhelmed.

**What it doesn't do.** No delivery inside the park, no cash for WhatsApp orders, and no refunds, discounts or complaint handling. The assistant sends those customers to you at the kiosk. It can't cancel a paid order. It doesn't know about allergens beyond "everything may contain gluten, dairy and nuts".

**What must be true before real customers use it:**

1. **Real Paystack account.** Complete Paystack business verification, then switch the server from the test key to your live key. You also need to set the webhook URL in Paystack. Refunds are done by you in the Paystack dashboard. Decide who pays Paystack's fee (about 1.5% + ₦100). Today the customer pays it, and the assistant warns them up front (for example, ₦16,100 becomes ≈₦16,446.70 at checkout).
2. **Your WhatsApp number on Chord.** Connect a WhatsApp Business number to the Chord teammate. The test setup only works in the simulator.
3. **Orders survive restarts.** Today orders live in the server's memory. If the server restarts (an update or a crash), open orders disappear from the board, though payments stay in Paystack. Before launch, move orders into a small database.
4. **Someone gets alerted.** Set up an alert (SMS or WhatsApp to you) when the server is down, when Paystack errors repeat, or when an order goes to **"needs review"**. That status means a customer paid the wrong amount or paid after cancelling, and you need to sort it out with them.
5. **Your real menu and prices.** The current menu and prices are made up. Give us yours, and keep the sold-out switch up to date on busy days.
6. **Kiosk setup.** Keep a charged phone or tablet with the kitchen board open, and keep the board password private. Put a "Order on WhatsApp: 0xxx" sign and QR code at the food court, and a "Ready orders" sign at the collection window.

**When a payment fails:** the customer isn't charged, and the assistant offers a new link. When Paystack itself is down, the assistant apologises and asks them to try again in a minute or order at the kiosk. No order reaches your board until it's paid.
