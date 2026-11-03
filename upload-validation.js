const path = require("node:path");

function matches(buffer, signature, offset = 0) {
  return buffer.length >= offset + signature.length &&
    signature.every((byte, index) => buffer[offset + index] === byte);
}

function isZip(buffer) {
  return matches(buffer, [0x50, 0x4b, 0x03, 0x04]) ||
    matches(buffer, [0x50, 0x4b, 0x05, 0x06]) ||
    matches(buffer, [0x50, 0x4b, 0x07, 0x08]);
}

function validFile(buffer, originalName, category) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  const ext = path.extname(originalName || "").toLowerCase();
  const pdf = buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  const jpeg = matches(buffer, [0xff, 0xd8, 0xff]);
  const png = matches(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const gif = ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"));
  const webp = buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP";
  const mp4 = buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp";
  const webm = matches(buffer, [0x1a, 0x45, 0xdf, 0xa3]);
  const ole = matches(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

  if (category === "proof") {
    return (ext === ".pdf" && pdf) ||
      (ext === ".jpg" || ext === ".jpeg") && jpeg ||
      ext === ".png" && png || ext === ".webp" && webp;
  }
  if (category === "media") {
    return ([".jpg", ".jpeg"].includes(ext) && jpeg) ||
      (ext === ".png" && png) || (ext === ".gif" && gif) ||
      (ext === ".webp" && webp) || (ext === ".mp4" && mp4) ||
      (ext === ".webm" && webm);
  }
  if (category === "document") {
    if (ext === ".pdf") return pdf;
    if ([".doc", ".xls", ".ppt"].includes(ext)) return ole;
    if ([".docx", ".xlsx", ".pptx"].includes(ext)) return isZip(buffer);
    if (ext === ".txt") return !buffer.includes(0);
  }
  return false;
}

function validateUpload(category) {
  return (req, res, next) => {
    if (!req.file || validFile(req.file.buffer, req.file.originalname, category)) return next();
    return res.status(400).json({
      error: "The uploaded file content does not match its file type. Please choose a genuine supported file."
    });
  };
}

module.exports = { validFile, validateUpload };
