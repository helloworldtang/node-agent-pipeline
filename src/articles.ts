// 文章库：output/ 下每篇文章一个文件夹，相关文件集中存放
//   output/<id>/article.md    正文 Markdown
//   output/<id>/article.html  公众号排版 HTML（md 变更后自动重渲染）
//   output/<id>/cover.<ext>   本篇封面（投递时从封面库复制，或 AI 生成）
//   output/<id>/images/       正文插图（markdown 里用 ![](images/xxx.png) 引用）
//   output/<id>/readme.log    产出日志：生成 / 编辑 / 封面 / 投递全程记录
// 旧版平铺文件（output/<ts>.md + .html）启动时自动迁移为文件夹结构
import { readdir, readFile, appendFile, mkdir, rename, stat, rm } from "node:fs/promises";
import { join, resolve, extname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { OUTPUT_DIR, TRASH_DIR } from "./config.ts";
import { renderMarkdownToWeChatHtml } from "./tools/formatSkill.ts";
import { atomicCopyFile, atomicWriteFile } from "./util/files.ts";
import { getArticleIndex, type IndexedArticle } from "./article-db.ts";

export interface ArticleMeta {
  id: string;
  title: string;
  mtime: string;
  size: number; // article.md 字节数
  hasHtml: boolean;
  hasCover: boolean;
  cover?: string;
}

export interface TrashedArticleMeta extends ArticleMeta {
  trashedAt: string;
}

export interface ArticleRunRecord {
  status: "success" | "degraded" | "failed";
  /** 初次生成时使用的原始选题与素材，供后续 AI 重新生成复用。 */
  topic?: string;
  notes?: string;
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  model?: string;
  retries?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  failedStage?: string;
  failureReason?: string | null;
  mediaId?: string;
}

export interface ArticleVersionMeta {
  id: string;
  createdAt: string;
}

export interface ArticleAiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  rewrittenText?: string;
  explanation?: string;
  originalText?: string;
  applied?: boolean;
  timestamp?: string;
}

export interface ArticleAiSession {
  id: string;
  createdAt: string;
  originalSnippet: string;
  applied?: boolean;
  appliedAt?: string;
  messages: ArticleAiMessage[];
}

const ts = (): string => new Date().toLocaleString("zh-CN", { hour12: false }).replace(/\//g, "-");

/** 防目录穿越：id 只允许安全字符 */
export function safeId(id: string): string | null {
  return /^[\w.-]+$/.test(id) && !id.includes("..") ? id : null;
}

export function articleDir(id: string): string {
  const safe = safeId(id);
  if (!safe) throw new Error("非法文章 ID");
  return resolve(OUTPUT_DIR, safe);
}

export async function appendLog(id: string, line: string): Promise<void> {
  await appendFile(join(articleDir(id), "readme.log"), `[${ts()}] ${line}\n`, "utf8");
}

/** 从 markdown 提取文章名（一级标题，其次首个像样文本行） */
export function extractTitle(markdown: string): string | undefined {
  const head = markdown.slice(0, 2000);
  return (
    head.match(/^#\s+(.+)$/m)?.[1]?.trim() ??
    head
      .split("\n")
      .map((l) => l.replace(/^[#>*`\-\s]+/, "").trim())
      .find((l) => l.length >= 4)
      ?.slice(0, 50)
  );
}

/** 列出一篇文章文件夹里实际存在的封面文件名（cover.png / cover.jpg …） */
async function coverFileOf(dir: string): Promise<string | null> {
  try {
    const names = await readdir(dir);
    return names.find((n) => /^cover\.(png|jpe?g|webp)$/i.test(n)) ?? null;
  } catch {
    return null;
  }
}

async function readCoverSourceName(dir: string, fallbackCover: string): Promise<string> {
  try {
    const metaText = await readFile(join(dir, "cover.meta.json"), "utf8");
    const meta = JSON.parse(metaText) as { sourceName?: string };
    if (meta.sourceName) return meta.sourceName;
  } catch {
    /* 无元数据文件时使用后备文件名 */
  }
  return fallbackCover;
}

export interface ArticleMetadataFile {
  id: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
}

async function readArticleMetaJson(dir: string): Promise<ArticleMetadataFile | null> {
  try {
    const text = await readFile(join(dir, "meta.json"), "utf8");
    const json = JSON.parse(text);
    if (json && typeof json === "object" && typeof json.title === "string") {
      return json as ArticleMetadataFile;
    }
  } catch {
    /* 无 meta.json 或解析失败 */
  }
  return null;
}

async function readArticleMetaFromDir(id: string, dir: string): Promise<IndexedArticle | null> {
  const mdPath = join(dir, "article.md");
  const mdStat = await stat(mdPath).catch(() => null);
  if (!mdStat) return null;
  let title = id;
  const metaJson = await readArticleMetaJson(dir);
  if (metaJson?.title?.trim()) {
    title = metaJson.title.trim();
  } else {
    try {
      title = extractTitle(await readFile(mdPath, "utf8")) ?? id;
    } catch {
      /* 文件被并发替换时保留 id 作为标题 */
    }
  }
  const htmlStat = await stat(join(dir, "article.html")).catch(() => null);
  const coverFile = await coverFileOf(dir);
  const cover = coverFile ? await readCoverSourceName(dir, coverFile) : undefined;
  return {
    id,
    title,
    mtime: mdStat.mtime.toISOString(),
    size: mdStat.size,
    hasHtml: Boolean(htmlStat),
    hasCover: Boolean(coverFile),
    cover,
  };
}

async function readArticleMetaFromDisk(id: string): Promise<IndexedArticle | null> {
  return readArticleMetaFromDir(id, articleDir(id));
}

async function readTrashedAt(dir: string): Promise<string> {
  try {
    const text = await readFile(join(dir, ".trash-meta.json"), "utf8");
    const meta = JSON.parse(text) as { trashedAt?: unknown };
    if (typeof meta.trashedAt === "string" && meta.trashedAt) return meta.trashedAt;
  } catch {
    /* 没有回收站元数据时使用文件夹修改时间 */
  }
  return (await stat(dir)).mtime.toISOString();
}

/** 启动时把文件夹结构同步到 SQLite；之后列表查询不再扫描 output/。 */
export async function syncArticleIndex(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(OUTPUT_DIR);
  } catch {
    getArticleIndex().removeArticlesExcept([]);
    return;
  }
  const ids: string[] = [];
  for (const name of entries) {
    if (!safeId(name)) continue;
    const meta = await readArticleMetaFromDisk(name);
    if (!meta) continue;
    ids.push(name);
    getArticleIndex().upsertArticle(meta);

    const historyDir = join(articleDir(name), "history");
    const versionIds: string[] = [];
    try {
      for (const entry of await readdir(historyDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !safeId(entry.name)) continue;
        const versionStat = await stat(join(historyDir, entry.name)).catch(() => null);
        if (!versionStat) continue;
        versionIds.push(entry.name);
        getArticleIndex().upsertVersion(name, {
          id: entry.name,
          createdAt: versionStat.mtime.toISOString(),
        });
      }
    } catch {
      /* 没有历史目录 */
    }
    getArticleIndex().removeVersionsExcept(name, versionIds);
  }
  // 进程在移动目录与更新 SQLite 之间异常退出时，启动同步仍能恢复回收站状态。
  try {
    for (const entry of await readdir(TRASH_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || !safeId(entry.name)) continue;
      const meta = await readArticleMetaFromDir(entry.name, join(TRASH_DIR, entry.name));
      if (meta)
        getArticleIndex().markArticleTrashed(
          entry.name,
          await readTrashedAt(join(TRASH_DIR, entry.name)),
        );
    }
  } catch {
    /* 回收站目录不存在时忽略 */
  }
  getArticleIndex().removeArticlesExcept(ids);
}

export async function listArticles(): Promise<ArticleMeta[]> {
  return getArticleIndex().listArticles();
}

/** 列出回收站中的文章；正文目录仍保留，只有恢复后才回到文章库。 */
export async function listTrashedArticles(): Promise<TrashedArticleMeta[]> {
  let entries: string[];
  try {
    entries = (await readdir(TRASH_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && safeId(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const articles: TrashedArticleMeta[] = [];
  for (const id of entries) {
    const dir = join(TRASH_DIR, id);
    const meta = await readArticleMetaFromDir(id, dir);
    if (!meta) continue;
    articles.push({ ...meta, trashedAt: await readTrashedAt(dir) });
  }
  return articles.sort(
    (a, b) =>
      new Date(b.trashedAt).getTime() - new Date(a.trashedAt).getTime() || b.id.localeCompare(a.id),
  );
}

/** 将文章文件夹移入回收站，不删除任何正文、历史版本或素材。 */
export async function trashArticle(id: string): Promise<void> {
  const source = articleDir(id);
  const target = join(TRASH_DIR, id);
  if (!(await stat(source).catch(() => null))?.isDirectory()) throw new Error("文章不存在");
  if (await stat(target).catch(() => null)) throw new Error("回收站中已存在同 ID 文章");
  const trashedAt = new Date().toISOString();
  await atomicWriteFile(
    join(source, ".trash-meta.json"),
    JSON.stringify({ trashedAt }, null, 2),
    "utf8",
  );
  await mkdir(TRASH_DIR, { recursive: true });
  await rename(source, target);
  getArticleIndex().markArticleTrashed(id, trashedAt);
}

/** 从回收站恢复文章；目标位置有同 ID 文章时拒绝覆盖。 */
export async function restoreTrashedArticle(id: string): Promise<void> {
  if (!safeId(id)) throw new Error("非法文章 ID");
  const source = join(TRASH_DIR, id);
  const target = articleDir(id);
  if (!(await stat(source).catch(() => null))?.isDirectory())
    throw new Error("回收站中不存在该文章");
  if (await stat(target).catch(() => null))
    throw new Error("文章库中已存在同 ID 文章，无法覆盖恢复");
  await rename(source, target);
  await rm(join(target, ".trash-meta.json"), { force: true });
  getArticleIndex().markArticleRestored(id);
  await refreshArticleIndex(id);
}

/** 新建文章文件夹，返回文章 id */
export async function createArticle(opts: {
  title?: string;
  markdown: string;
  html?: string | null;
  log?: string[];
  run?: ArticleRunRecord;
}): Promise<string> {
  const id = `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${String(
    Date.now() % 1e7,
  ).padStart(7, "0")}-${randomUUID().slice(0, 4)}`;
  const dir = articleDir(id);
  const stagingDir = `${dir}.tmp-${randomUUID()}`;
  await mkdir(join(stagingDir, "images"), { recursive: true });
  const html =
    opts.html === undefined || opts.html === null
      ? renderMarkdownToWeChatHtml(opts.markdown)
      : opts.html;
  const rawTitle = opts.title?.trim() || extractTitle(opts.markdown) || id;
  const metaJson: ArticleMetadataFile = {
    id,
    title: rawTitle,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  try {
    await atomicWriteFile(join(stagingDir, "meta.json"), JSON.stringify(metaJson, null, 2), "utf8");
    await atomicWriteFile(join(stagingDir, "article.md"), opts.markdown, "utf8");
    await atomicWriteFile(join(stagingDir, "article.html"), html, "utf8");
    await atomicWriteFile(
      join(stagingDir, "readme.log"),
      [
        `[${ts()}] 文章创建（标题：「${rawTitle}」）`,
        ...(opts.log ?? []).map((l) => `[${ts()}] ${l}`),
      ].join("\n") + "\n",
      "utf8",
    );
    if (opts.run) {
      await atomicWriteFile(
        join(stagingDir, "run.json"),
        JSON.stringify(opts.run, null, 2),
        "utf8",
      );
    }
    await rename(stagingDir, dir);
    const meta = await readArticleMetaFromDisk(id);
    if (meta) getArticleIndex().upsertArticle(meta);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return id;
}

/** 修改文章标题 */
export async function updateArticleTitle(id: string, title: string): Promise<void> {
  const cleanTitle = title.trim();
  if (!cleanTitle) throw new Error("标题不能为空");
  const dir = articleDir(id);
  const metaJson = (await readArticleMetaJson(dir)) ?? {
    id,
    title: cleanTitle,
    createdAt: new Date().toISOString(),
  };
  metaJson.title = cleanTitle;
  metaJson.updatedAt = new Date().toISOString();
  await atomicWriteFile(join(dir, "meta.json"), JSON.stringify(metaJson, null, 2), "utf8");
  await appendLog(id, `修改标题为：「${cleanTitle}」`);
  await refreshArticleIndex(id);
}

/** 手动编辑：覆盖 md、重渲染 html、可同步更新标题、写日志 */
export async function updateArticle(
  id: string,
  markdown: string,
  note = "手动编辑",
  title?: string,
): Promise<void> {
  const dir = articleDir(id);
  const previousMarkdown = await readFile(join(dir, "article.md"), "utf8").catch(() => null);
  const previousHtml = await readFile(join(dir, "article.html"), "utf8").catch(() => null);
  if (previousMarkdown !== null) {
    await saveArticleVersion(id, previousMarkdown, previousHtml);
  }
  await atomicWriteFile(join(dir, "article.md"), markdown, "utf8");
  await atomicWriteFile(join(dir, "article.html"), renderMarkdownToWeChatHtml(markdown), "utf8");
  if (title?.trim()) {
    const metaJson = (await readArticleMetaJson(dir)) ?? {
      id,
      title: title.trim(),
      createdAt: new Date().toISOString(),
    };
    metaJson.title = title.trim();
    metaJson.updatedAt = new Date().toISOString();
    await atomicWriteFile(join(dir, "meta.json"), JSON.stringify(metaJson, null, 2), "utf8");
  }
  await appendLog(id, `${note}（正文 ${markdown.length} 字符，已重新排版）`);
  await refreshArticleIndex(id);
}

export async function listArticleVersions(id: string): Promise<ArticleVersionMeta[]> {
  return getArticleIndex().listVersions(id);
}

export async function restoreArticleVersion(id: string, version: string): Promise<void> {
  if (!/^[\w.-]+$/.test(version) || version.includes("..")) throw new Error("非法文章版本");
  const dir = articleDir(id);
  const historyDir = join(dir, "history", version);
  const markdown = await readFile(join(historyDir, "article.md"), "utf8");
  const html = await readFile(join(historyDir, "article.html"), "utf8").catch(() =>
    renderMarkdownToWeChatHtml(markdown),
  );
  const currentMarkdown = await readFile(join(dir, "article.md"), "utf8").catch(() => null);
  const currentHtml = await readFile(join(dir, "article.html"), "utf8").catch(() => null);
  if (currentMarkdown !== null && currentMarkdown !== markdown) {
    await saveArticleVersion(id, currentMarkdown, currentHtml);
  }
  await atomicWriteFile(join(dir, "article.md"), markdown, "utf8");
  await atomicWriteFile(join(dir, "article.html"), html, "utf8");
  await appendLog(id, `已回滚到版本 ${version}（正文 ${markdown.length} 字符）`);
  await refreshArticleIndex(id);
}

export async function readArticleVersion(
  id: string,
  version: string,
): Promise<{ id: string; markdown: string; html: string }> {
  if (!/^[\w.-]+$/.test(version) || version.includes("..")) throw new Error("非法文章版本");
  const historyDir = join(articleDir(id), "history", version);
  const markdown = await readFile(join(historyDir, "article.md"), "utf8");
  const html = await readFile(join(historyDir, "article.html"), "utf8").catch(() =>
    renderMarkdownToWeChatHtml(markdown),
  );
  return { id: version, markdown, html };
}

export async function readArticleFile(id: string, which: "md" | "html" | "log"): Promise<string> {
  const name = which === "md" ? "article.md" : which === "html" ? "article.html" : "readme.log";
  return readFile(join(articleDir(id), name), "utf8");
}

/** 读取文章首次生成时保存的选题与素材；手动导入或旧文章没有时返回空值。 */
export async function readArticleSource(id: string): Promise<{ topic: string; notes: string }> {
  const runPath = join(articleDir(id), "run.json");
  let topic = "";
  let notes = "";
  try {
    const parsed = JSON.parse(await readFile(runPath, "utf8")) as {
      topic?: unknown;
      notes?: unknown;
    };
    topic = typeof parsed.topic === "string" ? parsed.topic.trim() : "";
    notes = typeof parsed.notes === "string" ? parsed.notes.trim() : "";
  } catch {
    /* 继续从日志尝试恢复旧文章的选题 */
  }
  if (!topic) {
    // 兼容早期版本：日志至少保存了原始选题，但没有保存素材全文。
    try {
      const log = await readArticleFile(id, "log");
      topic = log.match(/选题：([^\n\r]+)/)?.[1]?.trim() ?? "";
    } catch {
      /* 文章可能是手动导入 */
    }
  }
  return { topic, notes };
}

/** 把封面文件复制进文章文件夹（统一命名 cover.<ext>），并在 cover.meta.json 记录来源名称 */
export async function setArticleCover(
  id: string,
  sourcePath: string,
  sourceName?: string,
): Promise<string> {
  const dir = articleDir(id);
  const ext = extname(sourcePath).toLowerCase() || ".png";
  const sName = sourceName ?? basename(sourcePath);
  // 清掉旧封面，避免 cover.png 与 cover.jpg 并存
  const old = await coverFileOf(dir);
  const name = `cover${ext}`;
  await atomicCopyFile(sourcePath, join(dir, name));
  if (old && old !== name) await rm(join(dir, old), { force: true });
  await atomicWriteFile(
    join(dir, "cover.meta.json"),
    JSON.stringify({ sourceName: sName, updatedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
  await refreshArticleIndex(id);
  return sName;
}

export async function removeArticleCover(id: string): Promise<void> {
  const dir = articleDir(id);
  const old = await coverFileOf(dir);
  if (old) {
    await rm(join(dir, old), { force: true });
  }
  await rm(join(dir, "cover.meta.json"), { force: true });
  await refreshArticleIndex(id);
}

export async function onCoverRenamed(oldName: string, newName: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(OUTPUT_DIR);
  } catch {
    return;
  }
  for (const id of entries) {
    if (!safeId(id)) continue;
    const metaPath = join(articleDir(id), "cover.meta.json");
    try {
      const text = await readFile(metaPath, "utf8");
      const meta = JSON.parse(text) as { sourceName?: string };
      if (meta.sourceName === oldName) {
        await atomicWriteFile(
          metaPath,
          JSON.stringify(
            { ...meta, sourceName: newName, updatedAt: new Date().toISOString() },
            null,
            2,
          ),
          "utf8",
        );
        await refreshArticleIndex(id);
      }
    } catch {
      /* 无此文件忽略 */
    }
  }
}

export async function articleCoverPath(id: string): Promise<string | null> {
  const dir = articleDir(id);
  const f = await coverFileOf(dir);
  return f ? join(dir, f) : null;
}

export async function listArticleImages(id: string): Promise<string[]> {
  try {
    return (await readdir(join(articleDir(id), "images"))).filter((f) =>
      /\.(png|jpe?g|webp|gif)$/i.test(f),
    );
  } catch {
    return [];
  }
}

export async function saveArticleImage(id: string, filename: string, buf: Buffer): Promise<string> {
  const safe = filename.replace(/[/\\]/g, "_");
  if (!/\.(png|jpe?g|webp|gif)$/i.test(safe)) throw new Error("只支持 png/jpg/jpeg/webp/gif 图片");
  const dir = join(articleDir(id), "images");
  await mkdir(dir, { recursive: true });
  await atomicWriteFile(join(dir, safe), buf);
  return safe;
}

export async function deleteArticle(id: string): Promise<void> {
  await rm(articleDir(id), { recursive: true, force: true });
  getArticleIndex().removeArticle(id);
}

export async function listArticleAiSessions(id: string): Promise<ArticleAiSession[]> {
  const filePath = join(articleDir(id), "ai-chat.jsonl");
  try {
    const raw = await readFile(filePath, "utf8");
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const sessions: ArticleAiSession[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as ArticleAiSession;
        if (parsed && parsed.id && Array.isArray(parsed.messages)) {
          sessions.push(parsed);
        }
      } catch {
        /* 忽略单行损坏 */
      }
    }
    return sessions.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  } catch {
    return [];
  }
}

export async function saveArticleAiSession(id: string, session: ArticleAiSession): Promise<void> {
  const dir = articleDir(id);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "ai-chat.jsonl");

  let existing: ArticleAiSession[];
  try {
    const raw = await readFile(filePath, "utf8");
    existing = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as ArticleAiSession;
        } catch {
          return null;
        }
      })
      .filter((s): s is ArticleAiSession => s !== null && Boolean(s.id));
  } catch {
    existing = [];
  }

  const idx = existing.findIndex((s) => s.id === session.id);
  if (idx >= 0) {
    existing[idx] = session;
  } else {
    existing.push(session);
  }

  const content = existing.map((s) => JSON.stringify(s)).join("\n") + "\n";
  await atomicWriteFile(filePath, content, "utf8");
}

async function saveArticleVersion(
  id: string,
  markdown: string,
  html: string | null,
): Promise<ArticleVersionMeta> {
  const version = `${Date.now()}-${randomUUID().slice(0, 4)}`;
  const historyDir = join(articleDir(id), "history", version);
  await atomicWriteFile(join(historyDir, "article.md"), markdown, "utf8");
  if (html !== null) await atomicWriteFile(join(historyDir, "article.html"), html, "utf8");
  const createdAt = new Date().toISOString();
  getArticleIndex().upsertVersion(id, { id: version, createdAt });
  return { id: version, createdAt };
}

async function refreshArticleIndex(id: string): Promise<void> {
  const meta = await readArticleMetaFromDisk(id);
  if (meta) getArticleIndex().upsertArticle(meta);
  else getArticleIndex().removeArticle(id);
}

/** 旧版平铺结构迁移：output/<ts>.md(+html) → output/<ts>/article.md(+html) */
export async function migrateFlatOutputs(): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(OUTPUT_DIR);
  } catch {
    return 0;
  }
  let moved = 0;
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const base = name.slice(0, -3);
    if (!safeId(base)) continue;
    const dir = resolve(OUTPUT_DIR, base);
    if ((await stat(dir).catch(() => null))?.isDirectory()) continue; // 已是新结构
    await mkdir(join(dir, "images"), { recursive: true });
    await rename(resolve(OUTPUT_DIR, name), join(dir, "article.md"));
    const oldHtml = resolve(OUTPUT_DIR, `${base}.html`);
    let hasHtml = false;
    try {
      await rename(oldHtml, join(dir, "article.html"));
      hasHtml = true;
    } catch {
      /* 没有配对 html */
    }
    const md = await readFile(join(dir, "article.md"), "utf8").catch(() => "");
    await atomicWriteFile(
      join(dir, "readme.log"),
      `[${ts()}] 从旧版平铺结构迁移（原文件名 ${name}）\n` +
        `[${ts()}] 文章信息：标题「${extractTitle(md) ?? base}」，正文 ${md.length} 字符，HTML ${hasHtml ? "有" : "无"}\n`,
      "utf8",
    );
    moved++;
  }
  return moved;
}
