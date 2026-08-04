// 主 ReActAgent：createAgent(flash) + 工具集 = [exomind MCP 工具(动态) + delegate_to_writer(subagent) + format_wechat(Skill)]
// 注：LangGraph v1 起 createReactAgent(prebuilt) 已弃用，统一用 langchain 的 createAgent（仍是 ReAct 模式）。
import { createAgent } from "langchain";
import { buildLlm } from "../llm.ts";
import { loadExomindTools } from "../tools/mcp.ts";
import { formatWeChatTool } from "../tools/formatSkill.ts";
import { buildPublishWechatTool } from "../tools/publishWechat.ts";
import { delegateToWriter } from "./writerAgent.ts";

const REACT_PROMPT = `你是「公众号文章生产流水线」的主控 ReAct Agent。给定用户选题，按固定步骤完成，每一步先思考再行动（Thought → Action → Observation）：

1. 取材：调用 exomind 的 MCP 工具检索知识库（优先用 search 搜关键词；需要深入时再用 query）。把要点整理成简短笔记。
2. 写作：调用 delegate_to_writer，传入选题大纲 + 素材笔记，取回 Markdown 正文。
3. 排版：调用 format_wechat，把 Markdown 正文转成微信可用 HTML。

若收到来自校验环节的反馈（通常要求：补充「## 小结」小节、确保正文 ≥600 字、或加入引用块），按反馈修正后「重新委托写作 → 重新排版」，不要手动拼凑。`;

interface Cached {
  react: ReturnType<typeof createAgent>;
  close: () => Promise<void>;
  toolNames: string[];
}

let _cached: Cached | null = null;

/** 装配主 ReAct Agent：启动 exomind MCP、收集工具、构建 createAgent。幂等，全局复用。
 *  若设置了环境变量 PUBLISH_ACCOUNT，额外注册 publish_wechat 工具并启用发布步骤（闭环投草稿箱）。 */
export async function buildReactAgent(): Promise<Cached> {
  if (_cached) return _cached;
  const { client, tools: mcpTools } = await loadExomindTools();
  const tools = [...mcpTools, delegateToWriter, formatWeChatTool];

  // 收尾步骤动态拼：默认只到排版；设了 PUBLISH_ACCOUNT 才加发布步骤
  const publishAccount = process.env.PUBLISH_ACCOUNT;
  const closing = publishAccount
    ? `4. 发布：调用 publish_wechat（title=文章主标题，markdown=完整 Markdown 正文），把文章投到【${publishAccount}】草稿箱。\n5. 收尾：一句话告知"已投递草稿箱"，不要复述 HTML/正文。`
    : `4. 收尾：一句话告知"排版完成"，不要复述 HTML/正文。`;
  if (publishAccount) tools.push(buildPublishWechatTool(publishAccount));

  const react = createAgent({
    model: buildLlm("flash", 0.4),
    tools,
    systemPrompt: `${REACT_PROMPT}\n${closing}`,
  });
  _cached = {
    react,
    close: () => client.close(),
    toolNames: tools.map((t) => t.name),
  };
  return _cached;
}

export async function closeReactAgent(): Promise<void> {
  if (_cached) {
    await _cached.close();
    _cached = null;
  }
}
