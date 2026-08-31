import test from "node:test";
import assert from "node:assert/strict";
import { parseArticleRegenerateOutput, parseRewriteOutput } from "../src/tools/aiEditor.ts";

test("parseArticleRegenerateOutput: parses title, content and explanation markers", () => {
  const result = parseArticleRegenerateOutput(
    `===TITLE===
新的文章标题
===CONTENT===
## 新的正文

这是完整的新版本。
===EXPLANATION===
调整了开头并补充了行动建议。`,
    "原标题",
    "原正文",
  );
  assert.deepEqual(result, {
    title: "新的文章标题",
    article: "## 新的正文\n\n这是完整的新版本。",
    explanation: "调整了开头并补充了行动建议。",
  });
});

test("parseArticleRegenerateOutput: falls back safely when markers are missing", () => {
  const result = parseArticleRegenerateOutput("一篇新的完整文章", "原标题", "原正文");
  assert.equal(result.title, "原标题");
  assert.equal(result.article, "一篇新的完整文章");
});

test("parseRewriteOutput: parses standard ===REWRITE=== and ===EXPLANATION=== markers", () => {
  const raw = `===REWRITE===
很多人在使用 AI 辅助创作时，总误以为给个标题就能出一篇爆款。

其实关键在于**上下文的把控与渐进式的微调**。
===EXPLANATION===
强化了核心论点的对比，语言更凝练有力。`;

  const original = "旧的片段内容";
  const result = parseRewriteOutput(raw, original);
  assert.equal(
    result.rewrittenText,
    "很多人在使用 AI 辅助创作时，总误以为给个标题就能出一篇爆款。\n\n其实关键在于**上下文的把控与渐进式的微调**。",
  );
  assert.equal(result.explanation, "强化了核心论点的对比，语言更凝练有力。");
});

test("parseRewriteOutput: parses output with only ===REWRITE===", () => {
  const raw = `===REWRITE===
这是重写后的段落，没有提供说明。`;

  const original = "旧内容";
  const result = parseRewriteOutput(raw, original);
  assert.equal(result.rewrittenText, "这是重写后的段落，没有提供说明。");
  assert.equal(result.explanation, "已根据要求完成重写");
});

test("parseRewriteOutput: parses markdown fenced block fallback", () => {
  const raw = "```markdown\n这是带有 markdown 代码块的重写内容\n```";
  const original = "旧内容";
  const result = parseRewriteOutput(raw, original);
  assert.equal(result.rewrittenText, "这是带有 markdown 代码块的重写内容");
});

test("parseRewriteOutput: handles empty output gracefully with fallback original", () => {
  const raw = "";
  const original = "原文保持不变";
  const result = parseRewriteOutput(raw, original);
  assert.equal(result.rewrittenText, "原文保持不变");
  assert.equal(result.explanation, "未提供修改内容");
});
