# ELCSA Mavhola Parish website CMS

A responsive parish website and content-management system for ELCSA Mavhola Parish. Includes parish announcements, events and ticket information, a photo/video gallery, Youth League membership applications with required proof-of-payment upload, and a private administrator dashboard.

## What is included
- Corrected logo layout: one ELCSA Church logo in the header, with no duplicate large hero logo; one Youth League logo in its own section, without an overlapping circular backing.
- Membership form requiring a PDF, JPG, PNG or WEBP proof of payment (maximum 10 MB).
- Private proof-of-payment files are stored outside the public web folder and can only be viewed by a signed-in administrator.
- Admin dashboard to view submitted applications and payment proofs, approve/reject applications, and send a decision email when email delivery is configured.
- Admin tools to create, edit and delete announcements and events; upload, edit captions and delete gallery media; view ticket orders; and update parish contact details/tagline.
- Existing SQLite databases are upgraded automatically with the new proof-of-payment fields.
- Render reverse-proxy trust and session-save handling are configured so secure administrator sessions can work behind Render HTTPS.

## Run locally
1. Install Node.js 20 or newer.
2. Extract this project and open a terminal in the project folder.
3. Run `npm install`.
4. Copy `.env.example` to `.env`.
5. Set a unique, strong `SESSION_SECRET`, `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env`.
6. Run `npm start`.
7. Open `http://localhost:3000`.
8. Select **Admin** on the website and sign in with the configured administrator credentials.

Do not share your `.env` file or administrator password. Do not commit `.env` or database/upload folders to GitHub.

## Membership proof uploads
Applicants must attach a PDF or image proof of payment (JPG, PNG or WEBP, maximum 10 MB). The proof is not served from the public `/uploads` folder. An authenticated administrator can open it from the Memberships tab. Applicant details and proof metadata are stored with the application record.

## Configure email notifications
Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM` in `.env`. If SMTP is not configured, applications are still saved, but applicant receipt and decision emails are not sent. Render free web services block common SMTP ports; use an email provider's HTTPS API integration or a hosting plan/network that supports your chosen provider before relying on email notifications.

## Optional online ticket payments
Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `BASE_URL`. Configure a Stripe webhook at `https://YOUR-DOMAIN/api/stripe/webhook` subscribed to `checkout.session.completed`. Test with Stripe test credentials before enabling live payments. Never collect or store card numbers on this website.

## CMS administrator dashboard
- **Memberships:** review all submitted applications, inspect contact and congregation details, open payment proof, approve or reject, and add a message for the applicant.
- **Announcements:** publish, pin, edit and delete notices.
- **Events:** create, edit and delete events, dates, venues, descriptions, prices and capacity.
- **Media:** upload images/videos, edit titles/descriptions and delete gallery items.
- **Ticket orders:** view ticket orders and payment status.
- **Website settings:** update parish email, phone, address and tagline.

## Important hosting and privacy warning
This starter version stores its SQLite database, gallery uploads and private payment proofs on the server's local filesystem. Render's free web service uses an ephemeral filesystem and does not provide a persistent disk. **Do not use this version on Render Free to collect real membership applications, proof-of-payment documents, ticket orders or other important parish records.** Data and uploaded files can disappear when the service restarts, redeploys or spins down.

Before public production use, migrate the database to a durable managed PostgreSQL service and move public media and private payment proofs to durable object storage. Private payment proofs must remain in a private bucket and be served only to authenticated administrators (or via short-lived signed URLs). Configure email through an HTTPS email API, add backups, publish a privacy notice and have the system security-reviewed. Free database/storage tiers have quotas and may expire; confirm their retention rules before relying on them.

## Before launch checklist
- Confirm the parish-approved membership fee and payment instructions are displayed to applicants.
- Add and verify parish contact details in Admin → Website settings.
- Publish a privacy notice explaining how personal details and proof-of-payment documents are used, who can access them, and how long they are retained.
- Restrict admin access to authorised parish officers; use unique credentials and rotate any password/secret that was ever shared or exposed.
- Test application submission, proof viewing, approval/rejection, email delivery, content editing, media uploads and ticket payment webhooks.
- This starter system has not undergone an independent security audit. Do not use it for real member data or payments until the persistent-storage and security work is complete.


## Version 1.4 updates
- Church logo used as a subtle background watermark in the homepage hero.
- Parish contact details prefilled: mavholaparish.yl@gmail.com, 0679378130, PO Box 222, Makonde, 0984.
- Ticket orders can be reviewed and their status updated in the admin dashboard.
- Contact details remain editable under Admin → Website settings.

## Local preview
Copy `.env.example` to `.env`, set a strong `ADMIN_PASSWORD` and `SESSION_SECRET`, then run `npm install` and `npm start`. Open http://localhost:3000.
