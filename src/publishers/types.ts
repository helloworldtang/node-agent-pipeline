// 发布抽象层：所有平台共用同一接口，新增平台只需实现 Publisher 并注册进 registry
export interface PublishInput {
  title: string;
  markdown: string; // Markdown 正文（留底/备用）
  html: string; // 已内联样式的 HTML（平台编辑器直接使用）
  /** 可选：本次发布专用的封面图路径，优先级高于账号配置里的 cover */
  coverPath?: string;
  /** 可选：文章文件夹路径，用于解析正文里的本地插图（![](images/xxx.png)） */
  baseDir?: string;
}

export interface PublishResult {
  platform: string;
  account: string;
  /** 平台侧返回的草稿/文章 id */
  id: string;
  /** 可选：平台返回的详情链接或附加信息 */
  extra?: Record<string, unknown>;
}

export interface Publisher {
  readonly platform: string;
  publish(input: PublishInput): Promise<PublishResult>;
}
