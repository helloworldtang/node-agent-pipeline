// HarnessAgent：把四个节点组装成 StateGraph，挂 MemorySaver(checkpointer = 上下文管理)
//   START → input_guardrail ──(过)──→ react → validator ──(不过)──┐
//                  │ (拒)                                        │
//                  ▼                                             │
//                 END ←── output_guardrail ←──(过)────────────────┘
import { StateGraph, MemorySaver, START, END } from "@langchain/langgraph";
import { HarnessState } from "./state.ts";
import {
  inputGuardrail,
  routeAfterInput,
  reactNode,
  validator,
  routeAfterValidator,
  outputGuardrail,
} from "./nodes.ts";

const builder = new StateGraph(HarnessState)
  .addNode("input_guardrail", inputGuardrail)
  .addNode("react", reactNode)
  .addNode("validator", validator)
  .addNode("output_guardrail", outputGuardrail)
  .addEdge(START, "input_guardrail")
  .addConditionalEdges("input_guardrail", routeAfterInput, ["react", END])
  .addEdge("react", "validator")
  .addConditionalEdges("validator", routeAfterValidator, ["react", "output_guardrail"])
  .addEdge("output_guardrail", END);

// 外层 checkpointer：持久化整个 harness 的 state（= 上下文管理）。注意：内层 createAgent 不再挂 checkpointer，避免双重 checkpoint。
// recursionLimit 在每次 invoke/stream 的 config 里指定。
export const harness = builder.compile({
  checkpointer: new MemorySaver(),
});
