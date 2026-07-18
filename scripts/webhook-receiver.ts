#!/usr/bin/env bun
// Test receiver for ework webhooks. Listens on a port, prints each delivery,
// and writes every received payload to a JSONL log file. Used by
// scripts/webhook-test.sh to verify the full pipeline end-to-end.
//
// Usage:
//   bun run scripts/webhook-receiver.ts [port] [secret]
//   PORT=8099 SECRET=topsecret bun run scripts/webhook-receiver.ts
//
// Log file: ./webhook-received.jsonl (one JSON object per line per delivery).

import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.PORT ?? process.argv[2] ?? "8099");
const SECRET = process.env.SECRET ?? process.argv[3] ?? "";
const LOG_FILE = resolve(process.env.LOG_FILE ?? "./webhook-received.jsonl");

mkdirSync(resolve(LOG_FILE, ".."), { recursive: true });

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

function verifySig(body: string, header: string | null): boolean {
  if (!SECRET) return true;
  if (!header) return false;
  const expected = sign(body);
  if (expected.length !== header.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(header));
  } catch {
    return false;
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") {
      return new Response("ework webhook receiver ready\n", { headers: { "Content-Type": "text/plain" } });
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok\n", { headers: { "Content-Type": "text/plain" } });
    }
    if (req.method !== "POST") {
      return new Response("method not allowed\n", { status: 405 });
    }

    const rawBody = await req.text();
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });

    const delivery = headers["x-gitea-delivery"] ?? headers["x-github-delivery"] ?? "(none)";
    const event = headers["x-gitea-event"] ?? headers["x-github-event"] ?? "(none)";
    const sig = headers["x-gitea-signature"] ?? headers["x-gogs-signature"] ?? null;
    const ghSig = headers["x-github-signature-256"] ?? null;

    const valid = verifySig(rawBody, sig);
    const ghValid = !SECRET || (ghSig ? ghSig === `sha256=${sign(rawBody)}` : false);

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      // ignore — non-JSON body, leave parsed null
    }

    const summary = {
      ts: new Date().toISOString(),
      delivery,
      event,
      sig_present: !!sig,
      sig_valid: valid,
      gh_sig_present: !!ghSig,
      gh_sig_valid: ghValid,
      content_type: headers["content-type"] ?? null,
      user_agent: headers["user-agent"] ?? null,
      path: url.pathname,
      body_len: rawBody.length,
      body: parsed,
      raw: rawBody,
    };

    appendFileSync(LOG_FILE, JSON.stringify(summary) + "\n");

    const status = valid ? 200 : 401;
    const tag = valid ? "OK" : "BAD-SIG";
    const preview = typeof parsed === "object" && parsed && "action" in (parsed as Record<string, unknown>)
      ? ` action=${(parsed as { action: string }).action}`
      : "";
    console.log(
      `[${summary.ts}] ${event} delivery=${delivery.slice(0, 8)} ${tag}${preview} len=${rawBody.length} sig=${sig ? sig.slice(0, 10) + "…" : "-"} gh_sig=${ghValid ? "ok" : (ghSig ? "BAD" : "-")}`
    );

    if (!valid) {
      return new Response("invalid signature\n", { status: 401 });
    }

    return new Response(JSON.stringify({ received: true, delivery, event }, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
});

console.log(`ework webhook receiver listening on http://localhost:${server.port}`);
console.log(`  secret: ${SECRET ? SECRET.length + " chars" : "(none — no signature verification)"}`);
console.log(`  log:    ${LOG_FILE}`);
console.log(`\nTo configure against ework, add a webhook at:`);
console.log(`  http://localhost:${server.port}/hook`);
console.log(`\nCtrl-C to stop.`);
