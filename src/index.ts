// 入口：装配 HarnessAgent → stream 打 ReAct 流程日志(THOUGHT/ACTION/OBSERVE/FEEDBACK) → 落盘 output/{ts}.md + .html → 关闭 MCP
import { writeFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
import { publishMarkdown } from "./tools/publishWechat.ts";

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

// 入口：--publish-file <md> 直发已有稿（走 pipeline 自己的 publishMarkdown）；否则走完整生成流水线
if (process.argv.includes("--publish-file")) {
  runPublishFile().catch((e: unknown) => {
    console.error("✗ 投递出错：", e instanceof Error ? e.message : e);
    process.exit(1);
  });
} else {
  main().catch(async (e: unknown) => {
    console.error("✗ 运行出错：", e instanceof Error ? e.stack ?? e.message : e);
    await closeReactAgent().catch(() => {});
    process.exit(1);
  });
}

/** 直发模式：读一个 md 文件，经 publishMarkdown 直接投到公众号草稿箱（不起 Agent、不需要 DEEPSEEK_API_KEY） */
async function runPublishFile(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args[args.indexOf("--publish-file") + 1];
  const ti = args.indexOf("--title");
  const title = ti >= 0 ? args[ti + 1] : "未命名文章";
  const ai = args.indexOf("--account");
  const account = ai >= 0 ? args[ai + 1] : process.env.PUBLISH_ACCOUNT;
  if (!file) { console.error("✗ 缺少 --publish-file <md 路径>"); process.exit(1); }
  if (!account) { console.error("✗ 直发模式需要 --account <号> 或环境变量 PUBLISH_ACCOUNT"); process.exit(1); }

  const markdown = await readFile(file, "utf8");
  console.log("=".repeat(64));
  console.log(" 直发模式 · pipeline publishMarkdown（不经 Agent 生成）");
  console.log("=".repeat(64));
  console.log(`文件：${file}`);
  console.log(`标题：${title}`);
  console.log(`目标：${account} 草稿箱`);
  console.log(`正文：${markdown.length} 字符\n`);

  const r = await publishMarkdown(title, markdown, account);
  console.log(`✓ draft_id: ${r.draft_id}`);
  console.log(`  media_id: ${r.media_id}  (${r.published ? "真投成功" : "前缀不符，需排查"})`);
}
