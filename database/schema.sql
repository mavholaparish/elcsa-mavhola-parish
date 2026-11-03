-- PostgreSQL schema for the Neon-backed ELCSA Mavhola Parish CMS.
-- Apply once to a NEW database. Existing SQLite data is not imported by this script.
-- Keep this schema aligned with the application queries before switching production.

CREATE TABLE IF NOT EXISTS admins (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
  id BIGSERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  date_of_birth TEXT,
  occupation TEXT,
  congregation TEXT,
  address TEXT,
  motivation TEXT,
  proof_filename TEXT,
  proof_original_name TEXT,
  proof_mime TEXT,
  status TEXT NOT NULL DEFAULT 'Pending',
  admin_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS applications_created_at_idx ON applications (created_at DESC);
CREATE INDEX IF NOT EXISTS applications_email_idx ON applications (LOWER(email));

CREATE TABLE IF NOT EXISTS announcements (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS announcements_created_at_idx ON announcements (created_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  event_date TEXT,
  venue TEXT,
  ticket_price_cents INTEGER NOT NULL DEFAULT 0,
  ticket_capacity INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS events_event_date_idx ON events (event_date);

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL REFERENCES events(id),
  buyer_name TEXT NOT NULL,
  buyer_email TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  status TEXT NOT NULL DEFAULT 'Pending',
  stripe_session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tickets_emailed_at TIMESTAMPTZ,
  tickets_email_claimed_at TIMESTAMPTZ
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tickets_email_claimed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS orders_event_status_idx ON orders (event_id, status);

CREATE TABLE IF NOT EXISTS tickets (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  redeemed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tickets_order_id_idx ON tickets (order_id);

CREATE TABLE IF NOT EXISTS media (
  id BIGSERIAL PRIMARY KEY,
  title TEXT,
  description TEXT,
  filename TEXT NOT NULL,
  media_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS media_created_at_idx ON media (created_at DESC);

CREATE TABLE IF NOT EXISTS documents (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  media_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS documents_created_at_idx ON documents (created_at DESC);

CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

INSERT INTO site_settings (key, value) VALUES
  ('parish_email', 'mavholaparish.yl@gmail.com'),
  ('parish_phone', '0679378130'),
  ('parish_address', 'PO Box 222, Makonde, 0984'),
  ('tagline', 'Growing Together in Christ'),
  ('eft_account_name', ''),
  ('eft_bank_name', ''),
  ('eft_account_number', ''),
  ('eft_branch_code', ''),
  ('eft_reference_instructions', 'Use your ticket order reference as the EFT payment reference.')
ON CONFLICT (key) DO NOTHING;
