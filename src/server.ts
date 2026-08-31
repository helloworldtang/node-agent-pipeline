// 本地 Web 界面的 API 服务：零新依赖（node:http），只监听本机回环地址
// 职责：素材/账号/产出文件的只读接口 + 起流水线子进程（SSE 实时日志）+ 两段式确认投递
// 启动：node src/server.ts [--port 7302] [--host 127.0.0.1]
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readdir, readFile, stat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, extname } from "node:path";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { once } from "node:events";
import { MATERIALS_DIR, OUTPUT_DIR, PROJECT_ROOT, WECHAT_ACCOUNTS_FILE, COVERS_DIR, IMAGE_API_KEY, IMAGE_BASE_URL, IMAGE_MODEL, IMAGE_SIZE, DEFAULT_COVER_PROMPT, API_MAX_BODY_BYTES, API_TOKEN, MAX_CONCURRENT_RUNS } from "./config.ts";
import { publishArticle } from "./tools/publish.ts";
import { generateImage } from "./tools/imagegen.ts";
import { describeArticleForCover } from "./tools/coverDesign.ts";
import { regenerateArticle, rewriteSelection } from "./tools/aiEditor.ts";
import { getSettings, updateSettings } from "./settings.ts";
import { atomicWriteFile } from "./util/files.ts";
import { isInsideDir } from "./util/paths.ts";

/** 封面模板填充：模板含 {description} 则替换，否则拼在末尾 */
function fillCoverTemplate(description: string): string {
  const tpl = process.env.IMAGE_COVER_PROMPT ?? DEFAULT_COVER_PROMPT;
  return tpl.includes("{description}")
    ? tpl.replaceAll("{description}", description)
    : `${tpl}\n\n画面内容：${description}`;
}

/** 封面尺寸：显式配置优先；万相默认 1280*544（2.35:1），其他家不猜、用供应商默认 */
function coverSizeOverride(): string | undefined {
  const explicit = process.env.IMAGE_SIZE ?? IMAGE_SIZE;
  if (explicit) return explicit;
  const baseURL = process.env.IMAGE_BASE_URL ?? IMAGE_BASE_URL;
  return baseURL.includes("dashscope") ? "1280*544" : undefined;
}
import {
  appendLog,
  articleCoverPath,
  articleDir,
  createArticle,
  deleteArticle,
  listArticleImages,
  listArticleVersions,
  listArticles,
  readArticleSource,
  listTrashedArticles,
  migrateFlatOutputs,
  readArticleVersion,
  readArticleFile,
  safeId,
  saveArticleImage,
  setArticleCover,
  removeArticleCover,
  onCoverRenamed,
  restoreArticleVersion,
  syncArticleIndex,
  updateArticle,
  updateArticleTitle,
  listArticleAiSessions,
  saveArticleAiSession,
  trashArticle,
  restoreTrashedArticle,
} from "./articles.ts";
import { ensureDeliveriesIndexed, getArticleIndex } from "./article-db.ts";

// ---- CLI 参数 ----
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const PORT = Number(argValue("--port") ?? process.env.PORT ?? process.env.VITE_API_PORT ?? 7302);
const HOST = argValue("--host") ?? process.env.HOST ?? "127.0.0.1";

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

const AUTH_REQUIRED = Boolean(API_TOKEN) || !isLoopbackHost(HOST);

if (!isLoopbackHost(HOST) && !API_TOKEN) {
  throw new Error("远程监听已禁用：使用 --host 0.0.0.0 等非本机地址时必须配置 API_TOKEN");
}

// ---- 工具函数 ----
class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > API_MAX_BODY_BYTES) {
    req.resume();
    throw new HttpError(413, `请求体超过限制（最大 ${API_MAX_BODY_BYTES} 字节）`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const chunk = c as Buffer;
    total += chunk.length;
    if (total <= API_MAX_BODY_BYTES) chunks.push(chunk);
  }
  if (total > API_MAX_BODY_BYTES) throw new HttpError(413, `请求体超过限制（最大 ${API_MAX_BODY_BYTES} 字节）`);
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "请求体必须是 JSON 对象");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "请求体不是有效 JSON");
  }
}

/** Stream binary uploads to a temporary file, then atomically publish the file. */
async function streamUpload(req: IncomingMessage, destination: string, maxBytes: number): Promise<number> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > maxBytes) {
    req.resume();
    throw new HttpError(413, `上传文件超过限制（最大 ${maxBytes} 字节）`);
  }
  await mkdir(dirname(destination), { recursive: true });
  const tmp = `${destination}.tmp-${randomUUID()}`;
  const out = createWriteStream(tmp, { flags: "wx" });
  let total = 0;
  let tooLarge = false;
  try {
    for await (const value of req) {
      const chunk = value as Buffer;
      total += chunk.length;
      if (total <= maxBytes) {
        if (!out.write(chunk)) await once(out, "drain");
      } else {
        tooLarge = true;
      }
    }
    await new Promise<void>((resolvePromise, reject) => {
      out.once("error", reject);
      out.end(() => resolvePromise());
    });
    if (tooLarge) throw new HttpError(413, `上传文件超过限制（最大 ${maxBytes} 字节）`);
    await rename(tmp, destination);
    return total;
  } catch (error) {
    out.destroy();
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

function authorized(req: IncomingMessage, queryToken?: string): boolean {
  if (!AUTH_REQUIRED) return true;
  const raw = req.headers.authorization ?? req.headers["x-api-token"];
  const token = Array.isArray(raw) ? raw[0] : raw;
  const value = token?.startsWith("Bearer ") ? token.slice(7) : token ?? queryToken;
  if (!value || !API_TOKEN) return false;
  const left = Buffer.from(value);
  const right = Buffer.from(API_TOKEN);
  return left.length === right.length && timingSafeEqual(left, right);
}

// ---- 运行管理：内存里跟踪流水线子进程 ----
interface Run {
  id: string;
  proc: ChildProcess;
  logs: string[];
  done: boolean;
  exitCode: number | null;
  status: "running" | "success" | "degraded" | "failed" | "cancelled";
  reason?: string;
  cancelRequested?: boolean;
  listeners: Set<ServerResponse>;
}
const runs = new Map<string, Run>();

function startRun(topic: string, notesFile: string | null, notesInline: string): Run {
  const id = randomUUID().slice(0, 8);
  const args = ["src/index.ts", topic];
  // Web 端素材必须显式提供；内联笔记经环境变量传给子进程。
  // 同时覆盖继承来的 NOTES_INLINE，避免空输入意外复用服务进程环境。
  const env = {
    ...process.env,
    AUTO_LOAD_MATERIALS: "0",
    NOTES_INLINE: notesInline,
  };

  const proc = spawn(process.execPath, args, {
    cwd: PROJECT_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const run: Run = { id, proc, logs: [], done: false, exitCode: null, status: "running", listeners: new Set() };
  runs.set(id, run);

  const push = (line: string) => {
    run.logs.push(line);
    const marker = line.replace(/^\[stderr\]\s*/, "").match(/^\[run-result\]\s+(.+)$/);
    if (marker) {
      try {
        const result = JSON.parse(marker[1]!) as { status?: Run["status"]; reason?: string };
        if (result.status === "success" || result.status === "degraded" || result.status === "failed") {
          run.status = result.status;
          run.reason = result.reason;
        }
      } catch { /* 日志标记损坏时由退出码兜底 */ }
    }
    for (const res of run.listeners) {
      res.write(`data: ${JSON.stringify({ type: "log", line })}\n\n`);
    }
  };
  proc.stdout?.on("data", (b: Buffer) => b.toString("utf8").split("\n").filter(Boolean).forEach(push));
  proc.stderr?.on("data", (b: Buffer) => b.toString("utf8").split("\n").filter(Boolean).forEach((l) => push(`[stderr] ${l}`)));
  proc.on("close", (code) => {
    run.done = true;
    run.exitCode = run.cancelRequested ? 130 : code;
    if (run.cancelRequested) run.status = "cancelled";
    else if (run.status === "running") run.status = code === 0 ? "success" : "failed";
    if (run.status === "failed" && !run.reason) run.reason = `子进程退出码 ${code ?? "unknown"}`;
    for (const res of run.listeners) {
      res.write(`data: ${JSON.stringify({ type: "done", exitCode: run.exitCode, status: run.status, reason: run.reason })}\n\n`);
      res.end();
    }
    run.listeners.clear();
    // 运行记录保留 30 分钟后清理
    setTimeout(() => runs.delete(id), 30 * 60 * 1000);
  });
  return run;
}

function activeRunCount(): number {
  return [...runs.values()].filter((run) => !run.done).length;
}

function cancelRun(run: Run): void {
  if (run.done) return;
  run.cancelRequested = true;
  run.reason = "任务已取消";
  run.proc.kill("SIGTERM");
  setTimeout(() => {
    if (!run.done) run.proc.kill("SIGKILL");
  }, 5_000).unref();
}

// ---- 路由 ----
async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  try {
    if (!authorized(req, url.searchParams.get("token") ?? undefined)) return sendJson(res, 401, { error: "需要有效的 API Token" });

    // 健康检查
    if (path === "/api/health") {
      return sendJson(res, 200, { ok: true, llmKeyConfigured: Boolean(process.env.LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? process.env.MOONSHOT_API_KEY) });
    }

    // 图形化设置：GET 回掩码后的配置项；POST 写入 .env 并即时生效（空值=保持不变）
    if (path === "/api/settings" && method === "GET") {
      return sendJson(res, 200, { settings: getSettings() });
    }
    if (path === "/api/settings" && method === "POST") {
      const body = await readBody(req);
      const updates: Record<string, string> = {};
      for (const [k, v] of Object.entries(body)) updates[k] = String(v ?? "").trim();
      const changed = await updateSettings(updates);
      return sendJson(res, 200, { ok: true, changed, settings: getSettings() });
    }

    // AI 编辑选区：POST /api/ai/edit-selection
    if (path === "/api/ai/edit-selection" && method === "POST") {
      const body = await readBody(req);
      const selectedText = String(body.selectedText ?? "").trim();
      const instruction = String(body.instruction ?? "").trim();
      if (!selectedText) {
        return sendJson(res, 400, { error: "选中的文本片段不能为空" });
      }
      if (!instruction) {
        return sendJson(res, 400, { error: "修改意图或指令不能为空" });
      }
      const fullText = body.fullText !== undefined ? String(body.fullText) : undefined;
      const history = Array.isArray(body.history)
        ? (body.history as { role: "user" | "assistant"; content: string }[])
        : undefined;
      const tier = body.tier === "pro" ? "pro" : "flash";
      const result = await rewriteSelection({
        selectedText,
        instruction,
        fullText,
        history,
        tier,
      });
      return sendJson(res, 200, { ok: true, ...result });
    }

    // AI 整篇文章重新生成：POST /api/ai/regenerate-article
    if (path === "/api/ai/regenerate-article" && method === "POST") {
      const body = await readBody(req);
      const articleId = safeId(String(body.articleId ?? ""));
      if (!articleId) return sendJson(res, 400, { error: "缺少有效的文章 ID" });
      const instruction = String(body.instruction ?? "").trim();
      if (!instruction) return sendJson(res, 400, { error: "重新生成提示词不能为空" });
      const diskArticle = await readArticleFile(articleId, "md");
      const source = await readArticleSource(articleId);
      const currentArticle = String(body.currentArticle ?? diskArticle).trim();
      const currentTitle = String(body.currentTitle ?? (await listArticles()).find((a) => a.id === articleId)?.title ?? articleId).trim();
      const topic = String(body.topic ?? source.topic ?? "").trim();
      const sourceNotes = String(body.sourceNotes ?? source.notes ?? "").trim();
      const history = Array.isArray(body.history)
        ? (body.history as { role: "user" | "assistant"; content: string }[])
        : undefined;
      const tier = body.tier === "flash" ? "flash" : "pro";
      const result = await regenerateArticle({ topic, sourceNotes, currentTitle, currentArticle, instruction, history, tier });
      return sendJson(res, 200, { ok: true, ...result });
    }

    // 素材列表 / 素材内容
    if (path === "/api/materials" && method === "GET") {
      let files: string[] = [];
      try {
        files = (await readdir(MATERIALS_DIR))
          .filter(
            (f) =>
              [".md", ".txt", ".markdown"].includes(extname(f).toLowerCase()) &&
              f.toLowerCase() !== "readme.md", // 目录说明书不算素材
          )
          .sort();
      } catch { /* 目录不存在时返回空 */ }
      return sendJson(res, 200, { dir: MATERIALS_DIR, files });
    }
    const matMatch = path.match(/^\/api\/materials\/(.+)$/);
    if (matMatch && method === "GET") {
      const name = decodeURIComponent(matMatch[1]!);
      const p = resolve(MATERIALS_DIR, name);
      if (!(await isInsideDir(p, MATERIALS_DIR))) return sendJson(res, 403, { error: "非法路径" });
      return sendJson(res, 200, { name, content: await readFile(p, "utf8") });
    }

    // 上传笔记到素材库：{ name, content }，只允许 .md/.txt/.markdown，文件名禁止路径分隔符
    if (path === "/api/materials" && method === "POST") {
      if (!(req.headers["content-type"] ?? "").toLowerCase().includes("application/json")) {
        const filename = String(url.searchParams.get("filename") ?? "").replace(/[/\\]/g, "_");
        if (!/\.(md|txt|markdown)$/i.test(filename)) {
          return sendJson(res, 400, { error: "只支持 .md / .txt / .markdown 文件" });
        }
        await mkdir(MATERIALS_DIR, { recursive: true });
        const bytes = await streamUpload(req, join(MATERIALS_DIR, filename), 2 * 1024 * 1024);
        if (bytes === 0) {
          await rm(join(MATERIALS_DIR, filename), { force: true });
          return sendJson(res, 400, { error: "内容为空" });
        }
        return sendJson(res, 200, { ok: true, name: filename });
      }
      const body = await readBody(req);
      const rawName = String(body.name ?? "").trim();
      const content = String(body.content ?? "");
      const safeName = rawName.replace(/[/\\]/g, "_");
      if (!/\.(md|txt|markdown)$/i.test(safeName)) {
        return sendJson(res, 400, { error: "只支持 .md / .txt / .markdown 文件" });
      }
      if (!content.trim()) return sendJson(res, 400, { error: "内容为空" });
      await mkdir(MATERIALS_DIR, { recursive: true });
      await atomicWriteFile(join(MATERIALS_DIR, safeName), content, "utf8");
      return sendJson(res, 200, { ok: true, name: safeName });
    }

    // 封面库：列出 covers/ 目录下的图片 + 按文件名读图（供前端缩略图展示）
    if (path === "/api/covers" && method === "GET") {
      let files: string[] = [];
      try {
        files = (await readdir(COVERS_DIR))
          .filter((f) => [".png", ".jpg", ".jpeg", ".webp"].includes(extname(f).toLowerCase()))
          .sort();
      } catch { /* 目录不存在时返回空 */ }
      return sendJson(res, 200, { dir: COVERS_DIR, files, imageGenReady: Boolean(process.env.IMAGE_API_KEY ?? IMAGE_API_KEY), imageModel: (process.env.IMAGE_API_KEY ?? IMAGE_API_KEY) ? (process.env.IMAGE_MODEL ?? IMAGE_MODEL) : undefined });
    }
    // 上传封面到封面库：{ filename, dataBase64 }
    if (path === "/api/covers" && method === "POST") {
      if (!(req.headers["content-type"] ?? "").toLowerCase().includes("application/json")) {
        const filename = String(url.searchParams.get("filename") ?? "").replace(/[/\\]/g, "_");
        if (!/\.(png|jpe?g|webp)$/i.test(filename)) {
          return sendJson(res, 400, { error: "只支持 png/jpg/jpeg/webp 图片" });
        }
        await mkdir(COVERS_DIR, { recursive: true });
        await streamUpload(req, join(COVERS_DIR, filename), 10 * 1024 * 1024);
        return sendJson(res, 200, { ok: true, name: filename });
      }
      const body = await readBody(req);
      const filename = String(body.filename ?? "").replace(/[/\\]/g, "_");
      if (!/\.(png|jpe?g|webp)$/i.test(filename)) {
        return sendJson(res, 400, { error: "只支持 png/jpg/jpeg/webp 图片" });
      }
      const buf = Buffer.from(String(body.dataBase64 ?? ""), "base64");
      if (buf.length === 0) return sendJson(res, 400, { error: "图片数据为空" });
      if (buf.length > 10 * 1024 * 1024) return sendJson(res, 400, { error: "图片不能超过 10MB" });
      await mkdir(COVERS_DIR, { recursive: true });
      await atomicWriteFile(join(COVERS_DIR, filename), buf);
      return sendJson(res, 200, { ok: true, name: filename });
    }
    // 重命名封面：{ oldName, newName }
    if (path === "/api/covers/rename" && method === "POST") {
      const body = await readBody(req);
      const oldName = String(body.oldName ?? "").trim();
      let newName = String(body.newName ?? "").trim();
      if (!oldName || !newName) {
        return sendJson(res, 400, { error: "原名称与新名称均不能为空" });
      }
      if (
        oldName.includes("/") || oldName.includes("\\") || oldName.includes("..") ||
        newName.includes("/") || newName.includes("\\") || newName.includes("..")
      ) {
        return sendJson(res, 403, { error: "非法文件名" });
      }
      const oldExt = extname(oldName).toLowerCase();
      let newExt = extname(newName).toLowerCase();
      if (!newExt) {
        newName = `${newName}${oldExt}`;
        newExt = oldExt;
      }
      if (![".png", ".jpg", ".jpeg", ".webp"].includes(newExt)) {
        return sendJson(res, 400, { error: "只支持 png/jpg/jpeg/webp 图片" });
      }
      const oldPath = resolve(COVERS_DIR, oldName);
      const newPath = resolve(COVERS_DIR, newName);
      if (!(await isInsideDir(oldPath, COVERS_DIR)) || !(await isInsideDir(newPath, COVERS_DIR))) {
        return sendJson(res, 403, { error: "非法路径" });
      }
      const oldStat = await stat(oldPath).catch(() => null);
      if (!oldStat) {
        return sendJson(res, 404, { error: "原封面文件不存在" });
      }
      if (oldName !== newName) {
        const newStat = await stat(newPath).catch(() => null);
        if (newStat) {
          return sendJson(res, 400, { error: "已存在同名封面文件" });
        }
        await rename(oldPath, newPath);
        await onCoverRenamed(oldName, newName);
      }
      return sendJson(res, 200, { ok: true, name: newName });
    }
    // AI 生成封面（手动描述）：{ prompt } → 模板填充 → 存入封面库
    if (path === "/api/covers/generate" && method === "POST") {
      const body = await readBody(req);
      const prompt = String(body.prompt ?? "").trim();
      if (prompt.length < 2 || prompt.length > 1000) {
        return sendJson(res, 400, { error: "生图描述需 2~1000 字" });
      }
      const fullPrompt = fillCoverTemplate(prompt);
      const name = `ai-${Date.now()}.png`;
      await generateImage(fullPrompt, join(COVERS_DIR, name), coverSizeOverride());
      return sendJson(res, 200, { ok: true, name, description: prompt, prompt: fullPrompt });
    }
    // AI 生成封面（自动）：读文章内容 → LLM 出画面描述 → 生图 → 存封面库并设为本篇封面
    const autoCoverMatch = path.match(/^\/api\/articles\/([\w.-]+)\/cover\/auto$/);
    if (autoCoverMatch && method === "POST") {
      const id = safeId(decodeURIComponent(autoCoverMatch[1]!));
      if (!id) return sendJson(res, 403, { error: "非法文章 ID" });
      const body = await readBody(req);
      const hint = String(body.hint ?? "").trim() || undefined;
      const markdown = await readArticleFile(id, "md");
      const description = await describeArticleForCover(markdown, hint);
      const fullPrompt = fillCoverTemplate(description);
      const libName = `ai-${Date.now()}.png`;
      await generateImage(fullPrompt, join(COVERS_DIR, libName), coverSizeOverride());
      const name = await setArticleCover(id, join(COVERS_DIR, libName), libName);
      await appendLog(id, `AI 生成封面：${libName}（画面描述：${description}）`);
      return sendJson(res, 200, { ok: true, name: libName, cover: name, description, prompt: fullPrompt });
    }
    const coverMatch = path.match(/^\/api\/covers\/(.+)$/);
    if (coverMatch && method === "GET") {
      const name = decodeURIComponent(coverMatch[1]!);
      const p = resolve(COVERS_DIR, name);
      if (!(await isInsideDir(p, COVERS_DIR))) return sendJson(res, 403, { error: "非法路径" });
      const ext = extname(p).toLowerCase();
      const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
      try {
        const buf = await readFile(p);
        res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
        res.end(buf);
      } catch {
        sendJson(res, 404, { error: "封面图不存在" });
      }
      return;
    }

    // 账号列表（只回名称和配置完整性，绝不回传密钥；cover 只回文件名）
    if (path === "/api/accounts" && method === "GET") {
      try {
        const all = JSON.parse(await readFile(WECHAT_ACCOUNTS_FILE, "utf8")) as Record<string, { cover?: string; appId?: string; appSecret?: string }>;
        const accounts = Object.entries(all).map(([name, cfg]) => ({
          name,
          configured: Boolean(cfg.appId && cfg.appSecret && cfg.cover),
          cover: cfg.cover ? cfg.cover.split(/[/\\]/).pop() : undefined,
        }));
        return sendJson(res, 200, { accounts });
      } catch {
        return sendJson(res, 200, { accounts: [], hint: "config/accounts.json 未配置" });
      }
    }

    // 文章库（文件夹结构）：列表 / 手动添加
    if (path === "/api/articles" && method === "GET") {
      return sendJson(res, 200, { articles: await listArticles() });
    }
    // 回收站：只移动目录，不删除内容；POST 恢复时移回 output/<id>/。
    if (path === "/api/trash/articles" && method === "GET") {
      return sendJson(res, 200, { articles: await listTrashedArticles() });
    }
    // 手动添加：{ title?, markdown } 已写好的文章直接纳入管理
    if (path === "/api/articles" && method === "POST") {
      const body = await readBody(req);
      const markdown = String(body.markdown ?? "").trim();
      if (markdown.length < 10) return sendJson(res, 400, { error: "正文太短（至少 10 字符）" });
      const title = String(body.title ?? "").trim() || "未命名文章";
      const id = await createArticle({
        title,
        markdown,
        log: [`来源：手动添加（未经 AI 流水线）`, `正文 ${markdown.length} 字符`],
      });
      return sendJson(res, 200, { ok: true, id });
    }

    const artMatch = path.match(/^\/api\/articles\/([\w.-]+)(\/[\w./-]+)?$/);
    if (artMatch) {
      const id = safeId(decodeURIComponent(artMatch[1]!));
      if (!id) return sendJson(res, 403, { error: "非法文章 ID" });
      const sub = artMatch[2] ?? "";

      // 移入回收站：POST /api/articles/:id/trash
      if (sub === "/trash" && method === "POST") {
        await trashArticle(id);
        return sendJson(res, 200, { ok: true });
      }

      // 从回收站恢复：POST /api/articles/:id/restore
      if (sub === "/restore" && method === "POST") {
        await restoreTrashedArticle(id);
        return sendJson(res, 200, { ok: true });
      }

      // 读取首次生成时保存的原始选题与素材
      if (sub === "/source" && method === "GET") {
        return sendJson(res, 200, await readArticleSource(id));
      }

      // 修改文章标题：POST /api/articles/:id/title，body: { title }
      if (sub === "/title" && method === "POST") {
        const body = await readBody(req);
        const title = String(body.title ?? "").trim();
        if (!title) return sendJson(res, 400, { error: "标题不能为空" });
        await updateArticleTitle(id, title);
        return sendJson(res, 200, { ok: true, title });
      }

      // 读取文章文件：/file?which=md|html|log
      if (sub === "/file" && method === "GET") {
        const which = (url.searchParams.get("which") ?? "md") as "md" | "html" | "log";
        if (!["md", "html", "log"].includes(which)) return sendJson(res, 400, { error: "which 需为 md/html/log" });
        const content = await readArticleFile(id, which);
        if (which === "html") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(content);
          return;
        }
        return sendJson(res, 200, { id, which, content });
      }
      // 手动编辑保存：{ markdown, title?, note? } → 覆盖 md + 重渲染 html + 可更新 title + 写日志
      if (sub === "" && method === "PUT") {
        const body = await readBody(req);
        const markdown = String(body.markdown ?? "");
        if (markdown.trim().length < 10) return sendJson(res, 400, { error: "正文太短" });
        const title = body.title !== undefined ? String(body.title).trim() : undefined;
        await updateArticle(id, markdown, String(body.note ?? "手动编辑"), title);
        return sendJson(res, 200, { ok: true });
      }
      // 删除整篇文章文件夹
      if (sub === "" && method === "DELETE") {
        await deleteArticle(id);
        return sendJson(res, 200, { ok: true });
      }
      const versionsMatch = sub.match(/^\/versions(?:\/([\w.-]+)\/restore)?$/);
      if (versionsMatch && method === "GET" && !versionsMatch[1]) {
        return sendJson(res, 200, { versions: await listArticleVersions(id) });
      }
      const versionReadMatch = sub.match(/^\/versions\/([\w.-]+)$/);
      if (versionReadMatch && method === "GET") {
        return sendJson(res, 200, await readArticleVersion(id, decodeURIComponent(versionReadMatch[1]!)));
      }
      if (versionsMatch && method === "POST" && versionsMatch[1]) {
        await restoreArticleVersion(id, decodeURIComponent(versionsMatch[1]));
        return sendJson(res, 200, { ok: true });
      }
      // AI 会话历史：GET 读取；POST 保存/更新
      if (sub === "/ai-sessions" && method === "GET") {
        return sendJson(res, 200, { sessions: await listArticleAiSessions(id) });
      }
      if (sub === "/ai-sessions" && method === "POST") {
        const body = await readBody(req);
        if (!body || !body.id || !Array.isArray(body.messages)) {
          return sendJson(res, 400, { error: "缺少有效的 session 数据" });
        }
        await saveArticleAiSession(id, body as unknown as any);
        return sendJson(res, 200, { ok: true, id: body.id });
      }
      // 本篇封面：GET 读图；POST { name } 从封面库选用 / { filename, dataBase64 } 直接上传新图
      if (sub === "/cover" && method === "GET") {
        const p = await articleCoverPath(id);
        if (!p) return sendJson(res, 404, { error: "本篇还没有封面" });
        const ext = extname(p).toLowerCase();
        const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
        res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
        res.end(await readFile(p));
        return;
      }
      if (sub === "/cover" && method === "POST") {
        if (!(req.headers["content-type"] ?? "").toLowerCase().includes("application/json")) {
          const filename = String(url.searchParams.get("filename") ?? "").replace(/[/\\]/g, "_");
          if (!/\.(png|jpe?g|webp)$/i.test(filename)) {
            return sendJson(res, 400, { error: "只支持 png/jpg/jpeg/webp 图片" });
          }
          await mkdir(COVERS_DIR, { recursive: true });
          const tmp = join(COVERS_DIR, filename);
          await streamUpload(req, tmp, 10 * 1024 * 1024);
          const name = await setArticleCover(id, tmp);
          await appendLog(id, `设置封面：手动上传 ${filename}`);
          return sendJson(res, 200, { ok: true, name });
        }
        const body = await readBody(req);
        if (body.name) {
          const src = resolve(COVERS_DIR, String(body.name));
          if (!(await isInsideDir(src, COVERS_DIR))) return sendJson(res, 403, { error: "非法路径" });
          const name = await setArticleCover(id, src, String(body.name));
          await appendLog(id, `设置封面：选用封面库 ${body.name}`);
          return sendJson(res, 200, { ok: true, name });
        }
        const filename = String(body.filename ?? "").replace(/[/\\]/g, "_");
        const buf = Buffer.from(String(body.dataBase64 ?? ""), "base64");
        if (!/\.(png|jpe?g|webp)$/i.test(filename) || buf.length === 0) {
          return sendJson(res, 400, { error: "图片格式或数据不正确" });
        }
        const tmp = join(COVERS_DIR, filename);
        await mkdir(COVERS_DIR, { recursive: true });
        await atomicWriteFile(tmp, buf); // 同时进封面库，方便其他文章复用
        const name = await setArticleCover(id, tmp, filename);
        await appendLog(id, `设置封面：手动上传 ${filename}`);
        return sendJson(res, 200, { ok: true, name });
      }
      if (sub === "/cover" && method === "DELETE") {
        await removeArticleCover(id);
        await appendLog(id, "移除本篇封面");
        return sendJson(res, 200, { ok: true });
      }
      // 正文插图：GET 列表；POST { filename, dataBase64 } 上传
      if (sub === "/images" && method === "GET") {
        return sendJson(res, 200, { files: await listArticleImages(id) });
      }
      if (sub === "/images" && method === "POST") {
        if (!(req.headers["content-type"] ?? "").toLowerCase().includes("application/json")) {
          const filename = String(url.searchParams.get("filename") ?? "").replace(/[/\\]/g, "_");
          if (!/\.(png|jpe?g|webp|gif)$/i.test(filename)) {
            return sendJson(res, 400, { error: "只支持 png/jpg/jpeg/webp/gif 图片" });
          }
          const p = join(articleDir(id), "images", filename);
          await streamUpload(req, p, 10 * 1024 * 1024);
          await appendLog(id, `添加正文插图：images/${filename}`);
          return sendJson(res, 200, { ok: true, name: filename });
        }
        const body = await readBody(req);
        const buf = Buffer.from(String(body.dataBase64 ?? ""), "base64");
        if (buf.length === 0 || buf.length > 10 * 1024 * 1024) {
          return sendJson(res, 400, { error: "图片数据为空或超过 10MB" });
        }
        const name = await saveArticleImage(id, String(body.filename ?? ""), buf);
        await appendLog(id, `添加正文插图：images/${name}`);
        return sendJson(res, 200, { ok: true, name });
      }
      const imgMatch = sub.match(/^\/images\/(.+)$/);
      if (imgMatch && method === "GET") {
        const p = resolve(articleDir(id), "images", decodeURIComponent(imgMatch[1]!));
        if (!(await isInsideDir(p, join(articleDir(id), "images")))) return sendJson(res, 403, { error: "非法路径" });
        const ext = extname(p).toLowerCase();
        const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/jpeg";
        try {
          res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
          res.end(await readFile(p));
        } catch {
          sendJson(res, 404, { error: "图片不存在" });
        }
        return;
      }
    }

    // 启动流水线
    if (path === "/api/run" && method === "POST") {
      if (activeRunCount() >= MAX_CONCURRENT_RUNS) {
        return sendJson(res, 409, { error: `已有 ${MAX_CONCURRENT_RUNS} 个任务运行中，请稍后再试或先取消现有任务` });
      }
      const body = await readBody(req);
      const topic = String(body.topic ?? "").trim();
      if (topic.length < 2 || topic.length > 200) {
        return sendJson(res, 400, { error: "选题长度需 2~200 字" });
      }
      const run = startRun(topic, null, String(body.notes ?? ""));
      return sendJson(res, 200, { runId: run.id });
    }

    const cancelMatch = path.match(/^\/api\/run\/([\w-]+)\/cancel$/);
    if (cancelMatch && method === "POST") {
      const run = runs.get(cancelMatch[1]!);
      if (!run) return sendJson(res, 404, { error: "运行不存在或已过期" });
      cancelRun(run);
      return sendJson(res, 200, { ok: true, runId: run.id });
    }

    // SSE：运行日志流
    const sseMatch = path.match(/^\/api\/run\/([\w-]+)\/events$/);
    if (sseMatch && method === "GET") {
      const run = runs.get(sseMatch[1]!);
      if (!run) return sendJson(res, 404, { error: "运行不存在或已过期" });
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      // 先补发历史日志，再挂到实时流上
      for (const line of run.logs) res.write(`data: ${JSON.stringify({ type: "log", line })}\n\n`);
      if (run.done) {
        res.write(`data: ${JSON.stringify({ type: "done", exitCode: run.exitCode, status: run.status, reason: run.reason })}\n\n`);
        res.end();
        return;
      }
      run.listeners.add(res);
      req.on("close", () => run.listeners.delete(res));
      return;
    }

    // 两段式投递：对文章库里的文章确认后投草稿箱（file = 文章文件夹 id）
    if (path === "/api/publish" && method === "POST") {
      const body = await readBody(req);
      const file = safeId(String(body.file ?? ""));
      const title = String(body.title ?? "").trim();
      const account = String(body.account ?? "").trim();
      if (!file || !title || !account) {
        return sendJson(res, 400, { error: "缺少 file / title / account" });
      }
      // 封面：显式指定封面库文件名 > 文章文件夹里已有的 cover > 账号默认
      let cover: string | undefined;
      const coverName = String(body.cover ?? "").trim();
      if (coverName) {
        const cp = resolve(COVERS_DIR, coverName);
        if (!(await isInsideDir(cp, COVERS_DIR))) return sendJson(res, 403, { error: "非法封面路径" });
        // 显式封面只属于本次投递，不复制进文章目录，避免污染文章自身封面状态。
        await appendLog(file, `投递时临时封面：${coverName}`);
        cover = cp;
      } else {
        cover = (await articleCoverPath(file)) ?? undefined;
      }
      const markdown = await readArticleFile(file, "md");
      const html = await readArticleFile(file, "html").catch(() => undefined);
      const r = await publishArticle({
        platform: "wechat",
        account,
        title,
        markdown,
        html,
        sourceFile: file,
        cover,
      });
      return sendJson(res, 200, { ok: true, mediaId: r.id, account });
    }

    // 投递记录：output/deliveries.jsonl，按时间倒序
    if (path === "/api/deliveries" && method === "GET") {
      await ensureDeliveriesIndexed();
      return sendJson(res, 200, { records: getArticleIndex().listDeliveries() });
    }

    sendJson(res, 404, { error: "Not Found" });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    sendJson(res, status, { error: e instanceof Error ? e.message : String(e) });
  }
}

// 启动时把旧版平铺产出（output/<ts>.md/.html）迁移为文章文件夹结构
const migrated = await migrateFlatOutputs();
if (migrated > 0) console.log(`[server] 已迁移 ${migrated} 篇旧版文章为文件夹结构`);
await syncArticleIndex();
await ensureDeliveriesIndexed();

createServer((req, res) => void route(req, res)).listen(PORT, HOST, () => {
  console.log(`[server] 文章流水线 API 已启动：http://${HOST}:${PORT}`);
  console.log(`[server] 素材目录：${MATERIALS_DIR}`);
  console.log(`[server] 产出目录：${OUTPUT_DIR}`);
  console.log(`[server] AI 生图：${IMAGE_API_KEY ? `已配置（${IMAGE_MODEL}）` : "未配置（配置 IMAGE_API_KEY 后可用）"}`);
});
