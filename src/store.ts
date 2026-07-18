// SQLite-backed data layer for ework. Single DB (see db.ts) holds projects +
// issues + comments + labels + reactions + attachments + users. All write ops
// run in transactions; per-project issue numbers are allocated atomically.

import { rawDB } from "./db";

export interface UserRow {
  login: string;
  kind: "human" | "bot" | "system";
  display_name: string | null;
  created_at: string;
}

export interface ProjectRow {
  id: number;
  owner: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface IssueRow {
  id: number;
  project_id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  author: string;
  created_at: string;
  updated_at: string;
}

export interface IssueWithMeta extends IssueRow {
  project_owner: string;
  project_name: string;
  comment_count: number;
}

export interface CommentRow {
  id: number;
  issue_id: number;
  author: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface LabelRow {
  id: number;
  project_id: number;
  name: string;
  color: string;
}

export interface AttachmentRow {
  uuid: string;
  issue_id: number;
  filename: string;
  content_type: string;
  size: number;
  blob_path: string;
  uploaded_by: string;
  created_at: string;
}

export class StoreError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "StoreError";
  }
}

type DB = ReturnType<typeof rawDB>;

function now(): string {
  return new Date().toISOString();
}

function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already rolled back
    }
    throw e;
  }
}

export function ensureUser(login: string, kind: "human" | "bot" | "system" = "human"): UserRow {
  const db = rawDB();
  const existing = db.query("SELECT * FROM users WHERE login = ?").get(login) as UserRow | null;
  if (existing) return existing;
  const ts = now();
  db.query("INSERT INTO users (login, kind, created_at) VALUES (?, ?, ?)").run(login, kind, ts);
  return { login, kind, display_name: null, created_at: ts };
}

export function getProject(owner: string, name: string): ProjectRow | null {
  return (rawDB().query("SELECT * FROM projects WHERE owner = ? AND name = ?").get(owner, name) as ProjectRow | null) ?? null;
}

export function getProjectById(id: number): ProjectRow | null {
  return (rawDB().query("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | null) ?? null;
}

export function getProjectByIssueId(issueId: number): ProjectRow | null {
  const row = rawDB()
    .query("SELECT p.* FROM projects p JOIN issues i ON i.project_id = p.id WHERE i.id = ?")
    .get(issueId) as ProjectRow | null;
  return row ?? null;
}

export interface ProjectWithCounts extends ProjectRow {
  open_count: number;
  total_count: number;
}

export function listProjectsWithCounts(): ProjectWithCounts[] {
  return rawDB()
    .query(
      `SELECT p.*,
         COALESCE(SUM(CASE WHEN i.state = 'open' THEN 1 ELSE 0 END), 0) AS open_count,
         COUNT(i.id) AS total_count
       FROM projects p
       LEFT JOIN issues i ON i.project_id = p.id
       GROUP BY p.id
       ORDER BY p.updated_at DESC`
    )
    .all() as ProjectWithCounts[];
}

export function createProject(owner: string, name: string, description: string): ProjectRow {
  owner = owner.trim();
  name = name.trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(owner)) throw new StoreError(400, "owner 含非法字符");
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new StoreError(400, "name 含非法字符");
  if (getProject(owner, name)) throw new StoreError(409, `项目 ${owner}/${name} 已存在`);
  const ts = now();
  const db = rawDB();
  const info = db
    .query("INSERT INTO projects (owner, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(owner, name, description ?? "", ts, ts);
  return getProjectById(Number(info.lastInsertRowid))!;
}

export function touchProject(projectId: number): void {
  rawDB().query("UPDATE projects SET updated_at = ? WHERE id = ?").run(now(), projectId);
}

export function getIssue(projectId: number, number: number): IssueRow | null {
  return (
    (rawDB()
      .query("SELECT * FROM issues WHERE project_id = ? AND number = ?")
      .get(projectId, number) as IssueRow | null) ?? null
  );
}

export function getIssueById(id: number): IssueRow | null {
  return (rawDB().query("SELECT * FROM issues WHERE id = ?").get(id) as IssueRow | null) ?? null;
}

export function getIssueWithMeta(projectId: number, number: number): IssueWithMeta | null {
  return (
    (rawDB()
      .query(
        `SELECT i.*, p.owner AS project_owner, p.name AS project_name,
                (SELECT COUNT(*) FROM comments c WHERE c.issue_id = i.id) AS comment_count
         FROM issues i JOIN projects p ON p.id = i.project_id
         WHERE i.project_id = ? AND i.number = ?`
      )
      .get(projectId, number) as IssueWithMeta | null) ?? null
  );
}

export interface ListIssuesOpts {
  state?: "open" | "closed" | "all";
  q?: string;
  limit?: number;
}

export function listIssues(projectId: number, opts: ListIssuesOpts = {}): IssueWithMeta[] {
  const state = opts.state ?? "open";
  const q = (opts.q ?? "").trim();
  const limit = Math.min(opts.limit ?? 50, 200);
  let sql = `SELECT i.*, p.owner AS project_owner, p.name AS project_name,
              (SELECT COUNT(*) FROM comments c WHERE c.issue_id = i.id) AS comment_count
            FROM issues i JOIN projects p ON p.id = i.project_id
            WHERE i.project_id = ?`;
  const args: (string | number)[] = [projectId];
  if (state !== "all") {
    sql += " AND i.state = ?";
    args.push(state);
  }
  if (q) {
    sql += " AND (i.title LIKE ? ESCAPE '\\' OR i.body LIKE ? ESCAPE '\\')";
    const like = `%${q.replace(/[%_]/g, (m) => "\\" + m)}%`;
    args.push(like, like);
  }
  sql += " ORDER BY i.updated_at DESC LIMIT ?";
  args.push(limit);
  return rawDB().query(sql).all(...args) as IssueWithMeta[];
}

export function listAllIssues(opts: ListIssuesOpts = {}): IssueWithMeta[] {
  const state = opts.state ?? "open";
  const q = (opts.q ?? "").trim();
  const limit = Math.min(opts.limit ?? 50, 200);
  let sql = `SELECT i.*, p.owner AS project_owner, p.name AS project_name,
              (SELECT COUNT(*) FROM comments c WHERE c.issue_id = i.id) AS comment_count
            FROM issues i JOIN projects p ON p.id = i.project_id
            WHERE 1=1`;
  const args: (string | number)[] = [];
  if (state !== "all") {
    sql += " AND i.state = ?";
    args.push(state);
  }
  if (q) {
    sql += " AND (i.title LIKE ? ESCAPE '\\' OR i.body LIKE ? ESCAPE '\\' OR p.owner LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\')";
    const like = `%${q.replace(/[%_]/g, (m) => "\\" + m)}%`;
    args.push(like, like, like, like);
  }
  sql += " ORDER BY i.updated_at DESC LIMIT ?";
  args.push(limit);
  return rawDB().query(sql).all(...args) as IssueWithMeta[];
}

export function createIssue(
  projectId: number,
  title: string,
  body: string,
  author: string
): IssueRow {
  title = title.trim();
  if (!title) throw new StoreError(400, "标题不能为空");
  if (title.length > 255) throw new StoreError(400, "标题过长（≤255）");
  if (body.length > 65536) throw new StoreError(413, "正文过长（≤65536）");
  ensureUser(author);
  const ts = now();
  const db = rawDB();
  return tx(db, () => {
    const next = (
      db.query("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM issues WHERE project_id = ?").get(projectId) as {
        n: number;
      }
    ).n;
    const info = db
      .query(
        "INSERT INTO issues (project_id, number, title, body, state, author, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)"
      )
      .run(projectId, next, title, body, author, ts, ts);
    db.query("UPDATE projects SET updated_at = ? WHERE id = ?").run(ts, projectId);
    return getIssueById(Number(info.lastInsertRowid))!;
  });
}

export function setIssueState(issueId: number, state: "open" | "closed"): void {
  const ts = now();
  const db = rawDB();
  tx(db, () => {
    db.query("UPDATE issues SET state = ?, updated_at = ? WHERE id = ?").run(state, ts, issueId);
    const row = db.query("SELECT project_id FROM issues WHERE id = ?").get(issueId) as { project_id: number };
    db.query("UPDATE projects SET updated_at = ? WHERE id = ?").run(ts, row.project_id);
  });
}

export function countComments(issueId: number): number {
  const row = rawDB().query("SELECT COUNT(*) AS n FROM comments WHERE issue_id = ?").get(issueId) as { n: number };
  return row.n;
}

export function listCommentsPage(issueId: number, page: number, pageSize: number): { rows: CommentRow[]; page: number } {
  const total = countComments(issueId);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(Math.max(1, page), totalPages);
  const offset = (clamped - 1) * pageSize;
  const rows = rawDB()
    .query("SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?")
    .all(issueId, pageSize, offset) as CommentRow[];
  return { rows, page: clamped };
}

export function listCommentsSince(issueId: number, sinceISO: string): CommentRow[] {
  return rawDB()
    .query("SELECT * FROM comments WHERE issue_id = ? AND created_at > ? ORDER BY created_at ASC, id ASC")
    .all(issueId, sinceISO) as CommentRow[];
}

export function postComment(issueId: number, body: string, author: string): CommentRow {
  if (!body || !body.trim()) throw new StoreError(400, "评论不能为空");
  if (body.length > 65536) throw new StoreError(413, "评论过长（≤65536）");
  ensureUser(author);
  const ts = now();
  const db = rawDB();
  return tx(db, () => {
    const info = db
      .query("INSERT INTO comments (issue_id, author, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(issueId, author, body, ts, ts);
    db.query("UPDATE issues SET updated_at = ? WHERE id = ?").run(ts, issueId);
    const row = db.query("SELECT project_id FROM issues WHERE id = ?").get(issueId) as { project_id: number };
    db.query("UPDATE projects SET updated_at = ? WHERE id = ?").run(ts, row.project_id);
    return db.query("SELECT * FROM comments WHERE id = ?").get(Number(info.lastInsertRowid)) as CommentRow;
  });
}

export interface ReactionAgg {
  comment_id: number;
  content: string;
  n: number;
}

export function listReactionsFor(commentIds: number[]): ReactionAgg[] {
  if (commentIds.length === 0) return [];
  const placeholders = commentIds.map(() => "?").join(",");
  return rawDB()
    .query(
      `SELECT comment_id, content, COUNT(*) AS n
       FROM reactions WHERE comment_id IN (${placeholders})
       GROUP BY comment_id, content`
    )
    .all(...commentIds) as ReactionAgg[];
}

export function addReaction(commentId: number, userLogin: string, content: string): void {
  if (!content || content.length > 32) throw new StoreError(400, "非法的 reaction content");
  ensureUser(userLogin);
  rawDB()
    .query("INSERT OR IGNORE INTO reactions (comment_id, user_login, content) VALUES (?, ?, ?)")
    .run(commentId, userLogin, content);
}

export function removeReaction(commentId: number, userLogin: string, content: string): void {
  rawDB()
    .query("DELETE FROM reactions WHERE comment_id = ? AND user_login = ? AND content = ?")
    .run(commentId, userLogin, content);
}

export function listLabels(projectId: number): LabelRow[] {
  return rawDB().query("SELECT * FROM labels WHERE project_id = ? ORDER BY name").all(projectId) as LabelRow[];
}

export function listLabelsForIssue(issueId: number): LabelRow[] {
  return rawDB()
    .query(
      `SELECT l.* FROM labels l
       JOIN issue_labels il ON il.label_id = l.id
       WHERE il.issue_id = ? ORDER BY l.name`
    )
    .all(issueId) as LabelRow[];
}

export function createLabel(projectId: number, name: string, color: string): LabelRow {
  name = name.trim();
  if (!name) throw new StoreError(400, "标签名不能为空");
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new StoreError(400, "颜色须为 #RRGGBB");
  const db = rawDB();
  const info = db
    .query("INSERT INTO labels (project_id, name, color) VALUES (?, ?, ?)")
    .run(projectId, name, color);
  return db.query("SELECT * FROM labels WHERE id = ?").get(Number(info.lastInsertRowid)) as LabelRow;
}

export function setIssueLabel(issueId: number, labelId: number, on: boolean): void {
  const db = rawDB();
  if (on) {
    db.query("INSERT OR IGNORE INTO issue_labels (issue_id, label_id) VALUES (?, ?)").run(issueId, labelId);
  } else {
    db.query("DELETE FROM issue_labels WHERE issue_id = ? AND label_id = ?").run(issueId, labelId);
  }
}

export function createAttachment(a: Omit<AttachmentRow, "created_at">): AttachmentRow {
  const ts = now();
  const db = rawDB();
  db
    .query(
      `INSERT INTO attachments (uuid, issue_id, filename, content_type, size, blob_path, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(a.uuid, a.issue_id, a.filename, a.content_type, a.size, a.blob_path, a.uploaded_by, ts);
  return db.query("SELECT * FROM attachments WHERE uuid = ?").get(a.uuid) as AttachmentRow;
}

export function getAttachment(uuid: string): AttachmentRow | null {
  return (rawDB().query("SELECT * FROM attachments WHERE uuid = ?").get(uuid) as AttachmentRow | null) ?? null;
}
