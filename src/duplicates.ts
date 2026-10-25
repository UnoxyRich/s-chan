export interface DuplicateMatch {
  postNo: number;
  threadId: string;
  body: string;
  similarity: number;
}

export function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

export function characterTrigrams(value: string): Set<string> {
  const characters = Array.from(normalizeText(value));
  const grams = new Set<string>();
  for (let i = 0; i <= characters.length - 3; i += 1) {
    grams.add(characters.slice(i, i + 3).join(""));
  }
  return grams;
}

export function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const gram of left) if (right.has(gram)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function ftsTerm(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function guaranteedAnchorGrams(grams: Set<string>): string[] {
  const all = [...grams];
  if (all.length <= 1) return all;
  // At Jaccard >= 0.85, at least 85% of either set is shared. A deterministic
  // 15%+1 sample therefore always contains a shared gram for a qualifying pair.
  const anchorCount = Math.min(all.length, Math.floor(all.length * 0.15) + 1);
  const selected: string[] = [];
  for (let i = 0; i < anchorCount; i += 1) {
    selected.push(all[Math.floor((i * all.length) / anchorCount)]);
  }
  return selected;
}

export async function findSimilarPost(
  db: any,
  body: string,
  now: string,
): Promise<DuplicateMatch | null> {
  const normalized = normalizeText(body);
  if (!normalized) return null;
  const since = new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString();
  const grams = characterTrigrams(normalized);

  if (grams.size === 0) {
    const exact = await db.prepare(
      "SELECT post_no, thread_id, body FROM posts WHERE normalized_body = ? AND created_at >= ? ORDER BY post_no DESC LIMIT 1",
    ).bind(normalized, since).first();
    return exact ? { postNo: exact.post_no, threadId: exact.thread_id, body: exact.body, similarity: 1 } : null;
  }

  const anchorQuery = guaranteedAnchorGrams(grams).map(ftsTerm).join(" OR ");
  const seen = new Set<number>();
  let before: number | null = null;
  while (true) {
    const statement = before === null
      ? db.prepare(`SELECT p.post_no, p.thread_id, p.body, p.normalized_body
          FROM posts_fts JOIN posts p ON p.post_no = posts_fts.rowid
          WHERE posts_fts MATCH ? AND p.created_at >= ?
          ORDER BY p.post_no DESC LIMIT 250`).bind(anchorQuery, since)
      : db.prepare(`SELECT p.post_no, p.thread_id, p.body, p.normalized_body
          FROM posts_fts JOIN posts p ON p.post_no = posts_fts.rowid
          WHERE posts_fts MATCH ? AND p.created_at >= ? AND p.post_no < ?
          ORDER BY p.post_no DESC LIMIT 250`).bind(anchorQuery, since, before);
    const result = await statement.all();
    const rows = result.results ?? [];
    if (rows.length === 0) return null;

    for (const row of rows) {
      const postNo = Number(row.post_no);
      if (seen.has(postNo)) continue;
      seen.add(postNo);
      const candidateGrams = characterTrigrams(row.normalized_body);
      const similarity = jaccardSimilarity(grams, candidateGrams);
      if (similarity >= 0.85) {
        return {
          postNo,
          threadId: row.thread_id,
          body: row.body,
          similarity,
        };
      }
    }
    if (rows.length < 250) return null;
    before = Number(rows[rows.length - 1].post_no);
  }
}
