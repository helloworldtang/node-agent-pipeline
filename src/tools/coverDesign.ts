// 封面设计：用 LLM 读文章内容，自动产出生图模型需要的画面描述
// 配置跟随 LLM 供应商（动态读 process.env，设置面板改动即时生效）
import { LLM_API_KEY, LLM_PRESETS, HTTP_RETRIES, HTTP_TIMEOUT_MS } from "../config.ts";
import { fetchWithRetry } from "../util/http.ts";

/**
 * 根据文章内容生成封面画面描述（中文，1~2 句，具象可视化）
 * @param markdown 文章正文（只取前 3000 字符，够判断主题了）
 * @param hint 可选：用户补充的画面要求
 */
export async function describeArticleForCover(markdown: string, hint?: string): Promise<string> {
  const provider = (process.env.LLM_PROVIDER ?? "deepseek").toLowerCase();
  const preset = LLM_PRESETS[provider];
  const baseURL = (process.env.LLM_BASE_URL || preset?.baseURL || "").replace(/\/$/, "");
  const model = process.env.LLM_MODEL_FLASH || preset?.flash || "";
  const apiKey = process.env.LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? process.env.MOONSHOT_API_KEY ?? LLM_API_KEY;
  if (!apiKey || !baseURL || !model) {
    throw new Error("LLM 未配置，无法自动设计封面（请先在「⚙ 设置」配置 LLM_API_KEY）");
  }

  const res = await fetchWithRetry(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content:
            "你是公众号封面设计师。根据文章内容，用 1~2 句话描述封面图应该画什么：" +
            "主体、场景、氛围、配色。要求具象、可视化（画得出的东西），避免抽象概念和修辞。" +
            "只输出画面描述本身，不要解释、不要引号，不超过 80 字。",
        },
        {
          role: "user",
          content:
            `文章内容（节选）：\n${markdown.slice(0, 3000)}` +
            (hint?.trim() ? `\n\n额外要求：${hint.trim()}` : ""),
        },
      ],
    }),
  }, { retries: HTTP_RETRIES, retryPost: true, timeoutMs: HTTP_TIMEOUT_MS, label: "封面设计" });
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!res.ok || !text) {
    throw new Error(`封面设计失败（HTTP ${res.status}）：${data.error?.message ?? "模型未返回内容"}`);
  }
  return text;
}
