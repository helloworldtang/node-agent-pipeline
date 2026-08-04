// 入口：装配 HarnessAgent → stream 打 ReAct 流程日志(THOUGHT/ACTION/OBSERVE/FEEDBACK) → 落盘 output/{ts}.md + .html → 关闭 MCP
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  HumanMessage,
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { harness } from "./harness/graph.ts";
import { buildReactAgent, closeReactAgent } from "./agents/reactAgent.ts";
import { OUTPUT_DIR } from "./config.ts";

const DEFAULT_TOPIC = "用 ReAct 模式构建一个能自我纠错的 Agent";
const topic = process.argv[2] ?? DEFAULT_TOPIC;

const preview = (s: unknown, n = 160): string => {
  const t = (typeof s === "string" ? s : JSON.stringify(s)).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function logMessage(node: string, m: BaseMessage): void {
  if (m instanceof AIMessage) {
    const tcs = (m as AIMessage).tool_calls ?? [];
    if (tcs.length > 0) {
      for (const tc of tcs) {
        console.log(`  ▶  [${node}] ACTION   ${tc.name}(${preview(tc.args ?? {}, 120)})`);
      }
    } else if (m.content) {
      console.log(`  💭 [${node}] THOUGHT  ${preview(m.content)}`);
    }
  } else if (m instanceof ToolMessage) {
    console.log(`  ◀  [${node}] OBSERVE  ${m.name}: ${preview(m.content)}`);
  } else if (m instanceof HumanMessage) {
    console.log(`  ✉  [${node}] FEEDBACK ${preview(m.content)}`);
  }
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("✗ 缺少环境变量 DEEPSEEK_API_KEY");
    process.exit(1);
  }

  console.log("=".repeat(64));
  console.log(" 公众号文章生产流水线 · ReActAgent + HarnessAgent · DeepSeek");
  console.log("=".repeat(64));
  console.log(`选题：${topic}\n`);

  // 预热：构建主 ReAct（启动 exomind MCP，动态发现工具）
  const { toolNames } = await buildReactAgent();
  const pub = process.env.PUBLISH_ACCOUNT;
  console.log(`[react] 工具集：${toolNames.join(", ")}`);
  console.log(`[publish] ${pub ? `启用 → 流水线闭环投到【${pub}】草稿箱` : "未启用（PUBLISH_ACCOUNT=ailang 开启闭环投递）"}\n`);

  const threadId = `harness-${Date.now()}`;
  const stream = await harness.stream(
    {
      topic,
      messages: [new HumanMessage(`请围绕以下选题生产一篇公众号文章并完成排版：\n\n${topic}`)],
    },
    { configurable: { thread_id: threadId }, streamMode: ["updates"], recursionLimit: 80 },
  );

  const seen = new Set<string>();
  let finalArticle: string | null = null;
  let finalHtml: string | null = null;
  let finalMsg: string | null = null;
  let valid = false;

  for await (const chunk of stream) {
    const [, value] = chunk as [string, Record<string, unknown>];
    for (const [node, upd] of Object.entries(value)) {
      const u = upd as Record<string, unknown>;
      const msgs = (u.messages as BaseMessage[]) ?? [];
      for (const m of msgs) {
        const id = m.id ?? `${m.getType?.()}:${preview(m.content, 40)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        logMessage(node, m);
      }
      if (node === "validator") {
        finalMsg = (u.validationMsg as string) ?? finalMsg;
        valid = (u.valid as boolean) ?? valid;
        console.log(`     ↳ validator: ${finalMsg}`);
      }
    }
  }

  // 取最终 state 拿 article / html
  const snap = await harness.getState({ configurable: { thread_id: threadId } });
  finalArticle = (snap.values.article as string) ?? finalArticle;
  finalHtml = (snap.values.html as string) ?? finalHtml;

  // 落盘
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  if (finalArticle) {
    writeFileSync(resolve(OUTPUT_DIR, `${ts}.md`), finalArticle);
    console.log(`\n[output] 正文 Markdown：output/${ts}.md（${finalArticle.length} 字）`);
  }
  if (finalHtml) {
    writeFileSync(resolve(OUTPUT_DIR, `${ts}.html`), finalHtml);
    console.log(`[output] 微信 HTML：output/${ts}.html（${finalHtml.length} 字符）`);
  }
  console.log(`\n✔ 完成（最终校验：${valid ? "通过" : "未通过"}）`);
  await closeReactAgent();
}

main().catch(async (e: unknown) => {
  console.error("✗ 运行出错：", e instanceof Error ? e.stack ?? e.message : e);
  await closeReactAgent().catch(() => {});
  process.exit(1);
});
