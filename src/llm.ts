// LLM 模型工厂：供应商可切换（deepseek / moonshot / custom），统一走 OpenAI 兼容协议
import { ChatOpenAI } from "@langchain/openai";
import { HTTP_RETRIES, HTTP_TIMEOUT_MS, LLM_API_KEY, LLM_PRESETS, LLM_PROVIDER } from "./config.ts";

export type ModelTier = "flash" | "pro";

export function buildLlm(tier: ModelTier = "flash", temperature = 0.7): ChatOpenAI {
  const preset = LLM_PRESETS[LLM_PROVIDER];
  if (!preset) {
    throw new Error(
      `未知 LLM_PROVIDER="${LLM_PROVIDER}"，可选：${Object.keys(LLM_PRESETS).join(", ")}`,
    );
  }
  if (!LLM_API_KEY) {
    throw new Error(`缺少 API key：请设置 LLM_API_KEY（或 DEEPSEEK_API_KEY / MOONSHOT_API_KEY）`);
  }
  const model =
    (tier === "pro" ? process.env.LLM_MODEL_PRO : process.env.LLM_MODEL_FLASH) ??
    (tier === "pro" ? preset.pro : preset.flash);
  const baseURL = process.env.LLM_BASE_URL ?? preset.baseURL;
  if (!model || !baseURL) {
    throw new Error(
      `供应商 "${LLM_PROVIDER}" 缺少模型名或 baseURL（custom 模式必须设置 LLM_BASE_URL / LLM_MODEL_FLASH / LLM_MODEL_PRO）`,
    );
  }
  return new ChatOpenAI({
    model,
    apiKey: LLM_API_KEY,
    configuration: { baseURL },
    temperature,
    timeout: HTTP_TIMEOUT_MS,
    maxRetries: HTTP_RETRIES,
  });
}

// 判断某次错误是否是「模型不可用」(用于 pro→flash 降级)
export function isModelUnavailable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /model_not_found|404|does not exist|not found/i.test(msg);
}
