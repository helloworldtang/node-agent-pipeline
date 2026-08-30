// 入口：
//   完整流水线  node src/index.ts "选题" [--notes 笔记.md] [--publish 账号] [--platform wechat]
//   直发模式    node src/index.ts --publish-file article.md --title "标题" --account 账号 [--platform wechat]
// 流程：加载素材 → 装配 HarnessAgent → stream 打印 ReAct 日志 → 落盘 output/{ts}.md + .html → （可选）发布
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { HumanMessage, AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { harness } from "./harness/graph.ts";
import { buildReactAgent, closeReactAgent } from "./agents/reactAgent.ts";
import { LLM_API_KEY, LLM_PRESETS, LLM_PROVIDER, OUTPUT_DIR } from "./config.ts";
import { loadMaterialsFromDir } from "./tools/materials.ts";
import { collectNotes as collectNotesFromSources, shouldAutoLoadMaterials } from "./util/notes.ts";
import { publishArticle } from "./tools/publish.ts";
import { createArticle } from "./articles.ts";
import type { ArticleRunRecord } from "./articles.ts";
import type { RunStatus } from "./harness/state.ts";
import { lastToolPayload } from "./util/messages.ts";
import { atomicWriteFile } from "./util/files.ts";

// ---- CLI 参数解析（极简，够用即可）----
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

const preview = (s: unknown, n = 160): string => {
  const t = (typeof s === "string" ? s : JSON.stringify(s)).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function logMessage(node: string, m: BaseMessage): void {
  if (m instanceof AIMessage) {
    const tcs = m.tool_calls ?? [];
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

/** 汇总素材：Web 只使用显式输入；CLI 默认额外加载 materials/ 目录全部笔记。 */
async function collectNotes(): Promise<string> {
  return collectNotesFromSources({
    inline: process.env.NOTES_INLINE,
    notesFile: argValue("--notes"),
    includeDirectory: shouldAutoLoadMaterials(),
  });
}

async function main(): Promise<void> {
  const startedAtMs = Date.now();
  const topic = process.argv[2];
  if (!topic || topic.startsWith("--")) {
    console.error('用法：node src/index.ts "选题" [--notes 笔记.md] [--publish 账号] [--platform wechat]');
    process.exit(1);
  }
  if (!LLM_API_KEY) {
    console.error("✗ 缺少 API key：请在 .env 里设置 LLM_API_KEY（见 .env.example）");
    process.exit(1);
  }

  // 发布目标：CLI 参数优先，落到环境变量供 reactAgent 读取
  const publishAccount = argValue("--publish") ?? process.env.PUBLISH_ACCOUNT;
  const publishPlatform = argValue("--platform") ?? process.env.PUBLISH_PLATFORM ?? "wechat";
  const cover = argValue("--cover");
  if (cover) process.env.PUBLISH_COVER = cover;
  if (publishAccount) {
    process.env.PUBLISH_ACCOUNT = publishAccount;
    process.env.PUBLISH_PLATFORM = publishPlatform;
  }

  console.log("=".repeat(64));
  console.log(` 文章生产流水线 · LLM=${LLM_PROVIDER} · 发布=${publishAccount ? `${publishPlatform}/${publishAccount}` : "关"}`);
  console.log("=".repeat(64));
  console.log(`选题：${topic}`);

  const notes = await collectNotes();
  console.log(`素材：${notes ? `${notes.length} 字符` : "无（凭模型自身知识写作）"}`);

  const { toolNames } = await buildReactAgent();
  console.log(`[react] 工具集：${toolNames.join(", ")}\n`);

  const initialMsg =
    `请围绕以下选题生产一篇公众号文章并完成排版：\n\n${topic}` +
    (notes ? `\n\n以下是我的素材笔记（探讨记录与结论），请以它们为主要依据：\n\n${notes}` : "");

  const threadId = `harness-${Date.now()}`;
  const stream = await harness.stream(
    { topic, notes, messages: [new HumanMessage(initialMsg)] },
    { configurable: { thread_id: threadId }, streamMode: ["updates"], recursionLimit: 80 },
  );

  const seen = new Set<string>();
  let finalMsg: string | null = null;
  let status: RunStatus = "failed";
  let failureReason: string | null = null;
  let failureStage: string | undefined;

  for await (const chunk of stream) {
    const [, value] = chunk as [string, Record<string, unknown>];
    for (const [node, upd] of Object.entries(value)) {
      const u = upd as Record<string, unknown>;
      for (const m of (u.messages as BaseMessage[]) ?? []) {
        const id = m.id ?? `${m.getType?.()}:${preview(m.content, 40)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        logMessage(node, m);
      }
      if (node === "validator") {
        finalMsg = (u.validationMsg as string) ?? finalMsg;
        console.log(`     ↳ validator: ${finalMsg}`);
      }
      if (typeof u.status === "string") status = u.status as RunStatus;
      if (typeof u.failureReason === "string") {
        failureReason = u.failureReason;
        failureStage = node;
      }
    }
  }

  // 取最终 state 拿 title / article / html，落盘到文章文件夹（output/<id>/）
  const snap = await harness.getState({ configurable: { thread_id: threadId } });
  const finalTitle = (snap.values.title as string) ?? topic;
  const finalArticle = (snap.values.article as string) ?? null;
  const finalHtml = (snap.values.html as string) ?? null;
  const finalMessages = (snap.values.messages as BaseMessage[]) ?? [];
  const publishPayload = lastToolPayload<{ draft_id?: string }>(finalMessages, "publish_article");
  status = (snap.values.status as RunStatus) ?? status;
  failureReason = (snap.values.failureReason as string | null) ?? failureReason;
  const outputOk = Boolean(snap.values.outputOk) && Boolean(finalArticle?.trim()) && Boolean(finalHtml?.trim());
  if (!outputOk && status !== "failed") {
    status = "failed";
    failureReason ??= !finalArticle?.trim() ? "未产出正文。" : "未产出有效 HTML。";
  }

  const preset = LLM_PRESETS[LLM_PROVIDER];
  const sourceDesc: string[] = [];
  if ((process.env.NOTES_INLINE ?? "").trim()) sourceDesc.push(`内联探讨笔记 ${(process.env.NOTES_INLINE ?? "").trim().length} 字符`);
  if (argValue("--notes")) sourceDesc.push(`笔记文件 ${argValue("--notes")}`);
  if (shouldAutoLoadMaterials() && await loadMaterialsFromDir()) sourceDesc.push("materials/ 目录素材");
  const usage = finalMessages.reduce(
    (sum, m) => {
      const u = (m as AIMessage).usage_metadata;
      if (!u) return sum;
      sum.inputTokens += u.input_tokens ?? 0;
      sum.outputTokens += u.output_tokens ?? 0;
      sum.totalTokens += u.total_tokens ?? 0;
      return sum;
    },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
  const run: ArticleRunRecord = {
    status,
    topic,
    notes,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAtMs,
    model: `${LLM_PROVIDER}（编排 ${preset?.flash ?? "?"} / 写作 ${preset?.pro ?? "?"}）`,
    retries: Number(snap.values.retryCount ?? 0),
    ...usage,
    failedStage: status === "failed" ? failureStage ?? "unknown" : undefined,
    failureReason,
    mediaId: publishPayload?.draft_id,
  };
  await atomicWriteFile(join(OUTPUT_DIR, "runs", `${threadId}.json`), JSON.stringify(run, null, 2), "utf8");

  if (finalArticle) {
    const id = await createArticle({
      title: finalTitle,
      markdown: finalArticle,
      html: finalHtml ?? "",
      log: [
        `生成方式：AI 流水线（LangChain ReAct + Harness 校验循环）`,
        `选题：${topic}`,
        `标题：${finalTitle}`,
        `模型：${LLM_PROVIDER}（编排 ${preset?.flash ?? "?"} / 写作 ${preset?.pro ?? "?"}）`,
        `素材：${sourceDesc.length > 0 ? sourceDesc.join("；") : "无（凭模型自身知识写作）"}`,
        `正文 ${finalArticle.length} 字符，最终状态：${status}${failureReason ? `，原因：${failureReason}` : ""}`,
      ],
      run,
    });
    console.log(`\n[output] 文章文件夹：output/${id}/（标题：「${finalTitle}」，正文 ${finalArticle.length} 字）`);
  }
  if (status === "failed") {
    console.error(`\n✗ 失败（${failureReason ?? "流水线未完成"}）`);
  } else {
    console.log(`\n${status === "degraded" ? "⚠" : "✔"} 完成（最终状态：${status}）`);
  }
  console.log(`[run-result] ${JSON.stringify({ status, reason: failureReason })}`);
  await closeReactAgent();
  if (status === "failed") process.exitCode = 1;
}

/** 直发模式：读一个 md 文件直接投草稿箱（不起 Agent、不需要 LLM key） */
async function runPublishFile(): Promise<void> {
  const file = argValue("--publish-file");
  const title = argValue("--title") ?? "未命名文章";
  const account = argValue("--account") ?? process.env.PUBLISH_ACCOUNT;
  const platform = argValue("--platform") ?? process.env.PUBLISH_PLATFORM ?? "wechat";
  if (!file) {
    console.error("✗ 缺少 --publish-file <md 路径>");
    process.exit(1);
  }
  if (!account) {
    console.error("✗ 直发模式需要 --account <账号>（账号在 config/accounts.json 里配置）");
    process.exit(1);
  }

  const absoluteFile = resolve(process.cwd(), file);
  const markdown = await readFile(absoluteFile, "utf8");
  console.log("=".repeat(64));
  console.log(` 直发模式 · ${platform}/${account}（不经 Agent 生成）`);
  console.log("=".repeat(64));
  console.log(`文件：${file}\n标题：${title}\n正文：${markdown.length} 字符\n`);

  const r = await publishArticle({
    platform,
    account,
    title,
    markdown,
    cover: argValue("--cover"),
    baseDir: dirname(absoluteFile),
  });
  console.log(`✓ 已投递草稿箱，draft media_id: ${r.id}`);
}

if (hasFlag("--publish-file")) {
  runPublishFile().catch((e: unknown) => {
    console.error("✗ 投递出错：", e instanceof Error ? e.message : e);
    process.exit(1);
  });
} else {
  main().catch(async (e: unknown) => {
    const reason = e instanceof Error ? e.message : String(e);
    console.error("✗ 运行出错：", e instanceof Error ? (e.stack ?? e.message) : e);
    console.error(`[run-result] ${JSON.stringify({ status: "failed", reason })}`);
    await closeReactAgent().catch(() => {});
    process.exit(1);
  });
}
