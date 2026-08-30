// HarnessAgent：把四个节点组装成 StateGraph，挂 MemorySaver(checkpointer = 上下文管理)
//   START → input_guardrail ──(过)──→ react → validator ──(不过)──→ refine ──┐
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
  refineNode,
  routeAfterValidator,
  outputGuardrail,
} from "./nodes.ts";

const builder = new StateGraph(HarnessState)
  .addNode("input_guardrail", inputGuardrail)
  .addNode("react", reactNode)
  .addNode("validator", validator)
  .addNode("refine", refineNode)
  .addNode("output_guardrail", outputGuardrail)
  .addEdge(START, "input_guardrail")
  .addConditionalEdges("input_guardrail", routeAfterInput, ["react", END])
  .addEdge("react", "validator")
  .addConditionalEdges("validator", routeAfterValidator, ["refine", "output_guardrail"])
  .addEdge("refine", "validator")
  .addEdge("output_guardrail", END);

// 外层 checkpointer：持久化整个 harness 的 state（= 上下文管理）。内层 createAgent 不挂，避免双重 checkpoint。
export const harness = builder.compile({
  checkpointer: new MemorySaver(),
});
