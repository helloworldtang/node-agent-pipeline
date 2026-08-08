// HarnessAgent 的状态 schema：messages + 业务字段
import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";

const lastWins =
  <T>() =>
  (_prev: T, next: T): T =>
    next;

export const HarnessState = Annotation.Root({
  // 主消息流（ReAct 全过程 + 校验反馈都进这里）
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  // 用户选题
  topic: Annotation<string | null>({ reducer: lastWins(), default: () => null }),
  // 校验循环计数
  retryCount: Annotation<number>({ reducer: lastWins(), default: () => 0 }),
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
});

export type HarnessStateT = typeof HarnessState.State;
