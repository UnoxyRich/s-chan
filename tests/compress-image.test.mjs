import assert from "node:assert/strict";
import { test } from "node:test";
import { compressImage } from "../public/bundle/compress-image.js";

const MAX_BYTES = 2 * 1024 * 1024;

test("browser canvas conversion retries smaller encodes and returns WebP under 2 MiB", async () => {
  const savedCreateImageBitmap = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const draws = [];
  const qualities = [];
  let closed = false;
  let outputIndex = 0;
  const bitmap = { width: 3000, height: 1500, close() { closed = true; } };
  const outputSizes = [MAX_BYTES + 1, MAX_BYTES + 2, MAX_BYTES + 3, MAX_BYTES + 4, MAX_BYTES + 5, 900_000];
  const context = {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    drawImage(image, x, y, width, height) { draws.push({ image, x, y, width, height }); },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext(type) {
      assert.equal(type, "2d");
      return context;
    },
    toBlob(callback, type, quality) {
      qualities.push(quality);
      callback(new Blob([new Uint8Array(outputSizes[outputIndex++])], { type }));
    },
  };

  globalThis.createImageBitmap = async () => bitmap;
  globalThis.document = { createElement(name) {
    assert.equal(name, "canvas");
    return canvas;
  } };

  try {
    const input = new File([new Uint8Array(5 * 1024 * 1024)], "source.jpg", { type: "image/jpeg" });
    const output = await compressImage(input);
    assert.equal(output.type, "image/webp");
    assert.equal(output.name, "s-chan-image.webp");
    assert.equal(output.size, 900_000);
    assert.ok(output.size <= MAX_BYTES);
    assert.deepEqual(qualities, [0.82, 0.66, 0.5, 0.34, 0.2, 0.82]);
    assert.deepEqual(draws.map(({ width, height }) => [width, height]), [[2048, 1024], [1679, 840]]);
    assert.equal(draws[0].image, bitmap);
    assert.equal(context.imageSmoothingEnabled, true);
    assert.equal(context.imageSmoothingQuality, "high");
    assert.equal(closed, true);
  } finally {
    if (savedCreateImageBitmap) Object.defineProperty(globalThis, "createImageBitmap", savedCreateImageBitmap);
    else delete globalThis.createImageBitmap;
    if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument);
    else delete globalThis.document;
  }
});
