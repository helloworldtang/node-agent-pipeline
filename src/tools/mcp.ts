// exomind MCP 接入：经 @langchain/mcp-adapters 的 MultiServerMCPClient(stdio) 拉 `exomind mcp`
// 工具是动态发现的（search/query/entity/...），无需硬编码 —— 这正是 MCP 的价值
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { MCP_COMMAND, MCP_ARGS } from "../config.ts";

export function createExomindMcpClient(): MultiServerMCPClient {
  return new MultiServerMCPClient({
    exomind: {
      transport: "stdio",
      command: MCP_COMMAND,
      args: MCP_ARGS,
      // exomind 读取 ~/.exomind/config.json 里的凭证，继承当前 env 即可
    },
  });
}

/** 启动 exomind MCP server，返回动态发现的 LangChain 工具集 + client（用完需 close） */
export async function loadExomindTools(): Promise<{
  client: MultiServerMCPClient;
  tools: Awaited<ReturnType<MultiServerMCPClient["getTools"]>>;
}> {
  const client = createExomindMcpClient();
  const tools = await client.getTools();
  return { client, tools };
}
