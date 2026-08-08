// HarnessAgent 的四个节点 + 路由函数
// 三大功能对照知识库 harness-tutorials 定义：
//   防护栏 = input_guardrail / output_guardrail
//   验证循环 = validator + 条件回退边
//   上下文管理 = 外层 MemorySaver(graph.ts) + messages 流
import { END } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { buildReactAgent } from "../agents/reactAgent.ts";
import { lastToolPayload } from "../util/messages.ts";
import { MAX_RETRIES, MIN_ARTICLE_LEN, REQUIRED_SECTIONS } from "../config.ts";
import type { HarnessStateT } from "./state.ts";

/** 防护栏-入口：选题合法性（长度 4~200） */
export async function inputGuardrail(state: HarnessStateT) {
  const topic = (state.topic ?? "").trim();
  const ok = topic.length >= 4 && topic.length <= 200;
  if (!ok) {
    console.log(`[guardrail:input] 拒绝（长度=${topic.length}，需 4~200 字）`);
    return { inputOk: false, validationMsg: `选题不合规，长度=${topic.length}，需 4~200 字。` };
  }
  console.log(`[guardrail:input] 通过：${topic}`);
  return { inputOk: true };
}

export function routeAfterInput(state: HarnessStateT): "react" | typeof END {
  return state.inputOk ? "react" : END;
}

/** react 节点：调用主 ReAct，抽出 writer 的 article 与 format 的 html */
export async function reactNode(state: HarnessStateT) {
  const { react } = await buildReactAgent();
  const { messages } = await react.invoke(
    { messages: state.messages },
    { configurable: { thread_id: "react-main" }, recursionLimit: 60 },
  );
  const writerOut = lastToolPayload<{ article?: string; model?: string }>(
    messages,
    "delegate_to_writer",
  );
  const fmtOut = lastToolPayload<{ html?: string }>(messages, "format_wechat");
  return {
    messages,
    article: writerOut?.article ?? state.article,
    html: fmtOut?.html ?? state.html,
  };
}

/**
 * 验证循环节点：校验正文。
 * 首轮强制精修一次（生产级 harness 常见模式，且稳定演示一次打回）；之后做真实校验。
 */
export async function validator(state: HarnessStateT) {
  const article = state.article ?? "";
  // 1) 首轮强制精修：注入反馈消息，让 react 看到
  if (state.retryCount === 0) {
    const msg = `【首轮强制精修】请确保正文满足：1) 含「${REQUIRED_SECTIONS.join("、")}」小节；2) 不少于 ${MIN_ARTICLE_LEN} 字。按此要求重新调用 delegate_to_writer 写作，再重新调用 format_wechat 排版，不要手动拼凑。`;
    return {
      retryCount: 1,
      valid: false,
      validationMsg: msg,
      messages: [new HumanMessage(msg)],
    };
  }
  // 2) 真实校验
  const longEnough = article.length >= MIN_ARTICLE_LEN;
  const hasSections = REQUIRED_SECTIONS.every((s) => article.includes(s));
  if (longEnough && hasSections) {
    const msg = `校验通过（正文 ${article.length} 字，含必需结构）。`;
    console.log(`[validator] ${msg}`);
    return { valid: true, validationMsg: msg };
  }
  // 3) 未过且还有重试名额 → 回退
  if (state.retryCount < MAX_RETRIES) {
    const reasons = [
      ...(!hasSections ? [`缺必需结构 ${REQUIRED_SECTIONS.join("/")}`] : []),
      ...(!longEnough ? [`字数不足 ${article.length}/${MIN_ARTICLE_LEN}`] : []),
    ];
    const msg = `校验未过：${reasons.join("；")}。请修正后重新调用 delegate_to_writer 并重新 format_wechat。`;
    console.log(`[validator] 第 ${state.retryCount} 次打回：${msg}`);
    return {
      retryCount: state.retryCount + 1,
      valid: false,
      validationMsg: msg,
      messages: [new HumanMessage(msg)],
    };
  }
  // 4) 用尽重试 → 放行告警
  const msg = `已达最大重试 ${MAX_RETRIES}，放行（告警：当前 ${article.length} 字）。`;
  console.log(`[validator] ${msg}`);
  return { valid: true, validationMsg: msg };
}

export function routeAfterValidator(state: HarnessStateT): "react" | "output_guardrail" {
  return state.valid ? "output_guardrail" : "react";
}

/** 防护栏-出口：产出非空且 HTML 含 <section> */
export async function outputGuardrail(state: HarnessStateT) {
  const html = state.html ?? "";
  const ok = html.length > 0 && html.includes("<section");
  console.log(
    `[guardrail:output] ${ok ? "通过" : "告警：未产出有效 HTML"}（html ${html.length} 字符）`,
  );
  return { valid: ok, validationMsg: ok ? "产出校验通过。" : "未产出有效 HTML。" };
}
