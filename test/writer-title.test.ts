import test from "node:test";
import assert from "node:assert/strict";
import { parseWriterOutput } from "../src/agents/writerAgent.ts";
import { createArticle, listArticles, readArticleSource, updateArticleTitle, deleteArticle } from "../src/articles.ts";

test("parseWriterOutput: parses standard markers correctly", () => {
  const raw = `===TITLE===
为什么聊天框做不好公众号内容？
===CONTENT===
很多人用生成式 AI 做内容，一开始就找错了方向。

## 一、为什么聊天框解决不了问题
正文内容...`;

  const parsed = parseWriterOutput(raw);
  assert.equal(parsed.title, "为什么聊天框做不好公众号内容？");
  assert.equal(parsed.article.startsWith("很多人用生成式 AI 做内容"), true);
  assert.equal(parsed.article.includes("# 为什么聊天框做不好公众号内容？"), false);
});

test("parseWriterOutput: parses JSON block correctly", () => {
  const raw = `\`\`\`json
{
  "title": "JSON 格式标题",
  "article": "正文内容第一行\\n\\n## 小节一\\n小节正文"
}
\`\`\``;

  const parsed = parseWriterOutput(raw);
  assert.equal(parsed.title, "JSON 格式标题");
  assert.equal(parsed.article, "正文内容第一行\n\n## 小节一\n小节正文");
});

test("parseWriterOutput: gracefully handles legacy markdown with # h1", () => {
  const raw = `# 旧格式的一级标题

正文从这里开始。

## 二级标题
内容...`;

  const parsed = parseWriterOutput(raw);
  assert.equal(parsed.title, "旧格式的一级标题");
  assert.equal(parsed.article.startsWith("正文从这里开始。"), true);
  assert.equal(parsed.article.startsWith("#"), false);
});

test("parseWriterOutput: fallback gracefully on plain text", () => {
  const raw = `这是一段没有任何特殊标记的正文，第一行很长很长。`;
  const parsed = parseWriterOutput(raw, "备用选题");
  assert.ok(parsed.title.length >= 2);
  assert.equal(parsed.article, raw);
});

test("createArticle & meta.json: stores independent title and updates it", async () => {
  const id = await createArticle({
    title: "独立文章标题测试",
    markdown: "这是没有一级标题的正文内容。\n\n## 小节一\n正文详情",
  });

  const articles = await listArticles();
  const matched = articles.find((a) => a.id === id);
  assert.ok(matched);
  assert.equal(matched?.title, "独立文章标题测试");

  // 更新标题
  await updateArticleTitle(id, "更新后的文章标题");
  const articlesUpdated = await listArticles();
  const matchedUpdated = articlesUpdated.find((a) => a.id === id);
  assert.equal(matchedUpdated?.title, "更新后的文章标题");

  // 清理
  await deleteArticle(id);
});

test("readArticleSource: keeps the original topic and notes for regeneration", async () => {
  const id = await createArticle({
    title: "带上下文的文章",
    markdown: "这是文章正文内容，足够长，可以验证原始上下文的保存。",
    run: {
      status: "success",
      topic: "如何让文章更有说服力",
      notes: "素材笔记：包含一个用户案例和三个关键结论。",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      elapsedMs: 10,
    },
  });
  try {
    assert.deepEqual(await readArticleSource(id), {
      topic: "如何让文章更有说服力",
      notes: "素材笔记：包含一个用户案例和三个关键结论。",
    });
  } finally {
    await deleteArticle(id);
  }
});
