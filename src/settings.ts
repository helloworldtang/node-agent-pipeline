// 图形化设置：界面填写 → 持久化写入 .env → 同步进 process.env 即时生效（无需重启）
// 安全约束：只允许白名单内的 key；密钥类字段读取时只回掩码，不回传明文
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PROJECT_ROOT, DEFAULT_COVER_PROMPT, LLM_PRESETS } from "./config.ts";
import { atomicWriteFile } from "./util/files.ts";

const ENV_FILE = resolve(PROJECT_ROOT, ".env");

/** 允许界面配置的 key 白名单 */
const EDITABLE = [
  "LLM_PROVIDER",
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "LLM_MODEL_FLASH",
  "LLM_MODEL_PRO",
  "IMAGE_API_KEY",
  "IMAGE_BASE_URL",
  "IMAGE_MODEL",
  "IMAGE_SIZE",
  "IMAGE_COVER_PROMPT",
] as const;

type EditableKey = (typeof EDITABLE)[number];

/** 密钥类字段：读取时掩码处理 */
const SECRET_KEYS = new Set<string>(["LLM_API_KEY", "IMAGE_API_KEY"]);

/** 有内置默认值的字段：界面直接回填默认值，用户只需填 key */
const DEFAULTS: Record<string, string> = {
  LLM_PROVIDER: "deepseek",
  IMAGE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  IMAGE_MODEL: "wanx2.1-t2i-turbo",
  IMAGE_COVER_PROMPT: DEFAULT_COVER_PROMPT,
};

function mask(v: string): string {
  if (v.length <= 8) return "****";
  return `${v.slice(0, 3)}****${v.slice(-4)}`;
}

export interface SettingItem {
  key: EditableKey;
  secret: boolean;
  set: boolean;
  /** 非密钥字段回明文；密钥字段回掩码（仅用于占位显示） */
  value: string;
}

/** 读取当前生效配置（process.env 为准；有默认值的字段回填默认值，LLM 字段回填当前供应商预设） */
export function getSettings(): SettingItem[] {
  const provider = (process.env.LLM_PROVIDER ?? "deepseek").toLowerCase();
  const preset = LLM_PRESETS[provider];
  const dynamic: Record<string, string> = {
    LLM_PROVIDER: provider,
    LLM_BASE_URL: preset?.baseURL ?? "",
    LLM_MODEL_FLASH: preset?.flash ?? "",
    LLM_MODEL_PRO: preset?.pro ?? "",
  };
  return EDITABLE.map((key) => {
    const effective = process.env[key] ?? dynamic[key] ?? DEFAULTS[key] ?? "";
    return {
      key,
      secret: SECRET_KEYS.has(key),
      set: Boolean(effective),
      value: effective ? (SECRET_KEYS.has(key) ? mask(effective) : effective) : "",
    };
  });
}

/** 更新配置：写 .env + 同步 process.env。空字符串 = 保持不变 */
export async function updateSettings(updates: Record<string, string>): Promise<string[]> {
  const changed: string[] = [];
  const entries = Object.entries(updates).filter(
    (kv): kv is [EditableKey, string] =>
      (EDITABLE as readonly string[]).includes(kv[0]) && kv[1] !== "",
  );
  if (entries.length === 0) return changed;

  let text = "";
  try {
    text = await readFile(ENV_FILE, "utf8");
  } catch { /* .env 不存在则新建 */ }
  const lines = text.split("\n");

  for (const [key, value] of entries) {
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    const line = `${key}=${value}`;
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
    process.env[key] = value; // 即时生效：健康检查 / 生图 / 后续启动的流水线子进程都读 process.env
    changed.push(key);
  }

  await atomicWriteFile(ENV_FILE, lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n", "utf8");
  return changed;
}
