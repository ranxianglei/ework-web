import type { Config } from "./config";

// Token-cookie auth for a READ-ONLY viewer (not a strong session system — for
// hardened deploy, also front with Caddy basic-auth / mTLS). Auth via either:
//   (a) a one-shot ?token=... link (cookie set, then redirect without it), or
//   (b) the /login form (preferred UX — no token ever in a shareable URL).
// Either way the HMAC-signed cookie lasts AUTH_COOKIE_MAX_AGE_SECONDS; after
// that all navigation is token-free.

export const AUTH_COOKIE_NAME = "ework_auth";
export const AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return Buffer.from(new Uint8Array(sig)).toString("base64url");
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export interface AuthResult {
  ok: boolean;
  setCookie?: string;
  redirectLocation?: string;
}

export function authCookieName(cfg: Config): string {
  // __Host- prefix (C2 hardening) requires Secure + Path=/ + no Domain and is only
  // honored by browsers over TLS; cfg.secureCookie is flipped on only after Caddy/TLS.
  return cfg.secureCookie ? `__Host-${AUTH_COOKIE_NAME}` : AUTH_COOKIE_NAME;
}

export async function makeAuthCookieHeader(cfg: Config): Promise<string> {
  const sig = await hmac(cfg.cookieSecret, cfg.authToken);
  const value = `${cfg.authToken}.${sig}`;
  const flags = ["Path=/", "HttpOnly", `Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}`, "SameSite=Lax"];
  if (cfg.secureCookie) flags.push("Secure");
  return `${authCookieName(cfg)}=${value}; ${flags.join("; ")}`;
}

function ctEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export async function checkAuth(req: Request, cfg: Config): Promise<AuthResult> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const cookieVal = cookies[authCookieName(cfg)];

  if (cookieVal) {
    const dot = cookieVal.lastIndexOf(".");
    if (dot > 0) {
      const token = cookieVal.slice(0, dot);
      const sig = cookieVal.slice(dot + 1);
      const expected = await hmac(cfg.cookieSecret, token);
      if (ctEqual(sig, expected) && ctEqual(token, cfg.authToken)) {
        return { ok: true };
      }
    }
  }

  return { ok: false };
}

// Same-origin relative targets only. Rejects "//" and "/\" — browsers collapse a
// leading "/\" to "//" (protocol-relative), an open-redirect bypass (M1).
export function sanitizeNext(next: string): string {
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  try {
    const u = new URL(next, "http://x.invalid");
    if (u.origin !== "http://x.invalid") return "/";
  } catch {
    return "/";
  }
  return next;
}

function esc(s: string): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function loginHTML(next: string, error?: string): string {
  const err = error ? `<div class="err">${esc(error)}</div>` : "";
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>登录 · ework</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#1b1b1b;color:#e6e6e6;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:#262626;border:1px solid #373737;border-radius:12px;padding:1.8rem;max-width:360px;width:90%}
h1{font-size:18px;margin:0 0 1.2rem;font-weight:600}
input{width:100%;box-sizing:border-box;padding:.75rem;border:1px solid #373737;border-radius:8px;background:#1b1b1b;color:#e6e6e6;font:inherit;margin-bottom:.8rem}
input:focus{outline:none;border-color:#2da44e}
button{width:100%;padding:.75rem;border:none;border-radius:8px;background:#2da44e;color:#fff;font:600 14px system-ui,sans-serif;cursor:pointer}
button:hover{background:#218742}
.err{color:#f85149;font-size:13px;margin-bottom:.8rem}
.hint{color:#9a9a9a;font-size:12px;line-height:1.5;margin-top:1rem}
</style></head><body>
<form class="box" method="POST" action="/login" autocomplete="off">
<h1>🔒 ework 登录</h1>
${err}
<input type="password" name="token" placeholder="访问 token" autofocus required>
<input type="hidden" name="next" value="${esc(next)}">
<button type="submit">登录</button>
<div class="hint">登录后写 cookie，30 天内、所有页面都不用再带 token；链接可随意分享，不含 token。</div>
</form></body></html>`;
}
