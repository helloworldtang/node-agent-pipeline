import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArticleIndex } from "../src/article-db.ts";

test("SQLite article metadata is queryable and ordered by mtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "article-index-"));
  const index = new ArticleIndex(join(root, "articles.sqlite"));
  try {
    index.upsertArticle({
      id: "older",
      title: "旧文章",
      mtime: "2026-08-20T10:00:00.000Z",
      size: 120,
      hasHtml: false,
      hasCover: false,
    });
    index.upsertArticle({
      id: "newer",
      title: "新文章",
      mtime: "2026-08-21T10:00:00.000Z",
      size: 240,
      hasHtml: true,
      hasCover: true,
      cover: "cover.png",
    });

    assert.deepEqual(index.listArticles().map((article) => article.id), ["newer", "older"]);
    assert.deepEqual(index.listArticles()[0], {
      id: "newer",
      title: "新文章",
      mtime: "2026-08-21T10:00:00.000Z",
      size: 240,
      hasHtml: true,
      hasCover: true,
      cover: "cover.png",
    });
  } finally {
    index.close();
  }
});

test("SQLite versions can be reconciled and are removed with their article", async () => {
  const root = await mkdtemp(join(tmpdir(), "article-index-"));
  const index = new ArticleIndex(join(root, "articles.sqlite"));
  try {
    index.upsertArticle({
      id: "article-1",
      title: "文章",
      mtime: "2026-08-21T10:00:00.000Z",
      size: 10,
      hasHtml: true,
      hasCover: false,
    });
    index.upsertVersion("article-1", { id: "v-old", createdAt: "2026-08-20T10:00:00.000Z" });
    index.upsertVersion("article-1", { id: "v-new", createdAt: "2026-08-21T10:00:00.000Z" });
    index.removeVersionsExcept("article-1", ["v-new"]);
    assert.deepEqual(index.listVersions("article-1"), [
      { id: "v-new", createdAt: "2026-08-21T10:00:00.000Z" },
    ]);

    index.removeArticle("article-1");
    assert.deepEqual(index.listVersions("article-1"), []);
  } finally {
    index.close();
  }
});

test("SQLite article can be hidden in the recycle bin and restored without losing versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "article-index-"));
  const index = new ArticleIndex(join(root, "articles.sqlite"));
  try {
    index.upsertArticle({
      id: "article-trash",
      title: "可恢复文章",
      mtime: "2026-08-21T10:00:00.000Z",
      size: 100,
      hasHtml: true,
      hasCover: false,
    });
    index.upsertVersion("article-trash", { id: "v-1", createdAt: "2026-08-20T10:00:00.000Z" });

    index.markArticleTrashed("article-trash", "2026-08-22T10:00:00.000Z");
    assert.deepEqual(index.listArticles(), []);
    assert.deepEqual(index.listVersions("article-trash"), [
      { id: "v-1", createdAt: "2026-08-20T10:00:00.000Z" },
    ]);

    index.markArticleRestored("article-trash");
    assert.deepEqual(index.listArticles().map((article) => article.id), ["article-trash"]);
  } finally {
    index.close();
  }
});

test("legacy delivery records are imported once and support idempotency lookup", async () => {
  const root = await mkdtemp(join(tmpdir(), "article-index-"));
  const file = join(root, "deliveries.jsonl");
  const record = {
    at: "2026-08-21T10:00:00.000Z",
    platform: "wechat",
    account: "测试账号",
    title: "测试文章",
    mediaId: "media-1",
    sourceFile: "article-1",
    idempotencyKey: "same-content",
    status: "success",
  };
  await writeFile(file, `${JSON.stringify(record)}\n${JSON.stringify(record)}\n`, "utf8");
  const index = new ArticleIndex(join(root, "articles.sqlite"));
  try {
    assert.equal(await index.importDeliveries(file), 2);
    assert.equal(index.listDeliveries().length, 1);
    assert.deepEqual(index.findSuccessfulDelivery("same-content"), {
      platform: "wechat",
      account: "测试账号",
      id: "media-1",
    });
  } finally {
    index.close();
  }
});
