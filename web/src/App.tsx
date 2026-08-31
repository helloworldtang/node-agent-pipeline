import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  subscribeRun,
  type AccountInfo,
  type Article,
  type TrashedArticle,
  type ArticleVersion,
  type AIChatMessage,
  type ArticleAiSession,
} from "./api";

type Phase = "idle" | "running" | "done" | "degraded" | "cancelled" | "error";
type Tab = "html" | "md" | "edit" | "log";
type DiffLine = { kind: "same" | "add" | "remove" | "notice"; text: string };

interface SelectionInfo {
  start: number;
  end: number;
  text: string;
}

interface AIChatItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  rewrittenText?: string;
  explanation?: string;
  originalText?: string;
  viewMode?: "result" | "diff";
  applied?: boolean;
  timestamp?: string;
}

interface ArticleRegenerateItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  title?: string;
  article?: string;
  explanation?: string;
  originalTitle?: string;
  originalArticle?: string;
  applied?: boolean;
  viewMode?: "result" | "diff";
  timestamp?: string;
}

const AI_PRESET_TAGS = [
  { label: "🗣️ 口语化讲人话", prompt: "用更接地气、更通俗自然的第一人称口语化表达重写这段内容，讲人话，避免生硬术语。" },
  { label: "✨ 润色与文采提升", prompt: "提升文字质感和文学感染力，句式更有节奏感，表达更生动凝练。" },
  { label: "💡 补充生动比喻/案例", prompt: "在保留核心论点的基础上，补充一个贴近日常生活的生动比喻或实际场景案例来帮助读者理解。" },
  { label: "📝 提炼为要点列表", prompt: "将这段内容拆解并提炼为 2~3 个结构清晰、条理分明的编号要点（1. 2. 3.）。" },
  { label: "✂️ 精简去粗取精", prompt: "去粗取精，删减冗余修饰词，用最凝练的语言精准保留核心信息。" },
  { label: "🔥 增强感染力与语气", prompt: "增强情绪共鸣与吸引力，语气更有力量感，直击读者痛点。" },
];

/** 文章通常只有几百行；对超大正文降级为整段新增/删除，避免浏览器卡死。 */
function buildDiff(previous: string, current: string): DiffLine[] {
  const oldLines = previous.split("\n");
  const newLines = current.split("\n");
  if (oldLines.length * newLines.length > 1_500_000) {
    return [
      { kind: "notice", text: "正文较长，已跳过逐行对齐。" },
      ...oldLines.map((text) => ({ kind: "remove" as const, text })),
      ...newLines.map((text) => ({ kind: "add" as const, text })),
    ];
  }

  const table = Array.from({ length: oldLines.length + 1 }, () => new Uint32Array(newLines.length + 1));
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i]![j] = oldLines[i] === newLines[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      result.push({ kind: "same", text: oldLines[i]! });
      i += 1;
      j += 1;
    } else if (j >= newLines.length || (i < oldLines.length && table[i + 1]![j]! >= table[i]![j + 1]!)) {
      result.push({ kind: "remove", text: oldLines[i]! });
      i += 1;
    } else {
      result.push({ kind: "add", text: newLines[j]! });
      j += 1;
    }
  }
  return result;
}

function extractArticleTitle(markdown: string): string {
  const head = markdown.slice(0, 2000);
  return (
    head.match(/^#\s+(.+)$/m)?.[1]?.trim() ??
    head
      .split("\n")
      .map((line) => line.replace(/^[#>*`\-\s]+/, "").trim())
      .find((line) => line.length >= 4)
      ?.slice(0, 50) ??
    ""
  );
}

export default function App() {
  // 表单
  const [topic, setTopic] = useState("");
  const [notes, setNotes] = useState("");
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [materials, setMaterials] = useState<string[]>([]);
  const [pickedMaterial, setPickedMaterial] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [account, setAccount] = useState("");

  // 运行
  const [phase, setPhase] = useState<Phase>("idle");
  const [logs, setLogs] = useState<string[]>([]);
  const [logsCollapsed, setLogsCollapsed] = useState(false);
  const termRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<(() => void) | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  // 文章库
  const [articles, setArticles] = useState<Article[]>([]);
  const [trashArticles, setTrashArticles] = useState<TrashedArticle[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [trashLoading, setTrashLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null); // 文章 id
  const [mdContent, setMdContent] = useState("");
  const [logContent, setLogContent] = useState("");
  const [tab, setTab] = useState<Tab>("html");
  const [showAdd, setShowAdd] = useState(false);
  const [addTitle, setAddTitle] = useState("");
  const [addMarkdown, setAddMarkdown] = useState("");
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const addFileInputRef = useRef<HTMLInputElement>(null);
  // 编辑模式
  const [editDraft, setEditDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);
  const [versions, setVersions] = useState<ArticleVersion[]>([]);
  const [versionPreview, setVersionPreview] = useState<(ArticleVersion & { markdown: string }) | null>(null);
  const [loadingVersion, setLoadingVersion] = useState<string | null>(null);
  const [restoringVersion, setRestoringVersion] = useState<string | null>(null);

  // AI 选区编辑与重写
  const [selectionInfo, setSelectionInfo] = useState<SelectionInfo | null>(null);
  const [aiSelectedExpanded, setAiSelectedExpanded] = useState(false);
  const [aiEditOpen, setAiEditOpen] = useState(false);
  const [aiDrawerTab, setAiDrawerTab] = useState<"current" | "history">("current");
  const [aiChatList, setAiChatList] = useState<AIChatItem[]>([]);
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiTier, setAiTier] = useState<"flash" | "pro">("flash");
  const [aiLoading, setAiLoading] = useState(false);
  const aiChatEndRef = useRef<HTMLDivElement>(null);
  const aiInputRef = useRef<HTMLTextAreaElement>(null);
  const aiCurrentSessionId = useRef<string>("");
  const aiSessionCreatedAt = useRef<string>("");
  const [aiHistorySessions, setAiHistorySessions] = useState<ArticleAiSession[]>([]);
  const [historyExpandedMap, setHistoryExpandedMap] = useState<Record<string, boolean>>({});
  const [historyViewModeMap, setHistoryViewModeMap] = useState<Record<string, "result" | "diff">>({});
  // 整篇文章重新生成
  const [articleRegenerateOpen, setArticleRegenerateOpen] = useState(false);
  const [articleRegenerateSource, setArticleRegenerateSource] = useState<{
    title: string;
    article: string;
    topic: string;
    sourceNotes: string;
  } | null>(null);
  const [articleRegenerateChat, setArticleRegenerateChat] = useState<ArticleRegenerateItem[]>([]);
  const [articleRegenerateInstruction, setArticleRegenerateInstruction] = useState("");
  const [articleRegenerateTier, setArticleRegenerateTier] = useState<"flash" | "pro">("pro");
  const [articleRegenerateLoading, setArticleRegenerateLoading] = useState(false);
  const [applyingArticleRegenerate, setApplyingArticleRegenerate] = useState(false);
  const articleRegenerateEndRef = useRef<HTMLDivElement>(null);
  const articleRegenerateInputRef = useRef<HTMLTextAreaElement>(null);
  // 投递记录：文章 id → 最近一次投递
  const [deliveryMap, setDeliveryMap] = useState<
    Map<string, { at: string; account: string; mediaId: string }>
  >(new Map());

  // 封面
  const [covers, setCovers] = useState<string[]>([]);
  const [showCoverList, setShowCoverList] = useState(true);
  const [renamingCover, setRenamingCover] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [imageGen, setImageGen] = useState<{ ready: boolean; model?: string }>({ ready: false });
  const [coverPrompt, setCoverPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [coverProgress, setCoverProgress] = useState<{
    step: number;
    total: number;
    title: string;
    hint: string;
    percent: number;
  } | null>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const [coverVersion, setCoverVersion] = useState(0); // 封面变更计数，给图片 URL 加时间戳防缓存
  const [zoom, setZoom] = useState<{ src: string; name?: string } | null>(null); // 灯箱放大；name=封面库文件名时可「设为本篇封面」

  // 投递
  const [title, setTitle] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [llmReady, setLlmReady] = useState<boolean | null>(null);

  // 设置面板
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<
    { key: string; secret: boolean; set: boolean; value: string }[]
  >([]);
  const [settingDraft, setSettingDraft] = useState<Record<string, string>>({});
  const [savingSettings, setSavingSettings] = useState(false);

  const SETTING_LABELS: Record<string, { label: string; hint?: string; placeholder?: string }> = {
    LLM_PROVIDER: { label: "LLM 供应商", hint: "deepseek / moonshot / custom" },
    LLM_API_KEY: { label: "LLM API Key", placeholder: "sk-…" },
    LLM_BASE_URL: { label: "LLM 接口地址", hint: "显示的是当前供应商的生效值；仅 custom 供应商必须手填" },
    LLM_MODEL_FLASH: { label: "编排模型", hint: "显示的是当前供应商的生效值；改它可覆盖默认" },
    LLM_MODEL_PRO: { label: "写作模型", hint: "显示的是当前供应商的生效值；改它可覆盖默认" },
    IMAGE_API_KEY: { label: "生图 API Key", placeholder: "sk-…" },
    IMAGE_BASE_URL: {
      label: "生图接口地址",
      hint: "万相 https://dashscope.aliyuncs.com/compatible-mode/v1 · 方舟 https://ark.cn-beijing.volces.com/api/v3 · 智谱 https://open.bigmodel.cn/api/paas/v4 · OpenAI https://api.openai.com/v1",
      placeholder: "https://…/v1",
    },
    IMAGE_MODEL: {
      label: "生图模型",
      hint: "wanx2.1-t2i-turbo / doubao-seedream-4-0-250828 / cogview-3-plus / gpt-image-1",
    },
    IMAGE_SIZE: { label: "生图尺寸", hint: "可留空；万相 1024*1024，其他家 1024x1024" },
    IMAGE_COVER_PROMPT: {
      label: "封面生图提示词模板",
      hint: "模板中的 {description} 是占位符：点「AI 生成封面」时，LLM 读完文章自动产出的画面描述会填到这里。可修改模板的构图/风格要求",
    },
  };

  const openSettings = async () => {
    setShowSettings(true);
    setSettingDraft({});
    try {
      const { settings } = await api.settings();
      setSettings(settings);
    } catch {
      setSettings([]);
    }
  };

  const saveSettings = async () => {
    const updates = Object.fromEntries(
      Object.entries(settingDraft).filter(([, v]) => v.trim() !== ""),
    );
    if (Object.keys(updates).length === 0) {
      setShowSettings(false);
      return;
    }
    setSavingSettings(true);
    try {
      await api.saveSettings(updates);
      setShowSettings(false);
      setSettingDraft({});
      // 配置变了，刷新相关状态
      api.health().then((h) => setLlmReady(h.llmKeyConfigured)).catch(() => {});
      refreshCovers();
      setToast({ kind: "ok", text: "✓ 设置已保存并即时生效（已写入 .env）" });
    } catch (e) {
      setToast({ kind: "err", text: `保存失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setSavingSettings(false);
    }
  };

  const refreshDeliveries = useCallback(async () => {
    try {
      const { records } = await api.deliveries();
      const map = new Map<string, { at: string; account: string; mediaId: string }>();
      for (const r of records) {
        if (r.sourceFile && r.status !== "failed" && r.mediaId) {
          const key = r.sourceFile.replace(/\.md$/, ""); // 兼容旧记录
          if (!map.has(key)) map.set(key, { at: r.at, account: r.account, mediaId: r.mediaId });
        }
      }
      setDeliveryMap(map);
    } catch {
      /* 记录读取失败不阻塞界面 */
    }
  }, []);

  const refreshArticles = useCallback(async (autoSelectLatest = false) => {
    const { articles } = await api.articles();
    setArticles(articles);
    if (autoSelectLatest && articles.length > 0) setSelected(articles[0]!.id);
  }, []);

  const refreshTrash = useCallback(async () => {
    setTrashLoading(true);
    try {
      const { articles: nextTrash } = await api.trashedArticles();
      setTrashArticles(nextTrash);
    } catch (e) {
      setToast({ kind: "err", text: `回收站读取失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setTrashLoading(false);
    }
  }, []);

  const refreshCovers = useCallback(async () => {
    try {
      const c = await api.covers();
      setCovers(c.files);
      setImageGen({ ready: c.imageGenReady, model: c.imageModel });
    } catch { /* 忽略 */ }
  }, []);

  useEffect(() => {
    api.health().then((h) => setLlmReady(h.llmKeyConfigured)).catch(() => setLlmReady(false));
    api.materials().then((m) => setMaterials(m.files)).catch(() => {});
    api
      .accounts()
      .then((a) => {
        setAccounts(a.accounts);
        const first = a.accounts.find((x) => x.configured);
        if (first) {
          setAccount(first.name);
        }
      })
      .catch(() => {});
    refreshCovers();
    refreshArticles(true).catch(() => {});
    refreshTrash().catch(() => {});
    refreshDeliveries().catch(() => {});
  }, [refreshArticles, refreshDeliveries, refreshCovers, refreshTrash]);

  const selectedArticle = useMemo(
    () => articles.find((a) => a.id === selected) ?? null,
    [articles, selected],
  );

  const reloadVersions = useCallback(async (id: string) => {
    const { versions: nextVersions } = await api.articleVersions(id);
    setVersions(nextVersions);
    return nextVersions;
  }, []);

  // 选中文章：载入 md / 日志，猜标题
  useEffect(() => {
    let cancelled = false;

    if (!selected) {
      setMdContent("");
      setLogContent("");
      setVersions([]);
      setVersionPreview(null);
      setTitle("");
      return;
    }

    setMdContent("");
    setLogContent("");
    setVersions([]);
    setVersionPreview(null);
    const matched = articles.find((a) => a.id === selected);
    setTitle(matched?.title ?? "");
    api
      .articleVersions(selected)
      .then(({ versions: nextVersions }) => {
        if (!cancelled) setVersions(nextVersions);
      })
      .catch(() => {
        if (!cancelled) setVersions([]);
      });
    api
      .articleAiSessions(selected)
      .then(({ sessions }) => {
        if (!cancelled) setAiHistorySessions(sessions);
      })
      .catch(() => {
        if (!cancelled) setAiHistorySessions([]);
      });
    api
      .articleFile(selected, "md")
      .then(({ content }) => {
        if (cancelled) return;
        setMdContent(content);
        setTitle((prev) => prev || extractArticleTitle(content));
      })
      .catch(() => {
        if (!cancelled) setMdContent("（读取失败）");
      });
    api
      .articleFile(selected, "log")
      .then(({ content }) => {
        if (!cancelled) setLogContent(content);
      })
      .catch(() => {
        if (!cancelled) setLogContent("（暂无日志）");
      });

    return () => {
      cancelled = true;
    };
  }, [selected, articles]);

  useEffect(() => {
    termRef.current?.scrollTo({ top: termRef.current.scrollHeight });
  }, [logs]);

  const loadMaterial = async () => {
    if (!pickedMaterial) return;
    const { content } = await api.materialContent(pickedMaterial);
    setNotes((prev) => (prev ? `${prev}\n\n` : "") + `【${pickedMaterial}】\n${content}`);
  };

  // 上传本地笔记文件到素材库，并直接载入输入框
  const uploadMaterial = async (file: File | undefined) => {
    if (!file) return;
    try {
      const content = await file.text();
      const r = await api.uploadMaterialFile(file.name, file);
      const m = await api.materials();
      setMaterials(m.files);
      setPickedMaterial(r.name);
      setNotes((prev) => (prev ? `${prev}\n\n` : "") + `【${r.name}】\n${content}`);
      setToast({ kind: "ok", text: `✓ 已存入素材库：${r.name}` });
    } catch (e) {
      setToast({ kind: "err", text: `上传失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const startRun = async () => {
    if (topic.trim().length < 2) {
      setToast({ kind: "err", text: "请先填写选题（至少 2 个字）" });
      return;
    }
    closeRef.current?.();
    setLogs([]);
    setPhase("running");
    setToast(null);
    try {
      const { runId } = await api.run(topic.trim(), notes);
      setRunId(runId);
      closeRef.current = subscribeRun(
        runId,
        (line) => setLogs((prev) => [...prev, line]),
        (result) => {
          const finalStatus = result.status ?? (result.exitCode === 0 ? "success" : "failed");
          setPhase(
            finalStatus === "success"
              ? "done"
              : finalStatus === "degraded"
                ? "degraded"
                : finalStatus === "cancelled"
                  ? "cancelled"
                  : "error",
          );
          if (finalStatus === "success" || finalStatus === "degraded") {
            refreshArticles(true).catch(() => {});
            if (!title) setTitle(topic.trim());
            if (finalStatus === "degraded") {
              setToast({ kind: "err", text: `任务完成但质量降级：${result.reason ?? "校验告警"}` });
            }
          } else if (finalStatus === "failed" || finalStatus === "cancelled") {
            setToast({
              kind: "err",
              text: finalStatus === "cancelled" ? "任务已取消" : `生产失败：${result.reason ?? "未提供失败原因"}`,
            });
          }
        },
      );
    } catch (e) {
      setPhase("error");
      setToast({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    }
  };

  const cancelRun = async () => {
    if (!runId) return;
    try {
      await api.cancelRun(runId);
    } catch (e) {
      setToast({ kind: "err", text: `取消失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  // ---- 编辑 ----
  const enterEdit = () => {
    setEditDraft(mdContent);
    setTab("edit");
    setSelectionInfo(null);
  };

  // 捕获文本选区
  const handleSelectionChange = () => {
    const ta = editRef.current;
    if (!ta) return;
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    if (start !== end) {
      const text = ta.value.substring(start, end);
      if (text.trim()) {
        setSelectionInfo({ start, end, text });
        return;
      }
    }
    // 当光标无选中范围或选中的是纯空白字符时，清空选区状态
    setSelectionInfo(null);
  };

  // 打开 AI 编辑面板
  const openAiEditor = (overrideText?: string) => {
    const ta = editRef.current;
    let targetText = overrideText;
    if (!targetText && ta && ta.selectionStart !== ta.selectionEnd) {
      const start = ta.selectionStart ?? 0;
      const end = ta.selectionEnd ?? 0;
      const text = ta.value.substring(start, end);
      if (text.trim()) {
        setSelectionInfo({ start, end, text });
        targetText = text;
      }
    }
    if (!targetText && !selectionInfo?.text && editDraft.trim()) {
      setToast({ kind: "err", text: "请先在编辑框中用鼠标选中需要修改的文章片段" });
      return;
    }
    setAiDrawerTab("current");
    if (!aiCurrentSessionId.current || aiChatList.length === 0) {
      aiCurrentSessionId.current = `session-${Date.now()}`;
      aiSessionCreatedAt.current = new Date().toISOString();
    }
    if (selected) {
      api.articleAiSessions(selected).then(({ sessions }) => setAiHistorySessions(sessions)).catch(() => {});
    }
    setAiEditOpen(true);
    setTimeout(() => aiInputRef.current?.focus(), 150);
  };

  // 打开 AI 历史对话记录面板
  const openAiHistory = () => {
    setAiDrawerTab("history");
    if (selected) {
      api
        .articleAiSessions(selected)
        .then(({ sessions }) => setAiHistorySessions(sessions))
        .catch(() => {});
    }
    setAiEditOpen(true);
  };

  const closeAiEditor = () => {
    setAiEditOpen(false);
    // 关闭抽屉后重新同步当前真实选区
    setTimeout(handleSelectionChange, 0);
  };

  // 持久化保存当前 AI 会话到 output/<id>/ai-chat.jsonl
  const syncAiSessionToDisk = useCallback(
    (messages: AIChatItem[], applied = false, appliedAt?: string) => {
      if (!selected || messages.length === 0) return;
      if (!aiCurrentSessionId.current) {
        aiCurrentSessionId.current = `session-${Date.now()}`;
        aiSessionCreatedAt.current = new Date().toISOString();
      }
      const sessionData: ArticleAiSession = {
        id: aiCurrentSessionId.current,
        createdAt: aiSessionCreatedAt.current || new Date().toISOString(),
        originalSnippet: selectionInfo?.text ?? "",
        applied,
        appliedAt,
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          rewrittenText: m.rewrittenText,
          explanation: m.explanation,
          originalText: m.originalText,
          applied: m.applied,
          timestamp: m.timestamp || new Date().toISOString(),
        })),
      };
      api
        .saveArticleAiSession(selected, sessionData)
        .then(() => api.articleAiSessions(selected))
        .then(({ sessions }) => setAiHistorySessions(sessions))
        .catch(() => {});
    },
    [selected, selectionInfo],
  );

  // 发送 AI 编辑请求
  const sendAiEdit = async (customInstruction?: string) => {
    const instr = (customInstruction ?? aiInstruction).trim();
    if (!instr) {
      setToast({ kind: "err", text: "请输入您的修改想法或选择快捷预设" });
      return;
    }
    const currentText = selectionInfo?.text?.trim() || "";
    if (!currentText) {
      setToast({ kind: "err", text: "未锁定有效选区文本，请先选中文本" });
      return;
    }

    const userMsg: AIChatItem = {
      id: `user-${Date.now()}`,
      role: "user",
      content: instr,
      timestamp: new Date().toISOString(),
    };
    const nextChatList = [...aiChatList, userMsg];
    setAiChatList(nextChatList);
    setAiInstruction("");
    setAiLoading(true);

    try {
      // 组装历史对话
      const history: AIChatMessage[] = aiChatList.map((item) => ({
        role: item.role,
        content: item.role === "assistant" && item.rewrittenText ? item.rewrittenText : item.content,
      }));

      const res = await api.aiEditSelection({
        selectedText: currentText,
        instruction: instr,
        fullText: editDraft,
        history,
        tier: aiTier,
      });

      const assistantMsg: AIChatItem = {
        id: `ai-${Date.now()}`,
        role: "assistant",
        content: res.explanation ? `💡 **修改思路**：${res.explanation}` : "已按要求完成重写",
        rewrittenText: res.rewrittenText,
        explanation: res.explanation,
        originalText: currentText,
        viewMode: "result",
        timestamp: new Date().toISOString(),
      };

      const finalChatList = [...nextChatList, assistantMsg];
      setAiChatList(finalChatList);
      syncAiSessionToDisk(finalChatList, false);
      setTimeout(() => aiChatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    } catch (e) {
      const errorMsg: AIChatItem = {
        id: `err-${Date.now()}`,
        role: "assistant",
        content: `❌ 请求失败：${e instanceof Error ? e.message : String(e)}`,
        timestamp: new Date().toISOString(),
      };
      const finalChatList = [...nextChatList, errorMsg];
      setAiChatList(finalChatList);
      syncAiSessionToDisk(finalChatList, false);
    } finally {
      setAiLoading(false);
    }
  };

  // 采纳并生效全篇
  const applyAiRewrite = (rewrittenText: string, originalText?: string, msgId?: string) => {
    if (!rewrittenText) return;
    const targetOriginal = originalText ?? selectionInfo?.text ?? "";
    let nextDraft = editDraft;
    let appliedStart = 0;
    let appliedEnd = 0;

    // 1. 先尝试通过 selectionInfo 精确索引替换
    if (
      selectionInfo &&
      selectionInfo.start >= 0 &&
      selectionInfo.end <= editDraft.length &&
      editDraft.slice(selectionInfo.start, selectionInfo.end) === targetOriginal
    ) {
      appliedStart = selectionInfo.start;
      appliedEnd = selectionInfo.start + rewrittenText.length;
      nextDraft = editDraft.slice(0, selectionInfo.start) + rewrittenText + editDraft.slice(selectionInfo.end);
    } else if (targetOriginal && editDraft.includes(targetOriginal)) {
      // 2. 索引有偏移，通过全文匹配 targetOriginal 替换
      const index = editDraft.indexOf(targetOriginal);
      appliedStart = index;
      appliedEnd = index + rewrittenText.length;
      nextDraft = editDraft.slice(0, index) + rewrittenText + editDraft.slice(index + targetOriginal.length);
    } else {
      // 3. 原文片段未在当前草稿中找到
      setToast({ kind: "err", text: "未在当前正文中找到该片段，可能正文已被手动修改。已复制重写内容至剪贴板。" });
      navigator.clipboard?.writeText(rewrittenText);
      return;
    }

    // 更新持久化会话记录为已采纳
    const updatedMessages = aiChatList.map((m) =>
      m.id === msgId ? { ...m, applied: true } : m,
    );
    syncAiSessionToDisk(
      updatedMessages.length > 0
        ? updatedMessages
        : [
            {
              id: `ai-${Date.now()}`,
              role: "assistant" as const,
              content: "已采纳历史版本",
              rewrittenText,
              originalText: targetOriginal,
              applied: true,
              timestamp: new Date().toISOString(),
            },
          ],
      true,
      new Date().toISOString(),
    );

    setEditDraft(nextDraft);
    // 采纳成功后，本次重写任务完成：清空选区与对话流，并自动收起抽屉
    setSelectionInfo(null);
    setAiChatList([]);
    aiCurrentSessionId.current = "";
    aiSessionCreatedAt.current = "";
    setAiEditOpen(false);

    setToast({ kind: "ok", text: "✓ 已成功采纳并生效到正文！可继续编辑或点击下方「保存」生效排版。" });

    const ta = editRef.current;
    if (ta) {
      setTimeout(() => {
        ta.focus();
        ta.setSelectionRange(appliedEnd, appliedEnd);
      }, 60);
    }
  };

  const setChatViewMode = (msgId: string, mode: "result" | "diff") => {
    setAiChatList((prev) =>
      prev.map((item) => (item.id === msgId ? { ...item, viewMode: mode } : item))
    );
  };

  const clearAiChat = () => {
    setAiChatList([]);
    aiCurrentSessionId.current = `session-${Date.now()}`;
    aiSessionCreatedAt.current = new Date().toISOString();
  };

  const openArticleRegenerator = async () => {
    if (!selected || !mdContent.trim()) {
      setToast({ kind: "err", text: "当前文章正文尚未加载完成，暂时无法重新生成" });
      return;
    }
    const currentTitle = title.trim() || selectedArticle?.title || "未命名文章";
    const source = await api.articleSource(selected).catch(() => ({ topic: "", notes: "" }));
    setArticleRegenerateSource({
      title: currentTitle,
      article: mdContent,
      topic: source.topic || currentTitle,
      sourceNotes: source.notes,
    });
    setArticleRegenerateChat([]);
    setArticleRegenerateInstruction("");
    setArticleRegenerateOpen(true);
    setTimeout(() => articleRegenerateInputRef.current?.focus(), 150);
  };

  const sendArticleRegeneration = async (customInstruction?: string) => {
    const instruction = (customInstruction ?? articleRegenerateInstruction).trim();
    if (!instruction) {
      setToast({ kind: "err", text: "请输入文章重新生成提示词" });
      return;
    }
    if (!selected || !articleRegenerateSource) return;

    const userMsg: ArticleRegenerateItem = {
      id: `article-user-${Date.now()}`,
      role: "user",
      content: instruction,
      timestamp: new Date().toISOString(),
    };
    const nextChat = [...articleRegenerateChat, userMsg];
    setArticleRegenerateChat(nextChat);
    setArticleRegenerateInstruction("");
    setArticleRegenerateLoading(true);
    try {
      const history: AIChatMessage[] = articleRegenerateChat.map((item) => ({
        role: item.role,
        content: item.role === "assistant" && item.article
          ? `===TITLE===\n${item.title ?? ""}\n===CONTENT===\n${item.article}\n===EXPLANATION===\n${item.explanation ?? ""}`
          : item.content,
      }));
      const result = await api.aiRegenerateArticle({
        articleId: selected,
        currentTitle: articleRegenerateSource.title,
        currentArticle: articleRegenerateSource.article,
        topic: articleRegenerateSource.topic,
        sourceNotes: articleRegenerateSource.sourceNotes,
        instruction,
        history,
        tier: articleRegenerateTier,
      });
      const assistantMsg: ArticleRegenerateItem = {
        id: `article-ai-${Date.now()}`,
        role: "assistant",
        content: result.explanation,
        title: result.title,
        article: result.article,
        explanation: result.explanation,
        originalTitle: articleRegenerateSource.title,
        originalArticle: articleRegenerateSource.article,
        timestamp: new Date().toISOString(),
      };
      setArticleRegenerateChat([...nextChat, assistantMsg]);
      setTimeout(() => articleRegenerateEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    } catch (e) {
      setArticleRegenerateChat([
        ...nextChat,
        {
          id: `article-error-${Date.now()}`,
          role: "assistant",
          content: `❌ 请求失败：${e instanceof Error ? e.message : String(e)}`,
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      setArticleRegenerateLoading(false);
    }
  };

  const applyArticleRegeneration = async (item: ArticleRegenerateItem) => {
    if (!selected || !item.article || applyingArticleRegenerate) return;
    setApplyingArticleRegenerate(true);
    try {
      await api.updateArticle(selected, item.article, "AI 重新生成文章", item.title?.trim() || title.trim());
      setMdContent(item.article);
      setEditDraft(item.article);
      setTitle(item.title?.trim() || title);
      const [{ content: log }, { versions: nextVersions }] = await Promise.all([
        api.articleFile(selected, "log"),
        api.articleVersions(selected),
      ]);
      setLogContent(log);
      setVersions(nextVersions);
      await refreshArticles();
      setArticleRegenerateOpen(false);
      setToast({ kind: "ok", text: "✓ 已采纳重新生成版本，原正文已自动保存为历史版本" });
    } catch (e) {
      setToast({ kind: "err", text: `采纳失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setApplyingArticleRegenerate(false);
    }
  };

  const setArticleRegenerateViewMode = (id: string, mode: "result" | "diff") => {
    setArticleRegenerateChat((prev) => prev.map((item) => (item.id === id ? { ...item, viewMode: mode } : item)));
  };

  const toggleHistorySession = (sessionId: string) => {
    setHistoryExpandedMap((prev) => ({ ...prev, [sessionId]: !prev[sessionId] }));
  };

  const setHistoryItemViewMode = (key: string, mode: "result" | "diff") => {
    setHistoryViewModeMap((prev) => ({ ...prev, [key]: mode }));
  };

  const handleTitleBlur = async () => {
    if (!selected || !title.trim()) return;
    const matched = articles.find((a) => a.id === selected);
    if (matched && matched.title !== title.trim()) {
      try {
        await api.updateArticleTitle(selected, title.trim());
        await refreshArticles();
      } catch (e) {
        setToast({ kind: "err", text: `更新标题失败：${e instanceof Error ? e.message : String(e)}` });
      }
    }
  };

  const saveEdit = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await api.updateArticle(selected, editDraft, "手动编辑", title.trim());
      setMdContent(editDraft);
      const { content } = await api.articleFile(selected, "log");
      setLogContent(content);
      await refreshArticles();
      await reloadVersions(selected);
      setTab("html");
      setToast({ kind: "ok", text: "✓ 已保存，排版已更新并写入日志" });
    } catch (e) {
      setToast({ kind: "err", text: `保存失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setSaving(false);
    }
  };

  const previewVersion = async (version: ArticleVersion) => {
    if (!selected) return;
    setLoadingVersion(version.id);
    try {
      const result = await api.articleVersion(selected, version.id);
      setVersionPreview({ ...version, markdown: result.markdown });
    } catch (e) {
      setToast({ kind: "err", text: `读取版本失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setLoadingVersion(null);
    }
  };

  const restoreVersion = async (version: ArticleVersion) => {
    if (!selected) return;
    if (!window.confirm(`确认回滚到 ${new Date(version.createdAt).toLocaleString("zh-CN")}？当前正文会自动保存为新版本。`)) return;
    setRestoringVersion(version.id);
    try {
      await api.restoreArticleVersion(selected, version.id);
      const [{ content: markdown }, { content: log }] = await Promise.all([
        api.articleFile(selected, "md"),
        api.articleFile(selected, "log"),
      ]);
      setMdContent(markdown);
      setEditDraft(markdown);
      setLogContent(log);
      await refreshArticles();
      await reloadVersions(selected);
      setVersionPreview(null);
      setTab("html");
      setToast({ kind: "ok", text: "✓ 已回滚，原正文已保存为一个新版本" });
    } catch (e) {
      setToast({ kind: "err", text: `回滚失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setRestoringVersion(null);
    }
  };

  // 插入图片：上传到文章 images/ 并在光标位置插入 ![](images/xxx.png)
  const insertImage = async (file: File | undefined) => {
    if (!file || !selected) return;
    try {
      const r = await api.uploadArticleImage(selected, file.name, file);
      const snippet = `\n\n![](images/${r.name})\n\n`;
      const ta = editRef.current;
      if (ta) {
        const start = ta.selectionStart ?? editDraft.length;
        const end = ta.selectionEnd ?? editDraft.length;
        const next = editDraft.slice(0, start) + snippet + editDraft.slice(end);
        setEditDraft(next);
        // 光标移到插入内容后
        setTimeout(() => {
          ta.selectionStart = ta.selectionEnd = start + snippet.length;
          ta.focus();
        }, 0);
      } else {
        setEditDraft((prev) => prev + snippet);
      }
      setToast({ kind: "ok", text: `✓ 图片已插入：images/${r.name}（保存后生效）` });
    } catch (e) {
      setToast({ kind: "err", text: `插图失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  // ---- 手动添加文章（支持文件导入与拖拽） ----
  const handleImportFile = async (file?: File) => {
    if (!file) return;
    try {
      const text = await file.text();
      const guessedTitle = extractArticleTitle(text);
      if (!addTitle.trim() && guessedTitle) {
        setAddTitle(guessedTitle);
      }
      setAddMarkdown(text);
      setToast({ kind: "ok", text: `✓ 已成功导入文件：${file.name}` });
    } catch (e) {
      setToast({ kind: "err", text: `读取文件失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const addArticle = async () => {
    if (addMarkdown.trim().length < 10) {
      setToast({ kind: "err", text: "正文太短（至少 10 字符）" });
      return;
    }
    try {
      const r = await api.addArticle(addTitle.trim(), addMarkdown);
      setShowAdd(false);
      setAddTitle("");
      setAddMarkdown("");
      await refreshArticles();
      setSelected(r.id);
      setToast({ kind: "ok", text: "✓ 已加入文章库" });
    } catch (e) {
      setToast({ kind: "err", text: `添加失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  // ---- 封面管理 ----
  // 点选封面库的图：关联到本篇
  const pickCover = async (name: string) => {
    if (!selected) return;
    try {
      await api.setArticleCover(selected, name);
      setCoverVersion((v) => v + 1);
      await refreshArticles();
      setToast({ kind: "ok", text: `✓ 已设为本篇封面：${name}` });
    } catch (e) {
      setToast({ kind: "err", text: `设置封面失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  // 开关切换本篇封面：已选则清除，未选则关联
  const toggleCover = async (name: string) => {
    if (!selected || !selectedArticle) return;
    const isCurrent = Boolean(selectedArticle.hasCover && selectedArticle.cover === name);
    if (isCurrent) {
      try {
        await api.removeArticleCover(selected);
        setCoverVersion((v) => v + 1);
        await refreshArticles();
        setToast({ kind: "ok", text: "✓ 已清除专属封面，将使用账号默认封面" });
      } catch (e) {
        setToast({ kind: "err", text: `取消封面失败：${e instanceof Error ? e.message : String(e)}` });
      }
    } else {
      await pickCover(name);
    }
  };

  // 重命名封面
  const startRenameCover = (name: string) => {
    setRenamingCover(name);
    setRenameDraft(name);
  };

  const cancelRenameCover = () => {
    setRenamingCover(null);
    setRenameDraft("");
  };

  const saveRenameCover = async (oldName: string) => {
    const trimmed = renameDraft.trim();
    if (!trimmed || trimmed === oldName) {
      cancelRenameCover();
      return;
    }
    setRenaming(true);
    try {
      const res = await api.renameCover(oldName, trimmed);
      await refreshCovers();
      await refreshArticles();
      setCoverVersion((v) => v + 1);
      setToast({ kind: "ok", text: `✓ 封面已重命名为：${res.name}` });
      cancelRenameCover();
    } catch (e) {
      setToast({ kind: "err", text: `重命名失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setRenaming(false);
    }
  };

  // 上传封面：直接归入本篇文件夹（同时进封面库供其他文章复用）
  const uploadCover = async (file: File | undefined) => {
    if (!file || !selected) return;
    try {
      await api.uploadArticleCover(selected, file.name, file);
      await refreshCovers();
      await refreshArticles();
      setCoverVersion((v) => v + 1);
      setToast({ kind: "ok", text: `✓ 封面已上传并归入本篇：${file.name}` });
    } catch (e) {
      setToast({ kind: "err", text: `上传封面失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const generateCover = async () => {
    if (!selected) return;
    setGenerating(true);
    try {
      // 一键模式：LLM 读文章内容自动设计画面；输入框留空即可，填了则作为补充要求
      const r = await api.autoCover(selected, coverPrompt.trim() || undefined);
      await refreshCovers();
      await refreshArticles();
      setCoverVersion((v) => v + 1);
      setCoverPrompt("");
      setToast({ kind: "ok", text: `✓ 封面已生成并归入本篇：${r.description}` });
    } catch (e) {
      setToast({ kind: "err", text: `生成失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setGenerating(false);
    }
  };

  // ---- 投递 ----
  const publish = async () => {
    if (!selected || !account || !title.trim()) return;
    setPublishing(true);
    setToast(null);
    try {
      const r = await api.publish(selected, title.trim(), account);
      setToast({ kind: "ok", text: `✓ 已投递到【${account}】草稿箱，media_id: ${r.mediaId}` });
      refreshDeliveries().catch(() => {});
      refreshArticles().catch(() => {});
    } catch (e) {
      setToast({ kind: "err", text: `投递失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setPublishing(false);
    }
  };

  const moveArticleToTrash = async (a: Article) => {
    if (!window.confirm(`将「${a.title}」移入回收站？文章内容仍会保留，可随时恢复。`)) return;
    try {
      await api.trashArticle(a.id);
      if (selected === a.id) setSelected(null);
      await refreshArticles();
      if (showTrash) await refreshTrash();
      setToast({ kind: "ok", text: "✓ 文章已移入回收站" });
    } catch (e) {
      setToast({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    }
  };

  const restoreFromTrash = async (a: TrashedArticle) => {
    try {
      await api.restoreTrashedArticle(a.id);
      await Promise.all([refreshArticles(), refreshTrash()]);
      setSelected(a.id);
      setToast({ kind: "ok", text: `✓「${a.title}」已恢复到文章库` });
    } catch (e) {
      setToast({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    }
  };

  const openTrash = async () => {
    setShowTrash(true);
    await refreshTrash();
  };

  return (
    <div className="app">
      <header className="topbar">
        <h1>内容生产台</h1>
        <span className="sub">选题 → 写作 → 排版 → 草稿箱</span>
        <span className={`badge ${llmReady === null ? "" : llmReady ? "ok" : "warn"}`}>
          {llmReady === null ? "检查中…" : llmReady ? "LLM 已配置" : "缺少 LLM API Key"}
        </span>
        <button className="btn ghost shrink" onClick={openSettings} title="API 配置">
          ⚙ 设置
        </button>
      </header>

      {showSettings && (
        <div className="modal-mask" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>API 配置</h3>
            <p className="hint">
              保存后写入项目 .env 并即时生效，无需重启。密钥字段留空表示保持不变。
            </p>
            {settings.map((s) => {
              const meta = SETTING_LABELS[s.key] ?? { label: s.key };
              // 非密钥字段直接回填当前值/默认值；密钥字段留空 = 保持不变
              const val = settingDraft[s.key] ?? (s.secret ? "" : s.value);
              return (
                <label className="field" key={s.key}>
                  <span className="label">
                    {meta.label}
                    <code className="keyname">{s.key}</code>
                    {s.set && <span className="setflag">已配置{s.secret ? ` ${s.value}` : ""}</span>}
                  </span>
                  {s.key === "IMAGE_COVER_PROMPT" ? (
                    <textarea
                      rows={5}
                      value={val}
                      onChange={(e) =>
                        setSettingDraft((prev) => ({ ...prev, [s.key]: e.target.value }))
                      }
                    />
                  ) : (
                    <input
                      type={s.secret ? "password" : "text"}
                      value={val}
                      onChange={(e) =>
                        setSettingDraft((prev) => ({ ...prev, [s.key]: e.target.value }))
                      }
                      placeholder={
                        s.secret && s.set ? "留空保持不变" : (meta.placeholder ?? "")
                      }
                    />
                  )}
                  {meta.hint && <span className="fieldhint">{meta.hint}</span>}
                </label>
              );
            })}
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn accent shrink" onClick={saveSettings} disabled={savingSettings}>
                {savingSettings ? "保存中…" : "保存"}
              </button>
              <button className="btn ghost shrink" onClick={() => setShowSettings(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {showTrash && (
        <div className="modal-mask" onClick={() => setShowTrash(false)}>
          <div className="modal trash-modal" onClick={(e) => e.stopPropagation()}>
            <div className="trash-modal-head">
              <div>
                <h3>🗑 回收站</h3>
                <p className="hint">移入回收站的文章不会被删除，恢复后会回到文章库。</p>
              </div>
              <button className="btn ghost shrink" onClick={() => setShowTrash(false)}>关闭</button>
            </div>
            {trashLoading ? (
              <p className="hint">读取中…</p>
            ) : trashArticles.length === 0 ? (
              <p className="hint trash-empty">回收站是空的。</p>
            ) : (
              <div className="trash-list">
                {trashArticles.map((a) => (
                  <div className="trash-item" key={a.id}>
                    <div className="trash-item-main">
                      <div className="lib-name">{a.title}</div>
                      <div className="lib-meta">
                        移入于 {new Date(a.trashedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })}
                        {" · "}
                        {(a.size / 1024).toFixed(1)} KB
                      </div>
                    </div>
                    <button className="btn ghost shrink" onClick={() => restoreFromTrash(a)}>恢复</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="layout">
        <section className="card">
          <h2>① 选题与素材</h2>
          <label className="field">
            <span className="label">选题</span>
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="例如：为什么 HTTPS 握手需要两次往返"
            />
          </label>

          <label className="field">
            <div className="label-row">
              <span className="label">素材笔记（和 AI 探讨的结论，可粘贴、上传或从素材库载入）</span>
              <div className="field-tools">
                <button
                  type="button"
                  className="btn ghost shrink"
                  onClick={() => setNotesExpanded((v) => !v)}
                  title="放大/还原输入框"
                >
                  {notesExpanded ? "⤡ 还原输入框" : "⤢ 放大输入框"}
                </button>
              </div>
            </div>
            <textarea
              className={notesExpanded ? "expanded" : ""}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="留空则凭模型自身知识写作；可在此粘贴探讨记录、核心要点或引用资料"
            />
          </label>

          <div className="row" style={{ marginBottom: 14 }}>
            <select value={pickedMaterial} onChange={(e) => setPickedMaterial(e.target.value)}>
              <option value="">从素材库载入…</option>
              {materials.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <button className="btn ghost shrink" onClick={loadMaterial} disabled={!pickedMaterial}>
              载入
            </button>
            <button
              className="btn ghost shrink"
              onClick={() => fileInputRef.current?.click()}
              title="上传 .md / .txt 笔记到素材库"
            >
              上传到素材库
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.txt,.markdown"
              style={{ display: "none" }}
              onChange={(e) => {
                uploadMaterial(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>

          <div className="row">
            <button className="btn block" onClick={startRun} disabled={phase === "running"}>
              {phase === "running" ? "生产中…" : "开始生产"}
            </button>
            {phase === "running" && (
              <button className="btn ghost shrink" onClick={cancelRun}>
                取消任务
              </button>
            )}
          </div>
          <p className="hint">产出会留底到 output/&lt;文章ID&gt;/ 文件夹，并出现在下方文章库。</p>

          {/* 嵌入式流水线日志 */}
          <div className="pipeline-logs-box">
            <div className="pipeline-logs-head">
              <span className="pipeline-logs-title">
                ② 流水线日志
                <span className={`pipeline-status-badge ${phase}`}>
                  {phase === "idle"
                    ? "空闲"
                    : phase === "running"
                      ? "● 生产中"
                      : phase === "done"
                        ? "✓ 已完成"
                        : phase === "degraded"
                          ? "⚠ 降级完成"
                          : phase === "cancelled"
                            ? "已取消"
                            : "✗ 运行错误"}
                </span>
              </span>
              <div className="pipeline-logs-actions">
                {logs.length > 0 && (
                  <button className="btn ghost shrink" onClick={() => setLogs([])} title="清空当前日志">
                    清空
                  </button>
                )}
                <button
                  className="btn ghost shrink"
                  onClick={() => setLogsCollapsed((v) => !v)}
                  title="折叠/展开日志面板"
                >
                  {logsCollapsed ? "▼ 展开日志" : "▲ 收起日志"}
                </button>
              </div>
            </div>
            <div className={`terminal ${logsCollapsed ? "collapsed" : ""}`} ref={termRef}>
              {logs.length === 0 ? (
                <span className="empty">等待任务…（点击上方「开始生产」后，日志会实时滚动在这里）</span>
              ) : (
                logs.map((l, i) => <div key={i}>{l}</div>)
              )}
            </div>
          </div>
        </section>
      </div>

      <section className="card result">
        <h2>
          <span>③ 文章库 · 预览与投递</span>
          <span className="article-library-actions">
            <button className="btn ghost shrink" onClick={openTrash}>
              🗑 回收站{trashArticles.length > 0 ? ` (${trashArticles.length})` : ""}
            </button>
            <button className="btn ghost shrink addbtn" onClick={() => setShowAdd((v) => !v)}>
              {showAdd ? "收起" : "＋ 手动添加文章"}
            </button>
          </span>
        </h2>

        {showAdd && (
          <div
            className={`addbox ${isDraggingFile ? "dragover" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDraggingFile(true);
            }}
            onDragLeave={() => setIsDraggingFile(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDraggingFile(false);
              const file = e.dataTransfer.files?.[0];
              if (file) handleImportFile(file);
            }}
          >
            <div
              className={`add-dropzone ${isDraggingFile ? "dragover" : ""}`}
              onClick={() => addFileInputRef.current?.click()}
            >
              <span className="dropzone-icon">📂</span>
              <span>点击选择或拖放本地 Markdown 文件 (.md / .txt) 到这里直接导入</span>
              <input
                ref={addFileInputRef}
                type="file"
                accept=".md,.txt,.markdown"
                style={{ display: "none" }}
                onChange={(e) => {
                  handleImportFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </div>
            <input
              type="text"
              value={addTitle}
              onChange={(e) => setAddTitle(e.target.value)}
              placeholder="文章标题（可留空，正文有一级标题则自动提取）"
            />
            <textarea
              value={addMarkdown}
              onChange={(e) => setAddMarkdown(e.target.value)}
              placeholder="粘贴或导入已经写好的 Markdown 正文，支持 ![](图片链接)"
            />
            <div className="row">
              <button className="btn accent shrink" onClick={addArticle}>
                加入文章库
              </button>
              <span className="hint">会创建独立文件夹并自动排版，readme.log 记录来源为「手动添加」。</span>
            </div>
          </div>
        )}

        {articles.length === 0 ? (
          <p className="hint">还没有文章。先在上方跑一次流水线，或点「手动添加文章」。回收站中的文章可恢复。</p>
        ) : (
          <div className="library">
            <div className="lib-list">
              {articles.map((a) => (
                <div
                  key={a.id}
                  className={`lib-item ${selected === a.id ? "active" : ""}`}
                  onClick={() => setSelected(a.id)}
                >
                  <div className="lib-name">
                    {a.hasCover && <span title="本篇已有封面">🖼 </span>}
                    {a.title}
                  </div>
                  <div className="lib-meta">
                    {new Date(a.mtime).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    {" · "}
                    {(a.size / 1024).toFixed(1)} KB{a.hasHtml ? "" : " · 无HTML"}
                    {deliveryMap.has(a.id) && (
                      <span className="lib-delivered">
                        已投递 {deliveryMap.get(a.id)!.account} ·{" "}
                        {new Date(deliveryMap.get(a.id)!.at).toLocaleString("zh-CN", {
                          month: "numeric",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </span>
                    )}
                  </div>
                  <button
                    className="lib-del"
                    title="移入回收站"
                    onClick={(e) => {
                      e.stopPropagation();
                      moveArticleToTrash(a);
                    }}
                  >
                    🗑
                  </button>
                </div>
              ))}
            </div>

            <div className="lib-detail">
              {selectedArticle ? (
                <>
                  <div className="article-detail-toolbar">
                    <div>
                      <div className="article-detail-title">{selectedArticle.title}</div>
                      <div className="hint">基于当前正文与提示词生成一个完整的新版本，采纳后才会写回文章库。</div>
                    </div>
                    <button
                      type="button"
                      className="btn accent shrink article-regenerate-trigger"
                      onClick={openArticleRegenerator}
                      disabled={!mdContent.trim()}
                    >
                      ✨ 重新生成文章
                    </button>
                  </div>
                  <div className="tabs">
                    <button
                      className={tab === "html" ? "active" : ""}
                      onClick={() => setTab("html")}
                      disabled={!selectedArticle.hasHtml}
                    >
                      排版预览（公众号效果）
                    </button>
                    <button className={tab === "md" ? "active" : ""} onClick={() => setTab("md")}>
                      Markdown 原文
                    </button>
                    <button className={tab === "edit" ? "active" : ""} onClick={enterEdit}>
                      ✏️ 编辑
                    </button>
                    <button className={tab === "log" ? "active" : ""} onClick={() => setTab("log")}>
                      产出日志
                    </button>
                  </div>

                  {tab === "html" && selectedArticle.hasHtml && (
                    <iframe
                      className="preview-html"
                      src={api.articleHtmlUrl(selectedArticle.id)}
                      title="排版预览"
                    />
                  )}
                  {tab === "md" && <div className="preview-md">{mdContent}</div>}
                  {tab === "log" && <div className="preview-md logview">{logContent}</div>}
                  {tab === "edit" && (
                    <div className="editbox">
                      <div className="editbox-head">
                        <span className="editbox-tip">
                          💡 提示：用鼠标在正文中选中任意段落或语句，即可点击右侧「✨ AI 对话重写」
                        </span>
                        <div className="editbox-head-right">
                          {selectionInfo && (
                            <span className="editbox-selection-indicator">
                              已选 <span className="highlight-count">{selectionInfo.text.trim().length}</span> 字
                            </span>
                          )}
                          <button
                            type="button"
                            className="btn ghost shrink mini-btn ai-history-top-btn"
                            onClick={openAiHistory}
                            title="查看本篇文章的历史 AI 编辑与重写记录"
                          >
                            📜 历史对话记录 {aiHistorySessions.length > 0 ? `(${aiHistorySessions.length})` : ""}
                          </button>
                        </div>
                      </div>
                      <textarea
                        ref={editRef}
                        value={editDraft}
                        onChange={(e) => {
                          setEditDraft(e.target.value);
                          setTimeout(handleSelectionChange, 0);
                        }}
                        onSelect={handleSelectionChange}
                        onClick={handleSelectionChange}
                        onKeyUp={handleSelectionChange}
                        onMouseUp={handleSelectionChange}
                        spellCheck={false}
                      />
                      <div className="row">
                        <button className="btn accent shrink" onClick={saveEdit} disabled={saving}>
                          {saving ? "保存中…" : "保存（自动重新排版 + 写日志）"}
                        </button>
                        <button className="btn ghost shrink" onClick={() => setTab("html")}>
                          取消
                        </button>
                        <button
                          type="button"
                          className={`btn shrink ai-edit-trigger ${selectionInfo ? "active" : ""}`}
                          onClick={() => openAiEditor()}
                          title={
                            selectionInfo
                              ? `点击与 AI 对话重写已选中的 ${selectionInfo.text.trim().length} 个字`
                              : "用鼠标在上方选中文本片段后，点击与 AI 对话重写"
                          }
                        >
                          ✨ AI 对话重写 {selectionInfo ? `(${selectionInfo.text.trim().length}字)` : ""}
                        </button>
                        <button
                          className="btn ghost shrink"
                          onClick={() => imgInputRef.current?.click()}
                          title="上传图片到本篇 images/ 并在光标处插入引用"
                        >
                          🖼 插入图片
                        </button>
                        <input
                          ref={imgInputRef}
                          type="file"
                          accept=".png,.jpg,.jpeg,.webp,.gif"
                          style={{ display: "none" }}
                          onChange={(e) => {
                            insertImage(e.target.files?.[0]);
                            e.target.value = "";
                          }}
                        />
                        <span className="hint">插图在投递时会自动上传到微信图床</span>
                      </div>
                    </div>
                  )}

                  {/* AI 片段编辑与重写浮动抽屉 */}
                  {aiEditOpen && (
                    <div className="ai-edit-drawer-overlay" onClick={closeAiEditor}>
                      <div className="ai-edit-drawer" onClick={(e) => e.stopPropagation()}>
                        <div className="ai-drawer-header">
                          <div className="ai-drawer-title-group">
                            <div className="ai-drawer-title">
                              <span className="ai-drawer-icon">🤖</span>
                              <span>AI 片段编辑与重写</span>
                            </div>
                            <div className="ai-drawer-nav-tabs">
                              <button
                                type="button"
                                className={`ai-nav-tab ${aiDrawerTab === "current" ? "active" : ""}`}
                                onClick={() => setAiDrawerTab("current")}
                              >
                                💬 当前编辑 {selectionInfo ? `(${selectionInfo.text.trim().length}字)` : ""}
                              </button>
                              <button
                                type="button"
                                className={`ai-nav-tab ${aiDrawerTab === "history" ? "active" : ""}`}
                                onClick={() => setAiDrawerTab("history")}
                              >
                                📜 历史会话 {aiHistorySessions.length > 0 ? `(${aiHistorySessions.length})` : ""}
                              </button>
                            </div>
                          </div>
                          <div className="ai-drawer-actions">
                            {aiDrawerTab === "current" && aiChatList.length > 0 && (
                              <button className="btn ghost shrink mini-btn" onClick={clearAiChat} title="开启全新会话">
                                新建会话
                              </button>
                            )}
                            <button className="btn ghost shrink mini-btn" onClick={closeAiEditor} title="关闭面板">
                              ✕
                            </button>
                          </div>
                        </div>

                        {aiDrawerTab === "history" ? (
                          /* 历史会话持久化列表视图 */
                          <div className="ai-history-body">
                            {aiHistorySessions.length === 0 ? (
                              <div className="ai-chat-empty">
                                <div className="ai-empty-icon">📜</div>
                                <div className="ai-empty-title">暂无历史编辑记录</div>
                                <div className="ai-empty-desc">
                                  在当前会话中与 AI 对话或采纳重写后，修改记录与思路会自动持久化归档在这里。
                                </div>
                              </div>
                            ) : (
                              aiHistorySessions.map((session) => {
                                const isExpanded = historyExpandedMap[session.id] ?? true;
                                return (
                                  <div key={session.id} className="ai-history-card">
                                    <div
                                      className="ai-history-head"
                                      onClick={() => toggleHistorySession(session.id)}
                                      style={{ cursor: "pointer" }}
                                    >
                                      <div className="ai-history-meta">
                                        <span className={`ai-history-badge ${session.applied ? "applied" : "explore"}`}>
                                          {session.applied ? "✓ 已采纳" : "💬 仅探讨"}
                                        </span>
                                        <span className="ai-history-time">
                                          {new Date(session.createdAt).toLocaleString("zh-CN", {
                                            month: "numeric",
                                            day: "numeric",
                                            hour: "numeric",
                                            minute: "2-digit",
                                          })}
                                        </span>
                                        {session.originalSnippet && (
                                          <span className="ai-history-snip-tag">
                                            {session.originalSnippet.slice(0, 18)}...
                                          </span>
                                        )}
                                      </div>
                                      <button type="button" className="btn ghost shrink mini-btn">
                                        {isExpanded ? "▲ 收起" : "▼ 展开"}
                                      </button>
                                    </div>

                                    {isExpanded && (
                                      <div className="ai-history-content">
                                        {session.originalSnippet && (
                                          <div className="ai-history-orig-box">
                                            <div className="orig-title">📌 针对原文片段：</div>
                                            <div className="orig-text">{session.originalSnippet}</div>
                                          </div>
                                        )}

                                        <div className="ai-history-msgs">
                                          {session.messages.map((m, idx) => (
                                            <div key={m.id || idx} className={`ai-history-msg ${m.role}`}>
                                              {m.role === "user" ? (
                                                <div className="hist-user-prompt">
                                                  <span className="hist-label">🗣️ 诉求：</span>
                                                  <span>{m.content}</span>
                                                </div>
                                              ) : (
                                                <div className="hist-assistant-box">
                                                  {m.explanation && (
                                                    <div className="ai-explanation-box hist-exp">
                                                      💡 <strong>修改思路</strong>：{m.explanation}
                                                    </div>
                                                  )}
                                                  {m.rewrittenText && (
                                                    <div className="ai-rewrite-result">
                                                      <div className="ai-result-head">
                                                        <div className="ai-view-tabs">
                                                          <button
                                                            type="button"
                                                            className={`ai-view-tab ${(historyViewModeMap[`${session.id}-${m.id}`] ?? "result") === "result" ? "active" : ""}`}
                                                            onClick={(e) => {
                                                              e.stopPropagation();
                                                              setHistoryItemViewMode(`${session.id}-${m.id}`, "result");
                                                            }}
                                                          >
                                                            📝 重写正文
                                                          </button>
                                                          <button
                                                            type="button"
                                                            className={`ai-view-tab ${historyViewModeMap[`${session.id}-${m.id}`] === "diff" ? "active" : ""}`}
                                                            onClick={(e) => {
                                                              e.stopPropagation();
                                                              setHistoryItemViewMode(`${session.id}-${m.id}`, "diff");
                                                            }}
                                                          >
                                                            🔍 差异对比
                                                          </button>
                                                        </div>
                                                        <div className="ai-result-tools">
                                                          <button
                                                            type="button"
                                                            className="btn ghost shrink mini-btn"
                                                            onClick={(e) => {
                                                              e.stopPropagation();
                                                              navigator.clipboard?.writeText(m.rewrittenText!);
                                                              setToast({ kind: "ok", text: "✓ 已复制重写内容到剪贴板" });
                                                            }}
                                                          >
                                                            📋 复制
                                                          </button>
                                                        </div>
                                                      </div>

                                                      {historyViewModeMap[`${session.id}-${m.id}`] === "diff" &&
                                                      (m.originalText || session.originalSnippet) ? (
                                                        <div className="diff-view ai-diff-view">
                                                          {buildDiff(
                                                            m.originalText || session.originalSnippet,
                                                            m.rewrittenText,
                                                          ).map((line, index) => (
                                                            <div key={`${index}-${line.kind}`} className={`diff-line ${line.kind}`}>
                                                              <span className="diff-mark">
                                                                {line.kind === "remove" ? "−" : line.kind === "add" ? "+" : line.kind === "notice" ? "!" : " "}
                                                              </span>
                                                              <span>{line.text || " "}</span>
                                                            </div>
                                                          ))}
                                                        </div>
                                                      ) : (
                                                        <div className="ai-result-content">
                                                          {m.rewrittenText}
                                                        </div>
                                                      )}

                                                      <div className="ai-result-footer">
                                                        <button
                                                          type="button"
                                                          className="btn accent shrink apply-btn"
                                                          onClick={(e) => {
                                                            e.stopPropagation();
                                                            applyAiRewrite(
                                                              m.rewrittenText!,
                                                              m.originalText || session.originalSnippet,
                                                              m.id,
                                                            );
                                                          }}
                                                        >
                                                          🔄 采纳此历史版本
                                                        </button>
                                                      </div>
                                                    </div>
                                                  )}
                                                </div>
                                              )}
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                );
                              })
                            )}
                          </div>
                        ) : (
                          /* 当前编辑对话视图 */
                          <>
                            {/* 锁定选区预览卡片（支持展开/折叠） */}
                            <div className="ai-selected-card">
                              <div
                                className="ai-selected-head"
                                onClick={() => setAiSelectedExpanded((v) => !v)}
                                style={{ cursor: "pointer", userSelect: "none" }}
                                title="点击展开/收起原文"
                              >
                                <div className="ai-selected-title">
                                  <span>📌 选中的原文片段</span>
                                  {selectionInfo && (
                                    <span className="ai-selection-badge">{selectionInfo.text.trim().length} 字</span>
                                  )}
                                </div>
                                <button type="button" className="btn ghost shrink mini-btn">
                                  {aiSelectedExpanded ? "▲ 收起" : "▼ 展开查看"}
                                </button>
                              </div>
                              {aiSelectedExpanded ? (
                                <div className="ai-selected-snippet">
                                  {selectionInfo?.text || "（未选中文本，请先在左侧编辑框选定）"}
                                </div>
                              ) : (
                                <div className="ai-selected-collapsed-hint">
                                  {selectionInfo?.text
                                    ? (selectionInfo.text.trim().slice(0, 46) + (selectionInfo.text.trim().length > 46 ? "..." : ""))
                                    : "（未选中文本）"}
                                </div>
                              )}
                            </div>

                            {/* 对话与重写历史列表 */}
                            <div className="ai-chat-body">
                              {aiChatList.length === 0 ? (
                                <div className="ai-chat-empty">
                                  <div className="ai-empty-icon">💬</div>
                                  <div className="ai-empty-title">在下方表达您的修改想法</div>
                                  <div className="ai-empty-desc">
                                    您可以自由描述意图，或直接点击下方快捷标签，AI 会结合整篇文章语境重写选中的片段。
                                  </div>
                                </div>
                              ) : (
                                aiChatList.map((item) => (
                                  <div key={item.id} className={`ai-chat-bubble-wrap ${item.role}`}>
                                    {item.role === "user" ? (
                                      <div className="ai-user-bubble">
                                        <div className="bubble-label">我的想法</div>
                                        <div className="bubble-text">{item.content}</div>
                                      </div>
                                    ) : (
                                      <div className="ai-assistant-bubble">
                                        <div className="bubble-label">
                                          <span>✨ AI 重写建议</span>
                                          {item.applied && <span className="applied-tag">✓ 已生效到正文</span>}
                                        </div>

                                        {item.explanation && (
                                          <div className="ai-explanation-box">
                                            💡 <strong>修改思路</strong>：{item.explanation}
                                          </div>
                                        )}

                                        {item.rewrittenText && (
                                          <div className="ai-rewrite-result">
                                            <div className="ai-result-head">
                                              <div className="ai-view-tabs">
                                                <button
                                                  type="button"
                                                  className={`ai-view-tab ${(item.viewMode ?? "result") === "result" ? "active" : ""}`}
                                                  onClick={() => setChatViewMode(item.id, "result")}
                                                >
                                                  📝 重写正文
                                                </button>
                                                <button
                                                  type="button"
                                                  className={`ai-view-tab ${item.viewMode === "diff" ? "active" : ""}`}
                                                  onClick={() => setChatViewMode(item.id, "diff")}
                                                >
                                                  🔍 差异对比 (Diff)
                                                </button>
                                              </div>
                                              <div className="ai-result-tools">
                                                <button
                                                  type="button"
                                                  className="btn ghost shrink mini-btn"
                                                  onClick={() => {
                                                    navigator.clipboard?.writeText(item.rewrittenText!);
                                                    setToast({ kind: "ok", text: "✓ 已复制重写内容到剪贴板" });
                                                  }}
                                                >
                                                  📋 复制
                                                </button>
                                              </div>
                                            </div>

                                            {/* 互斥展示：Diff 与纯文本二选一，绝不重复堆叠 */}
                                            {item.viewMode === "diff" && item.originalText ? (
                                              <div className="diff-view ai-diff-view">
                                                {buildDiff(item.originalText, item.rewrittenText).map((line, index) => (
                                                  <div key={`${index}-${line.kind}`} className={`diff-line ${line.kind}`}>
                                                    <span className="diff-mark">
                                                      {line.kind === "remove" ? "−" : line.kind === "add" ? "+" : line.kind === "notice" ? "!" : " "}
                                                    </span>
                                                    <span>{line.text || " "}</span>
                                                  </div>
                                                ))}
                                              </div>
                                            ) : (
                                              <div className="ai-result-content">
                                                {item.rewrittenText}
                                              </div>
                                            )}

                                            <div className="ai-result-footer">
                                              <button
                                                type="button"
                                                className={`btn accent shrink apply-btn ${item.applied ? "applied" : ""}`}
                                                onClick={() => applyAiRewrite(item.rewrittenText!, item.originalText, item.id)}
                                              >
                                                {item.applied ? "✓ 已生效（再次采纳）" : "✓ 采纳并生效全篇"}
                                              </button>
                                            </div>
                                          </div>
                                        )}

                                        {!item.rewrittenText && (
                                          <div className="bubble-text">{item.content}</div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                ))
                              )}
                              {aiLoading && (
                                <div className="ai-chat-bubble-wrap assistant">
                                  <div className="ai-assistant-bubble loading-bubble">
                                    <span className="spinner" />
                                    <span>AI 正在结合文章上下文深入构思并重写中…</span>
                                  </div>
                                </div>
                              )}
                              <div ref={aiChatEndRef} />
                            </div>

                            {/* 快捷预设提示词标签 */}
                            <div className="ai-preset-tags">
                              <span className="preset-label">快捷修改：</span>
                              {AI_PRESET_TAGS.map((tag) => (
                                <button
                                  key={tag.label}
                                  type="button"
                                  className="ai-tag-btn"
                                  onClick={() => sendAiEdit(tag.prompt)}
                                  disabled={aiLoading || !selectionInfo?.text}
                                  title={tag.prompt}
                                >
                                  {tag.label}
                                </button>
                              ))}
                            </div>

                            {/* 底部输入框 */}
                            <div className="ai-drawer-footer">
                              <div className="ai-footer-toolbar">
                                <div className="ai-tier-selector">
                                  <label className={`tier-option ${aiTier === "flash" ? "active" : ""}`}>
                                    <input
                                      type="radio"
                                      name="aiTier"
                                      value="flash"
                                      checked={aiTier === "flash"}
                                      onChange={() => setAiTier("flash")}
                                    />
                                    极速模型 (Flash)
                                  </label>
                                  <label className={`tier-option ${aiTier === "pro" ? "active" : ""}`}>
                                    <input
                                      type="radio"
                                      name="aiTier"
                                      value="pro"
                                      checked={aiTier === "pro"}
                                      onChange={() => setAiTier("pro")}
                                    />
                                    深度写作 (Pro)
                                  </label>
                                </div>
                                <span className="hint">Enter 发送 · Shift+Enter 换行</span>
                              </div>

                              <div className="ai-input-row">
                                <textarea
                                  ref={aiInputRef}
                                  className="ai-instruction-input"
                                  rows={2}
                                  value={aiInstruction}
                                  onChange={(e) => setAiInstruction(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && !e.shiftKey) {
                                      e.preventDefault();
                                      sendAiEdit();
                                    }
                                  }}
                                  placeholder="表达您的想法（如：这段说得太生硬了，用更幽默形象的口吻重写，并加个比喻）..."
                                  disabled={aiLoading}
                                />
                                <button
                                  type="button"
                                  className="btn accent shrink ai-send-btn"
                                  onClick={() => sendAiEdit()}
                                  disabled={aiLoading || !aiInstruction.trim() || !selectionInfo?.text}
                                >
                                  {aiLoading ? "重写中…" : "发送想法"}
                                </button>
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  )}

                  {articleRegenerateOpen && (
                    <div className="article-regenerate-overlay" onClick={() => setArticleRegenerateOpen(false)}>
                      <div className="article-regenerate-drawer" onClick={(e) => e.stopPropagation()}>
                        <div className="article-regenerate-header">
                          <div>
                            <div className="article-regenerate-title">🤖 AI 重新生成文章</div>
                            <div className="hint">围绕当前文章连续对话，逐步调整结构、语气、受众或篇幅。</div>
                          </div>
                          <div className="article-regenerate-header-actions">
                            {articleRegenerateChat.length > 0 && (
                              <button
                                type="button"
                                className="btn ghost shrink mini-btn"
                                onClick={() => setArticleRegenerateChat([])}
                              >
                                新建会话
                              </button>
                            )}
                            <button type="button" className="btn ghost shrink mini-btn" onClick={() => setArticleRegenerateOpen(false)}>
                              ✕
                            </button>
                          </div>
                        </div>

                        <div className="article-regenerate-source">
                          <div className="article-regenerate-source-label">原始上下文（重新生成会一并参考）</div>
                          <div className="article-regenerate-source-topic">选题：{articleRegenerateSource?.topic}</div>
                          {articleRegenerateSource?.sourceNotes && (
                            <div className="article-regenerate-source-notes">
                              素材笔记：{articleRegenerateSource.sourceNotes}
                            </div>
                          )}
                          <div className="article-regenerate-source-title">{articleRegenerateSource?.title}</div>
                          <div className="article-regenerate-source-text">{articleRegenerateSource?.article}</div>
                        </div>

                        <div className="article-regenerate-chat">
                          {articleRegenerateChat.length === 0 ? (
                            <div className="article-regenerate-empty">
                              <div className="ai-empty-icon">✍️</div>
                              <div className="ai-empty-title">告诉 AI 你想怎么改整篇文章</div>
                              <div className="ai-empty-desc">例如：保留观点，改成面向职场新人的口吻，并把开头写得更有冲击力。</div>
                            </div>
                          ) : (
                            articleRegenerateChat.map((item) => (
                              <div key={item.id} className={`article-regenerate-message ${item.role}`}>
                                {item.role === "user" ? (
                                  <div className="ai-user-bubble">
                                    <div className="bubble-label">我的要求</div>
                                    <div className="bubble-text">{item.content}</div>
                                  </div>
                                ) : (
                                  <div className="article-regenerate-result">
                                    <div className="bubble-label">✨ AI 完整文章版本</div>
                                    {item.article ? (
                                      <>
                                        <div className="article-regenerate-result-title">{item.title}</div>
                                        {item.explanation && <div className="ai-explanation-box">💡 {item.explanation}</div>}
                                        <div className="ai-view-tabs article-regenerate-view-tabs">
                                          <button type="button" className={`ai-view-tab ${(item.viewMode ?? "result") === "result" ? "active" : ""}`} onClick={() => setArticleRegenerateViewMode(item.id, "result")}>📝 新版本正文</button>
                                          <button type="button" className={`ai-view-tab ${item.viewMode === "diff" ? "active" : ""}`} onClick={() => setArticleRegenerateViewMode(item.id, "diff")}>🔍 与当前版本差异</button>
                                        </div>
                                        {(item.viewMode ?? "result") === "diff" ? (
                                          <div className="article-regenerate-result-diff">
                                            {buildDiff(item.originalArticle ?? articleRegenerateSource?.article ?? "", item.article).map((line, index) => (
                                              <div key={`${index}-${line.kind}`} className={`diff-line ${line.kind}`}>
                                                <span className="diff-mark">{line.kind === "remove" ? "−" : line.kind === "add" ? "+" : line.kind === "notice" ? "!" : " "}</span>
                                                <span>{line.text || " "}</span>
                                              </div>
                                            ))}
                                          </div>
                                        ) : (
                                          <div className="article-regenerate-result-body">{item.article}</div>
                                        )}
                                        <div className="article-regenerate-result-actions">
                                          <button
                                            type="button"
                                            className="btn ghost shrink mini-btn"
                                            onClick={() => navigator.clipboard?.writeText(item.article!)}
                                          >
                                            📋 复制正文
                                          </button>
                                          <button
                                            type="button"
                                            className="btn accent shrink"
                                            onClick={() => applyArticleRegeneration(item)}
                                            disabled={applyingArticleRegenerate}
                                          >
                                            {applyingArticleRegenerate ? "保存中…" : "✓ 采纳并保存为新版本"}
                                          </button>
                                        </div>
                                      </>
                                    ) : (
                                      <div className="bubble-text">{item.content}</div>
                                    )}
                                  </div>
                                )}
                              </div>
                            ))
                          )}
                          {articleRegenerateLoading && (
                            <div className="article-regenerate-message assistant">
                              <div className="article-regenerate-result loading-bubble"><span className="spinner" />AI 正在重新组织整篇文章…</div>
                            </div>
                          )}
                          <div ref={articleRegenerateEndRef} />
                        </div>

                        <div className="article-regenerate-presets">
                          {[
                            "保留核心观点，改得更口语、更像朋友聊天",
                            "重写开头和小标题，让文章更有吸引力",
                            "压缩篇幅，删掉重复内容，保留关键信息",
                          ].map((preset) => (
                            <button
                              type="button"
                              className="ai-tag-btn"
                              key={preset}
                              onClick={() => sendArticleRegeneration(preset)}
                              disabled={articleRegenerateLoading}
                            >
                              {preset}
                            </button>
                          ))}
                        </div>
                        <div className="article-regenerate-footer">
                          <div className="ai-footer-toolbar">
                            <div className="ai-tier-selector">
                              <label className={`tier-option ${articleRegenerateTier === "flash" ? "active" : ""}`}>
                                <input type="radio" name="articleRegenerateTier" checked={articleRegenerateTier === "flash"} onChange={() => setArticleRegenerateTier("flash")} />
                                极速模型 (Flash)
                              </label>
                              <label className={`tier-option ${articleRegenerateTier === "pro" ? "active" : ""}`}>
                                <input type="radio" name="articleRegenerateTier" checked={articleRegenerateTier === "pro"} onChange={() => setArticleRegenerateTier("pro")} />
                                深度写作 (Pro)
                              </label>
                            </div>
                            <span className="hint">Enter 发送 · Shift+Enter 换行</span>
                          </div>
                          <div className="ai-input-row">
                            <textarea
                              ref={articleRegenerateInputRef}
                              className="ai-instruction-input"
                              rows={2}
                              value={articleRegenerateInstruction}
                              onChange={(e) => setArticleRegenerateInstruction(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) {
                                  e.preventDefault();
                                  sendArticleRegeneration();
                                }
                              }}
                              placeholder="输入整篇文章的修改要求，例如：增加一个真实案例，结尾给出行动建议…"
                              disabled={articleRegenerateLoading}
                            />
                            <button type="button" className="btn accent shrink ai-send-btn" onClick={() => sendArticleRegeneration()} disabled={articleRegenerateLoading || !articleRegenerateInstruction.trim()}>
                              {articleRegenerateLoading ? "生成中…" : "发送提示词"}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="versions-panel">
                    <div className="versions-heading">
                      <span>版本管理</span>
                      <span className="hint">保存编辑会自动保留修改前正文</span>
                    </div>
                    {versions.length === 0 ? (
                      <p className="hint version-empty">暂无历史版本。第一次编辑并保存后会出现版本记录。</p>
                    ) : (
                      <div className="versions-layout">
                        <div className="version-list">
                          {versions.map((version) => (
                            <div
                              key={version.id}
                              className={`version-item ${versionPreview?.id === version.id ? "active" : ""}`}
                            >
                              <div>
                                <div className="version-date">
                                  {new Date(version.createdAt).toLocaleString("zh-CN")}
                                </div>
                                <div className="version-id">{version.id}</div>
                              </div>
                              <div className="version-actions">
                                <button
                                  className="btn ghost shrink"
                                  onClick={() => previewVersion(version)}
                                  disabled={loadingVersion === version.id || restoringVersion !== null}
                                >
                                  {loadingVersion === version.id ? "读取中…" : "比较"}
                                </button>
                                <button
                                  className="btn ghost shrink"
                                  onClick={() => restoreVersion(version)}
                                  disabled={restoringVersion !== null || loadingVersion !== null}
                                >
                                  {restoringVersion === version.id ? "回滚中…" : "回滚"}
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                        {versionPreview && (
                          <div className="version-compare">
                            <div className="version-compare-head">
                              <span>与当前正文的差异</span>
                              <span className="hint">- 旧版本　+ 当前正文</span>
                            </div>
                            <div className="diff-view">
                              {buildDiff(versionPreview.markdown, mdContent).map((line, index) => (
                                <div key={`${index}-${line.kind}`} className={`diff-line ${line.kind}`}>
                                  <span className="diff-mark">
                                    {line.kind === "remove" ? "−" : line.kind === "add" ? "+" : line.kind === "notice" ? "!" : " "}
                                  </span>
                                  <span>{line.text || " "}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="publishbar">
                    <input
                      type="text"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      onBlur={handleTitleBlur}
                      placeholder="文章标题"
                    />
                    <select
                      value={account}
                      onChange={(e) => setAccount(e.target.value)}
                    >
                      {accounts.length === 0 && <option value="">未配置账号</option>}
                      {accounts.map((a) => (
                        <option key={a.name} value={a.name} disabled={!a.configured}>
                          {a.name}
                          {a.configured ? "" : "（配置不完整）"}
                        </option>
                      ))}
                    </select>
                    <button
                      className="btn accent shrink"
                      onClick={publish}
                      disabled={publishing || !account || !title.trim()}
                    >
                      {publishing ? "投递中…" : "确认投递草稿箱"}
                    </button>
                  </div>

                  {/* 封面库管理面板（大图预览卡片、列表展示、Switch 开关、重命名与生图进度条） */}
                  <div className="covers-panel">
                    <div className="covers-panel-head">
                      <div className="covers-panel-title">
                        <span>🖼 文章封面管理</span>
                      </div>
                      <button
                        className="btn ghost shrink"
                        onClick={() => setShowCoverList((v) => !v)}
                      >
                        {showCoverList ? "▲ 收起封面库" : `▼ 展开封面库 (${covers.length})`}
                      </button>
                    </div>

                    {/* 当前生效封面展示卡片（直观显示封面图与状态） */}
                    {selectedArticle.hasCover ? (
                      <div className="current-cover-card has-cover">
                        <img
                          src={`${api.articleCoverUrl(selectedArticle.id)}?v=${coverVersion}`}
                          alt="当前专属封面"
                          className="current-cover-preview"
                          title="点击放大预览"
                          onClick={() =>
                            setZoom({
                              src: `${api.articleCoverUrl(selectedArticle.id)}?v=${coverVersion}`,
                              name: selectedArticle.cover,
                            })
                          }
                        />
                        <div className="current-cover-meta">
                          <div className="current-cover-title ok">
                            <span>✓ 已设置本篇专属封面</span>
                            {selectedArticle.cover && (
                              <span className="keyname">（{selectedArticle.cover}）</span>
                            )}
                          </div>
                          <div className="current-cover-sub">
                            已保存至本篇专属目录，投递微信公众号草稿箱时将优先使用此封面。
                          </div>
                          <div className="current-cover-actions">
                            <button
                              type="button"
                              className="btn ghost shrink"
                              onClick={() =>
                                setZoom({
                                  src: `${api.articleCoverUrl(selectedArticle.id)}?v=${coverVersion}`,
                                  name: selectedArticle.cover,
                                })
                              }
                            >
                              🔍 放大查看
                            </button>
                            <button
                              type="button"
                              className="btn ghost shrink"
                              onClick={() => selectedArticle.cover && toggleCover(selectedArticle.cover)}
                            >
                              🗑 清除专属封面
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="current-cover-card">
                        <div className="current-cover-placeholder">🖼 默认封面</div>
                        <div className="current-cover-meta">
                          <div className="current-cover-title">
                            <span>当前未设置本篇专属封面</span>
                          </div>
                          <div className="current-cover-sub">
                            投递时将自动使用账号默认封面：
                            <strong> {accounts.find((a) => a.name === account)?.cover ?? "未配置"}</strong>
                          </div>
                          <div className="current-cover-sub" style={{ color: "var(--ink-3)" }}>
                            可在下方封面库中开启 Switch 选用，或点击下方按钮上传/生成专属封面。
                          </div>
                        </div>
                      </div>
                    )}

                    {/* AI 生图动态进度条效果 */}
                    {coverProgress && (
                      <div className="cover-progress-box">
                        <div className="cover-progress-head">
                          <div className="cover-progress-title">
                            <span>{coverProgress.title}</span>
                            <span className="cover-progress-step">
                              环节 {coverProgress.step}/{coverProgress.total}
                            </span>
                          </div>
                          <span className="cover-progress-percent">{coverProgress.percent}%</span>
                        </div>
                        <div className="cover-progress-track">
                          <div
                            className="cover-progress-fill"
                            style={{ width: `${coverProgress.percent}%` }}
                          />
                        </div>
                        <div className="cover-progress-hint">{coverProgress.hint}</div>
                      </div>
                    )}

                    {/* 封面库操作工具条 */}
                    <div className="coverbar tools">
                      <button
                        className="btn ghost shrink"
                        onClick={() => coverInputRef.current?.click()}
                        title="上传图片作为本篇封面（同时存入封面库供复用）"
                      >
                        上传新封面
                      </button>
                      <input
                        ref={coverInputRef}
                        type="file"
                        accept=".png,.jpg,.jpeg,.webp"
                        style={{ display: "none" }}
                        onChange={(e) => {
                          uploadCover(e.target.files?.[0]);
                          e.target.value = "";
                        }}
                      />
                      <input
                        type="text"
                        className="cover-prompt"
                        value={coverPrompt}
                        onChange={(e) => setCoverPrompt(e.target.value)}
                        placeholder={
                          imageGen.ready
                            ? "可选：补充画面要求（如「极简科技风」），留空则由 AI 读完文章自动构思"
                            : "AI 生图未配置：点右上角「⚙ 设置」填 IMAGE_API_KEY"
                        }
                        disabled={!imageGen.ready || generating}
                      />
                      <button
                        className="btn ghost shrink"
                        onClick={generateCover}
                        disabled={!imageGen.ready || generating}
                        title="LLM 总结文章内容 → 决定画面 → 调用生图模型，一键完成"
                      >
                        {generating ? "AI 生成中…" : "✨ AI 生成封面"}
                      </button>
                    </div>

                    {/* 封面库列表形式展示 */}
                    {showCoverList && (
                      <div className="covers-list-container" style={{ marginTop: 10 }}>
                        {covers.length === 0 ? (
                          <div style={{ padding: 14, textAlign: "center", color: "var(--ink-3)", fontSize: 12 }}>
                            封面库暂无图片，可点击上方「上传新封面」或「✨ AI 生成封面」。
                          </div>
                        ) : (
                          covers.map((c) => {
                            const isCurrentCover = Boolean(
                              selectedArticle.hasCover && selectedArticle.cover === c,
                            );
                            const isRenamingThis = renamingCover === c;
                            return (
                              <div
                                key={c}
                                className={`cover-list-item ${isCurrentCover ? "selected" : ""}`}
                              >
                                <div className="cover-item-left">
                                  <img
                                    src={api.coverUrl(c)}
                                    alt={c}
                                    className="cover-item-thumb"
                                    title="点击放大预览"
                                    onClick={() => setZoom({ src: api.coverUrl(c), name: c })}
                                  />
                                  <div className="cover-item-info">
                                    {isRenamingThis ? (
                                      <div className="cover-rename-form" onClick={(e) => e.stopPropagation()}>
                                        <input
                                          type="text"
                                          value={renameDraft}
                                          onChange={(e) => setRenameDraft(e.target.value)}
                                          onKeyDown={(e) => {
                                            if (e.key === "Enter") saveRenameCover(c);
                                            if (e.key === "Escape") cancelRenameCover();
                                          }}
                                          autoFocus
                                        />
                                        <button
                                          className="btn accent shrink"
                                          onClick={() => saveRenameCover(c)}
                                          disabled={renaming}
                                        >
                                          {renaming ? "保存…" : "保存"}
                                        </button>
                                        <button
                                          className="btn ghost shrink"
                                          onClick={cancelRenameCover}
                                        >
                                          取消
                                        </button>
                                      </div>
                                    ) : (
                                      <div className="cover-item-name">
                                        <span>{c}</span>
                                        <button
                                          className="cover-rename-btn"
                                          onClick={() => startRenameCover(c)}
                                          title="修改封面名称"
                                        >
                                          ✏️ 改名
                                        </button>
                                      </div>
                                    )}
                                    {isCurrentCover && (
                                      <span className="cover-item-badge">✓ 已选用为本篇专属封面</span>
                                    )}
                                  </div>
                                </div>

                                <div className="cover-item-right">
                                  <label
                                    className={`switch-control ${isCurrentCover ? "checked" : ""}`}
                                    onClick={() => toggleCover(c)}
                                    title={isCurrentCover ? "点击取消本篇封面" : "点击设为本篇封面"}
                                  >
                                    <span className="switch-slider" />
                                    <span>{isCurrentCover ? "已选用" : "选用"}</span>
                                  </label>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <p className="hint">点击左侧任意一篇进行预览与投递。</p>
              )}
            </div>
          </div>
        )}
        {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
      </section>

      {/* 封面灯箱：点击任意封面放大；封面库的图可直接设为本篇封面 */}
      {zoom && (
        <div className="lightbox" onClick={() => setZoom(null)}>
          <div className="lightbox-inner" onClick={(e) => e.stopPropagation()}>
            <img src={zoom.src} alt={zoom.name ?? "封面预览"} />
            <div className="lightbox-bar">
              {zoom.name && <span className="cover-name">{zoom.name}</span>}
              {zoom.name && selected && (
                <button
                  className="btn accent shrink"
                  onClick={() => {
                    pickCover(zoom.name!);
                    setZoom(null);
                  }}
                >
                  设为本篇封面
                </button>
              )}
              <button className="btn ghost shrink" onClick={() => setZoom(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
