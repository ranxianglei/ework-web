import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, appendFileSync } from "fs";
import { loadConfig, DB_OVERRIDABLE, parseOverride, resolveTtsBackend } from "./config";
import type { Config } from "./config";
import { setConfig } from "./db";
import { checkAuth, makeAuthCookieHeader, loginHTML, sanitizeNext } from "./auth";
import { OpencodeClient, OpencodeError } from "./opencode";
import { renderMarkdown } from "./render/markdown";
import { buildIssueThread, fetchIssuePage, fetchIssueSince, errorPage } from "./views/issueThread";
import { buildIssueList } from "./views/issueList";
import { buildHome, handleCreateProject } from "./views/home";
import { buildIssuesFeed } from "./views/issues";
import { buildIssueNew } from "./views/issueNew";
import { buildSettingsPage } from "./views/settings";
import { buildSessionList, buildSessionView, renderNewMessages, renderBatchHTML } from "./views/sessionLog";
import { buildFileView, FileViewError, readFileSince, serveRawFile } from "./fileview";
import { translateText, translateTextStream, TranslateError } from "./translate";
import { rateLimit } from "./ratelimit";
import {
  StoreError,
  getProject,
  getIssueWithMeta,
  createIssue,
  createProject,
  postComment,
  setIssueState,
  createAttachment,
  getAttachment,
} from "./store";
import {
  newAttachmentUUID,
  saveAttachmentBlob,
  readAttachmentStream,
  sniffImageContentType,
  isImageContentType,
  MAX_ATTACHMENT_BYTES,
} from "./attachments";
import type { CommentView } from "./render/components";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, "static");

const cfg: Config = loadConfig();
const opencode = new OpencodeClient(cfg);

const SEC_HEADERS: Record<string, string> = {
  "content-security-policy": `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "permissions-policy": "()",
};

const hlCss = loadHighlightCss();

function loadHighlightCss(): string {
  const light = readFileSafe(join(__dirname, "..", "node_modules", "highlight.js", "styles", "github.css"));
  const dark = readFileSafe(join(__dirname, "..", "node_modules", "highlight.js", "styles", "github-dark.css"));
  if (!light && !dark) return "";
  const darkRule = dark
    ? `@media (prefers-color-scheme:dark){${stripAtMedia(dark)}}`
    : "";
  return `${light}${darkRule}`;
}

function readFileSafe(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function stripAtMedia(css: string): string {
  return css.replace(/@media[^{]*\{([\s\S]*)\}\s*$/, "$1");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...SEC_HEADERS },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", ...SEC_HEADERS },
  });
}

const REPO_ISSUE_RE = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)$/;
const REPO_LIST_RE = /^\/([^/]+)\/([^/]+)\/issues$/;
const REPO_NEW_RE = /^\/([^/]+)\/([^/]+)\/issues\/new$/;
const REPO_RE = /^\/([^/]+)\/([^/]+)$/;
const API_RE = /^\/api\/([^/]+)\/([^/]+)\/issues\/(\d+)\/(page|since)$/;
const COMMENT_POST_RE = /^\/api\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comment$/;
const UPLOAD_RE = /^\/api\/([^/]+)\/([^/]+)\/issues\/(\d+)\/upload$/;
const ATTACHMENT_RE = /^\/attachments\/([0-9a-fA-F-]+)$/;
const SESSIONS_RE = /^\/sessions$/;
const SESSION_VIEW_RE = /^\/sessions\/([A-Za-z0-9_-]+)$/;
const SESSION_SINCE_RE = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/since$/;
const SESSION_BATCH_RE = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/batch$/;

const server = Bun.serve({
  port: cfg.port,
  hostname: cfg.host,
  async fetch(req, server) {
    const url = new URL(req.url);
    const ip = remoteAddr(req, server);
    const start = Date.now();
    const ctx = { authed: false };
    let res: Response;
    try {
      res = await handle(req, url, ip, ctx);
    } catch (e) {
      res = html(errorPage("服务器错误", errMsg(e)), 500);
    }
    appendAccessLog(ip, req.method, url.pathname + url.search, res.status, ctx.authed, Date.now() - start);
    return res;
  },
});
void server;

function remoteAddr(
  req: Request,
  server: { requestIP(request: Request): { address: string } | null }
): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return (xff.split(",")[0] ?? "").trim();
  const info = server.requestIP(req);
  return info?.address ?? "unknown";
}

function appendAccessLog(ip: string, method: string, path: string, status: number, authed: boolean, ms: number): void {
  const line = `${new Date().toISOString()} ${ip} ${method} ${path} → ${status} authed=${authed ? "yes" : "no"} ${ms}ms\n`;
  console.log(line.trim());
  try {
    appendFileSync(cfg.accessLogPath, line);
  } catch {
    // best-effort: never let logging fail a request
  }
}

function staticAsset(name: string, type: string, req: Request): Response {
  const f = Bun.file(join(STATIC_DIR, name));
  const etag = `"${f.size}-${f.lastModified}"`;
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304 });
  return new Response(f, {
    headers: { "content-type": type, "cache-control": "no-cache", etag, ...SEC_HEADERS },
  });
}

const ttsStage = new Map<string, { text: string; url: string; voice: string; exp: number }>();
const TTS_STAGE_TTL = 600000;
const TTS_CHUNK_TIMEOUT = 60000;

function chunkTextTTS(text: string, max = 120): string[] {
  text = text.replace(/\r/g, "").replace(/\n+/g, "。");
  const out: string[] = [];
  let buf = "";
  const push = (s: string) => { const t = s.trim(); if (t) out.push(t); };
  const hardCut = (s: string): string => {
    while (s.length > max) {
      let cut = 0;
      for (const d of ["，", ",", "；", ";", " ", "　"]) {
        const i = s.lastIndexOf(d, max);
        if (i > cut) cut = i;
      }
      if (cut === 0) cut = max;
      push(s.slice(0, cut));
      s = s.slice(cut);
    }
    return s;
  };
  for (const s of text.replace(/\r/g, "").split(/(?<=[。！？\n.!?])/)) {
    if ((buf + s).length > max) { push(buf); buf = ""; }
    buf += hardCut(s);
    if (buf.length > max) { push(buf); buf = ""; }
  }
  push(buf);
  return out;
}

async function handle(req: Request, url: URL, ip: string, ctx: { authed: boolean }): Promise<Response> {
  if (url.pathname === "/static/app.js") return staticAsset("app.js", "text/javascript; charset=utf-8", req);
  if (url.pathname === "/static/session.js") return staticAsset("session.js", "text/javascript; charset=utf-8", req);
  if (url.pathname === "/static/file.js") return staticAsset("file.js", "text/javascript; charset=utf-8", req);
  if (url.pathname === "/static/tts.js") return staticAsset("tts.js", "text/javascript; charset=utf-8", req);
  if (url.pathname === "/static/highlight.css") {
    return new Response(hlCss, {
      headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache", ...SEC_HEADERS },
    });
  }
  if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") {
    return staticAsset("favicon.svg", "image/svg+xml", req);
  }

  if (url.pathname === "/login") {
    if (req.method === "POST") {
      const form = await req.formData().catch(() => new FormData());
      const next = sanitizeNext(String(form.get("next") ?? "/"));
      if (!rateLimit(`login:${ip}`, 5, 5 / (15 * 60))) {
        return html(loginHTML(next, "尝试过多，15 分钟后再试"), 429);
      }
      const token = String(form.get("token") ?? "");
      if (token && token === cfg.authToken) {
        const setCookie = await makeAuthCookieHeader(cfg);
        return new Response(null, {
          status: 302,
          headers: { location: next, "set-cookie": setCookie },
        });
      }
      return html(loginHTML(next, "token 不对，再试一次"), 401);
    }
    const next = sanitizeNext(url.searchParams.get("next") ?? "/");
    return html(loginHTML(next));
  }

  const auth = await checkAuth(req, cfg);
  if (!auth.ok) {
    const next = sanitizeNext(url.pathname + url.search);
    return Response.redirect(`${url.origin}/login?next=${encodeURIComponent(next)}`, 302);
  }
  ctx.authed = true;

  if (url.pathname.startsWith("/api/") && !rateLimit(`api:${ip}`, 60, 1)) {
    return json({ error: "rate limited" }, 429);
  }

  const att = url.pathname.match(ATTACHMENT_RE);
  if (att) {
    const [, uuid] = att;
    if (!uuid) return new Response(null, { status: 400, headers: SEC_HEADERS });
    const row = getAttachment(uuid);
    if (!row) return new Response(null, { status: 404, headers: SEC_HEADERS });
    const stream = readAttachmentStream(uuid);
    if (!stream) return new Response(null, { status: 404, headers: SEC_HEADERS });
    const headers = new Headers(SEC_HEADERS);
    // Force download for non-image content types so uploaded .svg/.html can't execute
    // in-origin (stored XSS). Images render inline; everything else is attachment.
    headers.set(
      "content-type",
      isImageContentType(row.content_type) ? row.content_type : "application/octet-stream"
    );
    headers.set(
      "content-disposition",
      isImageContentType(row.content_type)
        ? `inline; filename="${row.filename.replace(/["\\]/g, "")}"`
        : `attachment; filename="${row.filename.replace(/["\\]/g, "")}"`
    );
    headers.set("cache-control", "private, max-age=3600");
    return new Response(stream.file, { status: 200, headers });
  }

  if (url.pathname === "/") {
    return Response.redirect(`${url.origin}/projects`, 302);
  }

  if (url.pathname === "/projects") {
    if (req.method === "POST") {
      if (!cfg.writesEnabled) return html(errorPage("只读模式", "WORK_WRITES_ENABLED=false"), 403);
      const form = await req.formData().catch(() => new FormData());
      const f: Record<string, string | undefined> = {};
      for (const [k, v] of form.entries()) f[k] = typeof v === "string" ? v : undefined;
      const r = handleCreateProject(f);
      return Response.redirect(`${url.origin}${r.location}`, 303);
    }
    return html(buildHome());
  }

  if (url.pathname === "/issues") {
    const state = parseState(url.searchParams.get("state"));
    const q = url.searchParams.get("q")?.trim() ?? "";
    try {
      return html(buildIssuesFeed(state, q));
    } catch (e) {
      return html(errorPage("加载失败", errMsg(e)), e instanceof StoreError ? e.status : 500);
    }
  }

  if (url.pathname.match(SESSIONS_RE)) {
    const q = url.searchParams.get("q")?.trim() ?? "";
    try {
      const { html: body } = await buildSessionList(opencode, q);
      return html(body);
    } catch (e) {
      return html(errorPage("加载失败", errMsg(e)), e instanceof OpencodeError ? e.status : 502);
    }
  }

  const sessionView = url.pathname.match(SESSION_VIEW_RE);
  if (sessionView) {
    const [, sid] = sessionView;
    if (!sid) return html(errorPage("404", "bad session path"), 404);
    const desc = url.searchParams.get("asc") !== "1";
    const all = url.searchParams.get("all") === "1";
    const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit")) || 30));
    try {
      const { html: body } = await buildSessionView(opencode, sid, desc, cfg.collapseLines, limit, all);
      return html(body);
    } catch (e) {
      const status = e instanceof OpencodeError ? e.status : 500;
      return html(errorPage(status === 404 ? "找不到会话" : "加载失败", errMsg(e)), status);
    }
  }

  if (url.pathname === "/file") {
    const rawPath = url.searchParams.get("path") ?? "";
    const mode = url.searchParams.get("mode") ?? undefined;
    const order = url.searchParams.get("order") ?? undefined;
    try {
      const view = url.searchParams.get("view") || undefined;
      const sort = url.searchParams.get("sort") || undefined;
      const tdir = url.searchParams.get("tdir") || undefined;
      const { html: body } = buildFileView(cfg, rawPath, mode, order, view, sort, tdir);
      return html(body);
    } catch (e) {
      const status = e instanceof FileViewError ? e.status : 500;
      return html(errorPage(status === 404 ? "文件不存在" : "无法查看", errMsg(e)), status);
    }
  }

  if (url.pathname === "/file/raw" || url.pathname === "/file/dl") {
    const rawPath = url.searchParams.get("path") ?? "";
    const disp = url.pathname === "/file/dl" ? "attachment" : "inline";
    try {
      return serveRawFile(cfg, rawPath, disp);
    } catch (e) {
      const status = e instanceof FileViewError ? e.status : 500;
      return html(errorPage(status === 404 ? "文件不存在" : "无法查看", errMsg(e)), status);
    }
  }

  if (url.pathname === "/api/file/since") {
    const rawPath = url.searchParams.get("path") ?? "";
    const after = Number(url.searchParams.get("after") ?? "0");
    if (!Number.isFinite(after) || after < 0) return json({ error: "bad after" }, 400);
    try {
      const delta = readFileSince(cfg, rawPath, after);
      return json(delta);
    } catch (e) {
      const status = e instanceof FileViewError ? e.status : 500;
      return json({ error: errMsg(e) }, status);
    }
  }

  if (req.method === "POST" && url.pathname === "/api/translate") {
    if (!rateLimit(`translate:${ip}`, 10, 10 / 60)) return json({ error: "rate limited" }, 429);
    try {
      const payload = (await req.json().catch(() => ({}))) as { text?: unknown };
      const text = typeof payload.text === "string" ? payload.text : "";
      if (!text.trim()) return json({ error: "text required" }, 400);
      const translation = await translateText(cfg, text);
      return json({ translation, html: renderMarkdown(translation) });
    } catch (e) {
      const status = e instanceof TranslateError ? e.status : 502;
      return json({ error: errMsg(e) }, status);
    }
  }

  if (req.method === "POST" && url.pathname === "/api/translate/stream") {
    if (!rateLimit(`translate:${ip}`, 10, 10 / 60)) return json({ error: "rate limited" }, 429);
    const payload = (await req.json().catch(() => ({}))) as { text?: unknown };
    const text = typeof payload.text === "string" ? payload.text : "";
    if (!text.trim()) return json({ error: "text required" }, 400);
    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (obj: unknown) => controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
        try {
          let full = "";
          for await (const chunk of translateTextStream(cfg, text)) {
            full += chunk;
            send({ d: chunk });
          }
          send({ h: renderMarkdown(full) });
        } catch (e) {
          send({ e: e instanceof Error ? e.message : String(e) });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: { "content-type": "application/x-ndjson; charset=utf-8", ...SEC_HEADERS },
    });
  }

  if (req.method === "GET" && url.pathname === "/api/tts/backends") {
    return json(cfg.ttsBackends.map((b) => ({ id: b.id, label: b.label, voice: b.voice })));
  }

  if (req.method === "POST" && url.pathname === "/api/tts") {
    if (!rateLimit(`tts:${ip}`, 30, 30 / 60)) return json({ error: "rate limited" }, 429);
    const payload = (await req.json().catch(() => ({}))) as { text?: unknown; backend?: unknown };
    const text = typeof payload.text === "string" ? payload.text : "";
    if (!text.trim()) return json({ error: "text required" }, 400);
    if (text.length > 8000) return json({ error: "text too long" }, 413);
    const backend = resolveTtsBackend(cfg, typeof payload.backend === "string" ? payload.backend : undefined);
    if (!backend) return json({ error: "tts disabled" }, 503);
    const id = crypto.randomUUID();
    const now = Date.now();
    if (ttsStage.size > 50) for (const [k, v] of ttsStage) if (v.exp < now) ttsStage.delete(k);
    ttsStage.set(id, { text, url: backend.url, voice: backend.voice, exp: now + TTS_STAGE_TTL });
    return json({ id });
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/tts/stream/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/tts/stream/".length));
    const entry = id && ttsStage.get(id);
    if (!entry) return json({ error: "not found or expired" }, 404);
    const segs = chunkTextTTS(entry.text);
    if (segs.length === 0) return json({ error: "empty text" }, 400);
    const upstream = `${entry.url.replace(/\/$/, "")}/audio/speech`;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for (const seg of segs) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), TTS_CHUNK_TIMEOUT);
            try {
              const upRes = await fetch(upstream, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ input: seg, voice: entry.voice, response_format: "mp3", speed: cfg.ttsSpeed }),
                signal: ctrl.signal,
              });
              if (!upRes.ok || !upRes.body) { controller.error(new Error(`tts upstream ${upRes.status}`)); return; }
              const reader = upRes.body.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value);
              }
            } finally {
              clearTimeout(timer);
            }
          }
          controller.close();
        } catch (e) {
          controller.error(e instanceof Error ? e : new Error(String(e)));
        }
      },
    });
    const headers = new Headers(SEC_HEADERS);
    headers.set("content-type", "audio/mpeg");
    headers.set("cache-control", "no-cache");
    return new Response(stream, { status: 200, headers });
  }

  if (url.pathname === "/settings") {
    if (req.method === "GET") {
      return html(buildSettingsPage(cfg, url.searchParams.get("saved") === "1").html);
    }
    if (req.method === "POST") {
      if (!rateLimit(`settings:${ip}`, 10, 10 / 60)) return html(errorPage("太快了", "请稍后再试"), 429);
      const form = await req.formData();
      let bad = "";
      for (const key of DB_OVERRIDABLE) {
        const v = form.get(String(key));
        if (typeof v !== "string") continue;
        if (parseOverride(key, v) === null) { bad = String(key); break; }
        setConfig(String(key), v);
      }
      if (bad) return html(errorPage(`无效的字段: ${bad}`, "请检查输入后重试"), 400);
      Object.assign(cfg, loadConfig());
      const rh = new Headers(SEC_HEADERS);
      rh.set("location", "/settings?saved=1");
      return new Response(null, { status: 303, headers: rh });
    }
  }

  const sinceApi = url.pathname.match(SESSION_SINCE_RE);
  if (sinceApi) {
    const [, sid] = sinceApi;
    if (!sid) return json({ error: "bad session path" }, 400);
    const sinceNum = Number(url.searchParams.get("since") ?? "0");
    const since = Number.isFinite(sinceNum) ? sinceNum : 0;
    try {
      const data = await opencode.exportSession(sid);
      const { items, lastCreated } = renderNewMessages(data, since, cfg.collapseLines);
      return json({ items, lastCreated });
    } catch (e) {
      return json({ error: errMsg(e) }, e instanceof OpencodeError ? e.status : 502);
    }
  }

  const batchApi = url.pathname.match(SESSION_BATCH_RE);
  if (batchApi) {
    const [, sid] = batchApi;
    if (!sid) return json({ error: "bad session path" }, 400);
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 30));
    const desc = url.searchParams.get("asc") !== "1";
    try {
      const data = await opencode.exportSession(sid);
      const batch = renderBatchHTML(data, offset, limit, desc, cfg.collapseLines);
      return json(batch);
    } catch (e) {
      return json({ error: errMsg(e) }, e instanceof OpencodeError ? e.status : 502);
    }
  }

  if (req.method === "POST") {
    if (!cfg.writesEnabled) return json({ error: "writes disabled" }, 403);
    const up = url.pathname.match(UPLOAD_RE);
    if (up) {
      const [, owner, repo, numStr] = up;
      if (!(owner && repo && numStr)) return json({ error: "bad path" }, 400);
      const cl = Number(req.headers.get("content-length") ?? "0");
      if (cl > MAX_ATTACHMENT_BYTES) return json({ error: "file too large (max 20MB)" }, 413);
      const number = Number(numStr);
      try {
        const project = getProject(owner, repo);
        if (!project) return json({ error: "project not found" }, 404);
        const issue = getIssueWithMeta(project.id, number);
        if (!issue) return json({ error: "issue not found" }, 404);
        const form = await req.formData().catch(() => null);
        const file = form?.get("attachment");
        if (!(file instanceof File)) return json({ error: "attachment required" }, 400);
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.length > MAX_ATTACHMENT_BYTES) return json({ error: "file too large (max 20MB)" }, 413);
        const filename = file.name || "upload.bin";
        const contentType = file.type || sniffImageContentType(filename);
        const uuid = newAttachmentUUID();
        const blobPath = saveAttachmentBlob(uuid, bytes);
        createAttachment({
          uuid,
          issue_id: issue.id,
          filename,
          content_type: contentType,
          size: bytes.length,
          blob_path: blobPath,
          uploaded_by: cfg.operatorLogin,
        });
        const isImg = isImageContentType(contentType);
        const markdown = isImg
          ? `![${filename}](/attachments/${uuid})`
          : `[${filename}](/attachments/${uuid})`;
        return json({ uuid, name: filename, markdown });
      } catch (e) {
        return json({ error: errMsg(e) }, e instanceof StoreError ? e.status : 500);
      }
    }

    const cp = url.pathname.match(COMMENT_POST_RE);
    if (cp) {
      const [, owner, repo, numStr] = cp;
      if (!(owner && repo && numStr)) return json({ error: "bad path" }, 400);
      const number = Number(numStr);
      try {
        const payload = (await req.json().catch(() => ({}))) as { body?: unknown; close?: unknown; reopen?: unknown };
        const body = typeof payload.body === "string" ? payload.body : "";
        const hasBody = body.trim().length > 0;
        const wantsStateChange = payload.close === true || payload.reopen === true;
        if (!hasBody && !wantsStateChange) return json({ error: "body required" }, 400);
        if (body.length > 65536) return json({ error: "body too long" }, 413);
        const project = getProject(owner, repo);
        if (!project) return json({ error: "project not found" }, 404);
        const issue = getIssueWithMeta(project.id, number);
        if (!issue) return json({ error: "issue not found" }, 404);
        let view: CommentView | null = null;
        if (hasBody) {
          const c = postComment(issue.id, body, cfg.operatorLogin);
          view = {
            id: c.id,
            tag: "human",
            login: c.author,
            avatar: "",
            created_at: c.created_at,
            body_html: renderMarkdown(c.body),
          };
        }
        let closed = false;
        let reopened = false;
        if (payload.close === true) {
          setIssueState(issue.id, "closed");
          closed = true;
        } else if (payload.reopen === true) {
          setIssueState(issue.id, "open");
          reopened = true;
        }
        return json({ comment: view, closed, reopened });
      } catch (e) {
        return json({ error: errMsg(e) }, e instanceof StoreError ? e.status : 500);
      }
    }

    const ci = url.pathname.match(REPO_LIST_RE);
    if (ci) {
      const [, owner, repo] = ci;
      if (!(owner && repo)) return json({ error: "bad path" }, 400);
      try {
        const form = await req.formData().catch(() => new FormData());
        const title = String(form.get("title") ?? "").trim();
        const body = String(form.get("body") ?? "");
        if (!title) return html(errorPage("标题不能为空", "回到上一页填写标题后重试"), 400);
        let project = getProject(owner, repo);
        if (!project) project = createProjectSafe(owner, repo);
        const issue = createIssue(project.id, title, body, cfg.operatorLogin);
        return Response.redirect(
          `${url.origin}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issue.number}`,
          303
        );
      } catch (e) {
        return html(errorPage("创建失败", errMsg(e)), e instanceof StoreError ? e.status : 500);
      }
    }
    return json({ error: "not found" }, 404);
  }

  const api = url.pathname.match(API_RE);
  if (api) {
    const [, owner, repo, numStr, kind] = api;
    if (!(owner && repo && numStr && kind)) return html(errorPage("404", "bad path"), 404);
    const number = Number(numStr);
    try {
      if (kind === "page") {
        const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
        const { issue, views, currentPage, hasOlder } = fetchIssuePage(cfg, owner, repo, number, page);
        const payload = {
          owner,
          repo,
          number,
          issueTitle: issue.title,
          state: issue.state,
          totalComments: issue.comment_count,
          currentPage,
          hasOlder,
          comments: views,
        };
        return json(payload);
      }
      const since = url.searchParams.get("since") ?? new Date(0).toISOString();
      const views = fetchIssueSince(cfg, owner, repo, number, since);
      return json({ comments: views });
    } catch (e) {
      return json({ error: errMsg(e) }, e instanceof StoreError ? e.status : 500);
    }
  }

  const isNew = url.pathname.match(REPO_NEW_RE);
  if (isNew) {
    const [, owner, repo] = isNew;
    if (!(owner && repo)) return html(errorPage("404", "bad path"), 404);
    return html(buildIssueNew(owner, repo, cfg.writesEnabled));
  }

  const view = url.pathname.match(REPO_ISSUE_RE);
  if (view) {
    const [, owner, repo, numStr] = view;
    if (!(owner && repo && numStr)) return html(errorPage("404", "bad path"), 404);
    const number = Number(numStr);
    try {
      const { html: body } = buildIssueThread(cfg, owner, repo, number);
      return html(body);
    } catch (e) {
      const status = e instanceof StoreError ? e.status : 500;
      return html(errorPage(status === 404 ? "找不到 issue" : "加载失败", errMsg(e)), status);
    }
  }

  const list = url.pathname.match(REPO_LIST_RE);
  if (list) {
    const [, owner, repo] = list;
    if (!(owner && repo)) return html(errorPage("404", "bad path"), 404);
    const state = parseState(url.searchParams.get("state"));
    const q = url.searchParams.get("q")?.trim() ?? "";
    try {
      return html(buildIssueList(owner, repo, state, cfg.writesEnabled, q));
    } catch (e) {
      return html(errorPage("加载失败", errMsg(e)), e instanceof StoreError ? e.status : 500);
    }
  }

  const repoMatch = url.pathname.match(REPO_RE);
  if (repoMatch) {
    const [, owner, repo] = repoMatch;
    if (!(owner && repo)) return html(errorPage("404", "bad path"), 404);
    return Response.redirect(
      `${url.origin}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
      302
    );
  }

  return html(errorPage("404", `未知路径: ${url.pathname}`), 404);
}

function parseState(s: string | null): "open" | "closed" | "all" {
  return s === "closed" ? "closed" : s === "all" ? "all" : "open";
}

function createProjectSafe(owner: string, name: string) {
  let project = getProject(owner, name);
  if (project) return project;
  // Auto-create project on first issue POST. Owner/name were already validated by the
  // URL regex shape; allow creation here so `/dog/newproject/issues` (POST) bootstraps
  // a project in one step. Use createIssue's tx for atomicity.
  project = createProject(owner, name, "");
  return project;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

console.log(`ework listening on http://${cfg.host}:${cfg.port} (writes=${cfg.writesEnabled}, operator=${cfg.operatorLogin})`);

export {};
