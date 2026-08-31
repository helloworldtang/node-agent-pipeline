import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapeEnvValue } from "../src/settings.ts";

async function loadEnvRoundTrip(value: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "settings-env-"));
  await writeFile(join(root, ".env"), `ROUNDTRIP_KEY=${escapeEnvValue(value)}\n`, "utf8");
  delete process.env.ROUNDTRIP_KEY;
  process.loadEnvFile(join(root, ".env"));
  const loaded = process.env.ROUNDTRIP_KEY;
  delete process.env.ROUNDTRIP_KEY;
  return loaded ?? "";
}

test("escapeEnvValue round-trips multiline values through loadEnvFile", async () => {
  // 换行 + 双引号 + 反斜杠 + # —— 走单引号包裹路径，全部原样保留
  const value = '第一行\n第二行 "引号" 反斜杠\\ 结尾#井号';
  assert.equal(await loadEnvRoundTrip(value), value);
});

test("escapeEnvValue round-trips values containing single quotes", async () => {
  // 含 ' 时走双引号路径：换行转义为 \n，单引号原样
  const value = "it's a\nprompt";
  assert.equal(await loadEnvRoundTrip(value), value);
});

test("escapeEnvValue rejects values that no quoting can represent", () => {
  assert.throws(() => escapeEnvValue(`both ' and " quotes`), /无法安全写入/);
});

test("bare values get truncated by inline comments, hence the quoting", async () => {
  const root = await mkdtemp(join(tmpdir(), "settings-env-"));
  await writeFile(join(root, ".env"), "BARE_KEY=裸值 # 行内注释\n", "utf8");
  delete process.env.BARE_KEY;
  process.loadEnvFile(join(root, ".env"));
  // 未加引号的裸值：# 之后被当注释截断（这正是写入侧统一加引号的原因）
  assert.equal(process.env.BARE_KEY, "裸值");
  delete process.env.BARE_KEY;
});
