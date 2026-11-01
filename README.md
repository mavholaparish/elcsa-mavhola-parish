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
For Render Free, use the Resend HTTPS API: set `RESEND_API_KEY` and `MAIL_FROM` in Render Environment, and verify the sender domain in your Resend account. You can alternatively configure SMTP using `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM` on a host that permits SMTP. If email is not configured, applications and ticket orders are still saved, but emails are not delivered. Test email delivery before launch.

## Ticket sales by EFT
Ticket orders are recorded as Pending and the buyer receives an email with the order reference, event details, amount due and parish EFT instructions. The parish verifies the bank payment in the admin dashboard and changes the order to Paid; this triggers a paid ticket confirmation email. Enter the correct parish banking information under Admin → Website settings before selling tickets. Never mark an order Paid until the payment is verified.

## CMS administrator dashboard
- **Memberships:** search applicants by name or email, review occupation and other details, open payment proof, approve or reject, and add a message for the applicant. Applicants receive an email when their application is approved or rejected when email delivery is configured.
- **Announcements:** publish, pin, edit and delete notices.
- **Events:** create, edit and delete events, dates, venues, descriptions, prices and capacity.
- **Media:** upload images/videos, edit titles/descriptions and delete gallery items.
- **Ticket orders:** view ticket orders and payment status. Buyers receive an order email with EFT instructions and a unique reference; after the parish marks an order Paid, the system emails a paid ticket confirmation to the buyer.
- **EFT settings:** enter the parish-approved account holder, bank, account number, branch code and payment reference instructions in Admin → Website settings. These details are included in ticket order emails.
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


## Version 1.5 updates
- Membership form includes required occupation dropdown: Student, Employed or Unemployed.
- Admin Memberships tab includes live search by applicant name or email and displays occupation in application details. Existing database records are migrated automatically.
- Ticket orders use EFT rather than Stripe Checkout. Order emails include the event, quantity, total and order reference.
- Admin can configure EFT banking details under Website settings. When an order is marked Paid, the system emails the buyer a paid ticket confirmation.
- Email sending supports Resend over HTTPS (recommended for Render Free) as well as SMTP fallback. A verified sender identity and configured email service are required for delivery.
