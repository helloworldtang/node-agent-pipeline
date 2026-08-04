// DeepSeek 模型工厂：经 @langchain/openai 的 ChatOpenAI 走 OpenAI 兼容协议
import { ChatOpenAI } from "@langchain/openai";
import { DEEPSEEK_BASE_URL, MODEL_FLASH, MODEL_PRO } from "./config.ts";

export type ModelTier = "flash" | "pro";

export function buildLlm(tier: ModelTier = "flash", temperature = 0.7): ChatOpenAI {
  const model = tier === "pro" ? MODEL_PRO : MODEL_FLASH;
  const llm = new ChatOpenAI({
    model,
    apiKey: process.env.DEEPSEEK_API_KEY,
    configuration: { baseURL: DEEPSEEK_BASE_URL },
    temperature,
  });
  return llm;
}

// 判断某次错误是否是「模型不可用」(用于 pro→flash 降级)
export function isModelUnavailable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /model_not_found|404|does not exist|not found/i.test(msg);
}
