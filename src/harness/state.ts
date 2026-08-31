// HarnessAgent 的状态 schema：messages + 业务字段
import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";

const lastWins =
  <T>() =>
  (_prev: T, next: T): T =>
    next;

export type RunStatus = "success" | "degraded" | "failed";

export const HarnessState = Annotation.Root({
  // 主消息流（ReAct 全过程 + 校验反馈都进这里）
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  // 用户选题
  topic: Annotation<string | null>({ reducer: lastWins(), default: () => null }),
  // 用户素材笔记（和 AI 探讨整理出的结论/要点，可为空 = 凭模型自身知识写）
  notes: Annotation<string | null>({ reducer: lastWins(), default: () => null }),
  // 校验循环计数
  retryCount: Annotation<number>({ reducer: lastWins(), default: () => 0 }),
  // 写作 subagent 产出的文章标题
  title: Annotation<string | null>({ reducer: lastWins(), default: () => null }),
  // 写作 subagent 产出的 Markdown 正文
  article: Annotation<string | null>({ reducer: lastWins(), default: () => null }),
  // 排版 Skill 产出的微信 HTML
  html: Annotation<string | null>({ reducer: lastWins(), default: () => null }),
  // 校验/防护栏给出的可读信息
  validationMsg: Annotation<string | null>({ reducer: lastWins(), default: () => null }),
  // validator 是否放行
  valid: Annotation<boolean>({ reducer: lastWins(), default: () => false }),
  // input_guardrail 是否放行
  inputOk: Annotation<boolean>({ reducer: lastWins(), default: () => false }),
  // 最终运行状态：只能由实际执行到的节点更新，默认失败以避免空状态被误报成功
  status: Annotation<RunStatus>({ reducer: lastWins(), default: () => "failed" }),
  failureReason: Annotation<string | null>({ reducer: lastWins(), default: () => null }),
  // 输出防护栏是否确认正文和 HTML 都存在
  outputOk: Annotation<boolean>({ reducer: lastWins(), default: () => false }),
  // 发布工具是否报告过失败；没有配置发布时保持 true
  publishOk: Annotation<boolean>({ reducer: lastWins(), default: () => true }),
});

export type HarnessStateT = typeof HarnessState.State;
