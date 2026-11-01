require("dotenv").config();
const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const nodemailer = require("nodemailer");
const Stripe = require("stripe");

const app = express();
// Render terminates HTTPS at its proxy. Trust the proxy so secure session cookies work.
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;
const db = new Database(process.env.DB_PATH || "parish.db");
const uploadsDir = path.join(__dirname, "public/uploads");
const privateProofDir = path.join(__dirname, "private_uploads/payment-proofs");
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(privateProofDir, { recursive: true });
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT);
CREATE TABLE IF NOT EXISTS applications (
 id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, email TEXT NOT NULL,
 phone TEXT, date_of_birth TEXT, congregation TEXT, address TEXT, motivation TEXT,
 proof_filename TEXT, proof_original_name TEXT, proof_mime TEXT,
 status TEXT NOT NULL DEFAULT 'Pending', admin_note TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS announcements (
 id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL,
 pinned INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
 event_date TEXT, venue TEXT, ticket_price_cents INTEGER DEFAULT 0, ticket_capacity INTEGER DEFAULT 0,
 image TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, buyer_name TEXT NOT NULL,
 buyer_email TEXT NOT NULL, quantity INTEGER NOT NULL, total_cents INTEGER NOT NULL,
 status TEXT DEFAULT 'Pending', stripe_session_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS media (
 id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, description TEXT, filename TEXT NOT NULL,
 media_type TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS site_settings (
 key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT ''
);
`);
// Upgrade databases created by the earlier starter version without losing existing applications.
const applicationColumns = db.prepare("PRAGMA table_info(applications)").all().map(c => c.name);
for (const [column, type] of [["proof_filename", "TEXT"], ["proof_original_name", "TEXT"], ["proof_mime", "TEXT"]]) {
  if (!applicationColumns.includes(column)) db.exec(`ALTER TABLE applications ADD COLUMN ${column} ${type}`);
}
for (const [key, value] of [["parish_email", "mavholaparish.yl@gmail.com"], ["parish_phone", "0679378130"], ["parish_address", "PO Box 222, Makonde, 0984"], ["tagline", "Growing Together in Christ"]]) {
  db.prepare("INSERT INTO site_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=CASE WHEN site_settings.value='' THEN excluded.value ELSE site_settings.value END").run(key, value);
}
const adminEmail = (process.env.ADMIN_EMAIL || "").toLowerCase();
if (adminEmail && process.env.ADMIN_PASSWORD) {
  // Keep the administrator credentials in sync with Render environment variables.
  // This also repairs a stale initial admin password after the owner rotates it.
  db.prepare(`INSERT INTO admins(email,password_hash) VALUES(?,?)
    ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash`)
    .run(adminEmail,bcrypt.hashSync(process.env.ADMIN_PASSWORD,12));
}
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === "true",
  auth: process.env.SMTP_USER ? {user:process.env.SMTP_USER,pass:process.env.SMTP_PASS} : undefined
}) : null;
async function sendMail(to, subject, text) {
  if (!mailer) return false;
  await mailer.sendMail({from:process.env.MAIL_FROM || process.env.SMTP_USER,to,subject,text});
  return true;
}
app.use(helmet({contentSecurityPolicy:false}));
app.post("/api/stripe/webhook",express.raw({type:"application/json"}),(req,res)=>{
 if(!stripe||!process.env.STRIPE_WEBHOOK_SECRET)return res.status(400).send("Webhook not configured");
 let event;
 try{event=stripe.webhooks.constructEvent(req.body,req.headers["stripe-signature"],process.env.STRIPE_WEBHOOK_SECRET);}
 catch(err){return res.status(400).send(`Webhook Error: ${err.message}`);}
 if(event.type==="checkout.session.completed"){
  const session=event.data.object, orderId=session.metadata?.order_id;
  if(orderId)db.prepare("UPDATE orders SET status='Paid' WHERE id=?").run(orderId);
 }
 res.json({received:true});
});
app.use(express.json({limit:"1mb"}));
app.use(express.urlencoded({extended:true}));
app.use(session({
  store:new SQLiteStore({db:"sessions.db",dir:"."}),
  secret:process.env.SESSION_SECRET || "development-only-change-this-secret",
  resave:false,saveUninitialized:false,
  cookie:{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:8*60*60*1000}
}));
app.use(express.static(path.join(__dirname,"public")));
app.use("/uploads",express.static(path.join(__dirname,"public/uploads")));
const limiter=rateLimit({windowMs:15*60*1000,max:100});
app.use("/api",limiter);
const upload=multer({
  storage:multer.diskStorage({
    destination:(req,file,cb)=>cb(null,uploadsDir),
    filename:(req,file,cb)=>cb(null,Date.now()+"-"+Math.random().toString(36).slice(2)+path.extname(file.originalname).toLowerCase())
  }),
  limits:{fileSize:20*1024*1024},
  fileFilter:(req,file,cb)=>cb(null,/^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm))$/.test(file.mimetype))
});
const proofUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, privateProofDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(file.mimetype))
});
const requireAdmin=(req,res,next)=>req.session.admin?next():res.status(401).json({error:"Please sign in as an administrator."});

app.get("/api/public", (req,res)=>{
 res.json({
  announcements:db.prepare("SELECT * FROM announcements ORDER BY pinned DESC,datetime(created_at) DESC LIMIT 20").all(),
  events:db.prepare("SELECT * FROM events ORDER BY event_date ASC LIMIT 30").all(),
  media:db.prepare("SELECT * FROM media ORDER BY datetime(created_at) DESC LIMIT 30").all(),
  paymentsEnabled:!!stripe,
  settings:Object.fromEntries(db.prepare("SELECT key,value FROM site_settings").all().map(x=>[x.key,x.value]))
 });
});
app.post("/api/applications", (req,res,next)=>proofUpload.single("proof_of_payment")(req,res,err=>{
 if(err){ if(req.file)try{fs.unlinkSync(req.file.path)}catch{}; return res.status(400).json({error:err.code==="LIMIT_FILE_SIZE"?"Proof of payment must be 10 MB or smaller.":"Upload a PDF, JPG, PNG or WEBP proof of payment."}); }
 next();
}), async(req,res)=>{
 const {full_name,email,phone,date_of_birth,congregation,address,motivation}=req.body||{};
 if(!full_name?.trim()||!email?.trim()||!email.includes("@")) { if(req.file)fs.unlinkSync(req.file.path); return res.status(400).json({error:"Please provide your full name and a valid email address."}); }
 if(!req.file) return res.status(400).json({error:"Please upload proof of payment before submitting your application."});
 const result=db.prepare(`INSERT INTO applications(full_name,email,phone,date_of_birth,congregation,address,motivation,proof_filename,proof_original_name,proof_mime)
 VALUES(?,?,?,?,?,?,?,?,?,?)`).run(full_name.trim(),email.trim(),phone||"",date_of_birth||"",congregation||"",address||"",motivation||"",req.file.filename,path.basename(req.file.originalname),req.file.mimetype);
 try { await sendMail(email.trim(),"ELCSA Mavhola Parish – application received",
 `Dear ${full_name},\n\nYour Youth League membership application and proof of payment have been successfully submitted. The parish will review them and communicate the outcome.\n\nELCSA Mavhola Parish`); } catch(e){console.error("Applicant email failed:",e.message);}
 res.status(201).json({ok:true,id:result.lastInsertRowid,message:"Your application and proof of payment have been successfully submitted. The parish will review them and communicate the outcome."});
});
app.post("/api/admin/login", async(req,res)=>{
 const email=String(req.body.email||"").toLowerCase(), password=String(req.body.password||"");
 const admin=db.prepare("SELECT * FROM admins WHERE email=?").get(email);
 if(!admin || !bcrypt.compareSync(password,admin.password_hash)) return res.status(401).json({error:"Incorrect email or password."});
 req.session.admin={id:admin.id,email:admin.email};
 req.session.save(err=>{
  if(err){console.error("Admin session save failed:",err.message);return res.status(500).json({error:"Could not start your admin session. Please try again."});}
  res.json({ok:true,email:admin.email});
 });
});
app.post("/api/admin/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/api/admin/me",requireAdmin,(req,res)=>res.json(req.session.admin));
app.get("/api/admin/dashboard",requireAdmin,(req,res)=>{
 res.json({
  applications:db.prepare("SELECT id,full_name,email,phone,date_of_birth,congregation,address,motivation,status,admin_note,created_at,CASE WHEN proof_filename IS NULL THEN 0 ELSE 1 END AS has_proof,proof_original_name FROM applications ORDER BY datetime(created_at) DESC").all(),
  announcements:db.prepare("SELECT * FROM announcements ORDER BY datetime(created_at) DESC").all(),
  events:db.prepare("SELECT * FROM events ORDER BY datetime(event_date) ASC").all(),
  media:db.prepare("SELECT * FROM media ORDER BY datetime(created_at) DESC").all(),
  orders:db.prepare("SELECT orders.*,events.title AS event_title FROM orders JOIN events ON events.id=orders.event_id ORDER BY datetime(orders.created_at) DESC").all(),
  settings:Object.fromEntries(db.prepare("SELECT key,value FROM site_settings").all().map(x=>[x.key,x.value]))
 });
});
app.get("/api/admin/applications/:id/proof",requireAdmin,(req,res)=>{
 const item=db.prepare("SELECT proof_filename,proof_original_name,proof_mime FROM applications WHERE id=?").get(req.params.id);
 if(!item?.proof_filename) return res.status(404).send("Proof of payment not found.");
 const file=path.join(privateProofDir,path.basename(item.proof_filename));
 if(!fs.existsSync(file)) return res.status(404).send("The stored proof file is unavailable.");
 res.setHeader("Content-Type",item.proof_mime || "application/octet-stream");
 res.setHeader("Content-Disposition",`inline; filename="${String(item.proof_original_name||"proof").replace(/[\"\r\n]/g,"_")}"`);
 res.setHeader("Cache-Control","no-store");
 res.sendFile(file);
});
app.post("/api/admin/applications/:id/decision",requireAdmin,async(req,res)=>{
 const status=req.body.status, note=String(req.body.note||"");
 if(!["Approved","Rejected"].includes(status)) return res.status(400).json({error:"Choose Approved or Rejected."});
 const applicant=db.prepare("SELECT * FROM applications WHERE id=?").get(req.params.id);
 if(!applicant) return res.status(404).json({error:"Application not found."});
 db.prepare("UPDATE applications SET status=?,admin_note=? WHERE id=?").run(status,note,req.params.id);
 let emailSent=false;
 try { emailSent=await sendMail(applicant.email,`ELCSA Mavhola Parish – membership ${status.toLowerCase()}`,
 `Dear ${applicant.full_name},\n\nYour ELCSA Mavhola Parish Youth League membership application has been ${status.toLowerCase()}.\n${note?`\nMessage from the parish: ${note}\n`:""}\nRegards,\nELCSA Mavhola Parish`); } catch(e){console.error("Decision email failed:",e.message);}
 res.json({ok:true,emailSent});
});
app.post("/api/admin/announcements",requireAdmin,(req,res)=>{
 const {title,body,pinned}=req.body;
 if(!title||!body)return res.status(400).json({error:"Title and announcement are required."});
 const r=db.prepare("INSERT INTO announcements(title,body,pinned) VALUES(?,?,?)").run(title,body,pinned?1:0);
 res.json({ok:true,id:r.lastInsertRowid});
});
app.put("/api/admin/announcements/:id",requireAdmin,(req,res)=>{
 const {title,body,pinned}=req.body||{}; if(!title?.trim()||!body?.trim())return res.status(400).json({error:"Title and announcement are required."});
 const r=db.prepare("UPDATE announcements SET title=?,body=?,pinned=? WHERE id=?").run(title.trim(),body.trim(),pinned?1:0,req.params.id);
 if(!r.changes)return res.status(404).json({error:"Announcement not found."}); res.json({ok:true});
});
app.delete("/api/admin/announcements/:id",requireAdmin,(req,res)=>{db.prepare("DELETE FROM announcements WHERE id=?").run(req.params.id);res.json({ok:true});});
app.post("/api/admin/events",requireAdmin,(req,res)=>{
 const {title,description,event_date,venue,ticket_price_cents,ticket_capacity}=req.body;
 if(!title)return res.status(400).json({error:"Event title is required."});
 const r=db.prepare("INSERT INTO events(title,description,event_date,venue,ticket_price_cents,ticket_capacity) VALUES(?,?,?,?,?,?)")
 .run(title,description||"",event_date||"",venue||"",Math.max(0,Number(ticket_price_cents)||0),Math.max(0,Number(ticket_capacity)||0));
 res.json({ok:true,id:r.lastInsertRowid});
});
app.put("/api/admin/events/:id",requireAdmin,(req,res)=>{
 const {title,description,event_date,venue,ticket_price_cents,ticket_capacity}=req.body||{}; if(!title?.trim())return res.status(400).json({error:"Event title is required."});
 const r=db.prepare("UPDATE events SET title=?,description=?,event_date=?,venue=?,ticket_price_cents=?,ticket_capacity=? WHERE id=?").run(title.trim(),description||"",event_date||"",venue||"",Math.max(0,Number(ticket_price_cents)||0),Math.max(0,Number(ticket_capacity)||0),req.params.id);
 if(!r.changes)return res.status(404).json({error:"Event not found."}); res.json({ok:true});
});
app.delete("/api/admin/events/:id",requireAdmin,(req,res)=>{db.prepare("DELETE FROM events WHERE id=?").run(req.params.id);res.json({ok:true});});
app.post("/api/admin/media",requireAdmin,upload.single("file"),(req,res)=>{
 if(!req.file)return res.status(400).json({error:"Choose an image or video (maximum 20 MB)."});
 const r=db.prepare("INSERT INTO media(title,description,filename,media_type) VALUES(?,?,?,?)")
 .run(req.body.title||req.file.originalname,req.body.description||"",req.file.filename,req.file.mimetype);
 res.json({ok:true,id:r.lastInsertRowid});
});
app.put("/api/admin/media/:id",requireAdmin,(req,res)=>{
 const {title,description}=req.body||{}; const r=db.prepare("UPDATE media SET title=?,description=? WHERE id=?").run(title||"",description||"",req.params.id);
 if(!r.changes)return res.status(404).json({error:"Media item not found."}); res.json({ok:true});
});
app.delete("/api/admin/media/:id",requireAdmin,(req,res)=>{
 const item=db.prepare("SELECT filename FROM media WHERE id=?").get(req.params.id);
 if(item){try{fs.unlinkSync(path.join(uploadsDir,item.filename));}catch{} db.prepare("DELETE FROM media WHERE id=?").run(req.params.id);}
 res.json({ok:true});
});
app.put("/api/admin/orders/:id",requireAdmin,(req,res)=>{
 const status=String(req.body?.status||"");
 if(!["Pending","Paid","Cancelled"].includes(status)) return res.status(400).json({error:"Choose Pending, Paid or Cancelled."});
 const result=db.prepare("UPDATE orders SET status=? WHERE id=?").run(status,req.params.id);
 if(!result.changes) return res.status(404).json({error:"Ticket order not found."});
 res.json({ok:true});
});
app.put("/api/admin/settings",requireAdmin,(req,res)=>{
 const allowed=["parish_email","parish_phone","parish_address","tagline"];
 const update=db.prepare("INSERT INTO site_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
 for(const key of allowed) update.run(key,String(req.body?.[key]||"").trim());
 res.json({ok:true});
});
app.post("/api/tickets/checkout",async(req,res)=>{
 if(!stripe)return res.status(503).json({error:"Online card payments are not configured yet. Please contact the parish about ticket sales."});
 const {event_id,buyer_name,buyer_email,quantity}=req.body;
 const event=db.prepare("SELECT * FROM events WHERE id=?").get(event_id);
 const qty=Math.max(1,Math.min(10,Number(quantity)||1));
 if(!event||!buyer_name||!buyer_email||event.ticket_price_cents<=0)return res.status(400).json({error:"Please check the event and buyer details."});
 const sold=db.prepare("SELECT COALESCE(SUM(quantity),0) n FROM orders WHERE event_id=? AND status='Paid'").get(event.id).n;
 if(event.ticket_capacity>0 && sold+qty>event.ticket_capacity)return res.status(400).json({error:"There are not enough tickets remaining."});
 const order=db.prepare("INSERT INTO orders(event_id,buyer_name,buyer_email,quantity,total_cents) VALUES(?,?,?,?,?)")
 .run(event.id,buyer_name,buyer_email,qty,event.ticket_price_cents*qty);
 try{
  const checkout=await stripe.checkout.sessions.create({
   mode:"payment",customer_email:buyer_email,
   line_items:[{quantity:qty,price_data:{currency:"zar",unit_amount:event.ticket_price_cents,product_data:{name:event.title}}}],
   success_url:`${process.env.BASE_URL}/?ticket=success`,cancel_url:`${process.env.BASE_URL}/?ticket=cancelled`,
   metadata:{order_id:String(order.lastInsertRowid)}
  });
  db.prepare("UPDATE orders SET stripe_session_id=? WHERE id=?").run(checkout.id,order.lastInsertRowid);
  res.json({url:checkout.url});
 }catch(e){console.error(e);res.status(500).json({error:"Could not start checkout. Please try again later."});}
});
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public/index.html")));
app.listen(PORT,()=>console.log(`ELCSA Mavhola Parish website running at http://localhost:${PORT}`));
