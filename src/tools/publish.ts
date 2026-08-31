// publish_article 工具：挂在主 ReAct 上的发布入口，走发布抽象层（platform 可扩展）
import { tool } from "langchain";
import { z } from "zod";
import { appendFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { getPublisher } from "../publishers/registry.ts";
import { renderMarkdownToWeChatHtml } from "./formatSkill.ts";
import { OUTPUT_DIR } from "../config.ts";
import { ensureDeliveriesIndexed, getArticleIndex } from "../article-db.ts";

/** 投递记录：JSONL 持久化到 output/deliveries.jsonl，供界面展示「已投递」标记 */
async function logDelivery(record: Record<string, unknown>): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const entry = { at: new Date().toISOString(), ...record };
  await appendFile(join(OUTPUT_DIR, "deliveries.jsonl"), JSON.stringify(entry) + "\n", "utf8");
  getArticleIndex().recordDelivery(entry);
}

async function findSuccessfulDelivery(
  idempotencyKey: string,
): Promise<{ platform: string; account: string; id: string } | null> {
  await ensureDeliveriesIndexed();
  return getArticleIndex().findSuccessfulDelivery(idempotencyKey);
}

/** 把一篇已排版/未排版的文章发布到指定平台账号；cover 可临时指定封面图路径 */
export async function publishArticle(opts: {
  platform: string;
  account: string;
  title: string;
  markdown: string;
  html?: string;
  cover?: string;
  /** 来源文章 id（文章库投递时传入，用于投递记录关联 + 解析正文本地插图） */
  sourceFile?: string;
  /** 直发 Markdown 时使用的文件所在目录，用于解析 images/foo.png */
  baseDir?: string;
  /** 相同文章/账号的重复投递保护键；不传则按正文内容自动生成 */
  idempotencyKey?: string;
}) {
  const publisher = getPublisher(opts.platform, opts.account);
  const html = opts.html ?? renderMarkdownToWeChatHtml(opts.markdown);
  // 优先级：显式传入 > 环境变量 PUBLISH_COVER > 账号配置里的 cover
  const coverPath = opts.cover ?? process.env.PUBLISH_COVER ?? undefined;
  // sourceFile 是文章文件夹 id 时，正文里的本地插图从该文件夹解析
  const baseDir =
    opts.baseDir ?? (opts.sourceFile ? resolve(OUTPUT_DIR, opts.sourceFile) : undefined);
  const idempotencyKey =
    opts.idempotencyKey ??
    createHash("sha256")
      .update(`${opts.platform}\0${opts.account}\0${opts.title}\0${opts.markdown}`)
      .digest("hex");
  const existing = await findSuccessfulDelivery(idempotencyKey);
  if (existing) return { ...existing, extra: { idempotent: true } };
  let result;
  try {
    result = await publisher.publish({
      title: opts.title,
      markdown: opts.markdown,
      html,
      coverPath,
      baseDir,
    });
  } catch (error) {
    await logDelivery({
      status: "failed",
      platform: opts.platform,
      account: opts.account,
      title: opts.title,
      sourceFile: opts.sourceFile ?? null,
      idempotencyKey,
      error: error instanceof Error ? error.message : String(error),
    });
    if (opts.sourceFile) {
      const { appendLog } = await import("../articles.ts");
      await appendLog(
        opts.sourceFile,
        `投递失败：${error instanceof Error ? error.message : String(error)}`,
      ).catch(() => {});
    }
    throw error;
  }
  await logDelivery({
    status: "success",
    platform: result.platform,
    account: result.account,
    title: opts.title,
    mediaId: result.id,
    sourceFile: opts.sourceFile ?? null,
    idempotencyKey,
  });
  if (opts.sourceFile) {
    const { appendLog } = await import("../articles.ts");
    await appendLog(
      opts.sourceFile,
      `已投递到 ${result.platform}【${result.account}】草稿箱，media_id: ${result.id}`,
    ).catch(() => {});
  }
  return result;
}

/** 构造 publish_article 工具；platform/account 在构建时绑定（来自 CLI 参数） */
export function buildPublishTool(platform: string, account: string) {
  return tool(
    async ({ title, markdown }) => {
      const r = await publishArticle({ platform, account, title, markdown });
      return { platform: r.platform, account: r.account, draft_id: r.id, ok: true };
    },
    {
      name: "publish_article",
      description: `把文章投递到 ${platform} 平台【${account}】账号的草稿箱。排版完成后调用：title 用文章主标题，markdown 用完整正文（HTML 由发布器自动生成）。`,
      schema: z.object({
        title: z.string().describe("文章标题"),
        markdown: z.string().describe("完整 markdown 正文"),
      }),
    },
  );
}
