const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_EDGE = 2048;
const MAX_PIXELS = 20_000_000;
const QUALITIES = [0.82, 0.66, 0.5, 0.34, 0.2];

function encodeWebp(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("This image could not be converted. Try another image."));
      } else if (blob.type !== "image/webp") {
        reject(new Error("Your browser cannot create WebP images. Update your browser to post images."));
      } else {
        resolve(blob);
      }
    }, "image/webp", quality);
  });
}

export async function compressImage(file: File): Promise<File> {
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error("Choose an image under 20 MB. It will be compressed to 2 MB before upload.");
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("This image format is not supported by your browser, or the file is damaged.");
  }

  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > MAX_PIXELS) {
      throw new Error("This image is too large to process safely. Try a smaller image.");
    }

    const initialScale = Math.min(1, MAX_EDGE / bitmap.width, MAX_EDGE / bitmap.height);
    let width = Math.max(1, Math.round(bitmap.width * initialScale));
    let height = Math.max(1, Math.round(bitmap.height * initialScale));
    const canvas = document.createElement("canvas");

    for (let scaleStep = 0; scaleStep < 10; scaleStep += 1) {
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) throw new Error("Your browser could not prepare this image.");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, width, height);

      for (const quality of QUALITIES) {
        const output = await encodeWebp(canvas, quality);
        if (output.size <= MAX_OUTPUT_BYTES) {
          return new File([output], "s-chan-image.webp", { type: "image/webp", lastModified: Date.now() });
        }
      }

      if (width <= 240 && height <= 240) break;
      width = Math.max(1, Math.round(width * 0.82));
      height = Math.max(1, Math.round(height * 0.82));
    }

    throw new Error("This image could not be compressed below 2 MB.");
  } finally {
    bitmap.close();
  }
}
