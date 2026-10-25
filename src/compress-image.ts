import { ImageMagick, initializeImageMagick, Magick, MagickFormat, ResourceLimits } from "@imagemagick/magick-wasm";
import wasmAssetPath from "@imagemagick/magick-wasm/magick.wasm";

// esbuild emits the WASM asset as a relative filename. Resolve it beside this
// module so board routes such as /general/ do not turn it into /general/<wasm>.
const wasmUrl = new URL(wasmAssetPath, import.meta.url);

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_EDGE = 2048;
const MAX_PIXELS = 20_000_000;
let initialized: Promise<void> | undefined;

async function initialize(): Promise<void> {
  if (!initialized) {
    initialized = (async () => {
      const response = await fetch(wasmUrl, { cache: "force-cache", credentials: "same-origin" });
      if (!response.ok) throw new Error("The image tools could not be loaded. Refresh and try again.");
      await initializeImageMagick(new Uint8Array(await response.arrayBuffer()));
      ResourceLimits.area = BigInt(MAX_PIXELS);
      ResourceLimits.width = 12_000n;
      ResourceLimits.height = 12_000n;
    })();
  }
  return initialized;
}

function encodeWebp(image: any, quality: number): Uint8Array {
  image.quality = quality;
  return image.write(MagickFormat.WebP, (data: Uint8Array) => data.slice());
}

export async function compressImage(file: File): Promise<File> {
  if (file.size > 20 * 1024 * 1024) throw new Error("Choose an image under 20 MB. It will be compressed to 2 MB before upload.");
  await initialize();
  const input = new Uint8Array(await file.arrayBuffer());
  const output = ImageMagick.read(input, (image: any) => {
    if (!image.width || !image.height || image.width * image.height > MAX_PIXELS) {
      throw new Error("This image is too large to process safely. Try a smaller image.");
    }

    image.autoOrient();
    let width = image.width;
    let height = image.height;
    const initialScale = Math.min(1, MAX_EDGE / width, MAX_EDGE / height);
    if (initialScale < 1) {
      width = Math.max(1, Math.round(width * initialScale));
      height = Math.max(1, Math.round(height * initialScale));
      image.resize(width, height);
    }
    image.strip();

    const qualities = [82, 66, 50, 34, 20];
    for (let scaleStep = 0; scaleStep < 10; scaleStep += 1) {
      for (const quality of qualities) {
        const encoded = encodeWebp(image, quality);
        if (encoded.byteLength <= MAX_OUTPUT_BYTES) return encoded;
      }
      if (width <= 240 && height <= 240) break;
      width = Math.max(1, Math.round(width * 0.82));
      height = Math.max(1, Math.round(height * 0.82));
      image.resize(width, height);
    }
    throw new Error("This image could not be compressed below 2 MB.");
  });
  if (!(output instanceof Uint8Array) || output.byteLength > MAX_OUTPUT_BYTES) {
    throw new Error("This image could not be compressed below 2 MB.");
  }
  return new File([output], "s-chan-image.webp", { type: "image/webp", lastModified: Date.now() });
}

export function supportedImageFormats(): string[] {
  return Magick.supportedFormats
    .filter((format) => format.supportsReading && format.mimeType?.startsWith("image/"))
    .map((format) => format.format.toLowerCase());
}
