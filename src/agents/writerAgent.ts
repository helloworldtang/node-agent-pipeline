// 写作 subagent：独立 createAgent（更强模型 pro，不可用降级 flash），用 tool() 包成 delegate_to_writer 挂给主 ReAct
// 与主控上下文隔离（独立 thread_id），符合「subagent = 隔离上下文的子 agent」范式
import { createAgent, tool } from "langchain";
import { z } from "zod";
import { buildLlm, isModelUnavailable, type ModelTier } from "../llm.ts";

const WRITER_PROMPT = `你是一名资深微信公众号长文写手，擅长把技术/概念讲得清楚、有节奏、可读性强。
要求：
- 输出完整 Markdown 正文，使用合理的小标题层级（## / ###），必要时用列表、代码块、引用块。
- 行文自然，面向普通读者，避免干瘪罗列。
- 只输出正文 Markdown 本身：不要前后寒暄、不要解释、不要用代码围栏包裹整篇输出。`;

async function runWriter(tier: ModelTier, brief: string, notes: string, threadId: string): Promise<string> {
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
          content: `选题/大纲：\n${brief}\n\n素材笔记：\n${notes || "（无）"}\n\n请写出完整 Markdown 正文（不少于 600 字）。`,
        },
      ],
    },
    { configurable: { thread_id: threadId }, recursionLimit: 25 },
  );
  const last = messages[messages.length - 1];
  const content = last?.content;
  return typeof content === "string" ? content : String(content);
}

/** 主 ReAct 调用此工具即可委托写作 subagent；pro 不可用时自动降级 flash */
export const delegateToWriter = tool(
  async ({ brief, notes }) => {
    const tid = `writer-${Date.now()}`;
    try {
      const article = await runWriter("pro", brief, notes, tid);
      return { article, model: "deepseek-v4-pro" };
    } catch (e) {
      if (isModelUnavailable(e)) {
        const article = await runWriter("flash", brief, notes, `${tid}-flash`);
        return { article, model: "deepseek-v4-flash(fallback)" };
      }
      throw e;
    }
  },
  {
    name: "delegate_to_writer",
    description:
      "委托「写作 subagent」按大纲+素材笔记产出完整公众号 Markdown 正文。subagent 用更强模型独立完成、上下文隔离。返回 { article, model }。",
    schema: z.object({
      brief: z.string().describe("文章选题与大纲：要写什么、分几个部分"),
      notes: z.string().describe("从知识库检索到的素材笔记（没有就传空字符串）"),
    }),
  },
);
