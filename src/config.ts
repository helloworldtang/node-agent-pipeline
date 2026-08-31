// 全局配置：全部支持环境变量覆盖，LLM 供应商可切换
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 项目根目录以本文件位置为准（src/ 的上一级），与进程启动目录无关——
// 避免服务被 Kimi Work 等外部宿主以不同 cwd 拉起时 .env 加载不到
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 加载 .env（Node ≥ 20.6 原生支持，文件不存在时静默跳过）；cwd 下的 .env 作为后备
try {
  process.loadEnvFile(resolve(PROJECT_ROOT, ".env"));
} catch {
  try {
    process.loadEnvFile(resolve(process.cwd(), ".env"));
  } catch {
    /* 无 .env 文件时忽略 */
  }
}

// === LLM 供应商预设（OpenAI 兼容协议）===
export interface LlmPreset {
  baseURL: string;
  flash: string; // 主控编排：快、function calling 稳
  pro: string; // 写作 subagent：质量优先
}

export const LLM_PRESETS: Record<string, LlmPreset> = {
  deepseek: {
    baseURL: "https://api.deepseek.com/v1",
    flash: "deepseek-v4-flash",
    pro: "deepseek-v4-pro",
  },
  moonshot: {
    baseURL: "https://api.moonshot.cn/v1",
    flash: "kimi-k2.5",
    pro: "kimi-k2.6",
  },
  custom: {
    baseURL: process.env.LLM_BASE_URL ?? "",
    flash: process.env.LLM_MODEL_FLASH ?? "",
    pro: process.env.LLM_MODEL_PRO ?? "",
  },
};

export const LLM_PROVIDER = (process.env.LLM_PROVIDER ?? "deepseek").toLowerCase();
// DEEPSEEK_API_KEY / MOONSHOT_API_KEY 作为便捷别名也认
export const LLM_API_KEY =
  process.env.LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? process.env.MOONSHOT_API_KEY ?? "";

// === HarnessAgent 校验循环 ===
export const MAX_RETRIES = Number(process.env.MAX_RETRIES ?? 2);
export const MIN_ARTICLE_LEN = Number(process.env.MIN_ARTICLE_LEN ?? 600);
// 逗号分隔；默认空 = 不强制任何固定结构（选题/结构自由）
export const REQUIRED_SECTIONS: string[] = (process.env.REQUIRED_SECTIONS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// 首轮无条件打回精修（默认关；演示校验回退时可开）
export const FORCE_FIRST_REFINE = process.env.FORCE_FIRST_REFINE === "1";
export const MAX_MATERIAL_CHARS = Math.max(1_000, Number(process.env.MAX_MATERIAL_CHARS ?? 12_000));
export const REQUIRE_SUMMARY = process.env.REQUIRE_SUMMARY === "1";
export const REQUIRE_CITATIONS = process.env.REQUIRE_CITATIONS === "1";

// 网络与 Web API 安全边界
export const HTTP_TIMEOUT_MS = Math.max(1_000, Number(process.env.HTTP_TIMEOUT_MS ?? 30_000));
export const HTTP_RETRIES = Math.max(0, Math.min(5, Number(process.env.HTTP_RETRIES ?? 2)));
export const API_MAX_BODY_BYTES = Math.max(
  64 * 1024,
  Number(process.env.API_MAX_BODY_BYTES ?? 16 * 1024 * 1024),
);
export const MAX_CONCURRENT_RUNS = Math.max(1, Number(process.env.MAX_CONCURRENT_RUNS ?? 1));
export const API_TOKEN = process.env.API_TOKEN?.trim() ?? "";

// === 可选：通用 MCP 素材服务（不设 MCP_COMMAND 则不启用）===
export const MCP_COMMAND = process.env.MCP_COMMAND ?? "";
export const MCP_ARGS = (process.env.MCP_ARGS ?? "").split(" ").filter(Boolean);

// === 素材 ===
export const MATERIALS_DIR = process.env.MATERIALS_DIR
  ? resolve(PROJECT_ROOT, process.env.MATERIALS_DIR)
  : resolve(PROJECT_ROOT, "materials");

// === 输出 ===
export const OUTPUT_DIR = resolve(PROJECT_ROOT, "output");
// 回收站沿用 output 目录，移动目录即可保留正文、历史版本、封面和日志。
export const TRASH_DIR = resolve(OUTPUT_DIR, ".trash");
// SQLite 索引默认和产出放在同一目录；正文文件仍以 output/<文章ID>/ 为准。
export const ARTICLE_DB_FILE = process.env.ARTICLE_DB_FILE
  ? resolve(PROJECT_ROOT, process.env.ARTICLE_DB_FILE)
  : resolve(OUTPUT_DIR, "articles.sqlite");

// === 公众号账号配置 ===
export const WECHAT_ACCOUNTS_FILE = process.env.WECHAT_ACCOUNTS_FILE
  ? resolve(PROJECT_ROOT, process.env.WECHAT_ACCOUNTS_FILE)
  : resolve(PROJECT_ROOT, "config/accounts.json");

// === AI 生图（OpenAI 兼容协议，可选；不配则界面上「AI 生成封面」不可用）===
export const IMAGE_API_KEY = process.env.IMAGE_API_KEY ?? "";
export const IMAGE_BASE_URL = process.env.IMAGE_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const IMAGE_MODEL = process.env.IMAGE_MODEL ?? "wanx2.1-t2i-turbo";
export const IMAGE_SIZE = process.env.IMAGE_SIZE ?? ""; // 各家写法不同，留空用供应商默认

// === 封面生图提示词模板：{description} 是占位符，生成时由 LLM 读文章内容自动填充 ===
export const DEFAULT_COVER_PROMPT =
  "微信公众号封面图，宽幅 2.35:1 横幅构图。" +
  "核心主体与视觉焦点必须集中在画面正中央约 42% 宽度的正方形安全区内" +
  "（该区域单独裁切为 1:1 方形封面时，主体须完整居中、不被切断），" +
  "左右两侧只延伸背景与氛围，不放关键元素。" +
  "风格：扁平编辑插画，配色简洁高级，明暗对比强，小尺寸缩略图下依然清晰可辨；" +
  "画面中不出现任何文字、字母或水印；背景干净，主体轮廓清晰，留白得当。" +
  "\n\n画面内容：{description}";
export const IMAGE_COVER_PROMPT = process.env.IMAGE_COVER_PROMPT ?? DEFAULT_COVER_PROMPT;

// === 封面库 ===
export const COVERS_DIR = resolve(PROJECT_ROOT, "covers");
