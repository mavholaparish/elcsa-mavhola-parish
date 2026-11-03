# Neon + Cloudflare R2 migration (staged)

This branch is the isolated migration workspace. The live Render service must continue to deploy from `main` until the replacement passes the launch checks.

## Database foundation

- `database/schema.sql` defines the PostgreSQL tables used by the current CMS.
- Apply it to the new, empty Neon database only after reviewing the final application migration.
- The schema intentionally does not import SQLite records. The parish chose to start with a fresh database because the old live data was no longer available.
- Never commit a Neon connection string, database password, Cloudflare access key, secret key, Resend key, or session secret.

## Required Render environment variables for the completed migration

Database:
- `DATABASE_URL` — Neon pooled PostgreSQL connection string (keep private).
- `PGSSLMODE` — set to `require` if the application configuration does not enforce TLS itself.

Sessions and administrator:
- `SESSION_SECRET` — long, random secret.
- `ADMIN_EMAIL` — authorised administrator email.
- `ADMIN_PASSWORD` — strong initial administrator password; do not reuse an exposed password.

Cloudflare R2:
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME` — `mavhola-parish-files`
- `R2_ENDPOINT` — the account's S3-compatible endpoint.
- `R2_PUBLIC_BASE_URL` — only if a public custom domain is deliberately configured for public gallery assets. Private proof files must never use this URL.

Existing email configuration:
- `RESEND_API_KEY`
- `MAIL_FROM`

## Storage rules

- Gallery images/videos and downloadable parish documents may be served publicly only when intended for public access.
- Membership payment proofs are private personal information. Store them in a private object namespace and return them only through an authenticated admin route or a short-lived signed URL.
- Use opaque generated object keys; retain the original filename only as display metadata.
- Validate file type, size and upload permissions on the server. Do not trust a browser-supplied MIME type alone.
- When a database row is deleted, remove its corresponding R2 object after the database change succeeds; log cleanup failures for later repair.

## Implementation and release gates

The current `server.js` still uses synchronous SQLite queries and local-disk Multer storage. It is NOT yet connected to Neon or R2. Do not deploy this branch to the live Render service.

Before release, complete and test:
1. Convert every database route and webhook to parameterised asynchronous PostgreSQL queries.
2. Use a PostgreSQL-backed session store; do not use SQLite sessions or in-memory production sessions.
3. Use a database transaction for multi-ticket creation and other multi-row state changes.
4. Replace local upload storage with R2; keep payment proofs private.
5. Update gallery, document-download and admin-proof routes to use object storage safely.
6. Ensure ticket QR verification and ticket email generation still work.
7. Add startup validation that fails clearly when required production secrets are missing.
8. Run automated tests for public content, admin login/session persistence, membership submission/proof viewing/decisions, media and document uploads/deletes/downloads, ticket order/payment/ticket PDF/QR verification, and email failure handling.
9. Verify backups and perform a restore test before launch.
10. Deploy to a separate preview service, verify it, then switch production only with an agreed rollback plan.

## Free-tier note

Neon and R2 have free usage allowances, not unlimited free service. Monitor storage, request and compute quotas. Keep an independent backup of database data and important uploaded files.


Dependency note: the legacy SQLite session-store dependency is retained for compatibility with the original server entry point; the Neon preview uses PostgreSQL sessions. Security checks report the current dependency audit without modifying the dependency tree automatically.
