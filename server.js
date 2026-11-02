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
const crypto = require("crypto");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const QRCode = require("qrcode");

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
 phone TEXT, date_of_birth TEXT, occupation TEXT, congregation TEXT, address TEXT, motivation TEXT,
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
 status TEXT DEFAULT 'Pending', stripe_session_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 tickets_emailed_at TEXT
);
CREATE TABLE IF NOT EXISTS tickets (
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, token TEXT NOT NULL UNIQUE,
 redeemed_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(order_id) REFERENCES orders(id)
);
CREATE TABLE IF NOT EXISTS media (
 id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, description TEXT, filename TEXT NOT NULL,
 media_type TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS documents (
 id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
 filename TEXT NOT NULL, original_name TEXT NOT NULL, media_type TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS site_settings (
 key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT ''
);
`);
// Upgrade databases created by the earlier starter version without losing existing applications.
const orderColumns = db.prepare("PRAGMA table_info(orders)").all().map(c => c.name);
if (!orderColumns.includes("tickets_emailed_at")) db.exec("ALTER TABLE orders ADD COLUMN tickets_emailed_at TEXT");
const applicationColumns = db.prepare("PRAGMA table_info(applications)").all().map(c => c.name);
for (const [column, type] of [["proof_filename", "TEXT"], ["proof_original_name", "TEXT"], ["proof_mime", "TEXT"], ["occupation", "TEXT"]]) {
  if (!applicationColumns.includes(column)) db.exec(`ALTER TABLE applications ADD COLUMN ${column} ${type}`);
}
for (const [key, value] of [["parish_email", "mavholaparish.yl@gmail.com"], ["parish_phone", "0679378130"], ["parish_address", "PO Box 222, Makonde, 0984"], ["tagline", "Growing Together in Christ"], ["eft_account_name", ""], ["eft_bank_name", ""], ["eft_account_number", ""], ["eft_branch_code", ""], ["eft_reference_instructions", "Use your ticket order reference as the EFT payment reference."]]) {
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
async function sendMail(to, subject, text, attachments = []) {
  // Resend uses HTTPS and works on Render Free; the sender domain must be verified with Resend.
  if (process.env.RESEND_API_KEY) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.MAIL_FROM || "ELCSA Mavhola Parish <onboarding@resend.dev>", to: [to], subject, text, attachments: attachments.map(a => ({filename:a.filename, content:a.content.toString("base64")})) })
    });
    if (!response.ok) throw new Error(`Resend email error: ${response.status} ${await response.text()}`);
    return true;
  }
  if (!mailer) return false;
  await mailer.sendMail({from:process.env.MAIL_FROM || process.env.SMTP_USER,to,subject,text,attachments});
  return true;
}

async function buildTicketPdf(ticket, order, event) {
 const pdf=await PDFDocument.create();
 const page=pdf.addPage([842,595]);
 const font=await pdf.embedFont(StandardFonts.Helvetica);
 const bold=await pdf.embedFont(StandardFonts.HelveticaBold);
 const italic=await pdf.embedFont(StandardFonts.TimesRomanItalic);
 const navy=rgb(0.035,0.13,0.31),blue=rgb(0.08,0.31,0.62),gold=rgb(0.96,0.70,0.08);
 const cream=rgb(1,0.97,0.88),white=rgb(1,1,1),muted=rgb(0.29,0.35,0.45);
 const W=842,H=595,stubX=650;
 page.drawRectangle({x:0,y:0,width:W,height:H,color:white});
 page.drawRectangle({x:0,y:0,width:W,height:H,color:rgb(0.985,0.99,1),borderColor:rgb(0.86,0.89,0.94),borderWidth:1});
 page.drawRectangle({x:0,y:0,width:16,height:H,color:navy});
 page.drawRectangle({x:16,y:0,width:8,height:H,color:gold});
 page.drawRectangle({x:24,y:462,width:stubX-24,height:133,color:navy});
 page.drawRectangle({x:stubX,y:0,width:W-stubX,height:H,color:navy});
 page.drawRectangle({x:stubX,y:0,width:W-stubX,height:10,color:gold});
 // Official ELCSA parish logo from the website's existing assets.
 const churchLogoPath=path.join(__dirname,"public/elcsa-logo.png");
 if(fs.existsSync(churchLogoPath)){
  const logo=await pdf.embedPng(fs.readFileSync(churchLogoPath));
  const scale=Math.min(102/logo.width,102/logo.height);
  page.drawImage(logo,{x:43,y:474,width:logo.width*scale,height:logo.height*scale});
 }
 page.drawText("ELCSA MAVHOLA PARISH",{x:164,y:548,size:13,font:bold,color:white});
 page.drawText("YOUTH LEAGUE",{x:164,y:507,size:31,font:bold,color:white});
 page.drawText("FAITH  •  SERVICE  •  LEADERSHIP",{x:166,y:482,size:10,font:italic,color:gold});
 // Youth League logo is also included as the event organiser's mark.
 const youthLogoPath=path.join(__dirname,"public/youth-league-logo.png");
 if(fs.existsSync(youthLogoPath)){
  const logo=await pdf.embedPng(fs.readFileSync(youthLogoPath));
  const scale=Math.min(68/logo.width,68/logo.height);
  page.drawImage(logo,{x:stubX+62,y:500,width:logo.width*scale,height:logo.height*scale});
 }
 page.drawText("E-TICKET",{x:stubX+36,y:448,size:23,font:bold,color:white});
 page.drawLine({start:{x:stubX+28,y:432},end:{x:W-28,y:432},thickness:3,color:gold});
 page.drawText("INSTALLATION CONFERENCE",{x:48,y:430,size:18,font:bold,color:navy});
 page.drawText("Building a Youth for Christ",{x:48,y:405,size:13,font:italic,color:blue});
 // Event details
 page.drawText("DATE",{x:48,y:365,size:9,font:bold,color:blue});
 page.drawText(String(event.event_date||"To be announced").slice(0,38),{x:48,y:342,size:14,font:bold,color:navy});
 page.drawLine({start:{x:330,y:330},end:{x:330,y:380},thickness:1,color:gold});
 page.drawText("VENUE",{x:354,y:365,size:9,font:bold,color:blue});
 page.drawText(String(event.venue||"To be announced").slice(0,42),{x:354,y:342,size:14,font:bold,color:navy});
 // Buyer details panel
 page.drawRectangle({x:43,y:82,width:565,height:218,color:cream,borderColor:rgb(0.95,0.84,0.57),borderWidth:1});
 page.drawText("TICKET HOLDER",{x:64,y:269,size:9,font:bold,color:blue});
 page.drawText(String(order.buyer_name).slice(0,48),{x:64,y:244,size:17,font:bold,color:navy});
 page.drawText("TICKET NUMBER",{x:64,y:205,size:9,font:bold,color:blue});
 const ticketNo="MYL-"+String(new Date().getFullYear())+"-"+String(ticket.id).padStart(6,"0");
 page.drawText(ticketNo,{x:64,y:181,size:15,font:bold,color:navy});
 page.drawText("ORDER REF.  MAV-"+String(order.id).padStart(6,"0"),{x:64,y:145,size:10,font,color:muted});
 page.drawText("PAYMENT",{x:64,y:111,size:9,font:bold,color:blue});
 page.drawRectangle({x:137,y:101,width:67,height:23,color:rgb(0.83,0.96,0.86),borderColor:rgb(0.25,0.65,0.38),borderWidth:0.6});
 page.drawText("PAID",{x:153,y:108,size:10,font:bold,color:rgb(0.08,0.43,0.22)});
 // Compact QR is contained in its own reserved area.
 const base=(process.env.PUBLIC_BASE_URL||"https://mavholaparish.co.za").replace(/\/$/,"");
 const qrData=await QRCode.toDataURL(base+"/ticket/verify/"+ticket.token,{errorCorrectionLevel:"H",margin:1,width:180});
 const qr=await pdf.embedPng(Buffer.from(qrData.split(",")[1],"base64"));
 page.drawRectangle({x:490,y:116,width:94,height:112,color:white,borderColor:gold,borderWidth:1});
 page.drawImage(qr,{x:503,y:137,width:68,height:68});
 page.drawText("SCAN TO VERIFY",{x:500,y:124,size:7,font:bold,color:navy});
 // Detachable stub
 page.drawLine({start:{x:stubX,y:20},end:{x:stubX,y:575},thickness:1.5,color:rgb(0.72,0.79,0.89),dashArray:[5,5]});
 page.drawText("TICKET NO.",{x:stubX+26,y:392,size:9,font:bold,color:gold});
 page.drawText(ticketNo,{x:stubX+26,y:366,size:13,font:bold,color:white});
 page.drawText(String(event.title||"PARISH EVENT").toUpperCase().slice(0,22),{x:stubX+26,y:323,size:10,font:bold,color:white});
 page.drawText("EVENT ADMISSION",{x:stubX+26,y:306,size:9,font,color:white});
 page.drawText(String(event.event_date||"DATE TO BE ANNOUNCED").toUpperCase().slice(0,24),{x:stubX+26,y:267,size:9,font:bold,color:gold});
 page.drawText(String(event.venue||"VENUE TO BE ANNOUNCED").toUpperCase().slice(0,25),{x:stubX+26,y:247,size:7,font,color:white});
 page.drawLine({start:{x:stubX+25,y:224},end:{x:W-25,y:224},thickness:0.8,color:rgb(0.35,0.48,0.67)});
 page.drawText("KEEP THIS TICKET SAFE",{x:stubX+26,y:194,size:9,font:bold,color:white});
 page.drawText("Present your QR code at",{x:stubX+26,y:174,size:8,font,color:white});
 page.drawText("the entrance for admission.",{x:stubX+26,y:160,size:8,font,color:white});
 page.drawText("TOGETHER IN CHRIST",{x:stubX+26,y:77,size:9,font:bold,color:gold});
 page.drawText("Towards a Better Tomorrow",{x:stubX+26,y:58,size:8,font:italic,color:white});
 page.drawText("One ticket admits one person",{x:48,y:48,size:9,font:italic,color:muted});
 return Buffer.from(await pdf.save());
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
const documentUpload = multer({
 storage: multer.diskStorage({
  destination: (req,file,cb)=>cb(null,uploadsDir),
  filename: (req,file,cb)=>cb(null,`document-${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname).toLowerCase()}`)
 }),
 limits:{fileSize:25*1024*1024,files:1},
 fileFilter:(req,file,cb)=>cb(null,[".pdf",".doc",".docx",".xls",".xlsx",".ppt",".pptx",".txt"].includes(path.extname(file.originalname).toLowerCase()))
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
  documents:db.prepare("SELECT id,title,description,original_name,created_at FROM documents ORDER BY datetime(created_at) DESC LIMIT 100").all(),
  paymentsEnabled:!!stripe,
  settings:Object.fromEntries(db.prepare("SELECT key,value FROM site_settings").all().map(x=>[x.key,x.value]))
 });
});
app.post("/api/applications", (req,res,next)=>proofUpload.single("proof_of_payment")(req,res,err=>{
 if(err){ if(req.file)try{fs.unlinkSync(req.file.path)}catch{}; return res.status(400).json({error:err.code==="LIMIT_FILE_SIZE"?"Proof of payment must be 10 MB or smaller.":"Upload a PDF, JPG, PNG or WEBP proof of payment."}); }
 next();
}), async(req,res)=>{
 const {full_name,email,phone,date_of_birth,occupation,congregation,address,motivation}=req.body||{};
 if(!full_name?.trim()||!email?.trim()||!email.includes("@")||!["Student","Employed","Unemployed"].includes(occupation)) { if(req.file)fs.unlinkSync(req.file.path); return res.status(400).json({error:"Please provide your full name, a valid email address and select your occupation."}); }
 if(!req.file) return res.status(400).json({error:"Please upload proof of payment before submitting your application."});
 const result=db.prepare(`INSERT INTO applications(full_name,email,phone,date_of_birth,occupation,congregation,address,motivation,proof_filename,proof_original_name,proof_mime)
 VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(full_name.trim(),email.trim(),phone||"",date_of_birth||"",occupation,congregation||"",address||"",motivation||"",req.file.filename,path.basename(req.file.originalname),req.file.mimetype);
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
  applications:db.prepare("SELECT id,full_name,email,phone,date_of_birth,occupation,congregation,address,motivation,status,admin_note,created_at,CASE WHEN proof_filename IS NULL THEN 0 ELSE 1 END AS has_proof,proof_original_name FROM applications ORDER BY datetime(created_at) DESC").all(),
  announcements:db.prepare("SELECT * FROM announcements ORDER BY datetime(created_at) DESC").all(),
  events:db.prepare("SELECT * FROM events ORDER BY datetime(event_date) ASC").all(),
  media:db.prepare("SELECT * FROM media ORDER BY datetime(created_at) DESC").all(),
  documents:db.prepare("SELECT * FROM documents ORDER BY datetime(created_at) DESC").all(),
  orders:db.prepare("SELECT orders.*,events.title AS event_title FROM orders JOIN events ON events.id=orders.event_id ORDER BY datetime(orders.created_at) DESC").all(),
  settings:Object.fromEntries(db.prepare("SELECT key,value FROM site_settings").all().map(x=>[x.key,x.value]))
 });
});
app.get("/api/admin/applications/export.csv",requireAdmin,(req,res)=>{
 const rows=db.prepare("SELECT full_name,email,phone,congregation,status,created_at FROM applications ORDER BY full_name COLLATE NOCASE").all();
 const cell=v=>'"'+String(v??"").replace(/"/g,'""')+'"';
 const csv=["Full name,Email,Phone,Congregation,Status,Date applied",...rows.map(r=>[r.full_name,r.email,r.phone,r.congregation,r.status,r.created_at].map(cell).join(","))].join("\r\n");
 res.setHeader("Content-Type","text/csv; charset=utf-8");
 res.setHeader("Content-Disposition",'attachment; filename="mavhola-youth-league-membership-applications.csv"');
 res.send("\uFEFF"+csv);
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
app.post("/api/admin/documents",requireAdmin,documentUpload.single("file"),(req,res)=>{
 if(!req.file)return res.status(400).json({error:"Choose a supported document (maximum 25 MB)."});
 const title=String(req.body.title||"").trim()||path.basename(req.file.originalname,path.extname(req.file.originalname));
 const description=String(req.body.description||"").trim();
 const r=db.prepare("INSERT INTO documents(title,description,filename,original_name,media_type) VALUES(?,?,?,?,?)").run(title,description,req.file.filename,path.basename(req.file.originalname),req.file.mimetype);
 res.json({ok:true,id:r.lastInsertRowid});
});
app.put("/api/admin/documents/:id",requireAdmin,(req,res)=>{
 const title=String(req.body.title||"").trim(),description=String(req.body.description||"").trim();
 if(!title)return res.status(400).json({error:"Document title is required."});
 const r=db.prepare("UPDATE documents SET title=?,description=? WHERE id=?").run(title,description,req.params.id);
 if(!r.changes)return res.status(404).json({error:"Document not found."}); res.json({ok:true});
});
app.delete("/api/admin/documents/:id",requireAdmin,(req,res)=>{
 const item=db.prepare("SELECT filename FROM documents WHERE id=?").get(req.params.id);
 if(item){try{fs.unlinkSync(path.join(uploadsDir,path.basename(item.filename)));}catch{} db.prepare("DELETE FROM documents WHERE id=?").run(req.params.id);}
 res.json({ok:true});
});
app.get("/documents/:id/download",(req,res)=>{
 const item=db.prepare("SELECT filename,original_name FROM documents WHERE id=?").get(req.params.id);
 if(!item)return res.status(404).send("Document not found.");
 const file=path.join(uploadsDir,path.basename(item.filename));
 if(!fs.existsSync(file))return res.status(404).send("Document file is unavailable.");
 res.download(file,path.basename(item.original_name));
});
app.put("/api/admin/orders/:id",requireAdmin,async(req,res)=>{
 const status=String(req.body?.status||"");
 if(!["Pending","Paid","Cancelled"].includes(status))return res.status(400).json({error:"Choose Pending, Paid or Cancelled."});
 const order=db.prepare("SELECT orders.*,events.title AS event_title,events.event_date,events.venue FROM orders JOIN events ON events.id=orders.event_id WHERE orders.id=?").get(req.params.id);
 if(!order)return res.status(404).json({error:"Ticket order not found."});
 db.prepare("UPDATE orders SET status=? WHERE id=?").run(status,req.params.id);
 let emailSent=false;
 if(status==="Paid"){
  try{
   let tickets=db.prepare("SELECT * FROM tickets WHERE order_id=? ORDER BY id").all(order.id);
   if(!tickets.length){
    const insert=db.prepare("INSERT INTO tickets(order_id,token) VALUES(?,?)");
    db.transaction(()=>{for(let i=0;i<order.quantity;i++)insert.run(order.id,crypto.randomBytes(24).toString("hex"));})();
    tickets=db.prepare("SELECT * FROM tickets WHERE order_id=? ORDER BY id").all(order.id);
   }
   const emailed=db.prepare("SELECT tickets_emailed_at FROM orders WHERE id=?").get(order.id).tickets_emailed_at;
   if(!emailed){
    const attachments=[];
    for(let i=0;i<tickets.length;i++){
     const content=await buildTicketPdf({...tickets[i],position:i+1},order,{title:order.event_title,event_date:order.event_date,venue:order.venue});
     attachments.push({filename:"MAV-T"+String(tickets[i].id).padStart(6,"0")+".pdf",content});
    }
    emailSent=await sendMail(order.buyer_email,"Your ELCSA Mavhola Parish e-ticket(s) – Order MAV-"+String(order.id).padStart(6,"0"),
"Dear "+order.buyer_name+",\n\nYour EFT payment has been verified. Your booking is confirmed. Your individual PDF e-ticket(s), each with a unique QR code, are attached to this email.\n\nEvent: "+order.event_title+"\nDate: "+(order.event_date||"To be announced")+"\nVenue: "+(order.venue||"To be announced")+"\nTickets: "+order.quantity+"\nAmount paid: R "+(order.total_cents/100).toFixed(2)+"\nOrder reference: MAV-"+String(order.id).padStart(6,"0")+"\n\nPlease bring your ticket(s) and show the QR code(s) at the entrance.\n\nELCSA Mavhola Parish Youth League",attachments);
    if(emailSent)db.prepare("UPDATE orders SET tickets_emailed_at=CURRENT_TIMESTAMP WHERE id=?").run(order.id);
   }else emailSent=true;
  }catch(e){console.error("E-ticket generation/email failed:",e.message);}
 }
 res.json({ok:true,emailSent,ticketCount:status==="Paid"?db.prepare("SELECT COUNT(*) n FROM tickets WHERE order_id=?").get(order.id).n:0});
});
app.put("/api/admin/settings",requireAdmin,(req,res)=>{
 const allowed=["parish_email","parish_phone","parish_address","tagline","eft_account_name","eft_bank_name","eft_account_number","eft_branch_code","eft_reference_instructions"];
 const update=db.prepare("INSERT INTO site_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
 for(const key of allowed) update.run(key,String(req.body?.[key]||"").trim());
 res.json({ok:true});
});
app.post("/api/tickets/checkout",async(req,res)=>{
 const {event_id,buyer_name,buyer_email,quantity}=req.body||{};
 const event=db.prepare("SELECT * FROM events WHERE id=?").get(event_id);
 const qty=Math.max(1,Math.min(10,Number(quantity)||1));
 if(!event||!buyer_name?.trim()||!buyer_email?.includes("@")||event.ticket_price_cents<=0)return res.status(400).json({error:"Please check the event, your name and a valid email address."});
 const sold=db.prepare("SELECT COALESCE(SUM(quantity),0) n FROM orders WHERE event_id=? AND status IN ('Paid','Pending')").get(event.id).n;
 if(event.ticket_capacity>0 && sold+qty>event.ticket_capacity)return res.status(400).json({error:"There are not enough tickets remaining."});
 const order=db.prepare("INSERT INTO orders(event_id,buyer_name,buyer_email,quantity,total_cents,status) VALUES(?,?,?,?,?,'Pending')")
 .run(event.id,buyer_name.trim(),buyer_email.trim(),qty,event.ticket_price_cents*qty);
 const settings=Object.fromEntries(db.prepare("SELECT key,value FROM site_settings").all().map(x=>[x.key,x.value]));
 const reference=`MAV-${String(order.lastInsertRowid).padStart(6,"0")}`;
 const eftDetails=[settings.eft_account_name&&`Account name: ${settings.eft_account_name}`,settings.eft_bank_name&&`Bank: ${settings.eft_bank_name}`,settings.eft_account_number&&`Account number: ${settings.eft_account_number}`,settings.eft_branch_code&&`Branch code: ${settings.eft_branch_code}`,settings.eft_reference_instructions||"Use the order reference below as your EFT payment reference."].filter(Boolean).join("\n");
 let emailSent=false;
 try { emailSent=await sendMail(buyer_email.trim(),`ELCSA Mavhola Parish – ticket order ${reference}`,
`Dear ${buyer_name.trim()},\n\nThank you for booking tickets. Your order has been received and is awaiting EFT payment verification. This is not yet a paid ticket.\n\nORDER DETAILS\nOrder reference: ${reference}\nEvent: ${event.title}\nDate: ${event.event_date||"To be announced"}\nVenue: ${event.venue||"To be announced"}\nTickets: ${qty}\nTotal due: R ${((event.ticket_price_cents*qty)/100).toFixed(2)}\nPayment method: EFT\n\nEFT PAYMENT DETAILS\n${eftDetails||"Please contact the parish using the contact details on our website to obtain the EFT banking details."}\n\nAfter making payment, please send proof of payment to the parish. Your paid ticket confirmation will be emailed once the parish verifies your payment.\n\nELCSA Mavhola Parish`); } catch(e){console.error("Ticket order email failed:",e.message);}
 res.status(201).json({ok:true,orderReference:reference,emailSent,message:`Your ticket order ${reference} has been recorded. Please pay by EFT and wait for the parish to verify your payment. ${emailSent?"Order details have been emailed to you.":"We could not send the email; please check your email address or contact the parish."}`});
});
app.get("/ticket/verify/:token",(req,res)=>{
 const t=db.prepare("SELECT tickets.id,tickets.redeemed_at,orders.buyer_name,events.title AS event_title,events.event_date,events.venue FROM tickets JOIN orders ON orders.id=tickets.order_id JOIN events ON events.id=orders.event_id WHERE tickets.token=? AND orders.status='Paid'").get(req.params.token);
 if(!t)return res.status(404).type("html").send("<!doctype html><html><body style='font-family:Arial;text-align:center;padding:40px'><h1>Ticket not found</h1><p>This QR code is not recognised as a paid ticket.</p></body></html>");
 const holder=String(t.buyer_name).replace(/[&<>"]/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[ch]));
 res.type("html").send("<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'><title>Ticket verification</title></head><body style='font-family:Arial;background:#f4f6fa;padding:24px'><main style='max-width:520px;margin:30px auto;background:white;padding:28px;border-radius:14px;text-align:center'><img src='/youth-league-logo.png' alt='Youth League' style='max-width:130px;max-height:110px'><h1 style='color:#092b67'>VALID PAID TICKET</h1><p><b>"+t.event_title+"</b></p><p>"+(t.event_date||"Date to be announced")+" · "+(t.venue||"Venue to be announced")+"</p><p>Ticket holder: "+holder+"</p><p>Ticket number: MAV-T"+String(t.id).padStart(6,"0")+"</p><p>Please compare the ticket holder details with their ticket.</p></main></body></html>");
});
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public/index.html")));
app.listen(PORT,()=>console.log(`ELCSA Mavhola Parish website running at http://localhost:${PORT}`));
