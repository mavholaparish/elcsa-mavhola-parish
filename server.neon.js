require("dotenv").config();
const express=require("express");
const session=require("express-session");
const PgSession=require("connect-pg-simple")(session);
const bcrypt=require("bcryptjs");
const helmet=require("helmet");
const rateLimit=require("express-rate-limit");
const multer=require("multer");
const path=require("path");
const fs=require("fs");
const nodemailer=require("nodemailer");
const Stripe=require("stripe");
const crypto=require("crypto");
const {PDFDocument,StandardFonts,rgb}=require("pdf-lib");
const QRCode=require("qrcode");
const db=require("./database");
const storage=require("./storage");
const {validateUpload}=require("./upload-validation");

const app=express();
app.set("trust proxy",1);
const PORT=process.env.PORT||3000;
const stripe=process.env.STRIPE_SECRET_KEY?new Stripe(process.env.STRIPE_SECRET_KEY):null;
const mailer=process.env.SMTP_HOST?nodemailer.createTransport({
 host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),
 secure:process.env.SMTP_SECURE==="true",
 auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}:undefined
}):null;

async function sendMail(to,subject,text,attachments=[]){
 if(process.env.RESEND_API_KEY){
  const response=await fetch("https://api.resend.com/emails",{method:"POST",
   headers:{Authorization:"Bearer "+process.env.RESEND_API_KEY,"Content-Type":"application/json"},
   body:JSON.stringify({from:process.env.MAIL_FROM||"ELCSA Mavhola Parish <onboarding@resend.dev>",to:[to],subject,text,
    attachments:attachments.map(a=>({filename:a.filename,content:a.content.toString("base64")}))})});
  if(!response.ok)throw new Error("Resend email error: "+response.status+" "+await response.text());
  return true;
 }
 if(!mailer)return false;
 await mailer.sendMail({from:process.env.MAIL_FROM||process.env.SMTP_USER,to,subject,text,attachments});
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

function asyncRoute(fn){return (req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);}
function fileFilter(allowed){return (req,file,cb)=>cb(null,allowed(file));}
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:20*1024*1024,files:1},
 fileFilter:fileFilter((f)=>/^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm))$/.test(f.mimetype))});
const documentUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:25*1024*1024,files:1},
 fileFilter:fileFilter(f=>[".pdf",".doc",".docx",".xls",".xlsx",".ppt",".pptx",".txt"].includes(path.extname(f.originalname).toLowerCase()))});
const proofUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:10*1024*1024,files:1},
 fileFilter:fileFilter(f=>["application/pdf","image/jpeg","image/png","image/webp"].includes(f.mimetype))});
const requireAdmin=(req,res,next)=>req.session.admin?next():res.status(401).json({error:"Please sign in as an administrator."});
const settingsObject=async()=>Object.fromEntries((await db.query("SELECT key,value FROM site_settings")).rows.map(x=>[x.key,x.value]));
function southAfricaDate(){
 const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Africa/Johannesburg",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());
 const values=Object.fromEntries(parts.map(part=>[part.type,part.value]));
 return values.year+"-"+values.month+"-"+values.day;
}
function membershipPeriod(settings){
 const opening=settings.membership_open_date||"",closing=settings.membership_close_date||"";
 if(!opening&&!closing)return {isOpen:true,status:"not_scheduled",message:"Membership applications are currently open."};
 if(!opening||!closing)return {isOpen:false,status:"not_configured",message:"Membership applications are temporarily unavailable. Please contact the parish."};
 const today=southAfricaDate();
 if(today<opening)return {isOpen:false,status:"upcoming",message:"Membership applications will open on "+opening+"."};
 if(today>closing)return {isOpen:false,status:"closed",message:"Membership applications are closed. The closing date was "+closing+"."};
 return {isOpen:true,status:"open",message:"Membership applications are open until "+closing+"."};
}
const requireMembershipOpen=async(req,res,next)=>{
 try{const period=membershipPeriod(await settingsObject());if(!period.isOpen)return res.status(403).json({error:period.message});next();}
 catch(error){next(error);}
};
const safeName=s=>path.basename(String(s||"file")).replace(/["\r\n]/g,"_");
const publicBase=(process.env.R2_PUBLIC_BASE_URL||"").replace(/\/$/,"");

app.use(helmet({contentSecurityPolicy:false}));
app.post("/api/stripe/webhook",express.raw({type:"application/json"}),asyncRoute(async(req,res)=>{
 if(!stripe||!process.env.STRIPE_WEBHOOK_SECRET)return res.status(400).send("Webhook not configured");
 let event;try{event=stripe.webhooks.constructEvent(req.body,req.headers["stripe-signature"],process.env.STRIPE_WEBHOOK_SECRET);}
 catch(err){return res.status(400).send("Webhook Error: "+err.message);}
 // Stripe fulfillment is intentionally disabled: a payment event must never mark
 // an order Paid without the same locked ticket-creation workflow used by admins.
 if(event.type==="checkout.session.completed"){
  console.warn("Stripe checkout completed but automatic fulfillment is disabled; verify payment and process order through the admin dashboard.");
  return res.json({received:true,fulfillment:"manual-review-required"});
 }
 res.json({received:true});
}));
app.use(express.json({limit:"1mb"}));
app.use(express.urlencoded({extended:true}));
if(!process.env.SESSION_SECRET||process.env.SESSION_SECRET.length<32)throw new Error("Set SESSION_SECRET to a random value of at least 32 characters.");
app.use(session({store:new PgSession({pool:db.pool,tableName:"user_sessions",createTableIfMissing:true}),
 secret:process.env.SESSION_SECRET,resave:false,saveUninitialized:false,
 cookie:{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:8*60*60*1000}}));
app.use(express.static(path.join(__dirname,"public")));
app.use("/api/admin",(req,res,next)=>{
 if(["GET","HEAD","OPTIONS"].includes(req.method))return next();
 const source=req.get("origin")||req.get("referer");
 if(!source)return res.status(403).json({error:"Request origin could not be verified."});
 try{
  const parsed=new URL(source);
  const expectedHost=String(req.get("host")||"").toLowerCase();
  if(parsed.host.toLowerCase()!==expectedHost||parsed.protocol!==(req.secure?"https:":"http:")||(process.env.NODE_ENV==="production"&&!req.secure))
   return res.status(403).json({error:"Cross-site request blocked."});
 }catch{return res.status(403).json({error:"Request origin could not be verified."});}
 next();
});

app.get("/uploads/*",asyncRoute(async(req,res)=>{
 const key=decodeURIComponent(req.params[0]||"");
 // Only gallery assets are public through this route. Documents use their
 // dedicated download endpoint; payment proofs must never be publicly served.
 if(!key||key.includes("..")||key.startsWith("/")||!key.startsWith("gallery/"))return res.sendStatus(404);
 const result=await storage.getObjectStream(key);
 res.setHeader("Content-Type",result.ContentType||"application/octet-stream");
 res.setHeader("X-Content-Type-Options","nosniff");
 res.setHeader("Cache-Control","public, max-age=3600");
 if(result.ContentLength)res.setHeader("Content-Length",String(result.ContentLength));
 result.Body.pipe(res);
}));
app.use("/api",rateLimit({windowMs:15*60*1000,max:100}));

// Create the initial administrator from environment variables without overwriting
// an existing password on every restart. Rotate credentials through the host dashboard.
async function bootstrap(){
 // Apply the idempotent base schema before accepting requests.
 const schemaSql=fs.readFileSync(path.join(__dirname,"database","schema.sql"),"utf8");
 await db.query(schemaSql);
 await storage.checkStorage();
 await db.query(`CREATE TABLE IF NOT EXISTS user_sessions (
  sid VARCHAR NOT NULL PRIMARY KEY, sess JSON NOT NULL, expire TIMESTAMP(6) NOT NULL
 )`);
 await db.query("CREATE INDEX IF NOT EXISTS user_sessions_expire_idx ON user_sessions(expire)");
 if(process.env.ADMIN_EMAIL&&process.env.ADMIN_PASSWORD){
  const email=process.env.ADMIN_EMAIL.trim().toLowerCase();
  const exists=await db.query("SELECT id FROM admins WHERE LOWER(email)=LOWER($1)",[email]);
  if(!exists.rowCount)await db.query("INSERT INTO admins(email,password_hash) VALUES($1,$2)",[email,await bcrypt.hash(process.env.ADMIN_PASSWORD,12)]);
 }
}
app.get("/api/public",asyncRoute(async(req,res)=>{
 const [announcements,events,media,documents,settings]=await Promise.all([
  db.query("SELECT * FROM announcements ORDER BY pinned DESC,created_at DESC LIMIT 20"),
  db.query("SELECT * FROM events ORDER BY event_date ASC LIMIT 30"),
  db.query("SELECT * FROM media ORDER BY created_at DESC LIMIT 30"),
  db.query("SELECT id,title,description,original_name,created_at FROM documents ORDER BY created_at DESC LIMIT 100"),
  settingsObject()
 ]);
 res.json({announcements:announcements.rows,events:events.rows,media:media.rows.map(x=>({...x,filename:publicBase?x.filename:x.filename})),documents:documents.rows,paymentsEnabled:false,settings,membershipPeriod:membershipPeriod(settings)});
}));
app.post("/api/applications",requireMembershipOpen,proofUpload.single("proof_of_payment"),validateUpload("proof"),asyncRoute(async(req,res)=>{
 const {full_name,email,phone,date_of_birth,occupation,congregation,address,motivation}=req.body||{};
 if(!full_name?.trim()||!email?.trim()||!email.includes("@")||!["Student","Employed","Unemployed"].includes(occupation))
  return res.status(400).json({error:"Please provide your full name, a valid email address and select your occupation."});
 if(!req.file)return res.status(400).json({error:"Please upload proof of payment before submitting your application."});
 const key=await storage.putObject({area:"payment-proofs",originalName:req.file.originalname,buffer:req.file.buffer,contentType:req.file.mimetype});
 try{
  const result=await db.query(`INSERT INTO applications(full_name,email,phone,date_of_birth,occupation,congregation,address,motivation,proof_filename,proof_original_name,proof_mime)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
  [full_name.trim(),email.trim(),phone||"",date_of_birth||"",occupation,congregation||"",address||"",motivation||"",key,path.basename(req.file.originalname),req.file.mimetype]);
  try{await sendMail(email.trim(),"ELCSA Mavhola Parish – application received",
   `Dear ${full_name},\n\nYour Youth League membership application and proof of payment have been successfully submitted. The parish will review them and communicate the outcome.\n\nELCSA Mavhola Parish`);}catch(e){console.error("Applicant email failed:",e.message);}
  try{
   const adminEmail=String(process.env.ADMIN_EMAIL||"").trim();
   if(adminEmail)await sendMail(adminEmail,"ELCSA Mavhola Parish – new membership application",
    `A new Youth League membership application has been submitted.\n\nApplication ID: ${result.rows[0].id}\nApplicant: ${full_name.trim()}\nApplicant email: ${email.trim()}\nCongregation: ${congregation||"Not provided"}\n\nPlease sign in to the parish admin dashboard to review the application and proof of payment.\n\nELCSA Mavhola Parish`);
   else console.warn("Admin application notification skipped: ADMIN_EMAIL is not configured.");
  }catch(e){console.error("Admin notification email failed:",e.message);}
  res.status(201).json({ok:true,id:result.rows[0].id,message:"Your application and proof of payment have been successfully submitted. The parish will review them and communicate the outcome."});
 }catch(e){await storage.deleteObject(key).catch(()=>{});throw e;}
}));
const adminLoginLimiter=rateLimit({
 windowMs:15*60*1000,max:10,standardHeaders:true,legacyHeaders:false,
 message:{error:"Too many sign-in attempts. Please wait 15 minutes and try again."}
});
app.post("/api/admin/login",adminLoginLimiter,asyncRoute(async(req,res)=>{
 const email=String(req.body.email||"").trim().toLowerCase(),password=String(req.body.password||"");
 const found=await db.query("SELECT * FROM admins WHERE LOWER(email)=LOWER($1)",[email]),admin=found.rows[0];
 if(!admin||!(await bcrypt.compare(password,admin.password_hash)))return res.status(401).json({error:"Incorrect email or password."});
 req.session.regenerate(err=>{
  if(err)return res.status(500).json({error:"Could not start your admin session. Please try again."});
  req.session.admin={id:admin.id,email:admin.email};
  req.session.save(saveErr=>saveErr?res.status(500).json({error:"Could not start your admin session. Please try again."}):res.json({ok:true,email:admin.email}));
 });
}));
app.post("/api/admin/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/api/admin/me",requireAdmin,(req,res)=>res.json(req.session.admin));
app.get("/api/admin/dashboard",requireAdmin,asyncRoute(async(req,res)=>{
 const [applications,announcements,events,media,documents,orders,settings]=await Promise.all([
  db.query("SELECT id,full_name,email,phone,date_of_birth,occupation,congregation,address,motivation,status,admin_note,created_at,(proof_filename IS NOT NULL)::int AS has_proof,proof_original_name FROM applications ORDER BY created_at DESC"),
  db.query("SELECT * FROM announcements ORDER BY created_at DESC"),
  db.query("SELECT * FROM events ORDER BY event_date ASC"),
  db.query("SELECT * FROM media ORDER BY created_at DESC"),
  db.query("SELECT * FROM documents ORDER BY created_at DESC"),
  db.query("SELECT orders.*,events.title AS event_title FROM orders JOIN events ON events.id=orders.event_id ORDER BY orders.created_at DESC"),
  settingsObject()
 ]);
 res.json({applications:applications.rows,announcements:announcements.rows,events:events.rows,media:media.rows,documents:documents.rows,orders:orders.rows,settings});
}));
app.get("/api/admin/applications/export.csv",requireAdmin,asyncRoute(async(req,res)=>{
 const rows=(await db.query("SELECT full_name,email,phone,congregation,status,created_at FROM applications ORDER BY LOWER(full_name)")).rows;
 const cell=v=>{let value=String(v??"");if(/^[\s\u0000-\u001f]*[=+\-@]/.test(value))value="'"+value;return '"'+value.replace(/"/g,'""')+'"';};
 const csv=["Full name,Email,Phone,Congregation,Status,Date applied",...rows.map(r=>[r.full_name,r.email,r.phone,r.congregation,r.status,r.created_at].map(cell).join(","))].join("\r\n");
 res.setHeader("Content-Type","text/csv; charset=utf-8");res.setHeader("Content-Disposition",'attachment; filename="mavhola-youth-league-membership-applications.csv"');res.send("\uFEFF"+csv);
}));
app.get("/api/admin/applications/:id/proof",requireAdmin,asyncRoute(async(req,res)=>{
 const item=(await db.query("SELECT proof_filename,proof_original_name,proof_mime FROM applications WHERE id=$1",[req.params.id])).rows[0];
 if(!item?.proof_filename)return res.status(404).send("Proof of payment not found.");
 const object=await storage.getObjectStream(item.proof_filename);
 res.setHeader("Content-Type",item.proof_mime||"application/octet-stream");res.setHeader("Content-Disposition",`inline; filename="${safeName(item.proof_original_name)}"`);res.setHeader("Cache-Control","no-store");
 object.Body.pipe(res);
}));
app.post("/api/admin/applications/:id/decision",requireAdmin,asyncRoute(async(req,res)=>{
 const status=req.body.status,note=String(req.body.note||"");
 if(!["Approved","Rejected"].includes(status))return res.status(400).json({error:"Choose Approved or Rejected."});
 const applicant=(await db.query("SELECT * FROM applications WHERE id=$1",[req.params.id])).rows[0];
 if(!applicant)return res.status(404).json({error:"Application not found."});
 await db.query("UPDATE applications SET status=$1,admin_note=$2 WHERE id=$3",[status,note,req.params.id]);
 let emailSent=false;try{emailSent=await sendMail(applicant.email,`ELCSA Mavhola Parish – membership ${status.toLowerCase()}`,
 `Dear ${applicant.full_name},\n\nYour ELCSA Mavhola Parish Youth League membership application has been ${status.toLowerCase()}.\n${note?"\nMessage from the parish: "+note+"\n":""}\nRegards,\nELCSA Mavhola Parish`);}catch(e){console.error("Decision email failed:",e.message);}
 res.json({ok:true,emailSent});
}));
app.post("/api/admin/announcements",requireAdmin,asyncRoute(async(req,res)=>{
 const {title,body,pinned}=req.body;if(!title||!body)return res.status(400).json({error:"Title and announcement are required."});
 const r=await db.query("INSERT INTO announcements(title,body,pinned) VALUES($1,$2,$3) RETURNING id",[title,body,pinned?1:0]);res.json({ok:true,id:r.rows[0].id});
}));
app.put("/api/admin/announcements/:id",requireAdmin,asyncRoute(async(req,res)=>{
 const {title,body,pinned}=req.body||{};if(!title?.trim()||!body?.trim())return res.status(400).json({error:"Title and announcement are required."});
 const r=await db.query("UPDATE announcements SET title=$1,body=$2,pinned=$3 WHERE id=$4",[title.trim(),body.trim(),pinned?1:0,req.params.id]);if(!r.rowCount)return res.status(404).json({error:"Announcement not found."});res.json({ok:true});
}));
app.delete("/api/admin/announcements/:id",requireAdmin,asyncRoute(async(req,res)=>{await db.query("DELETE FROM announcements WHERE id=$1",[req.params.id]);res.json({ok:true});}));
app.post("/api/admin/events",requireAdmin,asyncRoute(async(req,res)=>{
 const {title,description,event_date,venue,ticket_price_cents,ticket_capacity}=req.body;if(!title)return res.status(400).json({error:"Event title is required."});
 const r=await db.query("INSERT INTO events(title,description,event_date,venue,ticket_price_cents,ticket_capacity) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[title,description||"",event_date||"",venue||"",Math.max(0,Number(ticket_price_cents)||0),Math.max(0,Number(ticket_capacity)||0)]);res.json({ok:true,id:r.rows[0].id});
}));
app.put("/api/admin/events/:id",requireAdmin,asyncRoute(async(req,res)=>{
 const {title,description,event_date,venue,ticket_price_cents,ticket_capacity}=req.body||{};if(!title?.trim())return res.status(400).json({error:"Event title is required."});
 const r=await db.query("UPDATE events SET title=$1,description=$2,event_date=$3,venue=$4,ticket_price_cents=$5,ticket_capacity=$6 WHERE id=$7",[title.trim(),description||"",event_date||"",venue||"",Math.max(0,Number(ticket_price_cents)||0),Math.max(0,Number(ticket_capacity)||0),req.params.id]);if(!r.rowCount)return res.status(404).json({error:"Event not found."});res.json({ok:true});
}));
app.delete("/api/admin/events/:id",requireAdmin,asyncRoute(async(req,res)=>{
 try{
  const result=await db.query("DELETE FROM events WHERE id=$1",[req.params.id]);
  if(!result.rowCount)return res.status(404).json({error:"Event not found."});
  res.json({ok:true});
 }catch(error){
  // Keep ticket order history intact; PostgreSQL correctly prevents deleting
  // an event that already has orders linked to it.
  if(error.code==="23503")return res.status(409).json({error:"This event has ticket orders linked to it and cannot be deleted. You can edit the event instead."});
  throw error;
 }
}));
app.post("/api/admin/media",requireAdmin,upload.single("file"),validateUpload("media"),asyncRoute(async(req,res)=>{
 if(!req.file)return res.status(400).json({error:"Choose an image or video (maximum 20 MB)."});
 const key=await storage.putObject({area:"gallery",originalName:req.file.originalname,buffer:req.file.buffer,contentType:req.file.mimetype});
 try{const r=await db.query("INSERT INTO media(title,description,filename,media_type) VALUES($1,$2,$3,$4) RETURNING id",[req.body.title||req.file.originalname,req.body.description||"",key,req.file.mimetype]);res.json({ok:true,id:r.rows[0].id});}
 catch(e){await storage.deleteObject(key).catch(()=>{});throw e;}
}));
app.put("/api/admin/media/:id",requireAdmin,asyncRoute(async(req,res)=>{
 const {title,description}=req.body||{};const r=await db.query("UPDATE media SET title=$1,description=$2 WHERE id=$3",[title||"",description||"",req.params.id]);if(!r.rowCount)return res.status(404).json({error:"Media item not found."});res.json({ok:true});
}));
app.delete("/api/admin/media/:id",requireAdmin,asyncRoute(async(req,res)=>{
 const item=(await db.query("SELECT filename FROM media WHERE id=$1",[req.params.id])).rows[0];if(item){await db.query("DELETE FROM media WHERE id=$1",[req.params.id]);await storage.deleteObject(item.filename).catch(e=>console.error("R2 media cleanup failed:",e.message));}res.json({ok:true});
}));
app.post("/api/admin/documents",requireAdmin,documentUpload.single("file"),validateUpload("document"),asyncRoute(async(req,res)=>{
 if(!req.file)return res.status(400).json({error:"Choose a supported document (maximum 25 MB)."});
 const title=String(req.body.title||"").trim()||path.basename(req.file.originalname,path.extname(req.file.originalname)),description=String(req.body.description||"").trim();
 const key=await storage.putObject({area:"documents",originalName:req.file.originalname,buffer:req.file.buffer,contentType:req.file.mimetype});
 try{const r=await db.query("INSERT INTO documents(title,description,filename,original_name,media_type) VALUES($1,$2,$3,$4,$5) RETURNING id",[title,description,key,path.basename(req.file.originalname),req.file.mimetype]);res.json({ok:true,id:r.rows[0].id});}
 catch(e){await storage.deleteObject(key).catch(()=>{});throw e;}
}));
app.put("/api/admin/documents/:id",requireAdmin,asyncRoute(async(req,res)=>{
 const title=String(req.body.title||"").trim(),description=String(req.body.description||"").trim();if(!title)return res.status(400).json({error:"Document title is required."});
 const r=await db.query("UPDATE documents SET title=$1,description=$2 WHERE id=$3",[title,description,req.params.id]);if(!r.rowCount)return res.status(404).json({error:"Document not found."});res.json({ok:true});
}));
app.delete("/api/admin/documents/:id",requireAdmin,asyncRoute(async(req,res)=>{
 const item=(await db.query("SELECT filename FROM documents WHERE id=$1",[req.params.id])).rows[0];if(item){await db.query("DELETE FROM documents WHERE id=$1",[req.params.id]);await storage.deleteObject(item.filename).catch(e=>console.error("R2 document cleanup failed:",e.message));}res.json({ok:true});
}));
app.get("/documents/:id/download",asyncRoute(async(req,res)=>{
 const item=(await db.query("SELECT filename,original_name,media_type FROM documents WHERE id=$1",[req.params.id])).rows[0];if(!item)return res.status(404).send("Document not found.");
 const object=await storage.getObjectStream(item.filename);res.setHeader("Content-Type",item.media_type||"application/octet-stream");res.setHeader("Content-Disposition",`attachment; filename="${safeName(item.original_name)}"`);object.Body.pipe(res);
}));
app.put("/api/admin/orders/:id",requireAdmin,asyncRoute(async(req,res)=>{
 const status=String(req.body?.status||"");if(!["Pending","Paid","Cancelled"].includes(status))return res.status(400).json({error:"Choose Pending, Paid or Cancelled."});
 // Lock the order while checking/changing status and creating tickets. This makes
 // concurrent admin clicks safe and ensures a ticket set is created only once.
 const result=await db.transaction(async client=>{
  const order=(await client.query("SELECT orders.*,events.title AS event_title,events.event_date,events.venue FROM orders JOIN events ON events.id=orders.event_id WHERE orders.id=$1 FOR UPDATE OF orders",[req.params.id])).rows[0];
  if(!order)return {notFound:true};
  let tickets=[];
  if(status==="Paid"){
   tickets=(await client.query("SELECT * FROM tickets WHERE order_id=$1 ORDER BY id",[order.id])).rows;
   // Never silently fulfil an order with a partial ticket set. Check before
   // changing status so the transaction can safely leave the order Pending.
   if(tickets.length!==0&&tickets.length!==Number(order.quantity))
    return {ticketMismatch:true,expected:Number(order.quantity),actual:tickets.length};
  }
  if(order.status!==status){
   if(order.status!=="Pending")return {conflict:true,currentStatus:order.status};
   await client.query("UPDATE orders SET status=$1 WHERE id=$2",[status,order.id]);
   order.status=status;
  }
  if(status==="Paid"&&!tickets.length){
   for(let i=0;i<order.quantity;i++){
    const ticket=await client.query("INSERT INTO tickets(order_id,token) VALUES($1,$2) RETURNING *",[order.id,crypto.randomBytes(24).toString("hex")]);
    tickets.push(ticket.rows[0]);
   }
  }
  return {order,tickets};
 });
 if(result.notFound)return res.status(404).json({error:"Ticket order not found."});
 if(result.ticketMismatch)return res.status(409).json({error:"Ticket records do not match the order quantity. The order status was not changed; please contact technical support."});
 if(result.conflict)return res.status(409).json({error:"This order is already "+result.currentStatus+". Only Pending orders can be changed."});
 const {order,tickets}=result;let emailSent=false;
 if(status==="Paid"){
  try{
   const claim=await db.query(`UPDATE orders SET tickets_email_claimed_at=NOW()
    WHERE id=$1 AND tickets_emailed_at IS NULL
     AND (tickets_email_claimed_at IS NULL OR tickets_email_claimed_at < NOW()-INTERVAL '10 minutes')
    RETURNING id`,[order.id]);
   if(claim.rowCount){
    try{
     const attachments=[];
     for(let i=0;i<tickets.length;i++){
      const content=await buildTicketPdf({...tickets[i],position:i+1},order,{title:order.event_title,event_date:order.event_date,venue:order.venue});
      attachments.push({filename:"MAV-T"+String(tickets[i].id).padStart(6,"0")+".pdf",content});
     }
     emailSent=await sendMail(order.buyer_email,"Your ELCSA Mavhola Parish e-ticket(s) – Order MAV-"+String(order.id).padStart(6,"0"),
      "Dear "+order.buyer_name+",\\n\\nYour EFT payment has been verified. Your booking is confirmed. Your individual PDF e-ticket(s), each with a unique QR code, are attached to this email.\\n\\nEvent: "+order.event_title+"\\nDate: "+(order.event_date||"To be announced")+"\\nVenue: "+(order.venue||"To be announced")+"\\nTickets: "+order.quantity+"\\nAmount paid: R "+(order.total_cents/100).toFixed(2)+"\\nOrder reference: MAV-"+String(order.id).padStart(6,"0")+"\\n\\nPlease bring your ticket(s) and show the QR code(s) at the entrance.\\n\\nELCSA Mavhola Parish Youth League",attachments);
     if(emailSent)await db.query("UPDATE orders SET tickets_emailed_at=NOW(),tickets_email_claimed_at=NULL WHERE id=$1",[order.id]);
     else await db.query("UPDATE orders SET tickets_email_claimed_at=NULL WHERE id=$1",[order.id]);
    }catch(error){
     await db.query("UPDATE orders SET tickets_email_claimed_at=NULL WHERE id=$1",[order.id]).catch(()=>{});
     throw error;
    }
   }else{
    const state=(await db.query("SELECT tickets_emailed_at FROM orders WHERE id=$1",[order.id])).rows[0];
    emailSent=Boolean(state?.tickets_emailed_at);
   }
  }catch(e){console.error("E-ticket generation/email failed:",e.message);}
 }
 res.json({ok:true,emailSent,ticketCount:status==="Paid"?tickets.length:0});
}));
app.post("/api/admin/tickets/check-in",requireAdmin,asyncRoute(async(req,res)=>{
 const rawToken=String(req.body?.token||"").trim();
 const tokenMatch=rawToken.match(/([a-f0-9]{48})\/?$/i);
 const token=tokenMatch?tokenMatch[1]:"";
 if(!token)return res.status(400).json({error:"Enter a valid ticket QR token or verification link."});
 const redeemed=await db.query(`UPDATE tickets SET redeemed_at=NOW()
  FROM orders WHERE tickets.order_id=orders.id AND tickets.token=$1
   AND orders.status='Paid' AND tickets.redeemed_at IS NULL
  RETURNING tickets.id`,[token]);
 if(redeemed.rowCount)return res.json({ok:true,status:"redeemed",ticketNumber:"MAV-T"+String(redeemed.rows[0].id).padStart(6,"0")});
 const existing=(await db.query(`SELECT tickets.id,tickets.redeemed_at,orders.status
  FROM tickets JOIN orders ON orders.id=tickets.order_id WHERE tickets.token=$1`,[token])).rows[0];
 if(!existing)return res.status(404).json({error:"Ticket not found."});
 if(existing.status!=="Paid")return res.status(409).json({error:"This ticket is not paid and cannot be admitted."});
 if(existing.redeemed_at)return res.status(409).json({error:"This ticket has already been used."});
 return res.status(409).json({error:"Ticket could not be checked in. Please try again."});
}));
app.put("/api/admin/settings",requireAdmin,asyncRoute(async(req,res)=>{
 const allowed=["parish_email","parish_phone","parish_address","tagline","eft_account_name","eft_bank_name","eft_account_number","eft_branch_code","eft_reference_instructions","membership_open_date","membership_close_date"];
 const opening=String(req.body?.membership_open_date||"").trim(),closing=String(req.body?.membership_close_date||"").trim();
 const validDate=value=>!value||(/^\\d{4}-\\d{2}-\\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(value+"T00:00:00Z").toISOString().slice(0,10)===value);
 if(!validDate(opening)||!validDate(closing))return res.status(400).json({error:"Enter valid opening and closing dates."});
 if(Boolean(opening)!==Boolean(closing))return res.status(400).json({error:"Please enter both the opening date and closing date, or clear both dates to remove the schedule."});
 if(opening&&closing<opening)return res.status(400).json({error:"The closing date cannot be earlier than the opening date."});
 await db.transaction(async client=>{for(const key of allowed)await client.query("INSERT INTO site_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[key,String(req.body?.[key]||"").trim()]);});res.json({ok:true});
}));
app.post("/api/tickets/checkout",asyncRoute(async(req,res)=>{
 const {event_id,buyer_name,buyer_email,quantity}=req.body||{};const qty=Math.max(1,Math.min(10,Number(quantity)||1));
 if(!buyer_name?.trim()||!buyer_email?.includes("@"))return res.status(400).json({error:"Please check your name and a valid email address."});
 const created=await db.transaction(async client=>{
  const event=(await client.query("SELECT * FROM events WHERE id=$1 FOR UPDATE",[event_id])).rows[0];if(!event||event.ticket_price_cents<=0)return {error:"Please check the event and ticket details."};
  const sold=Number((await client.query("SELECT COALESCE(SUM(quantity),0) AS n FROM orders WHERE event_id=$1 AND status IN ('Paid','Pending')",[event.id])).rows[0].n);
  if(event.ticket_capacity>0&&sold+qty>event.ticket_capacity)return {error:"There are not enough tickets remaining."};
  const order=(await client.query("INSERT INTO orders(event_id,buyer_name,buyer_email,quantity,total_cents,status) VALUES($1,$2,$3,$4,$5,'Pending') RETURNING id",[event.id,buyer_name.trim(),buyer_email.trim(),qty,event.ticket_price_cents*qty])).rows[0];
  return {event,order};
 });
 if(created.error)return res.status(400).json({error:created.error});
 const {event,order}=created,settings=await settingsObject(),reference="MAV-"+String(order.id).padStart(6,"0");
 const eft=[settings.eft_account_name&&"Account name: "+settings.eft_account_name,settings.eft_bank_name&&"Bank: "+settings.eft_bank_name,settings.eft_account_number&&"Account number: "+settings.eft_account_number,settings.eft_branch_code&&"Branch code: "+settings.eft_branch_code,settings.eft_reference_instructions||"Use the order reference below as your EFT payment reference."].filter(Boolean).join("\n");
 let emailSent=false;try{emailSent=await sendMail(buyer_email.trim(),"ELCSA Mavhola Parish – ticket order "+reference,
  "Dear "+buyer_name.trim()+",\n\nThank you for booking tickets. Your order is awaiting EFT payment verification. This is not yet a paid ticket.\n\nORDER DETAILS\nOrder reference: "+reference+"\nEvent: "+event.title+"\nDate: "+(event.event_date||"To be announced")+"\nVenue: "+(event.venue||"To be announced")+"\nTickets: "+qty+"\nTotal due: R "+((event.ticket_price_cents*qty)/100).toFixed(2)+"\nPayment method: EFT\n\nEFT PAYMENT DETAILS\n"+(eft||"Please contact the parish for EFT banking details.")+"\n\nYour paid ticket confirmation will be emailed once payment is verified.\n\nELCSA Mavhola Parish");}catch(e){console.error("Ticket order email failed:",e.message);}
 res.status(201).json({ok:true,orderReference:reference,emailSent,message:"Your ticket order "+reference+" has been recorded. Please pay by EFT and wait for the parish to verify your payment."});
}));
app.get("/ticket/verify/:token",asyncRoute(async(req,res)=>{
 const t=(await db.query("SELECT tickets.id,tickets.redeemed_at,events.title AS event_title,events.event_date,events.venue FROM tickets JOIN orders ON orders.id=tickets.order_id JOIN events ON events.id=orders.event_id WHERE tickets.token=$1 AND orders.status='Paid'",[req.params.token])).rows[0];
 if(!t)return res.status(404).type("html").send("<!doctype html><html><body><h1>Ticket not found</h1><p>This QR code is not recognised as a paid ticket.</p></body></html>");
 const esc=s=>String(s||"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
 const used=Boolean(t.redeemed_at);
 const heading=used?"TICKET ALREADY USED":"VALID PAID TICKET";
 const message=used?"This ticket has already been checked in. It cannot be used for admission again.":"This ticket is valid for admission. Present it to event staff for check-in.";
 res.type("html").send("<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'><title>Ticket verification</title></head><body style='font-family:Arial;background:#f4f6fa;padding:24px'><main style='max-width:520px;margin:30px auto;background:white;padding:28px;border-radius:14px;text-align:center'><img src='/youth-league-logo.png' alt='Youth League' style='max-width:130px;max-height:110px'><h1 style='color:"+(used?"#a12626":"#092b67")+"'>"+heading+"</h1><p><b>"+esc(t.event_title)+"</b></p><p>"+esc(t.event_date||"Date to be announced")+" · "+esc(t.venue||"Venue to be announced")+"</p><p>Ticket number: MAV-T"+String(t.id).padStart(6,"0")+"</p><p>"+message+"</p></main></body></html>");
}));
// Render preview readiness check: confirm the app and PostgreSQL are reachable.
app.get("/healthz",asyncRoute(async(req,res)=>{
 await db.query("SELECT 1");
 res.json({ok:true,database:"connected"});
}));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public/index.html")));
app.use((err,req,res,next)=>{console.error("Request failed:",err.message);if(res.headersSent)return next(err);res.status(err.code==="LIMIT_FILE_SIZE"?413:500).json({error:err.code==="LIMIT_FILE_SIZE"?"The uploaded file is too large.":"The request could not be completed. Please try again."});});
bootstrap().then(()=>app.listen(PORT,()=>console.log("ELCSA Mavhola Parish website listening on "+PORT))).catch(err=>{console.error("Startup failed:",err);process.exit(1);});
