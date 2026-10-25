# S-chan

S-chan is a small, anonymous imageboard with one board: `/general/`. The intended public address is <https://s-chan.novibenocode.ccwu.cc>.

> Independent community site. Not affiliated with or endorsed by any school, club, or organization.

Posts display as **Anonymous**. There is no account sign-in, voting, moderator interface, reporting, or manual post deletion. Threads remain until a new thread pushes the oldest thread out of the 150-thread capacity; its D1 posts and R2 images are then removed. A quiet board does not expire threads by age alone.

## Behavior

- Threads are ordered by the last bump. A reply bumps the thread unless it is posted with **Sage**.
- Threads accept up to 300 replies. The board shows 15 threads per page, up to 10 pages.
- Text-only posts and image-only posts are allowed. Text is limited to 2,000 characters.
- New text is compared with posts from the previous 24 hours on the board. Unicode text is normalized, then unique character 3-gram sets are compared with Jaccard similarity. An exact match or similarity of at least 85% returns a warning with **Edit** and **Post anyway** choices. The post is saved only after the visitor chooses to continue.
- Quotes use `>>post-number` and link to the referenced post.

## Image handling

The upload picker accepts 30+ filename extensions for raster, vector, and camera image formats supported by the bundled ImageMagick WebAssembly build, including JPEG/JFIF, PNG/APNG, GIF, WebP, BMP, TIFF, AVIF, HEIC/HEIF, SVG/SVGZ, JPEG 2000, PNM-family, JNG, and WBMP variants. Actual decoder availability depends on the compiled ImageMagick build; unsupported or malformed files are rejected with a message.

The browser processes the selected image locally. Source files up to 20 MiB are oriented, stripped of metadata, resized to at most 2,048 pixels on the longest edge, and encoded as WebP at a quality/resolution that fits the 2 MiB upload limit. The original file is not uploaded. Animated formats are reduced to a still image. The Worker strips metadata from accepted JPEG, PNG, and WebP uploads again before storing the result in R2.

The WebAssembly codec is loaded from this site only when someone selects an image. The library is Apache-2.0 licensed; see [`third_party/`](third_party/) for its license and notice.

## Privacy and storage

Application data contains only post text, public post and thread numbers, timestamps, the sage flag, and image object references. The Worker does not save IP addresses, user-agent strings, device fingerprints, poster cookies, or account-to-post links. There are no analytics calls or external font services. Worker observability, invocation logs, traces, and issues are disabled in `wrangler.jsonc`.

Cloudflare and network providers process connection metadata to deliver traffic. The Cloudflare dashboard for this zone can show source IPs and request details to the site operator. Cloudflare's sampled HTTP request analytics are retained for at least 31 days, even though the separate Logpull HTTP log retention flag is off by default. The operator could correlate request metadata with post times, so S-chan does not promise that comments cannot be traced back to a visitor or absolute untraceability. See Cloudflare's [Logpull retention documentation](https://developers.cloudflare.com/logs/logpull/enabling-log-retention/) and [analytics retention update](https://developers.cloudflare.com/changelog/post/2026-10-02-30-days-analytics-on-every-plan/).

Worker observability and invocation logs are disabled in `wrangler.jsonc`. Logpush is a separate zone setting; confirm it remains unconfigured in Cloudflare before launch. This session's Wrangler OAuth credential could not read the zone log-retention flag (Cloudflare API returned 403), so that flag has not been verified here.

Database schema and duplicate-search data structures are in [`migrations/0001_initial.sql`](migrations/0001_initial.sql). FTS5 indexes normalized post text for candidate selection; the application computes the final trigram similarity. FTS entries are removed when posts are automatically pruned.

## Local development

Requirements: Node.js 20+ and a Cloudflare account for remote resources. Local Wrangler development uses local D1 and R2 emulation.

```sh
npm ci
npm run db:local
npm run dev
```

Open <http://localhost:8787/general/>. Image tools are built into `public/bundle/` by the `build`, `dev`, `check`, and `deploy` scripts; that generated directory is ignored by Git.

Run unit checks with `npm test`. For the API lifecycle checks, start `npm run dev` in one terminal and run `npm run test:integration` in another. The integration script writes and prunes local test posts.

## Cloudflare deployment

1. Authenticate with `npx wrangler login`.
2. Create resources:

   ```sh
   npx wrangler d1 create s-chan
   npx wrangler r2 bucket create s-chan-images
   ```

3. Apply the schema and deploy:

   ```sh
   npm ci
   npm run db:remote
   npm run deploy
   ```

The Wrangler configuration binds D1 and R2, disables Worker observability, and attaches the custom domain `s-chan.novibenocode.ccwu.cc`. The Cloudflare zone must be active in the same account. Zone HTTP log retention and Logpush must also be checked in the Cloudflare dashboard.

## HTTP interface

- `GET /api/threads?page=1` — paginated `/general/` thread list.
- `GET /api/threads/:id` — thread and posts.
- `GET /api/posts/:postNo` — quote target lookup.
- `POST /api/threads` — create a thread.
- `POST /api/threads/:id/replies` — reply; set `sage=true` to avoid a bump.
- `GET /media/:key` — public image delivery.

Post endpoints accept `multipart/form-data` with `text`, optional normalized `image`, optional `sage=true`, and `confirmSimilar=true` after a duplicate warning. There are no account, vote, report, or deletion APIs.
