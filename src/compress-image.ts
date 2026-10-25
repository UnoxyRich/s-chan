const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_EDGE = 2048;
const MAX_PIXELS = 20_000_000;
const QUALITIES = [0.82, 0.66, 0.5, 0.34, 0.2];
const OUTPUT_TYPES = new Set(["image/webp", "image/png", "image/jpeg"]);

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("Your browser could not create a supported image format.");
  const type = dataUrl.slice(5, comma).split(";")[0];
  if (!OUTPUT_TYPES.has(type)) throw new Error("Your browser could not create a supported image format.");
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type });
}

async function encodeCanvasImage(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  let blob: Blob | null = null;
  if (typeof canvas.toBlob === "function") {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
  }
  if (!blob) blob = dataUrlToBlob(canvas.toDataURL("image/webp", quality));
  if (!OUTPUT_TYPES.has(blob.type)) throw new Error("Your browser could not create a supported image format.");
  return blob;
}

async function decodeImage(file: File): Promise<{ image: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Fall through to the image-element decoder used by older browsers.
    }
  }

  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("This image could not be opened."));
      image.src = objectUrl;
    });
    return {
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(objectUrl),
    };
  } catch {
    URL.revokeObjectURL(objectUrl);
    throw new Error("This image format is not supported by your browser, or the file is damaged.");
  }
}

export async function compressImage(file: File): Promise<File> {
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error("Choose an image under 20 MB. It will be compressed to 2 MB before upload.");
  }

  let decoded: Awaited<ReturnType<typeof decodeImage>>;
  try {
    decoded = await decodeImage(file);
  } catch {
    throw new Error("This image format is not supported by your browser, or the file is damaged.");
  }

  try {
    if (!decoded.width || !decoded.height || decoded.width * decoded.height > MAX_PIXELS) {
      throw new Error("This image is too large to process safely. Try a smaller image.");
    }

    const initialScale = Math.min(1, MAX_EDGE / decoded.width, MAX_EDGE / decoded.height);
    let width = Math.max(1, Math.round(decoded.width * initialScale));
    let height = Math.max(1, Math.round(decoded.height * initialScale));
    const canvas = document.createElement("canvas");

    for (let scaleStep = 0; scaleStep < 18; scaleStep += 1) {
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) throw new Error("Your browser could not prepare this image.");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(decoded.image, 0, 0, width, height);

      for (const quality of QUALITIES) {
        const output = await encodeCanvasImage(canvas, quality);
        if (output.size <= MAX_OUTPUT_BYTES) {
          const extension = output.type === "image/jpeg" ? "jpg" : output.type === "image/png" ? "png" : "webp";
          return new File([output], `s-chan-image.${extension}`, { type: output.type, lastModified: Date.now() });
        }
        if (output.type === "image/png") break;
      }

      if (width <= 160 && height <= 160) break;
      width = Math.max(1, Math.round(width * 0.82));
      height = Math.max(1, Math.round(height * 0.82));
    }

    throw new Error("This image could not be compressed below 2 MB.");
  } finally {
    decoded.close();
  }
}
