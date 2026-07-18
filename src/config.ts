import { z } from "zod";
import { getConfigAll } from "./db";

export interface TtsBackend {
  id: string;
  label: string;
  url: string;
  voice: string;
}
export const DEFAULT_TTS_BACKENDS: TtsBackend[] = [
  { id: "kokoro", label: "Kokoro（快）", url: "http://gitea.example.local:9880/v1", voice: "zf_001" },
  { id: "cosyvoice3", label: "CosyVoice3（自然）", url: "http://gitea.example.local:9881/v1", voice: "default" },
];

export const configSchema = z.object({
  port: z.coerce.number().default(1196),
  host: z.string().default("127.0.0.1"),
  authToken: z.string().min(8, "WORK_TOKEN must be set (>= 8 chars)"),
  cookieSecret: z.string().min(8, "WORK_COOKIE_SECRET must be set (>= 8 chars)"),
  operatorLogin: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, "WORK_OPERATOR_LOGIN must be a plain login (alphanumeric)")
    .default("dog"),
  systemLogin: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, "WORK_SYSTEM_LOGIN must be a plain login (alphanumeric)")
    .default("ework-actions"),
  upstreamTimeoutMs: z.coerce.number().default(15000),
  secureCookie: z.boolean().default(false),
  // ework is human-facing; writes on by default. Flip off to use as a read-only mirror.
  writesEnabled: z.boolean().default(true),
  // Issue-thread comment order: 'desc' = newest first (top), 'asc' = oldest first.
  // Drives both SSR initial render and app.js display order.
  commentSort: z.enum(["desc", "asc"]).default("desc"),
  accessLogPath: z.string().default("/tmp/ework-access.log"),
  opencodeBin: z.string().default("opencode"),
  opencodeDbPath: z.string().default(
    `${process.env.XDG_DATA_HOME || `${process.env.HOME}/.local/share`}/opencode/opencode.db`
  ),
  contextBudget: z.coerce.number().int().positive().default(200000),
  collapseLines: z.coerce.number().int().positive().default(16),
  fileRoots: z
    .string()
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
    .default("/tmp,/home/user/projects"),
  fileMaxLines: z.coerce.number().int().positive().default(2000),
  fileMaxBytes: z.coerce.number().int().positive().default(512 * 1024),
  translateUrl: z.string().default("http://gitea.example.local:8199/v1"),
  translateModel: z.string().default("qwen2.5-7b"),
  ttsBackends: z
    .array(z.object({ id: z.string(), label: z.string(), url: z.string(), voice: z.string() }))
    .default(DEFAULT_TTS_BACKENDS),
  ttsDefaultBackend: z.string().default("kokoro"),
  ttsSpeed: z.coerce.number().min(0.25).max(4).default(1.0),
});

export type Config = z.infer<typeof configSchema>;

export type FieldType = "text" | "number" | "backend";
export interface SettingField {
  key: keyof Config;
  label: string;
  type: FieldType;
}
export interface SettingGroup {
  title: string;
  fields: SettingField[];
}
export const SETTINGS_GROUPS: SettingGroup[] = [
  {
    title: "翻译",
    fields: [
      { key: "translateUrl", label: "API 地址", type: "text" },
      { key: "translateModel", label: "模型", type: "text" },
    ],
  },
  {
    title: "朗读 (TTS)",
    fields: [
      { key: "ttsDefaultBackend", label: "默认引擎", type: "backend" },
      { key: "ttsSpeed", label: "语速 (0.25–4)", type: "number" },
    ],
  },
  {
    title: "会话显示",
    fields: [
      { key: "contextBudget", label: "上下文窗口 (tokens)", type: "number" },
      { key: "collapseLines", label: "折叠阈值 (行)", type: "number" },
    ],
  },
  {
    title: "Issue 评论排序",
    fields: [
      { key: "commentSort", label: "默认顺序（desc=最新在上 / asc=最老在上）", type: "text" },
    ],
  },
  {
    title: "文件查看",
    fields: [
      { key: "fileMaxLines", label: "最大行数", type: "number" },
      { key: "fileMaxBytes", label: "最大字节", type: "number" },
    ],
  },
];
export const DB_OVERRIDABLE: (keyof Config)[] = SETTINGS_GROUPS.flatMap((g) => g.fields.map((f) => f.key));

export function loadConfig(): Config {
  const db = getConfigAll();
  return configSchema.parse({
    port: process.env.WORK_PORT,
    host: process.env.WORK_HOST,
    authToken: process.env.WORK_TOKEN,
    cookieSecret: process.env.WORK_COOKIE_SECRET,
    operatorLogin: process.env.WORK_OPERATOR_LOGIN,
    systemLogin: process.env.WORK_SYSTEM_LOGIN,
    upstreamTimeoutMs: process.env.WORK_UPSTREAM_TIMEOUT_MS,
    secureCookie: process.env.WORK_SECURE_COOKIE === "true",
    writesEnabled: (process.env.WORK_WRITES_ENABLED ?? "true") === "true",
    commentSort: (db.commentSort as "desc" | "asc" | undefined) ?? process.env.WORK_COMMENT_SORT,
    accessLogPath: process.env.WORK_ACCESS_LOG ?? "/tmp/ework-access.log",
    opencodeDbPath: process.env.WORK_OPENCODE_DB,
    contextBudget: db.contextBudget ?? process.env.WORK_CONTEXT_BUDGET,
    collapseLines: db.collapseLines ?? process.env.WORK_COLLAPSE_LINES,
    fileRoots: process.env.WORK_FILE_ROOTS,
    fileMaxLines: db.fileMaxLines ?? process.env.WORK_FILE_MAX_LINES,
    fileMaxBytes: db.fileMaxBytes ?? process.env.WORK_FILE_MAX_BYTES,
    translateUrl: db.translateUrl ?? process.env.WORK_TRANSLATE_URL,
    translateModel: db.translateModel ?? process.env.WORK_TRANSLATE_MODEL,
    ttsDefaultBackend: db.ttsDefaultBackend ?? process.env.WORK_TTS_DEFAULT_BACKEND,
    ttsSpeed: db.ttsSpeed ?? process.env.WORK_TTS_SPEED,
  });
}

export function resolveTtsBackend(cfg: Config, id?: string): TtsBackend | null {
  const list = cfg.ttsBackends;
  if (list.length === 0) return null;
  return list.find((b) => b.id === id) ?? list.find((b) => b.id === cfg.ttsDefaultBackend) ?? list[0] ?? null;
}

export function parseOverride(key: keyof Config, raw: string): unknown | null {
  const shape = configSchema.shape as Record<string, z.ZodTypeAny>;
  const field = shape[key as string];
  if (!field) return null;
  const r = field.safeParse(raw);
  return r.success ? r.data : null;
}
