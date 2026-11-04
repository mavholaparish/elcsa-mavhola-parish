# ELCSA Mavhola Parish Shop setup

## What is included

- Public Shop catalogue with product photos, categories, descriptions, prices, size/colour options and quantities.
- Shopping cart and mobile-responsive checkout.
- EFT checkout requiring proof of payment upload.
- Secure hosted PayFast checkout for card payments.
- Automatic PayFast Instant Transaction Notification (ITN) verification before card orders are marked Paid.
- Admin Shop tab to add, edit and remove products, view orders and EFT proof, confirm EFT payments, or cancel orders.
- Stock is reserved when an order is placed and restored if an administrator cancels the order.
- Product images and EFT proofs are stored in the existing private Cloudflare R2 bucket.

## EFT setup

The Shop reuses the existing EFT bank details in Admin > Website settings. Complete the account name, bank name, account number and branch code with parish-approved details. Customers must upload proof of payment when choosing EFT. An administrator verifies the proof and confirms the order in Admin > Shop.

## PayFast card-payment setup

Card checkout remains disabled until the parish has a verified PayFast merchant account and adds these environment variables to the Render service `elcsa-mavhola-preview`:

- `PAYFAST_MERCHANT_ID` — PayFast merchant ID.
- `PAYFAST_MERCHANT_KEY` — PayFast merchant key.
- `PAYFAST_PASSPHRASE` — optional custom payment passphrase configured in PayFast.
- `PAYFAST_SANDBOX=true` — use the PayFast sandbox while testing. Set to `false` only when switching to the live merchant credentials.
- `PUBLIC_BASE_URL=https://mavholaparish.co.za` — public HTTPS website URL used for return and notification URLs.

PayFast ITN notification URL:

`https://mavholaparish.co.za/api/shop/payfast/notify`

The notification endpoint validates the signature, PayFast source IP, merchant ID, order amount and PayFast server confirmation before marking a card order Paid. Never put merchant credentials in frontend code or in the public repository.

## Before accepting live payments

1. Register and verify the parish merchant account with PayFast.
2. Add sandbox credentials in Render and keep `PAYFAST_SANDBOX=true`.
3. Test the hosted checkout and confirm that a sandbox ITN changes the order status to Paid and sends the confirmation email.
4. Replace sandbox credentials with live merchant credentials and set `PAYFAST_SANDBOX=false`.
5. Make a small real payment only after the parish has approved the launch.

PayFast's live custom integration currently requires a minimum transaction of R5.00. Payment-provider approval, verification and transaction fees are controlled by PayFast and are separate from this website code.
