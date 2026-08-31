import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inputGuardrail, outputGuardrail, validator } from "../src/harness/nodes.ts";
import { MAX_RETRIES, MIN_ARTICLE_LEN } from "../src/config.ts";
import type { HarnessStateT } from "../src/harness/state.ts";
import { isInsideDir } from "../src/util/paths.ts";
import { collectNotes } from "../src/util/notes.ts";

const state = (partial: Record<string, unknown>): HarnessStateT => partial as HarnessStateT;

test("invalid input is explicitly failed", async () => {
  const result = await inputGuardrail(state({ topic: "x" }));
  assert.equal(result.inputOk, false);
  assert.equal(result.status, "failed");
  assert.match(String(result.failureReason), /长度/);
});

test("missing HTML cannot pass the output guardrail", async () => {
  const result = await outputGuardrail(
    state({ title: "测试标题", article: "正文", html: "", publishOk: true, status: "success", validationMsg: null }),
  );
  assert.equal(result.outputOk, false);
  assert.equal(result.status, "failed");
  assert.equal(result.failureReason, "未产出有效 HTML。");
});

test("missing title cannot pass the output guardrail", async () => {
  const result = await outputGuardrail(
    state({ title: "", article: "正文", html: "<section>ok</section>", publishOk: true, status: "success", validationMsg: null }),
  );
  assert.equal(result.outputOk, false);
  assert.equal(result.status, "failed");
  assert.equal(result.failureReason, "未产出有效文章标题。");
});

test("validator exhaustion is degraded, not successful", async () => {
  const result = await validator(
    state({
      title: "测试标题",
      article: "短正文",
      retryCount: MAX_RETRIES,
      valid: false,
      status: "success",
      publishOk: true,
    }),
  );
  assert.equal(result.valid, true);
  assert.equal(result.status, "degraded");
});

test("a degraded validation remains degraded when output is present", async () => {
  const result = await outputGuardrail(
    state({
      title: "测试标题",
      article: "a".repeat(MIN_ARTICLE_LEN),
      html: "<section>ok</section>",
      publishOk: true,
      status: "degraded",
      validationMsg: "已达最大重试",
    }),
  );
  assert.equal(result.outputOk, true);
  assert.equal(result.status, "degraded");
  assert.match(String(result.failureReason), /^已达最大重试/);
});

test("path boundary rejects sibling prefixes and symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "article-pipeline-path-"));
  const sibling = `${root}-sibling`;
  await mkdir(sibling, { recursive: true });
  await writeFile(join(root, "inside.txt"), "ok");
  await writeFile(join(sibling, "outside.txt"), "no");
  assert.equal(await isInsideDir(join(root, "inside.txt"), root), true);
  assert.equal(await isInsideDir(join(sibling, "outside.txt"), root), false);
  if (process.platform !== "win32") {
    const link = join(root, "escape.txt");
    await symlink(join(sibling, "outside.txt"), link);
    assert.equal(await isInsideDir(link, root), false);
  }
});

test("web note collection does not implicitly include materials directory", async () => {
  const notes = await collectNotes({
    inline: "只使用这条显式笔记",
    includeDirectory: false,
    directoryNotes: "【素材：已有文件.md】\n不应被带入本次生成",
  });
  assert.equal(notes, "【探讨笔记】\n只使用这条显式笔记");
});

test("removeArticleCover correctly removes cover file", async () => {
  const { createArticle, setArticleCover, removeArticleCover, articleCoverPath } = await import("../src/articles.ts");
  const id = await createArticle({ markdown: "# 测试封面删除\n\n正文内容测试。" });
  const root = await mkdtemp(join(tmpdir(), "cover-test-"));
  const tmpImg = join(root, "test-cover.png");
  await writeFile(tmpImg, "fake png content");
  await setArticleCover(id, tmpImg);
  assert.ok(await articleCoverPath(id));
  await removeArticleCover(id);
  assert.equal(await articleCoverPath(id), null);
  const { deleteArticle } = await import("../src/articles.ts");
  await deleteArticle(id);
});
