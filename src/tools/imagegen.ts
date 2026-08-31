// AI 生图：OpenAI 兼容 /images/generations 协议的通用客户端
// 一份代码覆盖多家供应商，只需在 .env 配置三项：
//   IMAGE_API_KEY   供应商的 API Key
//   IMAGE_BASE_URL  接口地址（不含 /images/generations）
//   IMAGE_MODEL     模型名
// 已验证可用的供应商配置（任选其一）：
//   阿里百炼·通义万相  IMAGE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
//                      IMAGE_MODEL=wanx2.1-t2i-turbo   （国内直连，按张计费，便宜）
//   火山方舟·豆包Seedream IMAGE_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
//                      IMAGE_MODEL=doubao-seedream-4-0-250828
//   智谱 CogView       IMAGE_BASE_URL=https://open.bigmodel.cn/api/paas/v4
//                      IMAGE_MODEL=cogview-3-plus
//   OpenAI            IMAGE_BASE_URL=https://api.openai.com/v1
//                      IMAGE_MODEL=gpt-image-1         （需海外网络）
// IMAGE_SIZE 可选，各家写法不同（万相 "1024*1024"，OpenAI/方舟 "1024x1024"），留空用供应商默认
import { IMAGE_API_KEY, IMAGE_BASE_URL, IMAGE_MODEL, IMAGE_SIZE, HTTP_RETRIES, HTTP_TIMEOUT_MS } from "../config.ts";
import { atomicWriteFile } from "../util/files.ts";
import { fetchWithRetry } from "../util/http.ts";

interface ImagesResponse {
  data?: { b64_json?: string; url?: string }[];
  error?: { message?: string };
  message?: string;
}

/** 生成一张图并保存到 outPath，返回保存路径。配置在调用时动态读取，界面改动即时生效 */
export async function generateImage(
  prompt: string,
  outPath: string,
  sizeOverride?: string,
): Promise<string> {
  const apiKey = process.env.IMAGE_API_KEY ?? IMAGE_API_KEY;
  const baseURL = (process.env.IMAGE_BASE_URL ?? IMAGE_BASE_URL).replace(/\/$/, "");
  const model = process.env.IMAGE_MODEL ?? IMAGE_MODEL;
  const size = sizeOverride ?? process.env.IMAGE_SIZE ?? IMAGE_SIZE;
  if (!apiKey) {
    throw new Error(
      "未配置生图 API：点右上角「⚙ 设置」填写 IMAGE_API_KEY，或在 .env 手动配置（可选供应商见 src/tools/imagegen.ts 头部注释）",
    );
  }
  const body: Record<string, unknown> = { model, prompt };
  if (size) body.size = size;

  const res = await fetchWithRetry(`${baseURL}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  }, { retries: HTTP_RETRIES, retryPost: true, timeoutMs: HTTP_TIMEOUT_MS, label: "AI 生图" });
  const data = (await res.json()) as ImagesResponse;
  const item = data.data?.[0];
  if (!res.ok || !item) {
    throw new Error(
      `生图失败（HTTP ${res.status}）：${data.error?.message ?? data.message ?? JSON.stringify(data).slice(0, 200)}`,
    );
  }

  let buf: Buffer;
  if (item.b64_json) {
    buf = Buffer.from(item.b64_json, "base64");
  } else if (item.url) {
    const img = await fetchWithRetry(item.url, {}, { retries: HTTP_RETRIES, timeoutMs: HTTP_TIMEOUT_MS, label: "下载生成图" });
    if (!img.ok) throw new Error(`下载生成图失败：HTTP ${img.status}`);
    buf = Buffer.from(await img.arrayBuffer());
  } else {
    throw new Error("生图接口返回格式不识别（既无 b64_json 也无 url）");
  }

  await atomicWriteFile(outPath, buf);
  return outPath;
}
