// publish_wechat 工具：把文章投到公众号草稿箱，闭环流水线「发」的一端
// 复用 exomind 的 draft 能力：① POST /drafts 注入正文(CLI 没有 import 正文这步走 HTTP)
//                              ② child_process 调 `exomind draft wechat` 复用其出封面+调微信
// 受 PUBLISH_ACCOUNT 环境变量控制，默认不启用(避免每次跑都污染草稿箱)
import { tool } from "langchain";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";

const execFileP = promisify(execFile);

interface ExomindCreds {
  baseUrl: string;
  apiKey: string;
}

async function readExomindCreds(): Promise<ExomindCreds> {
  const cfgPath = join(homedir(), ".exomind", "config.json");
  const cfg = JSON.parse(await readFile(cfgPath, "utf8")) as { base_url: string; api_key: string };
  return { baseUrl: cfg.base_url, apiKey: cfg.api_key };
}

/** POST /drafts 注入自定义正文，返回草稿 id（exomind draft CLI 没有 import 正文，这步走 HTTP） */
async function postDraft(title: string, content: string, account: string): Promise<string> {
  const { baseUrl, apiKey } = await readExomindCreds();
  const body = JSON.stringify({
    title,
    content,
    target_account: account,
    topic: title,
    tags: ["Agent", "Node"],
  });
  const res = await fetch(`${baseUrl}/drafts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`POST /drafts 失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { id: string };
  return data.id;
}

/** 调 exomind draft wechat 复用其投递链路（AI 出封面 + 调微信新建草稿），从 stdout 提取 media_id */
async function wechatPublish(draftId: string, account: string): Promise<{ mediaId: string; raw: string }> {
  const { stdout, stderr } = await execFileP(
    "exomind",
    ["draft", "wechat", draftId, "--account", account],
    { timeout: 180_000, maxBuffer: 1024 * 1024 },
  );
  const out = `${stdout}\n${stderr}`;
  const m = out.match(/media_id[:：]\s*([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`未解析到 media_id。output: ${out.slice(0, 300)}`);
  return { mediaId: m[1], raw: out };
}

/** 构造 publish_wechat 工具；account 来自 PUBLISH_ACCOUNT 环境变量 */
export function buildPublishWechatTool(account: string) {
  return tool(
    async ({ title, markdown }) => {
      const draftId = await postDraft(title, markdown, account);
      const { mediaId } = await wechatPublish(draftId, account);
      // ailang 真投成功的 media_id 前缀是 T1NF4457...
      const published = /^T1NF/.test(mediaId);
      return { draft_id: draftId, media_id: mediaId, published, account };
    },
    {
      name: "publish_wechat",
      description: `把文章投递到公众号【${account}】草稿箱（经 exomind：注入正文 + 出封面 + 调微信）。返回 {draft_id, media_id, published}。排版完成后调用，标题用文章主标题、markdown 用完整正文。`,
      schema: z.object({
        title: z.string().describe("文章标题"),
        markdown: z.string().describe("完整 markdown 正文"),
      }),
    },
  );
}
