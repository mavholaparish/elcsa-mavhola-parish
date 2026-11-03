const assert = require("node:assert/strict");
const { test } = require("node:test");
const { validFile } = require("../upload-validation");

test("file signatures must match the declared extension", () => {
  assert.equal(validFile(Buffer.from("%PDF-1.7"), "proof.pdf", "proof"), true);
  assert.equal(validFile(Buffer.from("%PDF-1.7"), "proof.jpg", "proof"), false);
  assert.equal(validFile(Buffer.from([0xff,0xd8,0xff,0x00]), "proof.jpg", "proof"), true);
  assert.equal(validFile(Buffer.from("not a PDF"), "proof.pdf", "proof"), false);
});

test("gallery images and videos require recognised signatures", () => {
  assert.equal(validFile(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), "photo.png", "media"), true);
  assert.equal(validFile(Buffer.from("fake image"), "photo.png", "media"), false);
  assert.equal(validFile(Buffer.from([0x1a,0x45,0xdf,0xa3,0x00]), "clip.webm", "media"), true);
});

test("document archives and text are checked by content", () => {
  assert.equal(validFile(Buffer.from([0x50,0x4b,0x03,0x04,0x00]), "report.docx", "document"), true);
  assert.equal(validFile(Buffer.from("ordinary text"), "notes.txt", "document"), true);
  assert.equal(validFile(Buffer.from([0x00,0x01,0x02,0x03]), "notes.txt", "document"), false);
});
