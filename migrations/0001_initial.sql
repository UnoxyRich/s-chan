PRAGMA foreign_keys = ON;

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  op_post_no INTEGER UNIQUE,
  created_at TEXT NOT NULL,
  bumped_at TEXT NOT NULL,
  last_bump_post_no INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX threads_bump_order ON threads (bumped_at DESC, last_bump_post_no DESC, id DESC);

CREATE TABLE posts (
  post_no INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  normalized_body TEXT NOT NULL,
  image_key TEXT,
  created_at TEXT NOT NULL,
  is_op INTEGER NOT NULL DEFAULT 0 CHECK (is_op IN (0, 1)),
  sage INTEGER NOT NULL DEFAULT 0 CHECK (sage IN (0, 1)),
  CHECK (length(body) <= 2000),
  CHECK (body <> '' OR image_key IS NOT NULL)
);

CREATE INDEX posts_by_thread ON posts (thread_id, post_no);
CREATE INDEX posts_recent ON posts (created_at DESC, post_no DESC);

CREATE VIRTUAL TABLE posts_fts USING fts5(
  normalized_body,
  tokenize = 'trigram',
  content = 'posts',
  content_rowid = 'post_no'
);

CREATE TRIGGER posts_fts_insert AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts (rowid, normalized_body)
  VALUES (new.post_no, new.normalized_body);
END;

CREATE TRIGGER posts_fts_delete AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts (posts_fts, rowid, normalized_body)
  VALUES ('delete', old.post_no, old.normalized_body);
END;

CREATE TRIGGER posts_reply_limit BEFORE INSERT ON posts
WHEN new.is_op = 0
BEGIN
  SELECT CASE
    WHEN (SELECT count(*) FROM posts WHERE thread_id = new.thread_id AND is_op = 0) >= 300
    THEN RAISE(ABORT, 'thread reply limit reached')
  END;
END;

CREATE TRIGGER posts_reply_bump AFTER INSERT ON posts
WHEN new.is_op = 0 AND new.sage = 0
BEGIN
  UPDATE threads
  SET bumped_at = new.created_at, last_bump_post_no = new.post_no
  WHERE id = new.thread_id;
END;
