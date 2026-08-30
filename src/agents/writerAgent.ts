// 写作 subagent：独立 createAgent（更强模型 pro，不可用降级 flash），用 tool() 包成 delegate_to_writer 挂给主 ReAct
// 与主控上下文隔离（独立 thread_id），符合「subagent = 隔离上下文的子 agent」范式
import { createAgent, tool } from "langchain";
import { z } from "zod";
import { buildLlm, isModelUnavailable, type ModelTier } from "../llm.ts";
import { MIN_ARTICLE_LEN } from "../config.ts";

const WRITER_PROMPT = `你是一名公众号资深写手与编辑，擅长把知识点、探讨结论改写成「自己理解后讲给别人听」的高质量公众号爆款文章。
要求：
- 独立拟定一个吸引人、有传播力且符合微信公众号调性的文章主标题（10~30 字以内）。
- 输出完整 Markdown 正文；结构自由，根据内容自然组织（可用二级/三级小节标题 ##/###、列表、代码块、引用块，不强制固定格式）。
- 第一人称、讲人话：像跟朋友解释清楚一件事，有自己的理解和取舍，不做资料罗列。
- 面向对该话题感兴趣但未必有背景的普通读者，关键概念要解释。
- 正文首行无需重复输出一级标题（微信公众号已自带主标题渲染），小节统一使用 ## 或 ###。
- 只输出规定格式，不要前后寒暄、不要解释、不要用外部代码围栏包裹整篇输出。

输出格式规范（必须严格遵守以下分隔标记）：
===TITLE===
（这里是拟定的文章主标题，单行，不要带 # 号）
===CONTENT===
（这里是完整的 Markdown 正文）`;

export interface WriterOutput {
  title: string;
  article: string;
}

/** 鲁棒解析模型输出的标题与正文 */
export function parseWriterOutput(raw: string, fallbackTitle = "未命名文章"): WriterOutput {
  const text = String(raw ?? "").trim();
  if (!text) return { title: fallbackTitle, article: "" };

  // 1. 标准分隔标记解析
  const titleMarker = "===TITLE===";
  const contentMarker = "===CONTENT===";
  if (text.includes(titleMarker) && text.includes(contentMarker)) {
    const afterTitle = text.split(titleMarker)[1] ?? "";
    const [titlePart, ...contentParts] = afterTitle.split(contentMarker);
    const title = (titlePart ?? "")
      .replace(/^[#\s]+/, "")
      .split("\n")[0]
      ?.trim() || fallbackTitle;
    const article = contentParts.join(contentMarker).trim();
    return { title, article };
  }

  // 2. 尝试 JSON 格式解析（部分模型可能会输出 json 块）
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const jsonCandidate = jsonMatch ? jsonMatch[1] : text;
  try {
    const parsed = JSON.parse(jsonCandidate ?? "");
    if (parsed && typeof parsed === "object") {
      const title = String(parsed.title ?? "").trim() || fallbackTitle;
      const article = String(parsed.article ?? parsed.content ?? parsed.markdown ?? "").trim();
      if (article) return { title, article };
    }
  } catch {
    /* 不是 JSON，继续后续规则 */
  }

  // 3. 兼容首行是一级标题（# 标题）的情况：剥离首行作为 title，其余作为 article
  const h1Match = text.match(/^#\s+([^\n]+)\n*([\s\S]*)$/);
  if (h1Match) {
    const title = h1Match[1]!.trim();
    const article = h1Match[2]!.trim();
    return { title: title || fallbackTitle, article };
  }

  // 4. 兜底回退：若包含其他 Markdown 标题或纯文本
  const firstLine = text.split("\n")[0]?.replace(/^[#>*`\-\s]+/, "").trim() ?? "";
  const title = (firstLine.length >= 4 && firstLine.length <= 40 ? firstLine : fallbackTitle.slice(0, 30)) || "未命名文章";
  return { title, article: text };
}

async function runWriter(
  tier: ModelTier,
  brief: string,
  notes: string,
  threadId: string,
): Promise<WriterOutput> {
  const writer = createAgent({
    model: buildLlm(tier, 0.85),
    tools: [],
    systemPrompt: WRITER_PROMPT,
  });
  const { messages } = await writer.invoke(
    {
      messages: [
        {
          role: "user",
          content: `选题/想法：\n${brief}\n\n素材笔记（我之前的探讨记录与结论）：\n${notes || "（无，请凭你自身的知识写作）"}\n\n请按规范格式输出独立的文章主标题与完整 Markdown 正文（正文不少于 ${MIN_ARTICLE_LEN} 字）。`,
        },
      ],
    },
    { configurable: { thread_id: threadId }, recursionLimit: 25 },
  );
  const last = messages[messages.length - 1];
  const content = typeof last?.content === "string" ? last.content : String(last?.content ?? "");
  return parseWriterOutput(content, brief.slice(0, 30));
}

async function runRefiner(
  tier: ModelTier,
  currentTitle: string,
  draft: string,
  feedback: string,
  threadId: string,
): Promise<WriterOutput> {
  const refiner = createAgent({
    model: buildLlm(tier, 0.65),
    tools: [],
    systemPrompt: `${WRITER_PROMPT}\n你现在是修订器：优先保留原标题与原稿中已经成立的观点和表达，只针对校验反馈做必要修改，按 ===TITLE=== 和 ===CONTENT=== 格式输出修订后的标题与完整正文。`,
  });
  const { messages } = await refiner.invoke(
    {
      messages: [
        {
          role: "user",
          content: `当前文章标题：\n${currentTitle}\n\n当前 Markdown 草稿：\n${draft}\n\n校验反馈：\n${feedback}\n\n请按规范格式输出修订后的主标题与完整 Markdown 正文。`,
        },
      ],
    },
    { configurable: { thread_id: threadId }, recursionLimit: 25 },
  );
  const last = messages[messages.length - 1];
  const content = typeof last?.content === "string" ? last.content : String(last?.content ?? "");
  return parseWriterOutput(content, currentTitle);
}

/** 主 ReAct 调用此工具即可委托写作 subagent；pro 不可用时自动降级 flash */
export const delegateToWriter = tool(
  async ({ brief, notes }) => {
    const tid = `writer-${Date.now()}`;
    try {
      const res = await runWriter("pro", brief, notes, tid);
      return { title: res.title, article: res.article, model: "pro" };
    } catch (e) {
      if (isModelUnavailable(e)) {
        const res = await runWriter("flash", brief, notes, `${tid}-flash`);
        return { title: res.title, article: res.article, model: "flash(fallback)" };
      }
      throw e;
    }
  },
  {
    name: "delegate_to_writer",
    description:
      "委托「写作 subagent」按选题+素材笔记产出独立公众号标题与完整 Markdown 正文。subagent 用更强模型独立完成、上下文隔离。返回 { title, article, model }。",
    schema: z.object({
      brief: z.string().describe("文章选题与想表达的核心观点"),
      notes: z.string().describe("素材笔记：探讨结论、要点、想引用的内容（没有就传空字符串）"),
    }),
  },
);

/** 校验失败后的轻量修订：只把当前标题、草稿和问题交给修订器，避免重新运行主控 Agent。 */
export async function refineArticle(
  draft: string,
  feedback: string,
  currentTitle = "未命名文章",
): Promise<WriterOutput> {
  const tid = `refiner-${Date.now()}`;
  try {
    return await runRefiner("pro", currentTitle, draft, feedback, tid);
  } catch (e) {
    if (isModelUnavailable(e)) return runRefiner("flash", currentTitle, draft, feedback, `${tid}-flash`);
    throw e;
  }
}
