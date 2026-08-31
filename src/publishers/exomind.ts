// exomind 发布器：经 ExoMind 服务端投公众号草稿，与 wechat 直连并存的另一条链路
// 链路：POST /drafts 注入 Markdown 正文（exomind draft CLI 没有 import 正文这步，走 HTTP）
//      → child_process 调 `exomind draft wechat <id>` 复用其 AI 出封面 + 调微信
// 凭证：~/.exomind/config.json（exomind login 后自动生成，无需在本项目 .env 重复配置）
// 前提：exomind CLI 已安装并 login；服务端已配置对应公众号账号
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { HTTP_RETRIES, HTTP_TIMEOUT_MS } from "../config.ts";
import type { PublishInput, PublishResult, Publisher } from "./types.ts";
import { fetchWithRetry } from "../util/http.ts";

const execFileP = promisify(execFile);

/** exomind draft wechat 涉及服务端 AI 出封面，异步出图耗时较长 */
const CLI_TIMEOUT_MS = 180_000;

export function exomindConfigPath(): string {
  return join(homedir(), ".exomind", "config.json");
}

export async function readExomindCreds(
  configPath = exomindConfigPath(),
): Promise<{ baseUrl: string; apiKey: string }> {
  let cfg: { base_url?: string; api_key?: string };
  try {
    cfg = JSON.parse(await readFile(configPath, "utf8")) as typeof cfg;
  } catch {
    throw new Error(
      `读取 exomind 凭证失败：${configPath}（需要先安装 exomind CLI 并 exomind login）`,
    );
  }
  if (!cfg.base_url || !cfg.api_key) {
    throw new Error(
      `exomind 凭证不完整（base_url / api_key）：${configPath}，请重新 exomind login`,
    );
  }
  return { baseUrl: cfg.base_url, apiKey: cfg.api_key };
}

/** 从 exomind draft wechat 的 stdout/stderr 提取 media_id */
export function parseMediaId(output: string): string | null {
  return output.match(/media_id[:：]\s*([A-Za-z0-9_-]+)/)?.[1] ?? null;
}

/** POST /drafts 注入自定义正文，返回 exomind 草稿 id */
async function postDraft(
  baseUrl: string,
  apiKey: string,
  title: string,
  markdown: string,
  account: string,
): Promise<string> {
  const res = await fetchWithRetry(
    `${baseUrl}/drafts`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      // 建草稿非幂等，保持 POST 默认不重试
      body: JSON.stringify({ title, content: markdown, target_account: account, topic: title }),
    },
    { retries: HTTP_RETRIES, timeoutMs: HTTP_TIMEOUT_MS, label: "exomind 注入草稿" },
  );
  if (!res.ok) {
    throw new Error(
      `exomind POST /drafts 失败 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new Error("exomind POST /drafts 未返回草稿 id");
  return data.id;
}

export function createExomindPublisher(account: string): Publisher {
  return {
    platform: "exomind",
    async publish({ title, markdown }: PublishInput): Promise<PublishResult> {
      const { baseUrl, apiKey } = await readExomindCreds();
      const draftId = await postDraft(baseUrl, apiKey, title, markdown, account);
      const { stdout, stderr } = await execFileP(
        "exomind",
        ["draft", "wechat", draftId, "--account", account],
        { timeout: CLI_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      );
      const output = `${stdout}\n${stderr}`;
      const mediaId = parseMediaId(output);
      if (!mediaId) {
        throw new Error(`exomind 投递未解析到 media_id。output: ${output.slice(0, 300)}`);
      }
      return {
        platform: "exomind",
        account,
        id: mediaId,
        // 前缀 T1NF = yyps 真调通微信的实测特征；draftId 供 exomind 后台追溯
        extra: { draftId, wechatConfirmed: /^T1NF/.test(mediaId) },
      };
    },
  };
}
