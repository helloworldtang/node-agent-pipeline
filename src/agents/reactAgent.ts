// 主 ReActAgent：createAgent(flash) + 工具集
//   默认工具 = [list_materials, read_material(本地素材) + delegate_to_writer(subagent) + format_wechat(Skill)]
//   可选追加 = MCP 动态工具（设了 MCP_COMMAND）+ publish_article（指定了发布账号）
// 注：LangGraph v1 起 createReactAgent(prebuilt) 已弃用，统一用 langchain 的 createAgent。
import { createAgent } from "langchain";
import type { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { buildLlm } from "../llm.ts";
import { isMcpEnabled, loadMcpTools } from "../tools/mcp.ts";
import { listMaterialsTool, readMaterialTool } from "../tools/materials.ts";
import { formatWeChatTool } from "../tools/formatSkill.ts";
import { buildPublishTool } from "../tools/publish.ts";
import { delegateToWriter } from "./writerAgent.ts";

const REACT_PROMPT = `你是「公众号文章生产流水线」的主控 ReAct Agent。给定选题（可能附带素材笔记），按步骤完成，每一步先思考再行动（Thought → Action → Observation）：

1. 整理素材：用户消息里如果附了素材笔记，直接提炼要点；如果素材不够且提供了 list_materials / read_material 或其他检索工具，可以按需补充取材。素材为空就跳过，直接进入写作。
2. 写作：调用 delegate_to_writer，传入选题 + 想表达的核心观点 + 素材笔记，取回 Markdown 正文。
3. 排版：调用 format_wechat，把 Markdown 正文转成微信可用 HTML。

校验失败后的修订由 Harness 的轻量 refine 节点负责，主控无需重新运行。`;

interface Cached {
  react: ReturnType<typeof createAgent>;
  close: () => Promise<void>;
  toolNames: string[];
}

let _cached: Cached | null = null;

/** 装配主 ReAct Agent（幂等，全局复用）。
 *  发布受环境变量 PUBLISH_PLATFORM + PUBLISH_ACCOUNT 控制：不配则不注册发布工具。 */
export async function buildReactAgent(): Promise<Cached> {
  if (_cached) return _cached;

  let mcpClient: MultiServerMCPClient | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any[] = [listMaterialsTool, readMaterialTool, delegateToWriter, formatWeChatTool];

  if (isMcpEnabled()) {
    const { client, tools: mcpTools } = await loadMcpTools();
    mcpClient = client;
    tools.push(...mcpTools);
  }

  const platform = process.env.PUBLISH_PLATFORM;
  const account = process.env.PUBLISH_ACCOUNT;
  const closing =
    platform && account
      ? `4. 发布：调用 publish_article（title=文章主标题，markdown=完整 Markdown 正文），把文章投到 ${platform} 平台【${account}】草稿箱。\n5. 收尾：一句话告知"已投递草稿箱"，不要复述 HTML/正文。`
      : `4. 收尾：一句话告知"排版完成"，不要复述 HTML/正文。`;
  if (platform && account) tools.push(buildPublishTool(platform, account));

  const react = createAgent({
    model: buildLlm("flash", 0.4),
    tools,
    systemPrompt: `${REACT_PROMPT}\n${closing}`,
  });
  _cached = {
    react,
    close: async () => {
      if (mcpClient) await mcpClient.close();
    },
    toolNames: tools.map((t) => t.name as string),
  };
  return _cached;
}

export async function closeReactAgent(): Promise<void> {
  if (_cached) {
    await _cached.close();
    _cached = null;
  }
}
