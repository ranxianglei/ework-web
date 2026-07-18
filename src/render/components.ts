import { actionBarHTML } from "./layout";

export type ActorTag = "human" | "bot" | "system";

// classifyActor determines the human/bot/system label from the comment body
// prefix only. We intentionally do NOT match on author-login === operator
// because ework currently has no separate bot accounts — both the user and
// any automation share the operator login, so author-based heuristics would
// mislabel the user's own comments as bot (see dog/awork-web#8).
export function classifyActor(body: string): ActorTag {
  const b = body ?? "";
  if (b.startsWith("[system]")) return "system";
  if (b.startsWith("[bot]")) return "bot";
  return "human";
}

export interface CommentView {
  id: number;
  tag: ActorTag;
  login: string;
  avatar: string;
  created_at: string;
  body_html: string;
  reactions?: { e: string; n: number }[];
}

const TAG_LABEL: Record<ActorTag, string> = { human: "👤", bot: "🤖", system: "⚙️" };

function esc(s: string): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = (Date.now() - t) / 1000;
  if (d < 60) return "刚刚";
  if (d < 3600) return Math.floor(d / 60) + "分钟前";
  if (d < 86400) return Math.floor(d / 3600) + "小时前";
  if (d < 86400 * 30) return Math.floor(d / 86400) + "天前";
  return new Date(t).toISOString().slice(0, 10);
}

// Must match app.js cardHTML so client hydration/polling produce identical markup.
export function renderCommentCard(c: CommentView): string {
  const tag = c.tag || "human";
  const label = TAG_LABEL[tag] || "👤";
  const rx =
    c.reactions && c.reactions.length
      ? `<span class="rx">${c.reactions
          .map((r) => `<span class="rxc">${r.e}<span class="rxn">${r.n}</span></span>`)
          .join("")}</span>`
      : "";
  return (
    `<div class="item item-${esc(tag)}" id="comment-${c.id}" data-id="${c.id}">` +
    `<div class="card"><div class="card-h">` +
    `<span class="tag tag-${esc(tag)}">${label} ${esc(tag)}</span>` +
    `<span class="who">${esc(c.login)}</span>` +
    `<span class="when" data-ts="${esc(c.created_at)}" title="${esc(c.created_at)}">${relTime(c.created_at)}</span>` +
    rx +
    `<span class="card-actions">` + actionBarHTML({ cid: String(c.id), copy: true, link: true, translate: true, tts: true }) + `</span>` +
    `</div><div class="card-b">${c.body_html}</div></div></div>`
  );
}
