const path = require("path");
const crypto = require("crypto");
const {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const bucket = process.env.R2_BUCKET_NAME;
const configured = Boolean(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  bucket
);

const client = configured ? new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  },
  forcePathStyle: true
}) : null;

function requireStorage() {
  if (!client) throw new Error("Cloudflare R2 is not configured. Set the R2 environment variables.");
}

function safeExtension(originalName = "") {
  return path.extname(path.basename(originalName)).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 12);
}

function makeObjectKey(area, originalName) {
  const safeArea = ["gallery", "documents", "payment-proofs", "shop"].includes(area) ? area : "misc";
  return `${safeArea}/${Date.now()}-${crypto.randomBytes(16).toString("hex")}${safeExtension(originalName)}`;
}

async function putObject({ area, originalName, buffer, contentType }) {
  requireStorage();
  const key = makeObjectKey(area, originalName);
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType || "application/octet-stream",
    // Do not set public ACLs. Private proofs are never made public.
    Metadata: { originalname: Buffer.from(path.basename(originalName || "file")).toString("base64") }
  }));
  return key;
}

async function deleteObject(key) {
  requireStorage();
  if (!key || typeof key !== "string" || key.startsWith("/") || key.includes("..")) return;
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

async function signedDownloadUrl(key, expiresIn = 180) {
  requireStorage();
  if (!key || typeof key !== "string" || key.startsWith("/") || key.includes("..")) {
    throw new Error("Invalid storage object key.");
  }
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: Math.min(600, Math.max(30, Number(expiresIn) || 180))
  });
}

async function getObjectStream(key) {
  requireStorage();
  if (!key || typeof key !== "string" || key.startsWith("/") || key.includes("..")) {
    throw new Error("Invalid storage object key.");
  }
  return client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
}

async function checkStorage() {
  requireStorage();
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
  return true;
}

module.exports = { configured, putObject, deleteObject, signedDownloadUrl, getObjectStream, checkStorage };
