import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";

const base = process.env.SCHAN_TEST_URL ?? "http://localhost:8787";
const headers = { Origin: base };
const runId = crypto.randomUUID();

const before = await (await fetch(`${base}/api/threads?page=1`)).json();
const initialThreadCount = before.totalThreads;

const rootResponse = await fetch(`${base}/`, { redirect: "manual" });
assert.equal(rootResponse.status, 308);
assert.equal(rootResponse.headers.get("location"), `${base}/general/`);
const boardResponse = await fetch(`${base}/general/`, { redirect: "manual" });
assert.equal(boardResponse.status, 200);
const boardHtml = await boardResponse.text();
assert.ok(boardHtml.includes("Not affiliated with or endorsed by any school, club, or organization."));
const faqResponse = await fetch(`${base}/faq.html`);
assert.equal(faqResponse.status, 200);
const faqHtml = await faqResponse.text();
assert.ok(faqHtml.includes("The operator could correlate request times with posts"));
assert.ok(faqHtml.includes("Drawing the pixels to a fresh canvas removes embedded metadata"));

async function post(path, { text, image, sage = false, confirmSimilar = false } = {}) {
  const form = new FormData();
  if (text !== undefined) form.set("text", text);
  if (image) form.set("image", image);
  if (sage) form.set("sage", "true");
  if (confirmSimilar) form.set("confirmSimilar", "true");
  return fetch(`${base}${path}`, { method: "POST", headers, body: form });
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function pngWithTextMetadata() {
  const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("tEXt", Buffer.from("Comment\0private metadata")),
    pngChunk("iTXt", Buffer.from("XML:com.adobe.xmp\0\0\0\0\0<xmpmeta/>")),
    pngChunk("iCCP", Buffer.from("ICC Profile\0\0profile data")),
    pngChunk("eXIf", Buffer.from("Exif\0\0camera metadata")),
    pngChunk("pHYs", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 1])),
    pngChunk("tIME", Buffer.from([0x07, 0xea, 1, 1, 0, 0, 0])),
    pngChunk("zTXt", Buffer.from("Comment\0\0compressed text")),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function expectJson(response, status) {
  if (response.status !== status) throw new Error(`Expected HTTP ${status}; received ${response.status}: ${await response.text()}`);
  return response.json();
}

const imageThreadResponse = await post("/api/threads", { image: new File([pngWithTextMetadata()], "pixel.png", { type: "image/png" }), confirmSimilar: true });
const imageThread = (await expectJson(imageThreadResponse, 201)).post;
assert.ok(imageThread.imageUrl);
const initialStoredImage = await fetch(`${base}${imageThread.imageUrl}`);
assert.equal(initialStoredImage.status, 200);
const cleanedPng = Buffer.from(await initialStoredImage.arrayBuffer());
for (const metadataChunk of ["tEXt", "iTXt", "iCCP", "eXIf", "pHYs", "tIME", "zTXt"]) {
  assert.equal(cleanedPng.includes(Buffer.from(metadataChunk)), false, `PNG ${metadataChunk} metadata survived storage`);
}

const duplicateText = `A distinctive exact duplicate warning test sentence ${runId}.`;
const textThreadResponse = await post("/api/threads", { text: duplicateText });
const textThread = (await expectJson(textThreadResponse, 201)).post;
const exactWarning = await expectJson(await post("/api/threads", { text: duplicateText }), 409);
assert.equal(exactWarning.code, "duplicate_warning");
const acceptedDuplicate = await expectJson(await post("/api/threads", { text: duplicateText, confirmSimilar: true }), 201);
assert.ok(acceptedDuplicate.post.postNo > textThread.postNo);

const nearText = duplicateText.replace(/\.$/, "!");
const nearWarning = await expectJson(await post("/api/threads", { text: nearText }), 409);
assert.equal(nearWarning.code, "duplicate_warning");
assert.ok(nearWarning.match.similarity >= 85);

const quote = await expectJson(await fetch(`${base}/api/posts/${textThread.postNo}`), 200);
assert.equal(quote.threadId, textThread.threadId);

await new Promise((resolve) => setTimeout(resolve, 20));
const normalReply = await expectJson(await post(`/api/threads/${textThread.threadId}/replies`, { text: "A normal reply that bumps the thread", confirmSimilar: true }), 201);
assert.ok(normalReply.post.postNo > textThread.postNo);
const afterNormal = await (await fetch(`${base}/api/threads/${textThread.threadId}`)).json();
assert.equal(afterNormal.posts.at(-1).postNo, normalReply.post.postNo);
const normalBumpTime = afterNormal.thread.bumpedAt;

await new Promise((resolve) => setTimeout(resolve, 20));
const sageReply = await expectJson(await post(`/api/threads/${textThread.threadId}/replies`, { text: "A sage reply does not bump", sage: true, confirmSimilar: true }), 201);
const afterSage = await (await fetch(`${base}/api/threads/${textThread.threadId}`)).json();
assert.equal(afterSage.thread.bumpedAt, normalBumpTime);
assert.equal(afterSage.posts.at(-1).sage, 1);
assert.ok(sageReply.post.postNo > normalReply.post.postNo);

const limitThread = (await expectJson(await post("/api/threads", { text: `Thread for reply limit integration check ${runId}`, confirmSimilar: true }), 201)).post;
for (let index = 0; index < 300; index += 1) {
  const response = await post(`/api/threads/${limitThread.threadId}/replies`, { text: `Reply limit integration reply ${index}`, confirmSimilar: true });
  if (response.status !== 201) throw new Error(`Reply ${index + 1} failed: ${response.status} ${await response.text()}`);
}
const atLimit = await expectJson(await fetch(`${base}/api/threads/${limitThread.threadId}`), 200);
assert.equal(atLimit.repliesRemaining, 0);
assert.equal(atLimit.posts.length, 301);
await expectJson(await post(`/api/threads/${limitThread.threadId}/replies`, { text: "One too many replies", confirmSimilar: true }), 409);

const pages = await expectJson(await fetch(`${base}/api/threads?page=1`), 200);
assert.equal(pages.pageSize, 15);
assert.equal(pages.totalThreads, Math.min(initialThreadCount + 4, 150));

for (let index = 0; index < 151; index += 1) {
  const response = await post("/api/threads", { text: `Capacity pruning integration thread ${runId} ${index}`, confirmSimilar: true });
  if (response.status !== 201) throw new Error(`Thread ${index + 1} failed: ${response.status} ${await response.text()}`);
}

const afterPrune = await expectJson(await fetch(`${base}/api/threads?page=1`), 200);
assert.equal(afterPrune.totalThreads, 150);
assert.equal(afterPrune.threads.length, 15);
assert.equal((await fetch(`${base}/api/threads/${imageThread.threadId}`)).status, 404);
assert.equal((await fetch(`${base}${imageThread.imageUrl}`)).status, 404, "expired R2 image was not deleted");

assert.equal((await fetch(`${base}/api/reports`, { method: "POST", headers })).status, 404);
console.log("Integration checks passed: anonymous threads/replies, duplicate confirmation, quote lookup, sage/bump, 300 replies, 150-thread pruning, R2 image deletion, and image metadata stripping.");
