// API 客户端：与 ../src/server.ts 的接口一一对应
export interface MaterialFile {
  name: string;
}
export interface AccountInfo {
  name: string;
  configured: boolean;
  cover?: string; // 账号配置的封面文件名（covers/ 目录内）
}
export interface Article {
  id: string; // 文章文件夹 id
  title: string; // 文章名（一级标题）
  mtime: string;
  size: number;
  hasHtml: boolean;
  hasCover: boolean;
  cover?: string;
}

export interface TrashedArticle extends Article {
  trashedAt: string;
}

export interface ArticleVersion {
  id: string;
  createdAt: string;
}

export interface AIChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AIEditResult {
  ok: boolean;
  rewrittenText: string;
  explanation: string;
  model: string;
}

export interface AIRegenerateResult {
  ok: boolean;
  title: string;
  article: string;
  explanation: string;
  model: string;
}

export interface ArticleAiSession {
  id: string;
  createdAt: string;
  originalSnippet: string;
  applied?: boolean;
  appliedAt?: string;
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    rewrittenText?: string;
    explanation?: string;
    originalText?: string;
    applied?: boolean;
    timestamp?: string;
  }>;
}

const API_TOKEN = (import.meta.env.VITE_API_TOKEN as string | undefined)?.trim() ?? "";

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return API_TOKEN ? { ...extra, Authorization: `Bearer ${API_TOKEN}` } : extra;
}

function mediaUrl(path: string): string {
  return API_TOKEN ? `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(API_TOKEN)}` : path;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: authHeaders() });
  const data = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  const data = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  const data = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

async function uploadFile<T>(path: string, filename: string, file: File): Promise<T> {
  const separator = path.includes("?") ? "&" : "?";
  const r = await fetch(`${path}${separator}filename=${encodeURIComponent(filename)}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": file.type || "application/octet-stream" }),
    body: file,
  });
  const data = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

export const api = {
  health: () => get<{ ok: boolean; llmKeyConfigured: boolean }>("/api/health"),
  settings: () =>
    get<{ settings: { key: string; secret: boolean; set: boolean; value: string }[] }>(
      "/api/settings",
    ),
  saveSettings: (updates: Record<string, string>) =>
    post<{ ok: boolean; changed: string[] }>("/api/settings", updates),
  materials: () => get<{ files: string[] }>("/api/materials"),
  uploadMaterial: (name: string, content: string) =>
    post<{ ok: boolean; name: string }>("/api/materials", { name, content }),
  uploadMaterialFile: (name: string, file: File) =>
    uploadFile<{ ok: boolean; name: string }>("/api/materials", name, file),
  materialContent: (name: string) =>
    get<{ name: string; content: string }>(`/api/materials/${encodeURIComponent(name)}`),
  accounts: () => get<{ accounts: AccountInfo[] }>("/api/accounts"),
  covers: () =>
    get<{ files: string[]; imageGenReady: boolean; imageModel?: string }>("/api/covers"),
  uploadCover: (filename: string, file: File) =>
    uploadFile<{ ok: boolean; name: string }>("/api/covers", filename, file),
  generateCover: (prompt: string) =>
    post<{ ok: boolean; name: string }>("/api/covers/generate", { prompt }),
  renameCover: (oldName: string, newName: string) =>
    post<{ ok: boolean; name: string }>("/api/covers/rename", { oldName, newName }),
  // 一键封面：LLM 读文章内容自动设计画面 → 生图 → 设为本篇封面
  autoCover: (id: string, hint?: string) =>
    post<{ ok: boolean; name: string; description: string }>(
      `/api/articles/${encodeURIComponent(id)}/cover/auto`,
      { hint },
    ),

  // 文章库（文件夹结构）
  articles: () => get<{ articles: Article[] }>("/api/articles"),
  articleSource: (id: string) =>
    get<{ topic: string; notes: string }>(`/api/articles/${encodeURIComponent(id)}/source`),
  trashedArticles: () => get<{ articles: TrashedArticle[] }>("/api/trash/articles"),
  addArticle: (title: string, markdown: string) =>
    post<{ ok: boolean; id: string }>("/api/articles", { title, markdown }),
  aiEditSelection: (params: {
    selectedText: string;
    instruction: string;
    fullText?: string;
    history?: AIChatMessage[];
    tier?: "flash" | "pro";
  }) => post<AIEditResult>("/api/ai/edit-selection", params),
  aiRegenerateArticle: (params: {
    articleId: string;
    currentTitle: string;
    currentArticle: string;
    topic?: string;
    sourceNotes?: string;
    instruction: string;
    history?: AIChatMessage[];
    tier?: "flash" | "pro";
  }) => post<AIRegenerateResult>("/api/ai/regenerate-article", params),
  articleFile: (id: string, which: "md" | "log") =>
    get<{ id: string; which: string; content: string }>(
      `/api/articles/${encodeURIComponent(id)}/file?which=${which}`,
    ),
  articleHtmlUrl: (id: string) => mediaUrl(`/api/articles/${encodeURIComponent(id)}/file?which=html`),
  articleCoverUrl: (id: string) => mediaUrl(`/api/articles/${encodeURIComponent(id)}/cover`),
  coverUrl: (name: string) => mediaUrl(`/api/covers/${encodeURIComponent(name)}`),
  updateArticle: (id: string, markdown: string, note?: string, title?: string) =>
    put<{ ok: boolean }>(`/api/articles/${encodeURIComponent(id)}`, { markdown, note, title }),
  updateArticleTitle: (id: string, title: string) =>
    post<{ ok: boolean; title: string }>(`/api/articles/${encodeURIComponent(id)}/title`, { title }),
  articleVersions: (id: string) =>
    get<{ versions: ArticleVersion[] }>(
      `/api/articles/${encodeURIComponent(id)}/versions`,
    ),
  articleVersion: (id: string, version: string) =>
    get<{ id: string; markdown: string; html: string }>(
      `/api/articles/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`,
    ),
  restoreArticleVersion: (id: string, version: string) =>
    post<{ ok: boolean }>(
      `/api/articles/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/restore`,
      {},
    ),
  articleAiSessions: (id: string) =>
    get<{ sessions: ArticleAiSession[] }>(
      `/api/articles/${encodeURIComponent(id)}/ai-sessions`,
    ),
  saveArticleAiSession: (id: string, session: ArticleAiSession) =>
    post<{ ok: boolean; id: string }>(
      `/api/articles/${encodeURIComponent(id)}/ai-sessions`,
      session,
    ),
  removeArticle: async (id: string): Promise<{ ok: boolean }> => {
    const r = await fetch(`/api/articles/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    const data = (await r.json()) as { ok: boolean; error?: string };
    if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
    return data;
  },
  trashArticle: (id: string) =>
    post<{ ok: boolean }>(`/api/articles/${encodeURIComponent(id)}/trash`, {}),
  restoreTrashedArticle: (id: string) =>
    post<{ ok: boolean }>(`/api/articles/${encodeURIComponent(id)}/restore`, {}),
  setArticleCover: (id: string, name: string) =>
    post<{ ok: boolean; name: string }>(`/api/articles/${encodeURIComponent(id)}/cover`, { name }),
  removeArticleCover: async (id: string): Promise<{ ok: boolean }> => {
    const r = await fetch(`/api/articles/${encodeURIComponent(id)}/cover`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    const data = (await r.json()) as { ok: boolean; error?: string };
    if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
    return data;
  },
  uploadArticleCover: (id: string, filename: string, file: File) =>
    uploadFile<{ ok: boolean; name: string }>(`/api/articles/${encodeURIComponent(id)}/cover`, filename, file),
  articleImages: (id: string) =>
    get<{ files: string[] }>(`/api/articles/${encodeURIComponent(id)}/images`),
  uploadArticleImage: (id: string, filename: string, file: File) =>
    uploadFile<{ ok: boolean; name: string }>(`/api/articles/${encodeURIComponent(id)}/images`, filename, file),
  articleImageUrl: (id: string, name: string) =>
    mediaUrl(`/api/articles/${encodeURIComponent(id)}/images/${encodeURIComponent(name)}`),

  run: (topic: string, notes: string) => post<{ runId: string }>("/api/run", { topic, notes }),
  cancelRun: (runId: string) =>
    post<{ ok: boolean; runId: string }>(`/api/run/${encodeURIComponent(runId)}/cancel`, {}),
  publish: (file: string, title: string, account: string, cover?: string) =>
    post<{ ok: boolean; mediaId: string }>("/api/publish", { file, title, account, cover }),
  deliveries: () =>
    get<{
      records: {
        at: string;
        platform: string;
        account: string;
        title: string;
        mediaId?: string;
        status?: "success" | "failed";
        sourceFile: string | null;
        error?: string;
      }[];
    }>("/api/deliveries"),
};

/** 订阅运行日志（SSE），返回关闭函数 */
export function subscribeRun(
  runId: string,
  onLog: (line: string) => void,
  onDone: (result: {
    exitCode: number | null;
    status?: "success" | "degraded" | "failed" | "cancelled";
    reason?: string;
  }) => void,
): () => void {
  const query = API_TOKEN ? `?token=${encodeURIComponent(API_TOKEN)}` : "";
  const es = new EventSource(`/api/run/${runId}/events${query}`);
  es.onmessage = (ev) => {
    const data = JSON.parse(ev.data as string) as
      | { type: "log"; line: string }
      | { type: "done"; exitCode: number | null };
    if (data.type === "log") onLog(data.line);
    else {
      onDone(data);
      es.close();
    }
  };
  es.onerror = () => es.close();
  return () => es.close();
}
