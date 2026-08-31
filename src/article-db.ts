// 文章索引：正文文件仍存放在 output/<article-id>/，SQLite 只保存可查询的元数据。
// 使用 Node >= 22.5 内置的 node:sqlite，避免引入需要编译的第三方原生依赖。
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ARTICLE_DB_FILE, OUTPUT_DIR } from "./config.ts";

export interface IndexedArticle {
  id: string;
  title: string;
  mtime: string;
  size: number;
  hasHtml: boolean;
  hasCover: boolean;
  cover?: string;
}

export interface IndexedVersion {
  id: string;
  createdAt: string;
}

export interface IndexedDelivery {
  at: string;
  platform: string;
  account: string;
  title: string;
  mediaId?: string;
  status: "success" | "failed";
  sourceFile: string | null;
  idempotencyKey?: string;
  error?: string;
}

type DeliveryInput = Record<string, unknown>;

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeDelivery(input: DeliveryInput): IndexedDelivery {
  return {
    at: typeof input.at === "string" && input.at ? input.at : new Date().toISOString(),
    platform: String(input.platform ?? ""),
    account: String(input.account ?? ""),
    title: String(input.title ?? ""),
    mediaId: asOptionalString(input.mediaId),
    status: input.status === "failed" ? "failed" : "success",
    sourceFile: input.sourceFile == null ? null : String(input.sourceFile),
    idempotencyKey: asOptionalString(input.idempotencyKey),
    error: asOptionalString(input.error),
  };
}

function fingerprint(record: IndexedDelivery): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        record.at,
        record.platform,
        record.account,
        record.title,
        record.mediaId ?? null,
        record.status,
        record.sourceFile,
        record.idempotencyKey ?? null,
        record.error ?? null,
      ]),
    )
    .digest("hex");
}

export class ArticleIndex {
  private readonly db: DatabaseSync;

  constructor(filename = ARTICLE_DB_FILE) {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS articles (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        mtime TEXT NOT NULL,
        size INTEGER NOT NULL,
        has_html INTEGER NOT NULL DEFAULT 0,
        has_cover INTEGER NOT NULL DEFAULT 0,
        cover TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_articles_mtime ON articles(mtime DESC);

      CREATE TABLE IF NOT EXISTS article_versions (
        article_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (article_id, version_id),
        FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_article_versions_created_at
        ON article_versions(article_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS deliveries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT NOT NULL UNIQUE,
        at TEXT NOT NULL,
        platform TEXT NOT NULL,
        account TEXT NOT NULL,
        title TEXT NOT NULL,
        media_id TEXT,
        status TEXT NOT NULL,
        source_file TEXT,
        idempotency_key TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_deliveries_idempotency
        ON deliveries(idempotency_key, status, at DESC);
      CREATE INDEX IF NOT EXISTS idx_deliveries_at ON deliveries(at DESC);
    `);
    // 兼容在回收站功能之前创建的 articles.sqlite。
    try {
      this.db.exec("ALTER TABLE articles ADD COLUMN archived_at TEXT");
    } catch {
      /* 字段已存在 */
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_articles_archived_at ON articles(archived_at)");
  }

  close(): void {
    this.db.close();
  }

  upsertArticle(article: IndexedArticle, now = new Date().toISOString()): void {
    this.db
      .prepare(
        `
      INSERT INTO articles
        (id, title, mtime, size, has_html, has_cover, cover, created_at, updated_at, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        mtime = excluded.mtime,
        size = excluded.size,
        has_html = excluded.has_html,
        has_cover = excluded.has_cover,
        cover = excluded.cover,
        updated_at = excluded.updated_at,
        archived_at = NULL
    `,
      )
      .run(
        article.id,
        article.title,
        article.mtime,
        article.size,
        article.hasHtml ? 1 : 0,
        article.hasCover ? 1 : 0,
        article.cover ?? null,
        now,
        now,
      );
  }

  listArticles(): IndexedArticle[] {
    const rows = this.db
      .prepare(
        `
      SELECT id, title, mtime, size, has_html, has_cover, cover
      FROM articles
      WHERE archived_at IS NULL
      ORDER BY mtime DESC, id DESC
    `,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      mtime: String(row.mtime),
      size: Number(row.size),
      hasHtml: Number(row.has_html) === 1,
      hasCover: Number(row.has_cover) === 1,
      cover: typeof row.cover === "string" ? row.cover : undefined,
    }));
  }

  removeArticlesExcept(ids: Iterable<string>): void {
    const values = [...ids];
    if (values.length === 0) {
      this.db.exec("DELETE FROM articles WHERE archived_at IS NULL");
      return;
    }
    const placeholders = values.map(() => "?").join(",");
    this.db
      .prepare(`DELETE FROM articles WHERE archived_at IS NULL AND id NOT IN (${placeholders})`)
      .run(...values);
  }

  markArticleTrashed(id: string, trashedAt = new Date().toISOString()): void {
    this.db.prepare("UPDATE articles SET archived_at = ? WHERE id = ?").run(trashedAt, id);
  }

  markArticleRestored(id: string): void {
    this.db.prepare("UPDATE articles SET archived_at = NULL WHERE id = ?").run(id);
  }

  removeArticle(id: string): void {
    this.db.prepare("DELETE FROM articles WHERE id = ?").run(id);
  }

  upsertVersion(articleId: string, version: IndexedVersion): void {
    this.db
      .prepare(
        `
      INSERT INTO article_versions (article_id, version_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(article_id, version_id) DO UPDATE SET created_at = excluded.created_at
    `,
      )
      .run(articleId, version.id, version.createdAt);
  }

  listVersions(articleId: string): IndexedVersion[] {
    const rows = this.db
      .prepare(
        `
      SELECT version_id, created_at
      FROM article_versions
      WHERE article_id = ?
      ORDER BY created_at DESC, version_id DESC
    `,
      )
      .all(articleId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ id: String(row.version_id), createdAt: String(row.created_at) }));
  }

  removeVersionsExcept(articleId: string, ids: Iterable<string>): void {
    const values = [...ids];
    if (values.length === 0) {
      this.db.prepare("DELETE FROM article_versions WHERE article_id = ?").run(articleId);
      return;
    }
    const placeholders = values.map(() => "?").join(",");
    this.db
      .prepare(
        `DELETE FROM article_versions WHERE article_id = ? AND version_id NOT IN (${placeholders})`,
      )
      .run(articleId, ...values);
  }

  recordDelivery(input: DeliveryInput): void {
    const record = normalizeDelivery(input);
    this.db
      .prepare(
        `
      INSERT OR IGNORE INTO deliveries
        (fingerprint, at, platform, account, title, media_id, status, source_file, idempotency_key, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        fingerprint(record),
        record.at,
        record.platform,
        record.account,
        record.title,
        record.mediaId ?? null,
        record.status,
        record.sourceFile,
        record.idempotencyKey ?? null,
        record.error ?? null,
      );
  }

  findSuccessfulDelivery(
    idempotencyKey: string,
  ): { platform: string; account: string; id: string } | null {
    const row = this.db
      .prepare(
        `
      SELECT platform, account, media_id
      FROM deliveries
      WHERE idempotency_key = ? AND status = 'success' AND media_id IS NOT NULL
      ORDER BY at DESC, seq DESC
      LIMIT 1
    `,
      )
      .get(idempotencyKey) as Record<string, unknown> | undefined;
    if (!row || typeof row.media_id !== "string") return null;
    return { platform: String(row.platform), account: String(row.account), id: row.media_id };
  }

  listDeliveries(): IndexedDelivery[] {
    const rows = this.db
      .prepare(
        `
      SELECT at, platform, account, title, media_id, status, source_file, idempotency_key, error
      FROM deliveries
      ORDER BY seq DESC
    `,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      at: String(row.at),
      platform: String(row.platform),
      account: String(row.account),
      title: String(row.title),
      mediaId: typeof row.media_id === "string" ? row.media_id : undefined,
      status: row.status === "failed" ? "failed" : "success",
      sourceFile: typeof row.source_file === "string" ? row.source_file : null,
      idempotencyKey: typeof row.idempotency_key === "string" ? row.idempotency_key : undefined,
      error: typeof row.error === "string" ? row.error : undefined,
    }));
  }

  async importDeliveries(file: string): Promise<number> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return 0;
    }
    let imported = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        this.recordDelivery(JSON.parse(line) as DeliveryInput);
        imported++;
      } catch {
        // 保留坏行兼容性：JSONL 中单条损坏不应阻塞整个服务启动。
      }
    }
    return imported;
  }
}

let sharedIndex: ArticleIndex | null = null;
let deliveriesIndexed = false;

export function getArticleIndex(): ArticleIndex {
  sharedIndex ??= new ArticleIndex();
  return sharedIndex;
}

/** 兼容旧版 deliveries.jsonl；每个进程只导入一次，之后发布记录直接写 SQLite。 */
export async function ensureDeliveriesIndexed(): Promise<void> {
  if (deliveriesIndexed) return;
  await getArticleIndex().importDeliveries(`${OUTPUT_DIR}/deliveries.jsonl`);
  deliveriesIndexed = true;
}
