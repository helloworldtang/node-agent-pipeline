// 全局配置常量 —— DeepSeek 模型、校验阈值、MCP、输出目录
import { resolve } from "node:path";

// === DeepSeek（OpenAI 兼容协议）===
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
export const MODEL_FLASH = "deepseek-v4-flash"; // 主控编排：快、function calling 稳
export const MODEL_PRO = "deepseek-v4-pro"; // 写作 subagent：质量高（不可用时降级 flash）

// === HarnessAgent 校验循环 ===
export const MAX_RETRIES = 2; // 最多打回重写次数
export const MIN_ARTICLE_LEN = 600; // 正文最少字符数（含中文）
export const REQUIRED_SECTIONS = ["## 小结"]; // 必需结构：缺则打回重写（稳定演示一次校验循环）

// === exomind MCP（stdio）===
export const MCP_COMMAND = "exomind";
export const MCP_ARGS = ["mcp"];

// === 输出 ===
export const OUTPUT_DIR = resolve(process.cwd(), "output");

// === 运行参数 ===
export const REC_CURSOR_LIMIT = 200; // 递归上限兜底（react + 校验回退边可能较深）
