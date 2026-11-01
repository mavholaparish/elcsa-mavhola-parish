# ELCSA Mavhola Parish website

A responsive parish website starter with public announcements, events, a media gallery, Youth League membership applications, an administrator dashboard, decision emails and optional Stripe ticket checkout.

## Requirements
- Node.js 20 or newer
- An SMTP mailbox/provider for application and decision emails
- A Stripe account (optional) for online card payments

## Run locally
1. Extract this project.
2. In this folder run `npm install`.
3. Copy `.env.example` to `.env`.
4. Set a strong `SESSION_SECRET`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`.
5. Run `npm start`.
6. Open `http://localhost:3000` on your computer.

To test from a phone on the same Wi-Fi, find your computer's local IPv4 address (Windows: run `ipconfig`) and open `http://YOUR-COMPUTER-IP:3000` on the phone. Both devices must be on the same network and the computer firewall must allow port 3000.

## Configure decision emails
Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and `MAIL_FROM` in `.env`. Use an email provider's SMTP credentials or app password. Do not put email passwords in frontend code. If SMTP is not configured, applications are still saved but notification emails are not sent.

## Configure online ticket payments
Ticket checkout is optional until Stripe is configured. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `BASE_URL` in `.env`. In Stripe, create a webhook endpoint at `https://YOUR-DOMAIN/api/stripe/webhook` subscribed to `checkout.session.completed`. Use the webhook signing secret as `STRIPE_WEBHOOK_SECRET`. Set the currency and payment methods in your Stripe account as appropriate for South Africa. Test using Stripe test keys before enabling live payments. Never collect or store card numbers on this website.

Events with a ticket price of R0 are displayed as free events. Events with a positive price display a Buy tickets button. The ticket order is marked Paid only after Stripe confirms payment through the webhook.

## Admin dashboard
Visit the site and choose **Admin**. Sign in using the `ADMIN_EMAIL` and `ADMIN_PASSWORD` set in `.env`. From the dashboard you can review applications, approve/reject applicants, publish/delete announcements, create/delete events, upload/delete photos/videos, and view ticket orders.

## Deploy and get a public URL
This source code is not automatically hosted by ChatGPT, so it does not yet have a public internet URL or registered domain. Deploy the Node.js project to a hosting provider that supports persistent storage (SQLite database and uploaded media must persist), configure the environment variables there, and connect a domain you own. For production, use HTTPS, regular database/file backups, strong unique admin credentials, and a persistent disk or managed database. If your hosting provider uses ephemeral filesystems, replace SQLite/local uploads with managed persistent services before launch.

## Important launch checklist
- Add parish-approved contact details and any safeguarding/privacy wording.
- Decide who is authorised to access the administrator account.
- Publish a privacy notice explaining how membership information is used and retained.
- Test application submission, SMTP delivery, approval/rejection emails, event creation, media uploads and ticket payment webhooks.
- This is a starter system, not yet independently security-audited. Arrange a technical review before collecting real member information or accepting real payments.
