import test from "node:test";
import assert from "node:assert/strict";
import {
  saveArticleAiSession,
  listArticleAiSessions,
  createArticle,
  deleteArticle,
  type ArticleAiSession,
} from "../src/articles.ts";

test("saveArticleAiSession and listArticleAiSessions: persistence and updates", async () => {
  // 1. 创建临时文章
  const articleId = await createArticle({
    markdown: "# 测试文章\n\n正文第一段内容。",
    title: "测试文章",
  });

  try {
    // 2. 初始状态列表为空
    const initial = await listArticleAiSessions(articleId);
    assert.deepEqual(initial, []);

    // 3. 保存第一个会话（仅探讨）
    const session1: ArticleAiSession = {
      id: "session-1",
      createdAt: new Date(Date.now() - 10000).toISOString(),
      originalSnippet: "正文第一段内容",
      applied: false,
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "口语化润色",
          timestamp: new Date().toISOString(),
        },
        {
          id: "msg-2",
          role: "assistant",
          content: "修改思路：口语化",
          explanation: "口语化",
          rewrittenText: "正文第一段聊聊看。",
          originalText: "正文第一段内容",
          applied: false,
          timestamp: new Date().toISOString(),
        },
      ],
    };

    await saveArticleAiSession(articleId, session1);

    const list1 = await listArticleAiSessions(articleId);
    assert.equal(list1.length, 1);
    assert.equal(list1[0]?.id, "session-1");
    assert.equal(list1[0]?.applied, false);

    // 4. 保存第二个会话（已采纳，时间更晚）
    const session2: ArticleAiSession = {
      id: "session-2",
      createdAt: new Date().toISOString(),
      originalSnippet: "第二段内容",
      applied: true,
      appliedAt: new Date().toISOString(),
      messages: [
        {
          id: "msg-3",
          role: "user",
          content: "提炼为要点",
          timestamp: new Date().toISOString(),
        },
        {
          id: "msg-4",
          role: "assistant",
          content: "思路：要点化",
          explanation: "要点化",
          rewrittenText: "1. 第二段要点",
          originalText: "第二段内容",
          applied: true,
          timestamp: new Date().toISOString(),
        },
      ],
    };

    await saveArticleAiSession(articleId, session2);

    const list2 = await listArticleAiSessions(articleId);
    assert.equal(list2.length, 2);
    // 按时间倒序，session2 在前
    assert.equal(list2[0]?.id, "session-2");
    assert.equal(list2[1]?.id, "session-1");

    // 5. 更新 session1 为已采纳（测试就地更新）
    session1.applied = true;
    session1.appliedAt = new Date().toISOString();
    session1.messages[1]!.applied = true;
    await saveArticleAiSession(articleId, session1);

    const list3 = await listArticleAiSessions(articleId);
    assert.equal(list3.length, 2);
    const updated1 = list3.find((s) => s.id === "session-1");
    assert.equal(updated1?.applied, true);
    assert.equal(updated1?.messages[1]?.applied, true);
  } finally {
    // 清理测试文章
    await deleteArticle(articleId);
  }
});
