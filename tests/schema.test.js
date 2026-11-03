const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const schema = fs.readFileSync(path.join(__dirname, "..", "database", "schema.sql"), "utf8");
for (const table of ["admins", "applications", "announcements", "events", "orders", "tickets", "media", "documents", "site_settings"]) {
  assert.match(schema, new RegExp("CREATE TABLE IF NOT EXISTS " + table + "\\b"), table + " table is defined");
}
assert.match(schema, /proof_filename TEXT/);
assert.match(schema, /tickets_emailed_at TIMESTAMPTZ/);
assert.match(schema, /REFERENCES events/);
console.log("PostgreSQL schema smoke checks passed.");
