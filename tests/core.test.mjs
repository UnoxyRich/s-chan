import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanImage } from "../.test-build/image.mjs";
import { characterTrigrams, jaccardSimilarity, normalizeText } from "../.test-build/duplicates.mjs";

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
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const crcInput = Buffer.concat([name, data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(crcInput));
  return Buffer.concat([header, name, data, checksum]);
}

function tinyPng() {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const pixels = Buffer.from([0, 255, 0, 0, 255]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("tEXt", Buffer.from("Comment\0private metadata")),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

import { deflateSync } from "node:zlib";

test("PNG sanitizer validates integrity and removes metadata", () => {
  const source = tinyPng();
  const cleaned = cleanImage(source);
  assert.equal(cleaned.mimeType, "image/png");
  assert.equal(Buffer.from(cleaned.bytes).includes(Buffer.from("tEXt")), false);
  assert.equal(Buffer.from(cleaned.bytes).includes(Buffer.from("IDAT")), true);

  source[source.length - 5] ^= 1;
  assert.throws(() => cleanImage(source), /integrity check/);
});

test("duplicate comparison normalizes Unicode and whitespace", () => {
  assert.equal(normalizeText("  ＨＥＬＬＯ\n World  "), "hello world");
  const original = characterTrigrams("a near duplicate example");
  const near = characterTrigrams("a near duplicate examples");
  assert.ok(jaccardSimilarity(original, near) >= 0.85);
  assert.equal(jaccardSimilarity(original, characterTrigrams("completely unrelated")) < 0.85, true);
});
