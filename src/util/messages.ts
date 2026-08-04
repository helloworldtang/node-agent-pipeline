// 消息工具：从 LangChain messages 数组里抽取指定工具最后一次返回的 payload
import { ToolMessage, type BaseMessage } from "@langchain/core/messages";

/** 倒序查找最后一个 name=toolName 的 ToolMessage，把 content(JSON 字符串) 解析成对象返回 */
export function lastToolPayload<T = unknown>(messages: BaseMessage[], toolName: string): T | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m instanceof ToolMessage && m.name === toolName) {
      const c = m.content;
      if (typeof c === "string") {
        try {
          return JSON.parse(c) as T;
        } catch {
          return c as unknown as T;
        }
      }
      return c as T;
    }
  }
  return null;
}
