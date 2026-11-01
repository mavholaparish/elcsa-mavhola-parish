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
const PORT = process.env.PORT || 3000;
const db = new Database("parish.db");
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT);
CREATE TABLE IF NOT EXISTS applications (
 id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, email TEXT NOT NULL,
 phone TEXT, date_of_birth TEXT, congregation TEXT, address TEXT, motivation TEXT,
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
`);
const adminEmail = (process.env.ADMIN_EMAIL || "").toLowerCase();
if (adminEmail && process.env.ADMIN_PASSWORD && !db.prepare("SELECT id FROM admins WHERE email=?").get(adminEmail)) {
  db.prepare("INSERT INTO admins(email,password_hash) VALUES(?,?)").run(adminEmail,bcrypt.hashSync(process.env.ADMIN_PASSWORD,12));
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
    destination:(req,file,cb)=>cb(null,path.join(__dirname,"public/uploads")),
    filename:(req,file,cb)=>cb(null,Date.now()+"-"+Math.random().toString(36).slice(2)+path.extname(file.originalname).toLowerCase())
  }),
  limits:{fileSize:20*1024*1024},
  fileFilter:(req,file,cb)=>cb(null,/^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm))$/.test(file.mimetype))
});
const requireAdmin=(req,res,next)=>req.session.admin?next():res.status(401).json({error:"Please sign in as an administrator."});

app.get("/api/public", (req,res)=>{
 res.json({
  announcements:db.prepare("SELECT * FROM announcements ORDER BY pinned DESC,datetime(created_at) DESC LIMIT 20").all(),
  events:db.prepare("SELECT * FROM events ORDER BY event_date ASC LIMIT 30").all(),
  media:db.prepare("SELECT * FROM media ORDER BY datetime(created_at) DESC LIMIT 30").all(),
  paymentsEnabled:!!stripe
 });
});
app.post("/api/applications", async(req,res)=>{
 const {full_name,email,phone,date_of_birth,congregation,address,motivation}=req.body||{};
 if(!full_name?.trim()||!email?.trim()||!email.includes("@")) return res.status(400).json({error:"Please provide your full name and a valid email address."});
 const result=db.prepare(`INSERT INTO applications(full_name,email,phone,date_of_birth,congregation,address,motivation)
 VALUES(?,?,?,?,?,?,?)`).run(full_name.trim(),email.trim(),phone||"",date_of_birth||"",congregation||"",address||"",motivation||"");
 try { await sendMail(email.trim(),"ELCSA Mavhola Parish – application received",
 `Dear ${full_name},\n\nYour Youth League membership application has been successfully submitted. The parish will review it and communicate the outcome.\n\nELCSA Mavhola Parish`); } catch(e){console.error("Applicant email failed:",e.message);}
 res.status(201).json({ok:true,id:result.lastInsertRowid,message:"Your application has been successfully submitted. The parish will review your application and communicate the outcome."});
});
app.post("/api/admin/login", async(req,res)=>{
 const email=String(req.body.email||"").toLowerCase(), password=String(req.body.password||"");
 const admin=db.prepare("SELECT * FROM admins WHERE email=?").get(email);
 if(!admin || !bcrypt.compareSync(password,admin.password_hash)) return res.status(401).json({error:"Incorrect email or password."});
 req.session.admin={id:admin.id,email:admin.email}; res.json({ok:true,email:admin.email});
});
app.post("/api/admin/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/api/admin/me",requireAdmin,(req,res)=>res.json(req.session.admin));
app.get("/api/admin/dashboard",requireAdmin,(req,res)=>{
 res.json({
  applications:db.prepare("SELECT * FROM applications ORDER BY datetime(created_at) DESC").all(),
  announcements:db.prepare("SELECT * FROM announcements ORDER BY datetime(created_at) DESC").all(),
  events:db.prepare("SELECT * FROM events ORDER BY datetime(event_date) ASC").all(),
  media:db.prepare("SELECT * FROM media ORDER BY datetime(created_at) DESC").all(),
  orders:db.prepare("SELECT orders.*,events.title AS event_title FROM orders JOIN events ON events.id=orders.event_id ORDER BY datetime(orders.created_at) DESC").all()
 });
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
app.delete("/api/admin/announcements/:id",requireAdmin,(req,res)=>{db.prepare("DELETE FROM announcements WHERE id=?").run(req.params.id);res.json({ok:true});});
app.post("/api/admin/events",requireAdmin,(req,res)=>{
 const {title,description,event_date,venue,ticket_price_cents,ticket_capacity}=req.body;
 if(!title)return res.status(400).json({error:"Event title is required."});
 const r=db.prepare("INSERT INTO events(title,description,event_date,venue,ticket_price_cents,ticket_capacity) VALUES(?,?,?,?,?,?)")
 .run(title,description||"",event_date||"",venue||"",Math.max(0,Number(ticket_price_cents)||0),Math.max(0,Number(ticket_capacity)||0));
 res.json({ok:true,id:r.lastInsertRowid});
});
app.delete("/api/admin/events/:id",requireAdmin,(req,res)=>{db.prepare("DELETE FROM events WHERE id=?").run(req.params.id);res.json({ok:true});});
app.post("/api/admin/media",requireAdmin,upload.single("file"),(req,res)=>{
 if(!req.file)return res.status(400).json({error:"Choose an image or video (maximum 20 MB)."});
 const r=db.prepare("INSERT INTO media(title,description,filename,media_type) VALUES(?,?,?,?)")
 .run(req.body.title||req.file.originalname,req.body.description||"",req.file.filename,req.file.mimetype);
 res.json({ok:true,id:r.lastInsertRowid});
});
app.delete("/api/admin/media/:id",requireAdmin,(req,res)=>{
 const item=db.prepare("SELECT filename FROM media WHERE id=?").get(req.params.id);
 if(item){try{fs.unlinkSync(path.join(__dirname,"public/uploads",item.filename));}catch{} db.prepare("DELETE FROM media WHERE id=?").run(req.params.id);}
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
