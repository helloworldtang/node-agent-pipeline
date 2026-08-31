// HarnessAgent 的四个节点 + 路由函数
//   防护栏 = input_guardrail / output_guardrail
//   验证循环 = validator + 条件回退边（规则全部走 config，可配）
//   上下文管理 = 外层 MemorySaver(graph.ts) + messages 流
import { END } from "@langchain/langgraph";
import { HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { buildReactAgent } from "../agents/reactAgent.ts";
import { refineArticle } from "../agents/writerAgent.ts";
import { lastToolPayload } from "../util/messages.ts";
import {
  FORCE_FIRST_REFINE,
  MAX_RETRIES,
  MIN_ARTICLE_LEN,
  REQUIRED_SECTIONS,
} from "../config.ts";
import type { HarnessStateT } from "./state.ts";
import { renderMarkdownToWeChatHtml } from "../tools/formatSkill.ts";
import { inspectArticleQuality } from "../tools/quality.ts";

/** 防护栏-入口：选题合法性（长度 2~200） */
export async function inputGuardrail(state: HarnessStateT) {
  const topic = (state.topic ?? "").trim();
  const ok = topic.length >= 2 && topic.length <= 200;
  if (!ok) {
    console.log(`[guardrail:input] 拒绝（长度=${topic.length}，需 2~200 字）`);
    const reason = `选题不合规，长度=${topic.length}，需 2~200 字。`;
    return { inputOk: false, status: "failed" as const, failureReason: reason, validationMsg: reason };
  }
  console.log(`[guardrail:input] 通过：${topic}`);
  return { inputOk: true, status: "success" as const, failureReason: null };
}

export function routeAfterInput(state: HarnessStateT): "react" | typeof END {
  return state.inputOk ? "react" : END;
}

/** react 节点：调用主 ReAct，抽出 writer 的 title/article 与 format 的 html */
export async function reactNode(state: HarnessStateT) {
  const { react } = await buildReactAgent();
  const { messages } = await react.invoke(
    { messages: state.messages },
    { configurable: { thread_id: "react-main" }, recursionLimit: 60 },
  );
  const writerOut = lastToolPayload<{ title?: string; article?: string; model?: string }>(
    messages,
    "delegate_to_writer",
  );
  const fmtOut = lastToolPayload<{ html?: string }>(messages, "format_wechat");
  const publishFailure = messages
    .filter((m: BaseMessage) => m instanceof ToolMessage && m.name === "publish_article")
    .find((m: BaseMessage) => m instanceof ToolMessage && m.status === "error");
  const publishOk = !publishFailure;
  const failureReason = publishFailure
    ? `发布失败：${typeof publishFailure.content === "string" ? publishFailure.content : JSON.stringify(publishFailure.content)}`
    : null;
  return {
    messages,
    title: writerOut?.title ?? state.title ?? (state.topic ? state.topic.slice(0, 30) : null),
    article: writerOut?.article ?? state.article,
    html: fmtOut?.html ?? state.html,
    publishOk,
    ...(publishFailure ? { status: "failed" as const, failureReason } : {}),
  };
}

/** 校验规则描述（生成反馈文案用） */
function ruleDesc(): string {
  const rules = [`独立文章标题（2~64 字）`, `正文不少于 ${MIN_ARTICLE_LEN} 字`];
  if (REQUIRED_SECTIONS.length > 0) rules.push(`含「${REQUIRED_SECTIONS.join("、")}」小节`);
  return rules.join("；");
}

/** 验证循环节点：确定性规则校验（独立标题 + 字数 + 可选的必需小节），不依赖 LLM 结构化输出 */
export async function validator(state: HarnessStateT) {
  const title = (state.title ?? "").trim();
  const article = state.article ?? "";
  // 1) 可选：首轮强制精修（演示校验回退用，默认关闭）
  if (FORCE_FIRST_REFINE && state.retryCount === 0) {
    const msg = `【首轮强制精修】请确保满足：${ruleDesc()}。按此要求重新调用 delegate_to_writer 写作，再重新调用 format_wechat 排版，不要手动拼凑。`;
    return {
      retryCount: 1,
      valid: false,
      validationMsg: msg,
      messages: [new HumanMessage(msg)],
    };
  }
  // 2) 真实校验
  const titleOk = title.length >= 2 && title.length <= 64;
  const longEnough = article.length >= MIN_ARTICLE_LEN;
  const missing = REQUIRED_SECTIONS.filter((s) => !article.includes(s));
  if (titleOk && longEnough && missing.length === 0) {
    const msg = `校验通过（标题「${title}」，正文 ${article.length} 字）。`;
    console.log(`[validator] ${msg}`);
    return { valid: true, status: "success" as const, validationMsg: msg };
  }
  // 3) 未过且还有重试名额 → 回退
  if (state.retryCount < MAX_RETRIES) {
    const reasons = [
      ...(!titleOk ? [`缺少有效标题（需 2~64 字，当前「${title}」）`] : []),
      ...(missing.length > 0 ? [`缺必需结构 ${missing.join("/")}`] : []),
      ...(!longEnough ? [`字数不足 ${article.length}/${MIN_ARTICLE_LEN}`] : []),
    ];
    const msg = `校验未过：${reasons.join("；")}。请修正后重新调用 delegate_to_writer 并重新 format_wechat。`;
    console.log(`[validator] 第 ${state.retryCount + 1} 次打回：${msg}`);
    return {
      retryCount: state.retryCount + 1,
      valid: false,
      validationMsg: msg,
      messages: [new HumanMessage(msg)],
    };
  }
  // 4) 用尽重试 → 放行告警
  const msg = `已达最大重试 ${MAX_RETRIES}，放行（告警：标题「${title}」，正文 ${article.length} 字）。`;
  console.log(`[validator] ${msg}`);
  return { valid: true, status: "degraded" as const, validationMsg: msg };
}

/** 修订节点：只携带当前标题、草稿和确定性校验反馈，完成后直接重新排版。 */
export async function refineNode(state: HarnessStateT) {
  const currentTitle = state.title ?? state.topic ?? "未命名文章";
  const res = await refineArticle(state.article ?? "", state.validationMsg ?? "请修订当前草稿", currentTitle);
  const html = renderMarkdownToWeChatHtml(res.article);
  return { title: res.title, article: res.article, html, validationMsg: "已完成针对校验反馈的修订。" };
}

export function routeAfterValidator(state: HarnessStateT): "refine" | "output_guardrail" {
  if (!state.publishOk || state.status === "failed") return "output_guardrail";
  return state.valid ? "output_guardrail" : "refine";
}

/** 防护栏-出口：标题、正文和 HTML 都必须存在，否则最终状态为 failed */
export async function outputGuardrail(state: HarnessStateT) {
  const title = (state.title ?? "").trim();
  const article = state.article ?? "";
  const html = state.html ?? "";
  const titleOk = title.length > 0;
  const articleOk = article.trim().length > 0;
  const htmlOk = html.length > 0 && html.includes("<section");
  const qualityIssues = articleOk && htmlOk ? inspectArticleQuality(article, html) : [];
  const structuralOk = titleOk && articleOk && htmlOk && state.publishOk && state.status !== "failed";
  const ok = titleOk && articleOk && htmlOk && state.publishOk;
  const reason = !titleOk
    ? "未产出有效文章标题。"
    : !articleOk
      ? "未产出正文。"
      : !htmlOk
        ? "未产出有效 HTML。"
        : !state.publishOk
            ? state.failureReason ?? "发布失败。"
            : state.status === "failed"
              ? state.failureReason ?? "流水线已失败。"
              : null;
  const degradedReason = [
    state.status === "degraded" ? state.validationMsg : null,
    qualityIssues.length > 0 ? `质量检查：${qualityIssues.join("；")}` : null,
  ].filter(Boolean).join("；") || null;
  const finalStatus = !structuralOk
    ? ("failed" as const)
    : degradedReason
      ? ("degraded" as const)
      : ("success" as const);
  console.log(
    `[guardrail:output] ${ok ? `通过${degradedReason ? `（降级：${degradedReason}）` : ""}` : `失败：${reason}`}（title: 「${title}」，article ${article.length}，html ${html.length} 字符）`,
  );
  const finalReason = structuralOk ? degradedReason : reason;
  return {
    outputOk: ok,
    valid: ok,
    status: finalStatus,
    failureReason: finalReason,
    validationMsg: ok ? state.validationMsg ?? "产出校验通过。" : reason,
  };
}
