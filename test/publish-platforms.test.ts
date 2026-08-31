import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlatforms } from "../src/tools/publish.ts";
import { getPublisher, listPlatforms } from "../src/publishers/registry.ts";
import { parseMediaId, readExomindCreds } from "../src/publishers/exomind.ts";

test("parsePlatforms: splits, trims, dedupes and drops empties", () => {
  assert.deepEqual(parsePlatforms("wechat"), ["wechat"]);
  assert.deepEqual(parsePlatforms(" wechat , exomind ,,wechat "), ["wechat", "exomind"]);
});

test("parsePlatforms: rejects unknown platforms with the supported list", () => {
  assert.throws(() => parsePlatforms("wechat,zhihu"), /未知发布平台：zhihu.*wechat, exomind/);
});

test("registry: wechat and exomind publishers resolve with their platform tag", () => {
  assert.deepEqual([...listPlatforms()].sort(), ["exomind", "wechat"]);
  assert.equal(getPublisher("wechat", "a").platform, "wechat");
  assert.equal(getPublisher("exomind", "a").platform, "exomind");
  assert.throws(() => getPublisher("zhihu", "a"), /未知发布平台/);
});

test("parseMediaId: extracts media_id from CLI output (ascii and fullwidth colon)", () => {
  assert.equal(parseMediaId("✓ 已投递草稿箱 media_id: T1NF4457abc123"), "T1NF4457abc123");
  assert.equal(parseMediaId("media_id：draft_1785851612_8544"), "draft_1785851612_8544");
  assert.equal(parseMediaId("没有媒体 id 的输出"), null);
});

test("readExomindCreds: reads config and reports actionable errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "exomind-creds-"));
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({ base_url: "https://exomind.example.com", api_key: "sk-test" }),
    "utf8",
  );
  assert.deepEqual(await readExomindCreds(join(root, "config.json")), {
    baseUrl: "https://exomind.example.com",
    apiKey: "sk-test",
  });
  await assert.rejects(readExomindCreds(join(root, "missing.json")), /exomind login/);
  await writeFile(join(root, "partial.json"), JSON.stringify({ base_url: "https://x" }), "utf8");
  await assert.rejects(readExomindCreds(join(root, "partial.json")), /凭证不完整/);
});
