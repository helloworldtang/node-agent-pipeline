// 发布平台注册表：platform 名 → Publisher 工厂
// 未来扩展新平台（知乎/掘金/Newsletter…）：实现 Publisher 接口后在这里加一行即可
import type { Publisher } from "./types.ts";
import { createWechatPublisher } from "./wechat.ts";
import { createExomindPublisher } from "./exomind.ts";

type PublisherFactory = (account: string) => Publisher;

const registry: Record<string, PublisherFactory> = {
  wechat: createWechatPublisher,
  exomind: createExomindPublisher,
};

export function listPlatforms(): string[] {
  return Object.keys(registry);
}

export function getPublisher(platform: string, account: string): Publisher {
  const factory = registry[platform];
  if (!factory) {
    throw new Error(`未知发布平台 "${platform}"，当前支持：${listPlatforms().join(", ")}`);
  }
  return factory(account);
}
