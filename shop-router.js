const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");

module.exports = ({ db, storage, sendMail, requireAdmin }) => {
  const router = express.Router();
  const proofUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => cb(null, ["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) });
  const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype)) });
  const safeName = value => path.basename(String(value || "file")).replace(/["\r\n]/g, "_");
  const baseUrl = (process.env.PUBLIC_BASE_URL || "https://mavholaparish.co.za").replace(/\/$/, "");
  const isSandbox = String(process.env.PAYFAST_SANDBOX || "true").toLowerCase() !== "false";
  const pfHost = isSandbox ? "sandbox.payfast.co.za" : "www.payfast.co.za";
  const configured = Boolean(process.env.PAYFAST_MERCHANT_ID && process.env.PAYFAST_MERCHANT_KEY && process.env.PAYFAST_PASSPHRASE);

  function encodePf(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%20/g, "+");
  }
  function signature(data, passphrase) {
    const parts = [];
    for (const [key, raw] of Object.entries(data)) {
      if (key === "signature") continue;
      const value = String(raw == null ? "" : raw).trim();
      if (value !== "") parts.push(key + "=" + encodePf(value));
    }
    if (passphrase) parts.push("passphrase=" + encodePf(passphrase.trim()));
    return crypto.createHash("md5").update(parts.join("&")).digest("hex");
  }
  function safeEqual(a, b) {
    const aa = Buffer.from(String(a || ""), "utf8"), bb = Buffer.from(String(b || ""), "utf8");
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
  }
  function checkAdminOrigin(req, res, next) {
    const source = req.get("origin") || req.get("referer");
    if (!source) return res.status(403).json({ error: "Request origin could not be verified." });
    try {
      const parsed = new URL(source);
      if (parsed.host.toLowerCase() !== String(req.get("host") || "").toLowerCase() || parsed.protocol !== (req.secure ? "https:" : "http:") || (process.env.NODE_ENV === "production" && !req.secure))
        return res.status(403).json({ error: "Cross-site request blocked." });
    } catch { return res.status(403).json({ error: "Request origin could not be verified." }); }
    next();
  }
  const money = cents => "R " + (Number(cents || 0) / 100).toFixed(2);
  const reference = id => "SHOP-" + String(id).padStart(6, "0");

  router.get("/products", async (req, res, next) => {
    try {
      const rows = await db.query("SELECT id,title,description,category,price_cents,image_key,sizes,colors,stock_quantity FROM shop_products WHERE active=TRUE ORDER BY created_at DESC");
      res.json({ products: rows.rows.map(p => ({ ...p, image_url: p.image_key ? "/api/shop/products/" + p.id + "/image" : null })) });
    } catch (e) { next(e); }
  });
  router.get("/products/:id/image", async (req, res, next) => {
    try {
      const p = (await db.query("SELECT image_key FROM shop_products WHERE id=$1 AND active=TRUE", [req.params.id])).rows[0];
      if (!p || !p.image_key) return res.sendStatus(404);
      const object = await storage.getObjectStream(p.image_key);
      res.setHeader("Content-Type", object.ContentType || "application/octet-stream");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "public, max-age=3600");
      object.Body.pipe(res);
    } catch (e) { next(e); }
  });

  router.post("/checkout", proofUpload.single("proof_of_payment"), async (req, res, next) => {
    let uploadedKey = null;
    try {
      const name = String(req.body.customer_name || "").trim();
      const email = String(req.body.customer_email || "").trim();
      const phone = String(req.body.customer_phone || "").trim();
      const method = String(req.body.payment_method || "");
      let cart;
      try { cart = JSON.parse(req.body.cart || "[]"); } catch { cart = null; }
      if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !Array.isArray(cart) || !cart.length || cart.length > 30)
        return res.status(400).json({ error: "Please provide your name, a valid email address and at least one product." });
      if (!["eft", "card"].includes(method)) return res.status(400).json({ error: "Choose EFT or card payment." });
      if (method === "eft" && !req.file) return res.status(400).json({ error: "Please upload your EFT proof of payment (PDF, JPG, PNG or WEBP)." });
      if (method === "card" && !configured) return res.status(503).json({ error: "Online card payments are not activated yet. The parish must complete PayFast merchant registration and add its credentials before card checkout can be enabled. Please choose EFT for now." });

      const ids = [...new Set(cart.map(x => Number(x.product_id)).filter(Number.isSafeInteger))];
      if (!ids.length || ids.length !== new Set(cart.map(x => Number(x.product_id))).size) return res.status(400).json({ error: "Your cart contains an invalid product." });
      const products = (await db.query("SELECT * FROM shop_products WHERE id = ANY($1::bigint[]) AND active=TRUE", [ids])).rows;
      if (products.length !== ids.length) return res.status(400).json({ error: "One or more products are no longer available. Please refresh your cart." });
      const productMap = new Map(products.map(p => [String(p.id), p]));
      const items = [];
      let total = 0;
      for (const raw of cart) {
        const p = productMap.get(String(Number(raw.product_id)));
        const qty = Number(raw.quantity);
        if (!p || !Number.isInteger(qty) || qty < 1 || qty > 20) return res.status(400).json({ error: "Please check product quantities. Each item must be between 1 and 20." });
        const size = String(raw.size || "").trim(), color = String(raw.color || "").trim();
        if (p.sizes?.length && !p.sizes.includes(size)) return res.status(400).json({ error: "Please choose a valid size for " + p.title + "." });
        if (p.colors?.length && !p.colors.includes(color)) return res.status(400).json({ error: "Please choose a valid colour for " + p.title + "." });
        if (p.stock_quantity !== null && Number(p.stock_quantity) < qty) return res.status(409).json({ error: "There is not enough stock for " + p.title + "." });
        items.push({ product: p, quantity: qty, size, color });
        total += Number(p.price_cents) * qty;
      }
      if (total < 100 || total > 100000000) return res.status(400).json({ error: "The order total must be at least R1.00. Please review your cart." });
      if (method === "eft") uploadedKey = await storage.putObject({ area: "payment-proofs", originalName: req.file.originalname, buffer: req.file.buffer, contentType: req.file.mimetype });

      const created = await db.transaction(async client => {
        const order = (await client.query(
          "INSERT INTO shop_orders(customer_name,customer_email,customer_phone,payment_method,status,total_cents,proof_key,proof_original_name) VALUES($1,$2,$3,$4,'Pending',$5,$6,$7) RETURNING id",
          [name, email, phone, method, total, uploadedKey, method === "eft" ? path.basename(req.file.originalname) : null]
        )).rows[0];
        for (const item of items) await client.query(
          "INSERT INTO shop_order_items(order_id,product_id,product_title,unit_price_cents,quantity,size,colour) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [order.id, item.product.id, item.product.title, item.product.price_cents, item.quantity, item.size, item.color]
        );
        return order;
      });
      const orderRef = reference(created.id);
      if (method === "eft") {
        const settings = Object.fromEntries((await db.query("SELECT key,value FROM site_settings WHERE key LIKE 'eft_%'")).rows.map(x => [x.key, x.value]));
        const bank = [
          settings.eft_account_name && "Account name: " + settings.eft_account_name,
          settings.eft_bank_name && "Bank: " + settings.eft_bank_name,
          settings.eft_account_number && "Account number: " + settings.eft_account_number,
          settings.eft_branch_code && "Branch code: " + settings.eft_branch_code,
          "Payment reference: " + orderRef
        ].filter(Boolean).join("\n");
        try { await sendMail(email, "ELCSA Mavhola Parish – shop order " + orderRef,
          "Dear " + name + ",\n\nThank you for your order. Your order is recorded and is awaiting EFT payment verification.\n\nOrder reference: " + orderRef + "\nTotal: " + money(total) + "\n\nEFT details:\n" + (bank || "Please contact the parish for EFT banking details.") + "\n\nThe parish will confirm your order once payment has been checked.\n\nELCSA Mavhola Parish"); } catch (e) { console.error("Shop EFT order email failed:", e.message); }
        const adminEmail = String(process.env.ADMIN_EMAIL || "").trim();
        if (adminEmail) try { await sendMail(adminEmail, "New parish shop EFT order " + orderRef, "A new shop order is awaiting EFT verification.\nCustomer: " + name + "\nEmail: " + email + "\nTotal: " + money(total) + "\nOrder reference: " + orderRef); } catch (e) { console.error("Shop admin email failed:", e.message); }
        return res.status(201).json({ ok: true, method, orderReference: orderRef, message: "Your order " + orderRef + " has been recorded. The parish will verify your EFT payment and email you." });
      }

      const firstLast = name.split(/\s+/);
      const fields = {
        merchant_id: process.env.PAYFAST_MERCHANT_ID,
        merchant_key: process.env.PAYFAST_MERCHANT_KEY,
        return_url: baseUrl + "/?shopPayment=success#shop",
        cancel_url: baseUrl + "/?shopPayment=cancelled#shop",
        notify_url: baseUrl + "/api/shop/payfast/notify",
        name_first: firstLast.shift() || name,
        name_last: firstLast.join(" "),
        email_address: email,
        m_payment_id: String(created.id),
        amount: (total / 100).toFixed(2),
        item_name: "ELCSA Mavhola Parish Shop " + orderRef,
        item_description: "Parish merchandise order",
        email_confirmation: "1"
      };
      fields.signature = signature(fields, process.env.PAYFAST_PASSPHRASE);
      res.status(201).json({ ok: true, method, orderReference: orderRef, paymentUrl: "https://" + pfHost + "/eng/process", fields });
    } catch (e) {
      if (uploadedKey) await storage.deleteObject(uploadedKey).catch(() => {});
      next(e);
    }
  });

  router.post("/payfast/notify", async (req, res) => {
    try {
      if (!configured) return res.sendStatus(503);
      const data = req.body || {};
      if (!data.signature || !safeEqual(signature(data, process.env.PAYFAST_PASSPHRASE), data.signature)) return res.sendStatus(400);
      if (String(data.merchant_id) !== String(process.env.PAYFAST_MERCHANT_ID) || String(data.payment_status) !== "COMPLETE") return res.sendStatus(400);
      const orderId = Number(data.m_payment_id);
      if (!Number.isSafeInteger(orderId) || orderId < 1) return res.sendStatus(400);
      const order = (await db.query("SELECT * FROM shop_orders WHERE id=$1", [orderId])).rows[0];
      if (!order || order.payment_method !== "card" || Math.abs(Number(order.total_cents) / 100 - Number(data.amount_gross)) > 0.01) return res.sendStatus(400);
      const params = Object.entries(data).filter(([key]) => key !== "signature").map(([key, value]) => key + "=" + encodePf(value)).join("&");
      const validation = await fetch("https://" + pfHost + "/eng/query/validate", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params
      });
      if (!validation.ok || (await validation.text()).trim() !== "VALID") return res.sendStatus(400);
      const updated = await db.query("UPDATE shop_orders SET status='Paid',paid_at=COALESCE(paid_at,NOW()),payfast_payment_id=$1 WHERE id=$2 AND status='Pending' RETURNING id,customer_name,customer_email,total_cents",
        [String(data.pf_payment_id || ""), orderId]);
      if (updated.rowCount) {
        const paid = updated.rows[0];
        try { await sendMail(paid.customer_email, "Payment received – ELCSA Mavhola Parish Shop " + reference(paid.id),
          "Dear " + paid.customer_name + ",\n\nYour card payment has been confirmed. Your parish shop order is now marked as paid.\n\nOrder reference: " + reference(paid.id) + "\nAmount paid: " + money(paid.total_cents) + "\n\nThe parish will contact you about collection.\n\nELCSA Mavhola Parish"); } catch (e) { console.error("Shop card payment email failed:", e.message); }
        const adminEmail = String(process.env.ADMIN_EMAIL || "").trim();
        if (adminEmail) try { await sendMail(adminEmail, "Paid parish shop order " + reference(paid.id), "A card payment was confirmed by PayFast. Order " + reference(paid.id) + " is paid. Total: " + money(paid.total_cents)); } catch (e) { console.error("Shop card admin email failed:", e.message); }
      }
      return res.status(200).send("OK");
    } catch (e) { console.error("PayFast shop ITN failed:", e.message); return res.sendStatus(500); }
  });

  router.get("/admin/dashboard", requireAdmin, async (req, res, next) => {
    try {
      const [products, orders] = await Promise.all([
        db.query("SELECT * FROM shop_products ORDER BY created_at DESC"),
        db.query("SELECT * FROM shop_orders ORDER BY created_at DESC LIMIT 200")
      ]);
      const items = await db.query("SELECT * FROM shop_order_items WHERE order_id = ANY($1::bigint[]) ORDER BY id", [orders.rows.map(o => o.id)]);
      const grouped = new Map();
      for (const item of items.rows) { const key = String(item.order_id); if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(item); }
      res.json({ products: products.rows, orders: orders.rows.map(o => ({ ...o, reference: reference(o.id), items: grouped.get(String(o.id)) || [] })) });
    } catch (e) { next(e); }
  });
  router.post("/admin/products", requireAdmin, checkAdminOrigin, imageUpload.single("image"), async (req, res, next) => {
    let key = null;
    try {
      const title = String(req.body.title || "").trim(), price = Math.round(Number(req.body.price) * 100);
      if (!title || !Number.isSafeInteger(price) || price < 100 || price > 100000000) return res.status(400).json({ error: "Enter a product name and a valid price of at least R1.00." });
      if (req.file) key = await storage.putObject({ area: "shop", originalName: req.file.originalname, buffer: req.file.buffer, contentType: req.file.mimetype });
      const split = value => String(value || "").split(",").map(x => x.trim()).filter(Boolean).slice(0, 30);
      const stockRaw = String(req.body.stock_quantity || "").trim();
      const stock = stockRaw === "" ? null : Math.max(0, Math.floor(Number(stockRaw)));
      if (stock !== null && !Number.isSafeInteger(stock)) return res.status(400).json({ error: "Stock quantity must be a whole number or left blank for unlimited stock." });
      const row = (await db.query("INSERT INTO shop_products(title,description,category,price_cents,image_key,sizes,colors,stock_quantity,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,TRUE) RETURNING id",
        [title, String(req.body.description || "").trim(), String(req.body.category || "Merchandise").trim(), price, key, split(req.body.sizes), split(req.body.colors), stock])).rows[0];
      res.status(201).json({ ok: true, id: row.id });
    } catch (e) { if (key) await storage.deleteObject(key).catch(() => {}); next(e); }
  });
  router.put("/admin/products/:id", requireAdmin, checkAdminOrigin, async (req, res, next) => {
    try {
      const title = String(req.body.title || "").trim(), price = Math.round(Number(req.body.price) * 100);
      if (!title || !Number.isSafeInteger(price) || price < 100) return res.status(400).json({ error: "Enter a product name and a valid price." });
      const split = value => String(value || "").split(",").map(x => x.trim()).filter(Boolean).slice(0, 30);
      const stockRaw = String(req.body.stock_quantity ?? "").trim(), stock = stockRaw === "" ? null : Math.floor(Number(stockRaw));
      if (stock !== null && (!Number.isSafeInteger(stock) || stock < 0)) return res.status(400).json({ error: "Stock quantity must be a whole number or left blank for unlimited stock." });
      const result = await db.query("UPDATE shop_products SET title=$1,description=$2,category=$3,price_cents=$4,sizes=$5,colors=$6,stock_quantity=$7,active=$8 WHERE id=$9",
        [title, String(req.body.description || "").trim(), String(req.body.category || "Merchandise").trim(), price, split(req.body.sizes), split(req.body.colors), stock, req.body.active !== false && req.body.active !== "false", req.params.id]);
      if (!result.rowCount) return res.status(404).json({ error: "Product not found." });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  router.delete("/admin/products/:id", requireAdmin, checkAdminOrigin, async (req, res, next) => {
    try {
      const result = await db.query("UPDATE shop_products SET active=FALSE WHERE id=$1 RETURNING id", [req.params.id]);
      if (!result.rowCount) return res.status(404).json({ error: "Product not found." });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  router.get("/admin/orders/:id/proof", requireAdmin, async (req, res, next) => {
    try {
      const order = (await db.query("SELECT proof_key,proof_original_name FROM shop_orders WHERE id=$1", [req.params.id])).rows[0];
      if (!order || !order.proof_key) return res.status(404).send("Proof of payment not found.");
      const object = await storage.getObjectStream(order.proof_key);
      res.setHeader("Content-Type", object.ContentType || "application/octet-stream");
      res.setHeader("Content-Disposition", 'inline; filename="' + safeName(order.proof_original_name) + '"');
      res.setHeader("Cache-Control", "no-store");
      object.Body.pipe(res);
    } catch (e) { next(e); }
  });
  router.put("/admin/orders/:id", requireAdmin, checkAdminOrigin, async (req, res, next) => {
    try {
      const status = String(req.body.status || "");
      if (!["Paid", "Cancelled"].includes(status)) return res.status(400).json({ error: "Choose Paid or Cancelled." });
      const order = (await db.query("UPDATE shop_orders SET status=$1,paid_at=CASE WHEN $1='Paid' THEN COALESCE(paid_at,NOW()) ELSE paid_at END WHERE id=$2 AND status='Pending' RETURNING *", [status, req.params.id])).rows[0];
      if (!order) return res.status(409).json({ error: "This order was not found or is no longer pending." });
      let emailSent = false;
      if (status === "Paid") {
        try { emailSent = await sendMail(order.customer_email, "Payment verified – ELCSA Mavhola Parish Shop " + reference(order.id),
          "Dear " + order.customer_name + ",\n\nThe parish has verified your EFT payment. Your shop order is now confirmed.\n\nOrder reference: " + reference(order.id) + "\nAmount: " + money(order.total_cents) + "\n\nThe parish will contact you about collection.\n\nELCSA Mavhola Parish"); } catch (e) { console.error("Shop EFT verification email failed:", e.message); }
      }
      res.json({ ok: true, emailSent });
    } catch (e) { next(e); }
  });

  return router;
};
