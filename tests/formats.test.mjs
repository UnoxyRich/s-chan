import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { ImageMagick, initializeImageMagick, Magick, MagickFormat } from "@imagemagick/magick-wasm";

let initialized;
async function initialize() {
  initialized ??= initializeImageMagick(new Uint8Array(await readFile("node_modules/@imagemagick/magick-wasm/dist/x86/magick.wasm")));
  await initialized;
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

function onePixelPng() {
  const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

test("bundled codec exposes more than 15 readable image formats", async () => {
  await initialize();
  const formats = Magick.supportedFormats.filter((format) => format.supportsReading && format.mimeType?.startsWith("image/"));
  assert.ok(formats.length >= 16, `only ${formats.length} image formats are available`);
});

test("browser codec can normalize a source image to WebP under the upload cap", async () => {
  await initialize();
  const bytes = ImageMagick.read(new Uint8Array(onePixelPng()), (image) => {
    image.autoOrient();
    image.strip();
    image.quality = 82;
    return image.write(MagickFormat.WebP, (result) => result.slice());
  });
  assert.ok(Buffer.from(bytes).subarray(0, 4).equals(Buffer.from("RIFF")));
  assert.ok(Buffer.from(bytes).subarray(8, 12).equals(Buffer.from("WEBP")));
  assert.ok(bytes.byteLength <= 2 * 1024 * 1024);
});
