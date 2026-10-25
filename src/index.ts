import { findSimilarPost, normalizeText } from "./duplicates";
import { cleanImage, ImageError } from "./image";

const BOARD = "general";
const PAGE_SIZE = 15;
const MAX_THREADS = 150;
const MAX_REPLIES = 300;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_LENGTH = 2000;

interface Env {
  DB: any;
  IMAGES: any;
  ASSETS: { fetch(request: Request): Promise<Response> };
}

interface PostInput {
  body: string;
  image?: File;
  sage: boolean;
  confirmSimilar: boolean;
}

function secure(response: Response, extraHeaders: Record<string, string> = {}): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(value: unknown, status = 200): Response {
  return secure(new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  }));
}

function error(message: string, status: number): Response {
  return json({ error: message }, status);
}

function sameOriginPost(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== new URL(request.url).origin) return false;
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
}

async function readPostInput(request: Request): Promise<PostInput> {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_IMAGE_BYTES + 80_000) throw new ImageError("The post is too large. Images are compressed to 2 MB before upload.");
  const form = await request.formData();
  const text = form.get("text");
  const body = typeof text === "string" ? text.replace(/\r\n?/g, "\n").trim() : "";
  if (Array.from(body).length > MAX_TEXT_LENGTH) throw new ImageError(`Text must be ${MAX_TEXT_LENGTH.toLocaleString()} characters or fewer.`);
  const rawImage = form.get("image");
  const image = rawImage instanceof File && rawImage.size > 0 ? rawImage : undefined;
  if (image && image.size > MAX_IMAGE_BYTES) throw new ImageError("The compressed image must be 2 MB or smaller. Try a smaller source image.");
  if (!body && !image) throw new ImageError("Write a message or choose an image.");
  return {
    body,
    image,
    sage: form.get("sage") === "true",
    confirmSimilar: form.get("confirmSimilar") === "true",
  };
}

async function storeImage(env: Env, image?: File): Promise<{ key: string; mimeType: string } | null> {
  if (!image) return null;
  const cleaned = cleanImage(new Uint8Array(await image.arrayBuffer()));
  const key = `images/${crypto.randomUUID()}.${cleaned.extension}`;
  await env.IMAGES.put(key, cleaned.bytes, {
    httpMetadata: {
      contentType: cleaned.mimeType,
      cacheControl: "public, max-age=31536000, immutable",
      contentDisposition: "inline",
      xContentTypeOptions: "nosniff",
    },
  });
  return { key, mimeType: cleaned.mimeType };
}

async function removeImage(env: Env, key: string | null): Promise<void> {
  if (!key) return;
  try { await env.IMAGES.delete(key); } catch { /* D1 remains authoritative; orphan cleanup is documented. */ }
}

async function savePost(
  env: Env,
  threadId: string,
  input: PostInput,
  isOp: boolean,
): Promise<{ postNo: number; threadId: string; createdAt: string; imageUrl: string | null }> {
  const createdAt = new Date().toISOString();
  const image = await storeImage(env, input.image);
  try {
    if (isOp) {
      const results = await env.DB.batch([
        env.DB.prepare("INSERT INTO threads (id, created_at, bumped_at) VALUES (?, ?, ?)").bind(threadId, createdAt, createdAt),
        env.DB.prepare(`INSERT INTO posts (thread_id, body, normalized_body, image_key, created_at, is_op, sage)
          VALUES (?, ?, ?, ?, ?, 1, 0)`).bind(threadId, input.body, normalizeText(input.body), image?.key ?? null, createdAt),
        env.DB.prepare(`UPDATE threads SET op_post_no = (SELECT post_no FROM posts WHERE thread_id = ? AND is_op = 1),
          last_bump_post_no = (SELECT post_no FROM posts WHERE thread_id = ? AND is_op = 1) WHERE id = ?`).bind(threadId, threadId, threadId),
        env.DB.prepare(`DELETE FROM posts WHERE thread_id IN (
          SELECT id FROM threads ORDER BY bumped_at ASC, last_bump_post_no ASC, id ASC
          LIMIT CASE WHEN (SELECT count(*) FROM threads) > ? THEN (SELECT count(*) FROM threads) - ? ELSE 0 END
        ) RETURNING image_key`).bind(MAX_THREADS, MAX_THREADS),
        env.DB.prepare(`DELETE FROM threads WHERE id IN (
          SELECT id FROM threads ORDER BY bumped_at ASC, last_bump_post_no ASC, id ASC
          LIMIT CASE WHEN (SELECT count(*) FROM threads) > ? THEN (SELECT count(*) FROM threads) - ? ELSE 0 END
        ) RETURNING id`).bind(MAX_THREADS, MAX_THREADS),
      ]);
      const postNo = Number(results[1]?.results?.[0]?.post_no ?? results[1]?.meta?.last_row_id);
      const removedKeys = (results[3]?.results ?? []).map((row: { image_key: string | null }) => row.image_key).filter(Boolean);
      if (removedKeys.length) {
        try { await env.IMAGES.delete(removedKeys); } catch { /* Avoid turning a committed post into a failed response. */ }
      }
      if (!Number.isSafeInteger(postNo) || postNo < 1) throw new Error("Post number was not returned.");
      return { postNo, threadId, createdAt, imageUrl: image ? `/media/${image.key}` : null };
    }

    const result = await env.DB.prepare(`INSERT INTO posts (thread_id, body, normalized_body, image_key, created_at, is_op, sage)
      SELECT ?, ?, ?, ?, ?, 0, ? WHERE EXISTS (SELECT 1 FROM threads WHERE id = ?)
      RETURNING post_no`).bind(threadId, input.body, normalizeText(input.body), image?.key ?? null, createdAt, input.sage ? 1 : 0, threadId).first();
    if (!result) throw new Error("thread not found");
    return { postNo: Number(result.post_no), threadId, createdAt, imageUrl: image ? `/media/${image.key}` : null };
  } catch (cause) {
    await removeImage(env, image?.key ?? null);
    throw cause;
  }
}

async function duplicateWarning(env: Env, input: PostInput): Promise<Response | null> {
  if (!input.body || input.confirmSimilar) return null;
  const match = await findSimilarPost(env.DB, input.body, new Date().toISOString());
  if (!match) return null;
  return json({
    code: "duplicate_warning",
    message: "This text is the same as, or very similar to, a recent post.",
    match: {
      postNo: match.postNo,
      threadId: match.threadId,
      body: match.body.slice(0, 240),
      similarity: Math.round(match.similarity * 100),
    },
  }, 409);
}

async function createThread(request: Request, env: Env): Promise<Response> {
  if (!sameOriginPost(request)) return error("Posts must be submitted from this site.", 403);
  const input = await readPostInput(request);
  const warning = await duplicateWarning(env, input);
  if (warning) return warning;
  const threadId = crypto.randomUUID();
  const post = await savePost(env, threadId, input, true);
  return json({ ok: true, post, board: BOARD }, 201);
}

async function createReply(request: Request, env: Env, threadId: string): Promise<Response> {
  if (!sameOriginPost(request)) return error("Posts must be submitted from this site.", 403);
  const thread = await env.DB.prepare("SELECT id FROM threads WHERE id = ?").bind(threadId).first();
  if (!thread) return error("That thread has expired or does not exist.", 404);
  const count = await env.DB.prepare("SELECT count(*) AS replies FROM posts WHERE thread_id = ? AND is_op = 0").bind(threadId).first();
  if (Number(count?.replies ?? 0) >= MAX_REPLIES) return error("This thread reached its 300 reply limit.", 409);
  const input = await readPostInput(request);
  const warning = await duplicateWarning(env, input);
  if (warning) return warning;
  try {
    const post = await savePost(env, threadId, input, false);
    return json({ ok: true, post, board: BOARD }, 201);
  } catch (cause) {
    if (String(cause).includes("thread reply limit reached")) return error("This thread reached its 300 reply limit.", 409);
    if (String(cause).includes("thread not found")) return error("That thread has expired or does not exist.", 404);
    throw cause;
  }
}

async function listThreads(url: URL, env: Env): Promise<Response> {
  const requestedPage = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const page = Number.isFinite(requestedPage) ? Math.max(1, Math.min(10, requestedPage)) : 1;
  const total = await env.DB.prepare("SELECT count(*) AS count FROM threads").first();
  const totalThreads = Number(total?.count ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalThreads / PAGE_SIZE));
  const offset = (page - 1) * PAGE_SIZE;
  const result = await env.DB.prepare(`SELECT t.id AS threadId, t.op_post_no AS threadNo, t.created_at AS createdAt,
      t.bumped_at AS bumpedAt, op.post_no AS postNo, op.body, op.image_key AS imageKey,
      (SELECT count(*) FROM posts p WHERE p.thread_id = t.id AND p.is_op = 0) AS replyCount
    FROM threads t JOIN posts op ON op.thread_id = t.id AND op.is_op = 1
    ORDER BY t.bumped_at DESC, t.last_bump_post_no DESC, t.id DESC LIMIT ? OFFSET ?`)
    .bind(PAGE_SIZE, offset).all();
  return json({ board: BOARD, page, pageSize: PAGE_SIZE, totalThreads, totalPages: Math.min(totalPages, 10), threads: (result.results ?? []).map((thread: any) => ({
    ...thread,
    imageUrl: thread.imageKey ? `/media/${thread.imageKey}` : null,
  })) });
}

async function getThread(threadId: string, env: Env): Promise<Response> {
  const thread = await env.DB.prepare("SELECT id AS threadId, op_post_no AS threadNo, created_at AS createdAt, bumped_at AS bumpedAt FROM threads WHERE id = ?")
    .bind(threadId).first();
  if (!thread) return error("That thread has expired or does not exist.", 404);
  const result = await env.DB.prepare(`SELECT post_no AS postNo, thread_id AS threadId, body, image_key AS imageKey,
      created_at AS createdAt, is_op AS isOp, sage
    FROM posts WHERE thread_id = ? ORDER BY post_no ASC`).bind(threadId).all();
  const posts = (result.results ?? []).map((post: any) => ({ ...post, imageUrl: post.imageKey ? `/media/${post.imageKey}` : null }));
  return json({ board: BOARD, thread, posts, replyLimit: MAX_REPLIES, repliesRemaining: Math.max(0, MAX_REPLIES - (posts.length - 1)) });
}

async function getPost(threadPostNo: number, env: Env): Promise<Response> {
  const post = await env.DB.prepare("SELECT post_no AS postNo, thread_id AS threadId FROM posts WHERE post_no = ?").bind(threadPostNo).first();
  return post ? json({ postNo: post.postNo, threadId: post.threadId }) : error("That post is no longer available.", 404);
}

async function imageResponse(path: string, env: Env): Promise<Response> {
  const key = decodeURIComponent(path.slice("/media/".length));
  if (!/^images\/[0-9a-f-]{36}\.(?:jpg|png|webp)$/i.test(key)) return error("Image not found.", 404);
  const image = await env.IMAGES.get(key);
  if (!image) return error("Image not found.", 404);
  const headers = new Headers();
  image.writeHttpMetadata(headers);
  headers.set("ETag", image.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(image.body, { headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/threads" && request.method === "GET") return listThreads(url, env);
      if (path === "/api/threads" && request.method === "POST") return await createThread(request, env);
      const threadMatch = path.match(/^\/api\/threads\/([0-9a-f-]{36})(?:\/(replies))?$/i);
      if (threadMatch && request.method === "GET" && !threadMatch[2]) return await getThread(threadMatch[1], env);
      if (threadMatch && request.method === "POST" && threadMatch[2]) return await createReply(request, env, threadMatch[1]);
      const postMatch = path.match(/^\/api\/posts\/(\d+)$/);
      if (postMatch && request.method === "GET") return await getPost(Number(postMatch[1]), env);
      if (path.startsWith("/media/") && request.method === "GET") return await imageResponse(path, env);
      if (path.startsWith("/api/") || path.startsWith("/media/")) return error("Not found.", 404);
      if (path === "/") return Response.redirect(new URL(`/general/${url.search}`, url), 308);
      if (path === "/general") return Response.redirect(new URL("/general/", url), 308);
      if (path === "/general/") {
        const indexRequest = new Request(new URL("/index.html", url), request);
        return secure(await env.ASSETS.fetch(indexRequest), {
          "Content-Security-Policy": "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        });
      }
      return secure(await env.ASSETS.fetch(request), {
        "Content-Security-Policy": "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      });
    } catch (cause) {
      if (cause instanceof ImageError) return error(cause.message, 400);
      return error("The post could not be saved. Please try again.", 500);
    }
  },
} satisfies ExportedHandler<Env>;
