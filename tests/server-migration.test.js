const assert = require("node:assert/strict");
const { test } = require("node:test");
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

test("event deletion preserves linked ticket-order history", () => {
  const start = server.indexOf('app.delete("/api/admin/events/:id"');
  const end = server.indexOf('app.post("/api/admin/media"', start);
  const route = server.slice(start, end);
  assert.match(route, /error\.code===\"23503\"/);
  assert.match(route, /res\.status\(409\)/);
  assert.match(route, /cannot be deleted/i);
});

test("ticket checkout locks the event row before checking capacity", () => {
  const start = server.indexOf('app.post("/api/tickets/checkout"');
  const end = server.indexOf('app.get("/ticket/verify/', start);
  const route = server.slice(start, end);
  assert.ok(route.indexOf("FOR UPDATE") < route.indexOf("SUM(quantity)"));
  assert.match(route, /status IN \('Paid','Pending'\)/);
});

test("private proof objects are not exposed by the public upload route", () => {
  const start = server.indexOf('app.get("/uploads/*"');
  const end = server.indexOf('app.use("/api",rateLimit', start);
  const route = server.slice(start, end);
  assert.match(route, /payment-proofs\//);
  assert.match(route, /sendStatus\(404\)/);
});


test("admin write requests require a matching same-origin Origin or Referer", () => {
  assert.match(server, /app\.use\("\/api\/admin",\(req,res,next\)=>/);
  assert.match(server, /Cross-site request blocked/);
  assert.match(server, /Request origin could not be verified/);
});

test("membership CSV export neutralizes spreadsheet formula-leading values", () => {
  assert.match(server, /value=String\(v\?\?""\)/);
  assert.match(server, /\[=\+\\-@\]/);
});

test("public ticket booking buttons do not embed event titles in inline JavaScript", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.match(app, /data-buy-event/);
  assert.doesNotMatch(app, /onclick="buyTicket/);
});

test("ticket payment status changes are locked, atomic, and one-way", () => {
  const start = server.indexOf('app.put("/api/admin/orders/:id"');
  const end = server.indexOf('app.put("/api/admin/settings"', start);
  const route = server.slice(start, end);
  assert.match(route, /FOR UPDATE OF orders/);
  assert.match(route, /order\.status!==status/);
  assert.match(route, /order\.status!=="Pending"/);
  assert.match(route, /res\.status\(409\)/);
  assert.match(route, /INSERT INTO tickets/);
  assert.match(route, /db\.transaction\(async client=>/);
});

test("Stripe webhook does not mark orders Paid without ticket fulfillment", () => {
  const start = server.indexOf('app.post("/api/stripe/webhook"');
  const end = server.indexOf('app.use(express.json', start);
  const route = server.slice(start, end);
  assert.match(route, /manual-review-required/);
  assert.doesNotMatch(route, /UPDATE orders SET status='Paid'/);
});
