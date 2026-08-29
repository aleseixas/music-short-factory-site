import { randomBytes } from "node:crypto";
import { createReadStream, mkdirSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { extname } from "node:path";
import multer from "multer";

export const ALLOWED_VIDEO_MIME_TYPES = Object.freeze([
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

const MIME_EXTENSIONS = Object.freeze({
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
});
const MEBIBYTE = 1024 * 1024;
const MAX_SINGLE_CHUNK_BYTES = 64 * MEBIBYTE;
const MULTIPART_CHUNK_BYTES = 32 * MEBIBYTE;
const MAX_CHUNK_ATTEMPTS = 3;

export class TikTokTransferError extends Error {
  constructor(message = "Video transfer to TikTok failed") {
    super(message);
    this.name = "TikTokTransferError";
  }
}

export function createChunkPlan(videoSize) {
  if (!Number.isSafeInteger(videoSize) || videoSize <= 0) {
    throw new TypeError("videoSize must be a positive safe integer");
  }

  const chunkSize =
    videoSize <= MAX_SINGLE_CHUNK_BYTES ? videoSize : MULTIPART_CHUNK_BYTES;
  const totalChunkCount =
    videoSize <= MAX_SINGLE_CHUNK_BYTES
      ? 1
      : Math.floor(videoSize / chunkSize);
  const chunks = [];

  for (let index = 0; index < totalChunkCount; index += 1) {
    const start = index * chunkSize;
    const end =
      index === totalChunkCount - 1 ? videoSize - 1 : start + chunkSize - 1;
    chunks.push({ index, start, end, length: end - start + 1 });
  }

  return Object.freeze({ chunkSize, totalChunkCount, chunks });
}

function validateUploadUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("TikTok returned an invalid upload destination");
  }

  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    !(hostname === "tiktokapis.com" || hostname.endsWith(".tiktokapis.com"))
  ) {
    throw new Error("TikTok returned an untrusted upload destination");
  }
  return url.toString();
}

export function createUploadMiddleware({ uploadDir, maxUploadBytes }) {
  mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
  const storage = multer.diskStorage({
    destination: (_request, _file, callback) => callback(null, uploadDir),
    filename: (_request, file, callback) => {
      const extension = MIME_EXTENSIONS[file.mimetype] || extname(file.originalname);
      callback(null, `${randomBytes(24).toString("hex")}${extension}`);
    },
  });

  return multer({
    storage,
    limits: { fileSize: maxUploadBytes, files: 1, fields: 4 },
    fileFilter: (_request, file, callback) => {
      if (!ALLOWED_VIDEO_MIME_TYPES.includes(file.mimetype)) {
        const error = new multer.MulterError("LIMIT_UNEXPECTED_FILE", "video");
        error.publicCode = "unsupported_video_type";
        callback(error);
        return;
      }
      callback(null, true);
    },
  }).single("video");
}

export async function removeTemporaryFile(filePath) {
  if (!filePath) return;
  try {
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function cleanupTemporaryDirectory(
  uploadDir,
  maxAgeMs = 6 * 60 * 60 * 1000,
) {
  let names;
  try {
    names = await readdir(uploadDir);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  const cutoff = Date.now() - maxAgeMs;
  await Promise.all(
    names.map(async (name) => {
      if (!/^[a-f\d]{48}\.(mp4|mov|webm)$/i.test(name)) return;
      const filePath = `${uploadDir}/${name}`;
      try {
        const details = await stat(filePath);
        if (details.isFile() && details.mtimeMs < cutoff) await unlink(filePath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }),
  );
}

export async function uploadVideoFile({
  filePath,
  videoSize,
  mimeType,
  accessToken,
  tiktokClient,
  fetchImpl = globalThis.fetch,
  onInitialized = null,
}) {
  if (!ALLOWED_VIDEO_MIME_TYPES.includes(mimeType)) {
    throw new TypeError("Unsupported video MIME type");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is required");

  const plan = createChunkPlan(videoSize);
  const initialized = await tiktokClient.initializeUpload({
    accessToken,
    videoSize,
    chunkSize: plan.chunkSize,
    totalChunkCount: plan.totalChunkCount,
  });
  const uploadUrl = validateUploadUrl(initialized.uploadUrl);
  if (onInitialized) await onInitialized({ publishId: initialized.publishId });

  for (const chunk of plan.chunks) {
    const expectedStatus =
      chunk.index === plan.chunks.length - 1 ? 201 : 206;
    let accepted = false;

    for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt += 1) {
      const body = createReadStream(filePath, {
        start: chunk.start,
        end: chunk.end,
      });
      let response;
      try {
        response = await fetchImpl(uploadUrl, {
          method: "PUT",
          redirect: "error",
          duplex: "half",
          headers: {
            "Content-Type": mimeType,
            "Content-Length": String(chunk.length),
            "Content-Range": `bytes ${chunk.start}-${chunk.end}/${videoSize}`,
          },
          body,
          signal: AbortSignal.timeout(120_000),
        });
        await response.arrayBuffer();
      } catch {
        body.destroy();
        if (attempt === MAX_CHUNK_ATTEMPTS) {
          throw new TikTokTransferError();
        }
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, 250 * 2 ** (attempt - 1)),
        );
        continue;
      }

      if (response.status === expectedStatus) {
        accepted = true;
        break;
      }
      if (response.status >= 500 && attempt < MAX_CHUNK_ATTEMPTS) {
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, 250 * 2 ** (attempt - 1)),
        );
        continue;
      }
      throw new TikTokTransferError(
        `TikTok returned an unexpected transfer status (${response.status})`,
      );
    }

    if (!accepted) {
      throw new TikTokTransferError();
    }
  }

  return {
    publishId: initialized.publishId,
    status: "PROCESSING_UPLOAD",
  };
}
