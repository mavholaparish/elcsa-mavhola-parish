const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const server = fs.readFileSync(path.join(__dirname, "..", "server.neon.js"), "utf8");
const database = fs.readFileSync(path.join(__dirname, "..", "database.js"), "utf8");
const storage = fs.readFileSync(path.join(__dirname, "..", "storage.js"), "utf8");

test("migration server uses PostgreSQL and not SQLite", () => {
  assert.match(server, /require\("\.\/database"\)/);
  assert.doesNotMatch(server, /better-sqlite3|connect-sqlite3|db\.prepare\(/);
  assert.match(server, /connect-pg-simple/);
});

test("all existing public and admin API routes are retained", () => {
  for (const route of [
    "/api/public", "/api/applications", "/api/admin/login", "/api/admin/logout",
    "/api/admin/me", "/api/admin/dashboard", "/api/admin/applications/export.csv",
    "/api/admin/applications/:id/proof", "/api/admin/applications/:id/decision",
    "/api/admin/announcements", "/api/admin/events", "/api/admin/media",
    "/api/admin/documents", "/documents/:id/download", "/api/admin/orders/:id",
    "/api/admin/settings", "/api/tickets/checkout", "/ticket/verify/:token"
  ]) assert.ok(server.includes(route), "missing route " + route);
});

test("private proof files are served only through an admin-protected route", () => {
  const route = server.slice(server.indexOf('app.get("/api/admin/applications/:id/proof"'));
  assert.match(route, /requireAdmin/);
  assert.match(server, /area:"payment-proofs"/);
  assert.match(server, /key\.startsWith\("payment-proofs\/"\)/);
  assert.match(storage, /payment-proofs/);
  assert.doesNotMatch(storage, /public-read|publicRead|ACL:/i);
});

test("Neon and R2 fail closed when configuration is missing", () => {
  assert.match(database, /DATABASE_URL is required/);
  assert.match(storage, /R2_ACCESS_KEY_ID/);
  assert.match(storage, /R2_SECRET_ACCESS_KEY/);
  assert.match(server, /SESSION_SECRET/);
});
