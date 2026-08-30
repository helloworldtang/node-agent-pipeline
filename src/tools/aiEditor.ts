// AI 片段编辑与重写：根据文章语境与用户对话意图，对选中片段进行多轮润色与重写
import { LLM_API_KEY, LLM_PRESETS, HTTP_RETRIES, HTTP_TIMEOUT_MS } from "../config.ts";
import { fetchWithRetry } from "../util/http.ts";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface RewriteSelectionOptions {
  selectedText: string;
  instruction: string;
  fullText?: string;
  history?: ChatMessage[];
  tier?: "flash" | "pro";
}

export interface RewriteSelectionResult {
  rewrittenText: string;
  explanation: string;
  model: string;
}

export interface RegenerateArticleOptions {
  topic?: string;
  sourceNotes?: string;
  currentTitle: string;
  currentArticle: string;
  instruction: string;
  history?: ChatMessage[];
  tier?: "flash" | "pro";
}

export interface RegenerateArticleResult {
  title: string;
  article: string;
  explanation: string;
  model: string;
}

const AI_EDITOR_SYSTEM_PROMPT = `你是一名极其专业、文字功底深厚、敏锐且严谨的文章主编与资深写手。
你的任务是根据提供的文章整体语境和具体修改意图，对文章中选定的局部片段进行高质量的重写、润色或结构优化。

必须严格遵守以下原则：
1. 风格一致：重写后的片段必须与前后文的语调、用词习惯、核心观点自然契合，上下文衔接顺畅。
2. 忠于意图：严格贯彻用户的具体想法、修改诉求（如口语化、增强说服力、提炼要点、增加比喻、扩写/精简等）。
3. 局部聚焦：仅针对选定的片段进行重写，不要包含片段之外的前后文，以便系统直接无缝替换原选区。
4. 格式规范：输出标准 Markdown 格式。
5. 严格输出约定：为了便于程序准确提取，你的回答必须包含以下两个分隔标记：
===REWRITE===
（这里是重写后的 Markdown 正文片段）
===EXPLANATION===
（这里用 1~2 句话简要概括本次重写的改动要点与亮点）`;

const ARTICLE_REGENERATE_SYSTEM_PROMPT = `你是一名公众号资深主编与写手，负责根据用户的对话式提示，重新生成一篇完整文章。
必须遵守：
1. 保留原文中已经成立的事实、核心观点和必要细节；只按用户提示调整结构、语气、篇幅、受众或表达方式。
2. 输出完整 Markdown 正文，正文首行不要重复输出一级标题，文章小节统一使用 ## 或 ###。
3. 标题要准确、有吸引力，通常控制在 10~30 字；除非用户明确要求，尽量保留原标题的核心主题。
4. 不要输出与文章无关的寒暄、分析过程或代码围栏。
5. 必须严格使用以下分隔标记输出：
===TITLE===
（文章主标题，单行）
===CONTENT===
（完整 Markdown 正文）
===EXPLANATION===
（用 1~2 句话概括本轮修改重点）`;

/** 解析整篇文章重新生成结果，兼容模型偶尔漏掉说明标记的情况。 */
export function parseArticleRegenerateOutput(
  raw: string,
  fallbackTitle: string,
  fallbackArticle: string,
): { title: string; article: string; explanation: string } {
  const text = String(raw ?? "").trim();
  if (!text) {
    return { title: fallbackTitle, article: fallbackArticle, explanation: "模型未返回新文章，保留当前版本" };
  }

  const titleMarker = "===TITLE===";
  const contentMarker = "===CONTENT===";
  const explanationMarker = "===EXPLANATION===";
  if (text.includes(titleMarker) && text.includes(contentMarker)) {
    const afterTitle = text.split(titleMarker)[1] ?? "";
    const [titlePart, ...contentParts] = afterTitle.split(contentMarker);
    const afterContent = contentParts.join(contentMarker);
    const [articlePart, ...explanationParts] = afterContent.split(explanationMarker);
    return {
      title: (titlePart ?? "").replace(/^[#\s]+/, "").split("\n")[0]?.trim() || fallbackTitle,
      article: (articlePart ?? "").trim() || fallbackArticle,
      explanation: explanationParts.join(explanationMarker).trim() || "已根据提示重新生成整篇文章",
    };
  }

  const jsonCandidate = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? text;
  try {
    const parsed = JSON.parse(jsonCandidate) as { title?: unknown; article?: unknown; content?: unknown; explanation?: unknown };
    if (parsed && typeof parsed === "object") {
      const article = String(parsed.article ?? parsed.content ?? "").trim();
      if (article) {
        return {
          title: String(parsed.title ?? "").trim() || fallbackTitle,
          article,
          explanation: String(parsed.explanation ?? "已根据提示重新生成整篇文章").trim(),
        };
      }
    }
  } catch {
    /* 不是 JSON，继续兜底 */
  }

  const h1 = text.match(/^#\s+([^\n]+)\n*([\s\S]*)$/);
  if (h1) {
    return {
      title: h1[1]!.trim() || fallbackTitle,
      article: h1[2]!.trim() || fallbackArticle,
      explanation: "已根据提示重新生成整篇文章",
    };
  }
  return { title: fallbackTitle, article: text, explanation: "已根据提示重新生成整篇文章" };
}

/** 解析模型输出中的重写正文与修改说明 */
export function parseRewriteOutput(raw: string, fallbackOriginal: string): { rewrittenText: string; explanation: string } {
  const text = String(raw ?? "").trim();
  if (!text) {
    return { rewrittenText: fallbackOriginal, explanation: "未提供修改内容" };
  }

  const rewriteMarker = "===REWRITE===";
  const explanationMarker = "===EXPLANATION===";

  if (text.includes(rewriteMarker)) {
    const afterRewrite = text.split(rewriteMarker)[1] ?? "";
    if (afterRewrite.includes(explanationMarker)) {
      const [rewritePart, ...explanationParts] = afterRewrite.split(explanationMarker);
      const rewrittenText = (rewritePart ?? "").trim();
      const explanation = explanationParts.join(explanationMarker).trim() || "已根据要求完成重写";
      return { rewrittenText: rewrittenText || fallbackOriginal, explanation };
    } else {
      return { rewrittenText: afterRewrite.trim() || fallbackOriginal, explanation: "已根据要求完成重写" };
    }
  }

  // 若模型未输出分隔符，尝试剔除可能的外层代码块
  const cleaned = text.replace(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i, "$1").trim();
  return { rewrittenText: cleaned || fallbackOriginal, explanation: "已根据要求完成修改" };
}

/**
 * 执行 AI 片段编辑与重写
 */
export async function rewriteSelection(options: RewriteSelectionOptions): Promise<RewriteSelectionResult> {
  const { selectedText, instruction, fullText, history = [], tier = "flash" } = options;
  const trimmedSelection = selectedText.trim();
  const trimmedInstruction = instruction.trim();

  if (!trimmedSelection) {
    throw new Error("选中的文本片段不能为空");
  }
  if (!trimmedInstruction) {
    throw new Error("修改意图或指令不能为空");
  }

  const provider = (process.env.LLM_PROVIDER ?? "deepseek").toLowerCase();
  const preset = LLM_PRESETS[provider];
  const baseURL = (process.env.LLM_BASE_URL || preset?.baseURL || "").replace(/\/$/, "");
  const model =
    (tier === "pro" ? process.env.LLM_MODEL_PRO : process.env.LLM_MODEL_FLASH) ??
    (tier === "pro" ? preset?.pro : preset?.flash) ??
    "";
  const apiKey =
    process.env.LLM_API_KEY ??
    process.env.DEEPSEEK_API_KEY ??
    process.env.MOONSHOT_API_KEY ??
    LLM_API_KEY;

  if (!apiKey || !baseURL || !model) {
    throw new Error("LLM 未配置，无法进行 AI 编辑（请先在「⚙ 设置」配置 LLM_API_KEY）");
  }

  // 构造上下文背景（截取前后文，防止超出 token）
  let contextSnippet = "";
  if (fullText && fullText.trim()) {
    const cleanFull = fullText.trim();
    if (cleanFull.length > 4000) {
      // 找到选区在全文中的大致位置，保留前后上下文
      const pos = cleanFull.indexOf(trimmedSelection);
      if (pos >= 0) {
        const start = Math.max(0, pos - 1500);
        const end = Math.min(cleanFull.length, pos + trimmedSelection.length + 1500);
        contextSnippet = `...${cleanFull.slice(start, end)}...`;
      } else {
        contextSnippet = cleanFull.slice(0, 3500);
      }
    } else {
      contextSnippet = cleanFull;
    }
  }

  // 构造 messages 数组
  const apiMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    {
      role: "system",
      content: AI_EDITOR_SYSTEM_PROMPT,
    },
  ];

  // 如果有上下文背景，加入提示
  if (contextSnippet) {
    apiMessages.push({
      role: "user",
      content: `【整篇文章上下文参考】\n${contextSnippet}\n\n（以上仅作为风格与语境参考，请不要修改选区外的其他内容）`,
    });
    apiMessages.push({
      role: "assistant",
      content: "了解，我已掌握文章的主题、行文风格与上下文语境。请提供需要修改的选定片段及具体诉求。",
    });
  }

  // 载入多轮历史对话
  for (const h of history) {
    if (h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string") {
      apiMessages.push({
        role: h.role,
        content: h.content,
      });
    }
  }

  // 本轮请求
  const isFirstTurn = history.length === 0;
  const currentPrompt = isFirstTurn
    ? `【需要修改的原文片段】\n${trimmedSelection}\n\n【修改想法/诉求】\n${trimmedInstruction}\n\n请按规范输出 ===REWRITE=== 和 ===EXPLANATION===。`
    : `【进一步修改想法/诉求】\n${trimmedInstruction}\n\n请按规范输出 ===REWRITE=== 和 ===EXPLANATION===。`;

  apiMessages.push({
    role: "user",
    content: currentPrompt,
  });

  const res = await fetchWithRetry(
    `${baseURL}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        messages: apiMessages,
      }),
    },
    {
      retries: HTTP_RETRIES,
      retryPost: true,
      timeoutMs: HTTP_TIMEOUT_MS,
      label: "AI 编辑片段重写",
    },
  );

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };

  const reply = data.choices?.[0]?.message?.content?.trim();
  if (!res.ok || !reply) {
    throw new Error(`AI 编辑请求失败（HTTP ${res.status}）：${data.error?.message ?? "模型未返回内容"}`);
  }

  const { rewrittenText, explanation } = parseRewriteOutput(reply, trimmedSelection);

  return {
    rewrittenText,
    explanation,
    model,
  };
}

/** 根据整篇文章与多轮提示生成新版本；只有用户在前端采纳后才会写回文章库。 */
export async function regenerateArticle(options: RegenerateArticleOptions): Promise<RegenerateArticleResult> {
  const {
    topic = "",
    sourceNotes = "",
    currentTitle,
    currentArticle,
    instruction,
    history = [],
    tier = "pro",
  } = options;
  const title = currentTitle.trim();
  const article = currentArticle.trim();
  const prompt = instruction.trim();
  if (!title) throw new Error("当前文章标题不能为空");
  if (!article) throw new Error("当前文章正文不能为空");
  if (!prompt) throw new Error("重新生成提示词不能为空");

  const provider = (process.env.LLM_PROVIDER ?? "deepseek").toLowerCase();
  const preset = LLM_PRESETS[provider];
  const baseURL = (process.env.LLM_BASE_URL || preset?.baseURL || "").replace(/\/$/, "");
  const model =
    (tier === "pro" ? process.env.LLM_MODEL_PRO : process.env.LLM_MODEL_FLASH) ??
    (tier === "pro" ? preset?.pro : preset?.flash) ??
    "";
  const apiKey =
    process.env.LLM_API_KEY ??
    process.env.DEEPSEEK_API_KEY ??
    process.env.MOONSHOT_API_KEY ??
    LLM_API_KEY;
  if (!apiKey || !baseURL || !model) {
    throw new Error("LLM 未配置，无法重新生成文章（请先在「⚙ 设置」配置 LLM_API_KEY）");
  }

  const apiMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: ARTICLE_REGENERATE_SYSTEM_PROMPT },
    {
      role: "user",
      content: `【原始选题】\n${topic.trim() || title}\n\n【原始素材笔记】\n${sourceNotes.trim() || "（没有保存的原始素材，请主要依据文章正文）"}\n\n【当前文章标题】\n${title}\n\n【当前文章全文】\n${article}\n\n这是本轮对话的基础版本，请同时参考原始选题与素材，在此基础上按后续提示重新生成。`,
    },
    {
      role: "assistant",
      content: "已了解当前文章。我会保留核心事实与观点，并根据你的提示输出完整的新版本。",
    },
  ];
  for (const h of history) {
    if (h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string") {
      apiMessages.push({ role: h.role, content: h.content });
    }
  }
  apiMessages.push({
    role: "user",
    content: history.length === 0
      ? `【重新生成提示词】\n${prompt}\n\n请输出完整的新标题、Markdown 正文和修改说明。`
      : `【基于上一次结果继续修改】\n${prompt}\n\n请输出完整的新标题、Markdown 正文和修改说明。`,
  });

  const res = await fetchWithRetry(
    `${baseURL}/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature: 0.75, messages: apiMessages }),
    },
    { retries: HTTP_RETRIES, retryPost: true, timeoutMs: HTTP_TIMEOUT_MS, label: "AI 重新生成整篇文章" },
  );
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  const reply = data.choices?.[0]?.message?.content?.trim();
  if (!res.ok || !reply) {
    throw new Error(`AI 重新生成请求失败（HTTP ${res.status}）：${data.error?.message ?? "模型未返回内容"}`);
  }
  const parsed = parseArticleRegenerateOutput(reply, title, article);
  return { ...parsed, model };
}
