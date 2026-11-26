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
const {PDFDocument,StandardFonts,rgb,degrees}=require("pdf-lib");
const QRCode=require("qrcode");
const db=require("./database");
const storage=require("./storage");
const {validateUpload}=require("./upload-validation");

const app=express();
// Bind the Render web-service port immediately. Express allows routes and middleware
// to be registered after listen(), so slow route setup cannot trigger a port-scan timeout.
const PORT=process.env.PORT||3000;
const server=app.listen(PORT,"0.0.0.0",()=>console.log("ELCSA Mavhola Parish website listening on "+PORT));
server.on("error",error=>{console.error("HTTP server failed to bind:",error);process.exit(1);});
let startupReady=false;
let startupFailure=null;
app.set("trust proxy",1);
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
   body:JSON.stringify({from:process.env.MAIL_FROM||"ELCSA Mavhola Parish <tickets@send.mavholaparish.co.za>",to:[to],subject,text,
    attachments:attachments.map(a=>({filename:a.filename,content:a.content.toString("base64")}))})});
  if(!response.ok)throw new Error("Resend email error: "+response.status+" "+await response.text());
  return true;
 }
 if(!mailer)return false;
 await mailer.sendMail({from:process.env.MAIL_FROM||process.env.SMTP_USER,to,subject,text,attachments});
 return true;
}

async function buildTicketPdf(ticket, order, event) {
 // Final church-colour ticket: navy/white, logo-inspired watermark, clean QR,
 // readable attendee details, and domain/event footer around the ticket.
 const W=600,H=640,outer=34,top=78,bottom=82,gap=12;
 const leftX=outer,leftW=258,rightX=leftX+leftW+gap,rightW=W-outer-rightX;
 const panelY=bottom,panelH=H-top-bottom;
 const pdf=await PDFDocument.create(),page=pdf.addPage([W,H]);
 const font=await pdf.embedFont(StandardFonts.Helvetica),bold=await pdf.embedFont(StandardFonts.HelveticaBold);
 const navy=rgb(0.04,0.10,0.42),white=rgb(1,1,1),pale=rgb(0.96,0.97,1),ink=rgb(0.04,0.10,0.42);
 const ticketNo="MAV-T"+String(ticket.id).padStart(6,"0");
 const title=String(event.title||"Parish Event").slice(0,58);
 const rawDate=event.event_date||"";
 const parsedDate=rawDate?new Date(rawDate):null;
 const validDate=parsedDate&&!Number.isNaN(parsedDate.getTime());
 const date=validDate?parsedDate.toLocaleDateString("en-ZA",{timeZone:"Africa/Johannesburg",day:"2-digit",month:"long",year:"numeric"}):"Date to be announced";
 const time=validDate?parsedDate.toLocaleTimeString("en-ZA",{timeZone:"Africa/Johannesburg",hour:"2-digit",minute:"2-digit",hour12:false}):"Time to be announced";
 const venue=String(event.venue||"Venue to be announced").slice(0,48);
 const buyer=String(order.buyer_name||"Guest").slice(0,48);
 const quantity=Math.max(1,Number(order.quantity)||1);
 const unitPriceCents=Number.isFinite(Number(order.total_cents))?Math.round(Number(order.total_cents)/quantity):Number(event.ticket_price_cents)||0;
 const ticketPrice="R"+(unitPriceCents/100).toFixed(2);
 const drawFit=(text,x,y,maxWidth,size,f,color)=>{
  const s=String(text||"");let current=size;
  while(current>7&&f.widthOfTextAtSize(s,current)>maxWidth)current-=0.5;
  page.drawText(s,{x,y,size:current,font:f,color});
 };
 // Pale page with the actual ELCSA parish logo as a subtle background watermark.
 page.drawRectangle({x:0,y:0,width:W,height:H,color:pale});
 const logoBytes=fs.readFileSync(path.join(__dirname,"public","elcsa-logo-watermark.png"));
 const parishLogo=await pdf.embedPng(logoBytes);
 page.drawImage(parishLogo,{x:W/2-112,y:H/2-112,width:224,height:224,opacity:0.13});
 // ticket panels
 page.drawRectangle({x:leftX,y:panelY,width:leftW,height:panelH,color:navy});
 page.drawRectangle({x:rightX,y:panelY,width:rightW,height:panelH,color:navy});
 const goldH=panelH*0.43,goldY=panelY;
 page.drawRectangle({x:leftX,y:goldY,width:leftW,height:goldH,color:white});
 // Repeat the real parish crest faintly inside the white ticket-information panel.
 // Text is drawn afterwards, so names and ticket details remain crisp and readable.
 page.drawImage(parishLogo,{x:leftX+(leftW-142)/2,y:goldY+(goldH-142)/2,width:142,height:142,opacity:0.10});
 // QR section: keep the heading in its own top row and give the QR a larger,
 // centred area below it. The domain is already printed in the page footer,
 // so it is intentionally not repeated across the heading or QR.
 const base=(process.env.PUBLIC_BASE_URL||"https://mavholaparish.co.za").replace(/\/$/,"");
 const verifyUrl=base+"/ticket/verify/"+encodeURIComponent(ticket.token);
 const qrData=await QRCode.toDataURL(verifyUrl,{errorCorrectionLevel:"H",margin:2,width:600});
 const qr=await pdf.embedPng(Buffer.from(qrData.split(",")[1],"base64"));
 const q=150,qrX=leftX+(leftW-q)/2,qrY=panelY+goldH+18;
 const heading="E-TICKET",headingSize=24;
 page.drawText(heading,{x:leftX+leftW/2-bold.widthOfTextAtSize(heading,headingSize)/2,y:panelY+panelH-48,size:headingSize,font:bold,color:white});
 page.drawImage(qr,{x:qrX,y:qrY,width:q,height:q});
 // White attendee information block: generous size, no overlapping decorations.
 const half=leftW/2;
 drawFit(title.toUpperCase(),leftX+18,goldY+goldH-28,leftW-36,15,bold,ink);
 drawFit(venue.toUpperCase(),leftX+18,goldY+goldH-47,leftW-36,9,bold,ink);
 drawFit("Ticket ID:",leftX+20,goldY+goldH-76,half-28,12,bold,ink);
 drawFit(ticketNo,leftX+20,goldY+goldH-92,half-28,12,font,ink);
 drawFit("Name:",leftX+half+3,goldY+goldH-76,half-26,12,bold,ink);
 drawFit(buyer,leftX+half+3,goldY+goldH-92,half-26,12,font,ink);
 drawFit("Date:",leftX+20,goldY+goldH-119,half-28,12,bold,ink);
 drawFit(date,leftX+20,goldY+goldH-135,half-28,12,font,ink);
 drawFit("Time:",leftX+half+3,goldY+goldH-119,half-26,12,bold,ink);
 drawFit(time,leftX+half+3,goldY+goldH-135,half-26,12,font,ink);
 drawFit("Price:",leftX+20,goldY+goldH-160,half-28,12,bold,ink);
 drawFit(ticketPrice,leftX+20,goldY+goldH-176,half-28,13,bold,ink);
 // Right panel: vertically centred event title with font constrained to panel height.
 let verticalSize=22;
 while(verticalSize>12&&bold.widthOfTextAtSize(title.toUpperCase(),verticalSize)>panelH-100)verticalSize-=0.5;
 const verticalWidth=bold.widthOfTextAtSize(title.toUpperCase(),verticalSize);
 page.drawText(title.toUpperCase(),{x:rightX+rightW/2-verticalSize/2,y:panelY+panelH/2-verticalWidth/2,size:verticalSize,font:bold,color:white,rotate:degrees(90)});
 const sub="ELCSA MAVHOLA PARISH YOUTH LEAGUE";
 page.drawText(sub,{x:rightX+rightW/2+verticalSize/2+14,y:panelY+panelH/2-bold.widthOfTextAtSize(sub,7)/2,size:7,font:bold,color:white,rotate:degrees(90)});
 // Footer outside the two ticket panels, centred on the light page margin.
 const footer="MAVHOLAPARISH.CO.ZA  •  CONFERENCE GALA DINNER";
 const footerSize=10;
 page.drawText(footer,{x:W/2-bold.widthOfTextAtSize(footer,footerSize)/2,y:30,size:footerSize,font:bold,color:navy});
 return Buffer.from(await pdf.save());
}
function asyncRoute(fn){return (req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);}
function fileFilter(allowed){return (req,file,cb)=>cb(null,allowed(file));}
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:20*1024*1024,files:1},
 fileFilter:fileFilter((f)=>/^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm))$/.test(f.mimetype))});
const documentUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:25*1024*1024,files:1},
 fileFilter:fileFilter(f=>[".pdf",".doc",".docx",".xls",".xlsx",".ppt",".pptx",".txt"].includes(path.extname(f.originalname).toLowerCase()))});
const csvUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:1},
 fileFilter:(req,file,cb)=>cb(null,path.extname(file.originalname).toLowerCase()===".csv"||/csv|text\/plain/i.test(file.mimetype))});
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
app.use("/api",(req,res,next)=>{
 if(!startupReady)return res.status(503).json({error:"The parish system is starting. Please try again shortly."});
 next();
});
app.use("/api",rateLimit({windowMs:15*60*1000,max:100}));
const shopRouter=require("./shop-router")({db,storage,sendMail,requireAdmin});
app.use("/api/shop",shopRouter);

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
 await db.query(`CREATE TABLE IF NOT EXISTS admin_password_resets (
  id BIGSERIAL PRIMARY KEY, admin_id BIGINT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 )`);
 await db.query("CREATE INDEX IF NOT EXISTS admin_password_resets_expiry_idx ON admin_password_resets(expires_at)");
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

const passwordResetRequestLimiter=rateLimit({windowMs:60*60*1000,max:5,standardHeaders:true,legacyHeaders:false,message:{error:"Too many reset requests. Please wait before trying again."}});
const passwordResetSubmitLimiter=rateLimit({windowMs:60*60*1000,max:10,standardHeaders:true,legacyHeaders:false});
app.post("/api/admin/forgot-password",passwordResetRequestLimiter,asyncRoute(async(req,res)=>{
 const email=String(req.body.email||"").trim().toLowerCase();
 const genericMessage="If that email address belongs to an administrator, a password reset link will be sent shortly.";
 if(!email||email.length>254)return res.json({ok:true,message:genericMessage});
 const found=await db.query("SELECT id,email FROM admins WHERE LOWER(email)=LOWER($1)",[email]);
 if(found.rowCount){
  const admin=found.rows[0],rawToken=crypto.randomBytes(32).toString("hex");
  const tokenHash=crypto.createHash("sha256").update(rawToken).digest("hex");
  await db.query("DELETE FROM admin_password_resets WHERE admin_id=$1 OR expires_at<NOW()",[admin.id]);
  await db.query("INSERT INTO admin_password_resets(admin_id,token_hash,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 minutes')",[admin.id,tokenHash]);
  const resetUrl=new URL("/",`${req.protocol}://${req.get("host")}`);
  resetUrl.searchParams.set("adminReset",rawToken);
  try{
   const sent=await sendMail(admin.email,"ELCSA Mavhola Parish – administrator password reset",
    `A request was made to reset the administrator password for your ELCSA Mavhola Parish website account.\n\nUse this secure link within 30 minutes to choose a new password:\n${resetUrl.toString()}\n\nIf you did not request this, you can ignore this email. Your password will not change.\n\nELCSA Mavhola Parish`);
   if(!sent)console.error("Admin password reset email could not be sent: no email transport is configured.");
  }catch(error){console.error("Admin password reset email failed:",error?.message||error);}
 }
 res.json({ok:true,message:genericMessage});
}));
app.post("/api/admin/reset-password",passwordResetSubmitLimiter,asyncRoute(async(req,res)=>{
 const token=String(req.body.token||""),password=String(req.body.password||"");
 if(!/^[a-f0-9]{64}$/i.test(token))return res.status(400).json({error:"This reset link is invalid or has expired. Please request a new one."});
 if(password.length<10||password.length>200)return res.status(400).json({error:"Your new password must be between 10 and 200 characters."});
 const tokenHash=crypto.createHash("sha256").update(token).digest("hex");
 const found=await db.query("SELECT id FROM admin_password_resets WHERE token_hash=$1 AND expires_at>NOW()",[tokenHash]);
 if(!found.rowCount)return res.status(400).json({error:"This reset link is invalid or has expired. Please request a new one."});
 const passwordHash=await bcrypt.hash(password,12);
 const updated=await db.query(`WITH consumed AS (
  DELETE FROM admin_password_resets WHERE id=$2 AND expires_at>NOW() RETURNING admin_id
 ) UPDATE admins SET password_hash=$1 WHERE id=(SELECT admin_id FROM consumed) RETURNING id`,[passwordHash,found.rows[0].id]);
 if(!updated.rowCount)return res.status(400).json({error:"This reset link is invalid or has expired. Please request a new one."});
 res.json({ok:true,message:"Your password has been reset successfully. You can now sign in."});
}));

app.post("/api/admin/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/api/admin/me",requireAdmin,(req,res)=>res.json(req.session.admin));
// Admin finance ledger: income and expenses recorded with a transaction date and reference.
app.post("/api/admin/finance-records",requireAdmin,asyncRoute(async(req,res)=>{
 const type=String(req.body.type||""),category=String(req.body.category||"").trim(),description=String(req.body.description||"").trim(),date=String(req.body.transaction_date||""),reference=String(req.body.reference||"").trim(),amount=Number(req.body.amount);
 if(!["Income","Expense"].includes(type)||!category||!description||!/^\\d{4}-\\d{2}-\\d{2}$/.test(date)||!Number.isFinite(amount)||amount<=0||amount>100000000)return res.status(400).json({error:"Enter a valid type, category, description, date and positive amount."});
 const inserted=await db.query("INSERT INTO parish_finance_records(type,category,description,amount_cents,transaction_date,reference) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[type,category,description,Math.round(amount*100),date,reference]);
 res.status(201).json({record:inserted.rows[0]});
}));
app.delete("/api/admin/finance-records/:id",requireAdmin,asyncRoute(async(req,res)=>{
 const deleted=await db.query("DELETE FROM parish_finance_records WHERE id=$1 RETURNING id");if(!deleted.rowCount)return res.status(404).json({error:"Finance record not found."});res.json({ok:true});
}));
\napp.get("/api/admin/dashboard",requireAdmin,asyncRoute(async(req,res)=>{
 const [applications,announcements,events,media,documents,orders,settings,financeRecords]=await Promise.all([
  db.query("SELECT id,full_name,email,phone,date_of_birth,occupation,congregation,address,motivation,status,admin_note,created_at,(proof_filename IS NOT NULL)::int AS has_proof,proof_original_name FROM applications ORDER BY created_at DESC"),
  db.query("SELECT * FROM announcements ORDER BY created_at DESC"),
  db.query("SELECT * FROM events ORDER BY event_date ASC"),
  db.query("SELECT * FROM media ORDER BY created_at DESC"),
  db.query("SELECT * FROM documents ORDER BY created_at DESC"),
  db.query("SELECT orders.*,events.title AS event_title,COALESCE((SELECT string_agg('MAV-T'||LPAD(t.id::text,6,'0'), ', ' ORDER BY t.id) FROM tickets t WHERE t.order_id=orders.id),'') AS ticket_numbers,'MAV-'||LPAD(orders.id::text,6,'0') AS order_reference FROM orders JOIN events ON events.id=orders.event_id ORDER BY orders.created_at DESC"),
  settingsObject(),
  db.query("SELECT * FROM parish_finance_records ORDER BY transaction_date DESC,id DESC")
 ]);
 res.json({applications:applications.rows,announcements:announcements.rows,events:events.rows,media:media.rows,documents:documents.rows,orders:orders.rows,settings,financeRecords:financeRecords.rows});
}));
// Private parish member directory. All routes are admin-only and do not expose this data publicly.
function parseCsvRows(input){
 const rows=[];let row=[],field="",quoted=false;
 for(let i=0;i<input.length;i++){const ch=input[i];
  if(quoted){if(ch==='"'&&input[i+1]==='"'){field+='"';i++;}else if(ch==='"'){quoted=false;}else field+=ch;}
  else if(ch==='"'){quoted=true;}
  else if(ch===","){row.push(field);field="";}
  else if(ch==="\n"||ch==="\r"){if(ch==="\r"&&input[i+1]==="\n")i++;row.push(field);field="";if(row.some(v=>v.trim()))rows.push(row);row=[];}
  else field+=ch;
 }
 if(field.length||row.length){row.push(field);if(row.some(v=>v.trim()))rows.push(row);}
 return rows;
}
function memberCsvHeaderIndex(headers,label){return headers.findIndex(h=>String(h||"").trim().toLowerCase()===label.toLowerCase());}
app.get("/api/admin/parish-members",requireAdmin,asyncRoute(async(req,res)=>{
 const [members,congregations,campaigns]=await Promise.all([
  db.query("SELECT * FROM parish_members ORDER BY full_name"),
  db.query("SELECT DISTINCT congregation FROM parish_members WHERE congregation<>'' ORDER BY congregation"),
  db.query("SELECT * FROM parish_email_campaigns ORDER BY created_at DESC LIMIT 30")
 ]);
 res.json({members:members.rows,congregations:congregations.rows.map(r=>r.congregation),campaigns:campaigns.rows});
}));
app.post("/api/admin/parish-members/import",requireAdmin,csvUpload.single("file"),asyncRoute(async(req,res)=>{
 if(!req.file)return res.status(400).json({error:"Choose the cleaned members CSV file to import."});
 const raw=req.file.buffer.toString("utf8").replace(/^\uFEFF/,"");
 const rows=parseCsvRows(raw);if(rows.length<2)return res.status(400).json({error:"The CSV file contains no member rows."});
 const headers=rows[0],indices={name:memberCsvHeaderIndex(headers,"Full Name"),email:memberCsvHeaderIndex(headers,"Email"),phone:memberCsvHeaderIndex(headers,"Contact Number"),congregation:memberCsvHeaderIndex(headers,"Congregation")};
 if(Object.values(indices).some(i=>i<0))return res.status(400).json({error:"CSV headings must be Full Name, Email, Contact Number and Congregation."});
 let imported=0,updated=0,skipped=0;
 for(const row of rows.slice(1)){
  const name=String(row[indices.name]||"").trim(),email=String(row[indices.email]||"").trim().toLowerCase(),phone=String(row[indices.phone]||"").trim(),congregation=String(row[indices.congregation]||"").trim();
  if(!name){skipped++;continue;}
  if(email&&!/^\S+@\S+\.\S+$/.test(email)){skipped++;continue;}
  if(email){
   const prior=await db.query("SELECT id FROM parish_members WHERE LOWER(email)=LOWER($1)",[email]);
   await db.query("INSERT INTO parish_members(full_name,email,contact_number,congregation) VALUES($1,$2,$3,$4) ON CONFLICT (LOWER(email)) WHERE email IS NOT NULL AND email<>'' DO UPDATE SET full_name=EXCLUDED.full_name,contact_number=EXCLUDED.contact_number,congregation=EXCLUDED.congregation,updated_at=NOW()",[name,email,phone,congregation]);
   if(prior.rowCount)updated++;else imported++;
  }else{await db.query("INSERT INTO parish_members(full_name,email,contact_number,congregation) VALUES($1,NULL,$2,$3)",[name,phone,congregation]);imported++;}
 }
 res.json({ok:true,imported,updated,skipped,total:imported+updated});
}));
app.post("/api/admin/parish-members/email",requireAdmin,asyncRoute(async(req,res)=>{
 const subject=String(req.body.subject||"").trim(),message=String(req.body.message||"").trim(),filter=String(req.body.congregation||"ALL").trim();
 if(!subject||!message)return res.status(400).json({error:"Email subject and message are required."});
 if(subject.length>180||message.length>10000)return res.status(400).json({error:"Subject or message is too long."});
 const selected=await db.query(filter==="ALL"?"SELECT id,full_name,email FROM parish_members WHERE email IS NOT NULL AND email<>'' ORDER BY full_name":"SELECT id,full_name,email FROM parish_members WHERE email IS NOT NULL AND email<>'' AND congregation=$1 ORDER BY full_name",[...(filter==="ALL"?[]:[filter])]);
 const recipients=selected.rows;const unique=new Map();for(const m of recipients)if(m.email)unique.set(String(m.email).trim().toLowerCase(),m);
 const list=[...unique.values()];if(!list.length)return res.status(400).json({error:"No members with email addresses match this selection."});
 if(list.length>3000)return res.status(400).json({error:"This email campaign exceeds the safe batch limit of 3,000 recipients."});
 const campaign=(await db.query("INSERT INTO parish_email_campaigns(subject,message,congregation_filter,recipient_count) VALUES($1,$2,$3,$4) RETURNING id",[subject,message,filter,list.length])).rows[0];
 let sent=0,failed=0;
 for(const member of list){
  let status="Failed",error=null;
  try{const delivered=await sendMail(member.email,subject,"Dear "+member.full_name+",\n\n"+message+"\n\nELCSA Mavhola Parish");if(delivered){status="Sent";sent++;}else{error="Email delivery is not configured.";failed++;}}
  catch(e){error=String(e.message||e).slice(0,500);failed++;}
  await db.query("INSERT INTO parish_email_campaign_recipients(campaign_id,member_id,email,status,error,sent_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $4='Sent' THEN NOW() ELSE NULL END)",[campaign.id,member.id,member.email,status,error]);
 }
 await db.query("UPDATE parish_email_campaigns SET sent_count=$1,failed_count=$2 WHERE id=$3",[sent,failed,campaign.id]);
 res.json({ok:true,campaign_id:campaign.id,total:list.length,sent,failed});
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
app.delete("/api/admin/orders/:id",requireAdmin,asyncRoute(async(req,res)=>{
 const orderId=Number(req.params.id);
 if(!Number.isSafeInteger(orderId)||orderId<1)return res.status(400).json({error:"Invalid ticket order ID."});
 // Explicitly remove ticket rows before the order. This works even on databases
 // whose existing foreign-key constraint predates ON DELETE CASCADE.
 const result=await db.transaction(async client=>{
  const order=await client.query("SELECT id FROM orders WHERE id=$1 FOR UPDATE",[orderId]);
  if(!order.rowCount)return {notFound:true};
  const deletedTickets=await client.query("DELETE FROM tickets WHERE order_id=$1",[orderId]);
  const deletedOrder=await client.query("DELETE FROM orders WHERE id=$1 RETURNING id",[orderId]);
  return {deletedOrder:deletedOrder.rows[0],deletedTicketCount:deletedTickets.rowCount};
 });
 if(result.notFound)return res.status(404).json({error:"Ticket order not found. It may already have been deleted."});
 res.json({ok:true,deletedOrderId:Number(result.deletedOrder.id),deletedTicketCount:result.deletedTicketCount});
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
 const {order,tickets}=result;let emailSent=false,emailError="";
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
      "Dear "+order.buyer_name+",\n\nYour payment has been verified. Your booking is confirmed. Your individual PDF e-ticket(s), each with a unique QR code, are attached to this email.\n\nEvent: "+order.event_title+"\nDate: "+(order.event_date||"To be announced")+"\nVenue: "+(order.venue||"To be announced")+"\nTickets: "+order.quantity+"\nAmount paid: R "+(order.total_cents/100).toFixed(2)+"\nOrder reference: MAV-"+String(order.id).padStart(6,"0")+"\n\nPlease bring your ticket(s) and show the QR code(s) at the entrance.\n\nELCSA Mavhola Parish Youth League",attachments);
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
  }catch(e){emailError="Ticket generation or email delivery failed. Please check the Render service logs.";console.error("E-ticket generation/email failed:",e.message);}
 }
 res.json({ok:true,emailSent,emailError,ticketCount:status==="Paid"?tickets.length:0});
}));
app.post("/api/admin/orders/:id/resend-tickets",requireAdmin,asyncRoute(async(req,res)=>{
 const orderId=Number(req.params.id);
 if(!Number.isSafeInteger(orderId)||orderId<1)return res.status(400).json({error:"Invalid ticket order ID."});
 const order=(await db.query(`SELECT orders.*,events.title AS event_title,events.event_date,events.venue
  FROM orders JOIN events ON events.id=orders.event_id WHERE orders.id=$1`,[orderId])).rows[0];
 if(!order)return res.status(404).json({error:"Ticket order not found."});
 if(!["Paid","Used"].includes(order.status))return res.status(409).json({error:"Tickets can only be resent for a payment-verified order."});
 const tickets=(await db.query("SELECT * FROM tickets WHERE order_id=$1 ORDER BY id",[orderId])).rows;
 if(tickets.length!==Number(order.quantity)||!tickets.length)
  return res.status(409).json({error:"The issued ticket records do not match the order quantity. No email was sent; please contact technical support."});
 const attachments=[];
 for(let i=0;i<tickets.length;i++){
  const content=await buildTicketPdf({...tickets[i],position:i+1},order,{title:order.event_title,event_date:order.event_date,venue:order.venue});
  attachments.push({filename:"MAV-T"+String(tickets[i].id).padStart(6,"0")+".pdf",content});
 }
 const reference="MAV-"+String(order.id).padStart(6,"0");
 try{
  const emailSent=await sendMail(order.buyer_email,
   "Your ELCSA Mavhola Parish e-ticket(s) – "+reference,
   "Dear "+order.buyer_name+",\n\nAs requested, we are resending your existing e-ticket(s). Your original ticket number(s) and QR code(s) remain unchanged.\n\nEvent: "+order.event_title+"\nDate: "+(order.event_date||"To be announced")+"\nVenue: "+(order.venue||"To be announced")+"\nTickets: "+order.quantity+"\nOrder number / EFT payment reference: "+reference+"\nTicket number(s): "+tickets.map(t=>"MAV-T"+String(t.id).padStart(6,"0")).join(", ")+"\n\nPlease keep these tickets safe. A ticket that has already been scanned remains used; resending does not reset its entry status.\n\nELCSA Mavhola Parish Youth League",attachments);
  if(!emailSent)return res.status(503).json({error:"Email is not configured on the server. Check RESEND_API_KEY or SMTP settings."});
  res.json({ok:true,emailSent:true,ticketCount:tickets.length,buyerEmail:order.buyer_email,orderReference:reference});
 }catch(error){
  console.error("Admin resend ticket email failed for order "+orderId+":",error?.stack||error);
  return res.status(502).json({error:"Ticket resend failed: "+String(error?.message||"email provider error").slice(0,500)});
 }
}));
app.post("/api/admin/events/:id/ticket-reminders",requireAdmin,asyncRoute(async(req,res)=>{
 const eventId=Number(req.params.id);
 if(!Number.isSafeInteger(eventId)||eventId<1)return res.status(400).json({error:"Choose a valid event."});
 const subject=String(req.body?.subject||"").trim().slice(0,180);
 const message=String(req.body?.message||"").trim().slice(0,5000);
 if(!subject||!message)return res.status(400).json({error:"Enter an email subject and reminder message."});
 const event=(await db.query("SELECT id,title,event_date,venue FROM events WHERE id=$1",[eventId])).rows[0];
 if(!event)return res.status(404).json({error:"Event not found."});
 const buyers=(await db.query(`SELECT LOWER(BTRIM(buyer_email)) AS email,MIN(buyer_name) AS buyer_name
  FROM orders WHERE event_id=$1 AND status IN ('Paid','Used')
   AND buyer_email IS NOT NULL AND BTRIM(buyer_email)<>''
  GROUP BY LOWER(BTRIM(buyer_email)) ORDER BY LOWER(BTRIM(buyer_email))`,[eventId])).rows;
 if(!buyers.length)return res.status(409).json({error:"There are no payment-confirmed ticket buyers for this event yet."});
 const eventDetails="Event: "+event.title+"\nDate: "+(event.event_date||"To be announced")+"\nVenue: "+(event.venue||"To be announced");
 let sent=0,failed=0;
 for(const buyer of buyers){
  try{
   const ok=await sendMail(buyer.email,subject,
    "Dear "+(buyer.buyer_name||"ticket holder")+",\n\n"+message+"\n\n"+eventDetails+"\n\nPlease keep your ticket(s) safe and present them at the entrance.\n\nELCSA Mavhola Parish");
   if(ok)sent++;else failed++;
  }catch(error){failed++;console.error("Event reminder email failed for "+buyer.email+":",error?.message||error);}
 }
 res.json({ok:true,total:buyers.length,sent,failed,eventTitle:event.title});
}));
app.post("/api/admin/tickets/check-in",requireAdmin,asyncRoute(async(req,res)=>{
 const rawToken=String(req.body?.token||"").trim();
 const tokenMatch=rawToken.match(/([a-f0-9]{48})\/?$/i);
 const token=tokenMatch?tokenMatch[1]:"";
 if(!token)return res.status(400).json({error:"Enter a valid ticket QR token or verification link."});
 const redeemed=await db.transaction(async client=>{
  const result=await client.query(`UPDATE tickets SET redeemed_at=NOW()
   FROM orders WHERE tickets.order_id=orders.id AND tickets.token=$1
    AND orders.status='Paid' AND tickets.redeemed_at IS NULL
   RETURNING tickets.id,tickets.order_id`,[token]);
  if(!result.rowCount)return {ticket:null};
  const ticket=result.rows[0];
  const counts=(await client.query(`SELECT COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE redeemed_at IS NOT NULL)::int AS used
    FROM tickets WHERE order_id=$1`,[ticket.order_id])).rows[0];
  if(Number(counts.total)>0&&Number(counts.total)===Number(counts.used))
   await client.query("UPDATE orders SET status='Used' WHERE id=$1 AND status='Paid'",[ticket.order_id]);
  return {ticket};
 });
 if(redeemed.ticket)return res.json({ok:true,status:"redeemed",ticketNumber:"MAV-T"+String(redeemed.ticket.id).padStart(6,"0")});
 const existing=(await db.query(`SELECT tickets.id,tickets.redeemed_at,orders.status
  FROM tickets JOIN orders ON orders.id=tickets.order_id WHERE tickets.token=$1`,[token])).rows[0];
 if(!existing)return res.status(404).json({error:"Ticket not found."});
 if(existing.redeemed_at)return res.status(409).json({error:"This ticket has already been used."});
 if(existing.status!=="Paid")return res.status(409).json({error:"This ticket is not paid and cannot be admitted."});
 return res.status(409).json({error:"Ticket could not be checked in. Please try again."});
}));
app.put("/api/admin/settings",requireAdmin,asyncRoute(async(req,res)=>{
 const allowed=["parish_email","parish_phone","parish_address","tagline","eft_account_name","eft_bank_name","eft_account_number","eft_branch_code","eft_reference_instructions","membership_open_date","membership_close_date"];
 const opening=String(req.body?.membership_open_date||"").trim(),closing=String(req.body?.membership_close_date||"").trim();
 const validDate=value=>!value||(/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(value+"T00:00:00Z").toISOString().slice(0,10)===value);
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
 if(!startupReady)return res.status(503).json({ok:false,status:"starting",error:startupFailure?"Startup checks failed":"Startup checks are still running"});
 await db.query("SELECT 1");
 res.json({ok:true,database:"connected"});
}));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public/index.html")));
app.use((err,req,res,next)=>{console.error("Request failed:",err.message);if(res.headersSent)return next(err);res.status(err.code==="LIMIT_FILE_SIZE"?413:500).json({error:err.code==="LIMIT_FILE_SIZE"?"The uploaded file is too large.":"The request could not be completed. Please try again."});});
// Serve the public website immediately. Database-backed API routes remain gated
// until schema and private object storage checks have completed successfully.
bootstrap().then(()=>{
 startupReady=true;
 console.log("ELCSA Mavhola Parish startup checks complete; API is ready.");
}).catch(err=>{
 startupFailure=err;
 console.error("Startup checks failed; public pages remain available but API routes are paused:",err);
});
process.on("SIGTERM",()=>server.close(()=>db.close().finally(()=>process.exit(0))));
