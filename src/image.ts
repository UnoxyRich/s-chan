export interface CleanImage {
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  extension: "jpg" | "png" | "webp";
}

export class ImageError extends Error {}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function writeU32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset += 1) {
    crc ^= bytes[offset];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function stripPng(input: Uint8Array): Uint8Array {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!startsWith(input, signature)) throw new ImageError("That file is not a valid PNG image.");
  const chunks: Uint8Array[] = [input.slice(0, 8)];
  const renderAncillary = new Set(["tRNS"]);
  const critical = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
  let offset = 8;
  let hasHeader = false;
  let hasPixels = false;
  let hasEnd = false;
  let animated = false;
  while (offset + 12 <= input.length) {
    const length = readU32BE(input, offset);
    const end = offset + 12 + length;
    if (end > input.length) throw new ImageError("That PNG image is incomplete.");
    const type = new TextDecoder().decode(input.subarray(offset + 4, offset + 8));
    if (crc32(input, offset + 4, offset + 8 + length) !== readU32BE(input, offset + 8 + length)) {
      throw new ImageError("That PNG image failed its integrity check.");
    }
    if (type === "IHDR") hasHeader = true;
    if (type === "IDAT") hasPixels = true;
    if (type === "IEND") {
      hasEnd = true;
      if (length !== 0) throw new ImageError("That PNG image is malformed.");
    }
    if (type === "acTL") animated = true;
    const isAncillary = (input[offset + 4] & 0x20) !== 0;
    if (!isAncillary && !critical.has(type)) throw new ImageError("That PNG image uses an unsupported critical chunk.");
    if (critical.has(type) || (isAncillary && renderAncillary.has(type))) chunks.push(input.slice(offset, end));
    offset = end;
    if (hasEnd) break;
  }
  if (animated) throw new ImageError("Animated PNG images are not supported.");
  if (!hasHeader || !hasPixels || !hasEnd || offset !== input.length) throw new ImageError("That PNG image is malformed.");
  return concat(chunks);
}

function stripJpeg(input: Uint8Array): Uint8Array {
  if (!startsWith(input, [0xff, 0xd8])) throw new ImageError("That file is not a valid JPEG image.");
  const output: Uint8Array[] = [input.slice(0, 2)];
  const isMetadata = (marker: number) => (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
  let offset = 2;
  let sawSof = false;
  let sawSos = false;
  let sawEoi = false;
  while (offset < input.length) {
    if (input[offset] !== 0xff) throw new ImageError("That JPEG image is malformed.");
    const markerStart = offset;
    while (input[offset] === 0xff) offset += 1;
    if (offset >= input.length) throw new ImageError("That JPEG image is incomplete.");
    const marker = input[offset++];
    if (marker === 0x00) throw new ImageError("That JPEG image is malformed.");
    if (marker === 0xd9) {
      output.push(input.slice(markerStart, offset));
      sawEoi = true;
      break;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      if (!isMetadata(marker)) output.push(input.slice(markerStart, offset));
      continue;
    }
    if (offset + 2 > input.length) throw new ImageError("That JPEG image is incomplete.");
    const length = (input[offset] << 8) | input[offset + 1];
    if (length < 2 || offset + length > input.length) throw new ImageError("That JPEG image is malformed.");
    const end = offset + length;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) sawSof = true;
    if (!isMetadata(marker)) output.push(input.slice(markerStart, end));
    offset = end;
    if (marker === 0xda) {
      sawSos = true;
      const scanStart = offset;
      let markerStartInScan = -1;
      for (let i = offset; i + 1 < input.length; i += 1) {
        if (input[i] !== 0xff) continue;
        let j = i + 1;
        while (j < input.length && input[j] === 0xff) j += 1;
        if (j >= input.length) break;
        const next = input[j];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          i = j;
          continue;
        }
        markerStartInScan = i;
        break;
      }
      if (markerStartInScan < 0) throw new ImageError("That JPEG image is incomplete.");
      output.push(input.slice(scanStart, markerStartInScan));
      offset = markerStartInScan;
    }
  }
  if (!sawSof || !sawSos || !sawEoi) throw new ImageError("That JPEG image is malformed.");
  return concat(output);
}

function stripWebp(input: Uint8Array): Uint8Array {
  if (!startsWith(input, [0x52, 0x49, 0x46, 0x46]) || !startsWith(input.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
    throw new ImageError("That file is not a valid WebP image.");
  }
  const declaredEnd = readU32LE(input, 4) + 8;
  if (declaredEnd !== input.length) throw new ImageError("That WebP image is incomplete or malformed.");
  const chunks: Uint8Array[] = [];
  const imageChunks = new Set(["VP8 ", "VP8L", "VP8X", "ALPH"]);
  let offset = 12;
  let hasImage = false;
  let animated = false;
  while (offset + 8 <= declaredEnd) {
    const type = new TextDecoder().decode(input.subarray(offset, offset + 4));
    const length = readU32LE(input, offset + 4);
    const end = offset + 8 + length + (length & 1);
    if (end > declaredEnd) throw new ImageError("That WebP image is malformed.");
    if (type === "VP8 " || type === "VP8L") hasImage = true;
    if (type === "ANIM" || type === "ANMF") animated = true;
    if (imageChunks.has(type)) {
      const chunk = input.slice(offset, end);
      if (type === "VP8X") {
        if (length !== 10) throw new ImageError("That WebP image is malformed.");
        chunk[8] &= ~0x2c; // Clear ICC, EXIF, and XMP feature flags.
      }
      chunks.push(chunk);
    }
    offset = end;
  }
  if (offset !== declaredEnd || !hasImage) throw new ImageError("That WebP image is malformed.");
  if (animated) throw new ImageError("Animated WebP images are not supported.");
  const total = 12 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  output.set(input.subarray(0, 12), 0);
  let writeOffset = 12;
  for (const chunk of chunks) {
    output.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }
  writeU32LE(output, 4, total - 8);
  return output;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export function cleanImage(input: Uint8Array): CleanImage {
  if (input.length === 0) throw new ImageError("Choose an image first.");
  if (startsWith(input, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { bytes: stripPng(input), mimeType: "image/png", extension: "png" };
  }
  if (startsWith(input, [0xff, 0xd8])) {
    return { bytes: stripJpeg(input), mimeType: "image/jpeg", extension: "jpg" };
  }
  if (startsWith(input, [0x52, 0x49, 0x46, 0x46])) {
    return { bytes: stripWebp(input), mimeType: "image/webp", extension: "webp" };
  }
  throw new ImageError("Use a JPEG, PNG, or WebP image.");
}
