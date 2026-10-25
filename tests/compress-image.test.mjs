import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { compressImage } from "../public/bundle/compress-image.js";

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

function noisyPng(width, height) {
  const stride = width * 4 + 1;
  const pixels = new Uint8Array(height * stride);
  let seed = 89123;
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    pixels[row] = 0;
    for (let x = 1; x < stride; x += 1) {
      seed = (1664525 * seed + 1013904223) >>> 0;
      pixels[row + x] = seed >>> 24;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("tEXt", Buffer.from("Comment\0source metadata to remove")),
    pngChunk("iTXt", Buffer.from("XML:com.adobe.xmp\0\0\0\0\0<xmpmeta/>")),
    pngChunk("eXIf", Buffer.from("Exif\0\0camera metadata")),
    pngChunk("pHYs", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 1])),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

test("large image sources are compressed locally to a metadata-free WebP under 2 MiB", async () => {
  const wasmName = (await readdir(new URL("../public/bundle/", import.meta.url))).find((name) => name.endsWith(".wasm"));
  assert.ok(wasmName, "WebAssembly image codec was not built");
  const wasmBytes = await readFile(new URL(`../public/bundle/${wasmName}`, import.meta.url));
  const nativeFetch = globalThis.fetch;
  let wasmRequestUrl;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("magick-wasm-")) {
      wasmRequestUrl = new URL(String(input));
      return new Response(wasmBytes, { status: 200 });
    }
    return nativeFetch(input, init);
  };

  try {
    const source = noisyPng(2048, 1024);
    assert.ok(source.length > 2 * 1024 * 1024);
    const output = await compressImage(new File([source], "large-noisy.png", { type: "image/png" }));
    assert.equal(wasmRequestUrl?.pathname.split("/").slice(-2).join("/"), `bundle/${wasmName}`);
    const bytes = Buffer.from(await output.arrayBuffer());
    assert.equal(output.type, "image/webp");
    assert.ok(output.size <= 2 * 1024 * 1024);
    for (const metadata of ["source metadata to remove", "XML:com.adobe.xmp", "Exif", "camera metadata"]) {
      assert.equal(bytes.includes(Buffer.from(metadata)), false, `${metadata} survived browser conversion`);
    }
  } finally {
    globalThis.fetch = nativeFetch;
  }
});
