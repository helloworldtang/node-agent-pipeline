// 微信公众号发布器：直连微信官方 API，替代原项目的 exomind 投递链路
// 链路：gettoken(缓存) → add_material 上传封面(按文件哈希持久缓存) → draft/add 建草稿
// 凭证来源：config/accounts.json（AppID/AppSecret 按账号灵活配置，多账号支持）
// 前提：公众号后台「设置与开发 → 基本配置」已把本机公网 IP 加入 IP 白名单
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  PROJECT_ROOT,
  WECHAT_ACCOUNTS_FILE,
  OUTPUT_DIR,
  HTTP_RETRIES,
  HTTP_TIMEOUT_MS,
} from "../config.ts";
import type { PublishInput, PublishResult, Publisher } from "./types.ts";
import { atomicWriteFile } from "../util/files.ts";
import { fetchWithRetry } from "../util/http.ts";
import { isInsideDir } from "../util/paths.ts";

interface WechatAccountCfg {
  appId: string;
  appSecret: string;
  /** 封面图本地路径（微信草稿必须有封面），如 covers/default.jpg */
  cover: string;
  author?: string;
  /** 是否开启留言，默认 false */
  comment?: boolean;
}

type AccountsFile = Record<string, WechatAccountCfg>;

const API = "https://api.weixin.qq.com";

// ---- 账号配置 ----
async function loadAccount(account: string): Promise<WechatAccountCfg> {
  let all: AccountsFile;
  try {
    all = JSON.parse(await readFile(WECHAT_ACCOUNTS_FILE, "utf8")) as AccountsFile;
  } catch {
    throw new Error(
      `读取公众号配置失败：${WECHAT_ACCOUNTS_FILE}（请参照 config/accounts.example.json 创建）`,
    );
  }
  const cfg = all[account];
  if (!cfg) {
    throw new Error(`配置里找不到账号「${account}」，已有账号：${Object.keys(all).join(", ")}`);
  }
  if (!cfg.appId || !cfg.appSecret || !cfg.cover) {
    throw new Error(`账号「${account}」配置不完整：appId / appSecret / cover 均必填`);
  }
  return cfg;
}

// ---- access_token 缓存（进程内；有效期 7200s，提前 5 分钟过期）----
const tokenCache = new Map<string, { token: string; expireAt: number }>();

async function getAccessToken(cfg: WechatAccountCfg): Promise<string> {
  const hit = tokenCache.get(cfg.appId);
  if (hit && hit.expireAt > Date.now()) return hit.token;
  const url = `${API}/cgi-bin/token?grant_type=client_credential&appid=${cfg.appId}&secret=${cfg.appSecret}`;
  const data = (await (
    await fetchWithRetry(
      url,
      {},
      { retries: HTTP_RETRIES, timeoutMs: HTTP_TIMEOUT_MS, label: "获取微信 access_token" },
    )
  ).json()) as {
    access_token?: string;
    expires_in?: number;
    errcode?: number;
    errmsg?: string;
  };
  if (!data.access_token) {
    throw new Error(
      `获取 access_token 失败：${data.errmsg ?? "未知错误"}（errcode=${data.errcode}；常见原因：IP 未加入公众号后台白名单）`,
    );
  }
  tokenCache.set(cfg.appId, {
    token: data.access_token,
    expireAt: Date.now() + ((data.expires_in ?? 7200) - 300) * 1000,
  });
  return data.access_token;
}

// ---- 封面上传：永久素材接口 add_material；按 appId+文件md5 做持久缓存，避免重复上传 ----
const COVER_CACHE_FILE = resolve(OUTPUT_DIR, ".wechat-cover-cache.json");

async function loadCoverCache(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(COVER_CACHE_FILE, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

async function uploadCover(
  cfg: WechatAccountCfg,
  token: string,
  coverOverride?: string,
): Promise<string> {
  const coverPath = resolve(PROJECT_ROOT, coverOverride ?? cfg.cover);
  if (!(await isInsideDir(coverPath, PROJECT_ROOT))) {
    throw new Error("封面路径必须位于项目目录内，且不能通过符号链接逃逸");
  }
  const buf = await readFile(coverPath);
  const key = `${cfg.appId}:${createHash("md5").update(buf).digest("hex")}`;
  const cache = await loadCoverCache();
  if (cache[key]) return cache[key];

  const form = new FormData();
  form.append("media", new Blob([buf]), coverPath.split("/").pop() ?? "cover.jpg");
  const res = await fetchWithRetry(
    `${API}/cgi-bin/material/add_material?access_token=${token}&type=image`,
    {
      method: "POST",
      body: form,
    },
    { retries: HTTP_RETRIES, retryPost: true, timeoutMs: HTTP_TIMEOUT_MS, label: "上传微信封面" },
  );
  const data = (await res.json()) as { media_id?: string; errcode?: number; errmsg?: string };
  if (!data.media_id) {
    throw new Error(`上传封面失败：${data.errmsg ?? "未知错误"}（errcode=${data.errcode}）`);
  }
  await atomicWriteFile(
    COVER_CACHE_FILE,
    JSON.stringify({ ...cache, [key]: data.media_id }, null, 2),
    "utf8",
  );
  return data.media_id;
}

// ---- 摘要：从 Markdown 剥出纯文本前 100 字 ----
function makeDigest(markdown: string): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*`\-[\]]/g, "")
    .replace(/!\[.*?\]\(.*?\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 100);
}

// ---- 正文插图：uploadimg 上传后替换为微信域名 URL（草稿正文只认微信图床）----
// 按 appId+文件md5 持久缓存，同一张图不重复上传
const IMG_CACHE_FILE = resolve(OUTPUT_DIR, ".wechat-img-cache.json");

async function uploadInlineImage(
  cfg: WechatAccountCfg,
  token: string,
  absPath: string,
): Promise<string> {
  const buf = await readFile(absPath);
  const key = `${cfg.appId}:${createHash("md5").update(buf).digest("hex")}`;
  let cache: Record<string, string> = {};
  try {
    cache = JSON.parse(await readFile(IMG_CACHE_FILE, "utf8")) as Record<string, string>;
  } catch {
    /* 无缓存文件 */
  }
  if (cache[key]) return cache[key];

  const form = new FormData();
  form.append("media", new Blob([buf]), absPath.split("/").pop() ?? "image.png");
  const res = await fetchWithRetry(
    `${API}/cgi-bin/media/uploadimg?access_token=${token}`,
    {
      method: "POST",
      body: form,
    },
    {
      retries: HTTP_RETRIES,
      retryPost: true,
      timeoutMs: HTTP_TIMEOUT_MS,
      label: "上传微信正文插图",
    },
  );
  const data = (await res.json()) as { url?: string; errcode?: number; errmsg?: string };
  if (!data.url) {
    throw new Error(`上传正文插图失败：${data.errmsg ?? "未知错误"}（errcode=${data.errcode}）`);
  }
  await atomicWriteFile(
    IMG_CACHE_FILE,
    JSON.stringify({ ...cache, [key]: data.url }, null, 2),
    "utf8",
  );
  return data.url;
}

/** 把 HTML 里的本地插图（相对 baseDir）全部上传微信并替换 src */
async function uploadInlineImages(
  html: string,
  cfg: WechatAccountCfg,
  token: string,
  baseDir?: string,
): Promise<string> {
  if (!baseDir) return html;
  const srcs = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]!);
  let out = html;
  for (const src of new Set(srcs)) {
    if (/^(https?:)?\/\//.test(src) || src.startsWith("data:")) continue; // 已是外链
    const abs = resolve(baseDir, src);
    if (!(await isInsideDir(abs, baseDir))) {
      throw new Error(`插图 ${src} 不存在，或通过符号链接逃逸出文章目录`);
    }
    try {
      const url = await uploadInlineImage(cfg, token, abs);
      out = out.split(`src="${src}"`).join(`src="${url}"`);
    } catch (e) {
      throw new Error(`插图 ${src} 处理失败：${e instanceof Error ? e.message : String(e)}`, {
        cause: e,
      });
    }
  }
  return out;
}

// ---- 发布器 ----
export function createWechatPublisher(account: string): Publisher {
  return {
    platform: "wechat",
    async publish({
      title,
      markdown,
      html,
      coverPath,
      baseDir,
    }: PublishInput): Promise<PublishResult> {
      const cfg = await loadAccount(account);
      const token = await getAccessToken(cfg);
      const thumbMediaId = await uploadCover(cfg, token, coverPath);
      const content = await uploadInlineImages(html, cfg, token, baseDir);

      const body = {
        articles: [
          {
            title,
            author: cfg.author ?? "",
            digest: makeDigest(markdown),
            content,
            thumb_media_id: thumbMediaId,
            need_open_comment: cfg.comment ? 1 : 0,
            only_fans_can_comment: 0,
          },
        ],
      };
      const res = await fetchWithRetry(
        `${API}/cgi-bin/draft/add?access_token=${token}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // 微信接口要求 JSON 中的中文不转义（fetch 默认就是 UTF-8 直出）
          body: JSON.stringify(body),
        },
        { retries: 0, timeoutMs: HTTP_TIMEOUT_MS, label: "创建微信草稿" },
      );
      const data = (await res.json()) as { media_id?: string; errcode?: number; errmsg?: string };
      if (!data.media_id) {
        throw new Error(`新建草稿失败：${data.errmsg ?? "未知错误"}（errcode=${data.errcode}）`);
      }
      return { platform: "wechat", account, id: data.media_id };
    },
  };
}
