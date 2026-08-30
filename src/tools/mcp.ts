// 可选 MCP 接入（通用版）：设置了 MCP_COMMAND 才启用，工具动态发现，不绑定任何特定服务
// 例如接一个搜索类 MCP server 作为补充取材手段；不配则完全不启动，零依赖
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { MCP_ARGS, MCP_COMMAND } from "../config.ts";

export function isMcpEnabled(): boolean {
  return MCP_COMMAND.length > 0;
}

export async function loadMcpTools(): Promise<{
  client: MultiServerMCPClient;
  tools: Awaited<ReturnType<MultiServerMCPClient["getTools"]>>;
}> {
  const client = new MultiServerMCPClient({
    external: {
      transport: "stdio",
      command: MCP_COMMAND,
      args: MCP_ARGS,
    },
  });
  const tools = await client.getTools();
  return { client, tools };
}
