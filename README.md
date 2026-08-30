# node-agent-pipeline：个人公众号文章生产工作台

个人公众号文章生产流水线。在原有 ReAct、Harness、SubAgent 和排版 Skill 架构基础上，去掉了对 exomind 私有服务的默认依赖：

- **取材**：改为本地素材笔记（`materials/` 目录 / `--notes` 文件），适配「和 AI 探讨 → 整理结论 → 写成自己理解的版本」的工作流；可选挂任意 MCP server 补充检索
- **发布**：直连微信公众号官方 API（AppID/AppSecret 按账号配置），抽象了 Publisher 接口，未来可扩展知乎/掘金等平台
- **LLM**：DeepSeek / Kimi(Moonshot) / 任意 OpenAI 兼容服务可切换，key 与模型名均可配
- **校验**：规则全部走环境变量，默认不强制固定文章结构

## 架构

```
START → input_guardrail ──过──→ react → validator ──不过──→ refine（只修当前草稿，最多 MAX_RETRIES 次）
                 │拒                                   │过
                 ▼                                     ▼
                END ←────────── output_guardrail ←─────┘

react（主控 ReActAgent）的工具：
  ① list_materials / read_material   ← 本地素材笔记
  ② [MCP 动态工具]                   ← 可选，设了 MCP_COMMAND 才启用
  ③ delegate_to_writer               ← 写作 subagent（pro 模型，上下文隔离）
  ④ format_wechat                    ← 排版 Skill（markdown-it + juice 内联，doocs/md 主题）
  ⑤ publish_article                  ← 可选，指定发布账号才注册
```

## 快速开始

```bash
pnpm install
cp .env.example .env          # 填入 LLM_API_KEY
```

运行环境需要 Node.js 22.5+（使用内置 `node:sqlite` 保存文章索引）。

启动 Web 控制台：

```bash
cd web
npm install
npm run dev
```

默认访问地址为 `http://127.0.0.1:7101/`，API 地址为 `http://127.0.0.1:7302/`。可用 `VITE_WEB_PORT`、`VITE_API_PORT` 或 API 的 `PORT` / `--port` 参数覆盖默认端口。

### 1. 只生成，不发布（最常用）

```bash
# 凭模型自身知识写
node src/index.ts "为什么 HTTPS 握手需要两次往返"

# 带素材笔记写（推荐）：先把和 AI 探讨的结论存成笔记
node src/index.ts "为什么 HTTPS 握手需要两次往返" --notes materials/https-notes.md
```

产出留底：`output/<文章 ID>/article.md`、`article.html`、`readme.log`、`run.json`；即使正文缺失，运行级记录仍写入 `output/runs/<thread>.json`。

### 2. 生成并自动投递公众号草稿箱

先配置账号：

```bash
cp config/accounts.example.json config/accounts.json
# 编辑 accounts.json 填入 AppID / AppSecret / 封面图路径
```

> 前提：在公众号后台「设置与开发 → 基本配置」把本机公网 IP 加入 **IP 白名单**；
> 封面图是微信草稿的必填项，放一张图到 `covers/` 并在配置里指向它。

```bash
node src/index.ts "选题" --notes 笔记.md --publish 我的公众号
```

### 3. 直发已有稿件（不起 Agent，不需要 LLM key）

```bash
node src/index.ts --publish-file output/<文章ID>/article.md --title "文章标题" --account 我的公众号
```

实际生成的文章位于 `output/<文章ID>/article.md`。直发 Markdown 中的 `images/foo.png` 会按 Markdown 文件所在目录解析，并在投递时自动上传到微信图床。


### Web API 安全

默认只监听 `127.0.0.1`。如果使用 `--host 0.0.0.0` 或其他远程地址，必须先配置 `API_TOKEN`，否则服务不会启动：

```dotenv
API_TOKEN=一段足够长的随机字符串
```

使用 Web 控制台时，可参考 `web/.env.example` 在 `web/.env` 配置同一个 `VITE_API_TOKEN`。请求体有大小限制，图片上传使用原始文件流；任务默认只允许并发运行一个，可通过 Web 的“取消任务”终止后台子进程。

### 封面图

- 微信草稿必须有封面。账号配置里的 `cover` 是默认封面（已附一张生成的 `covers/default.png`），**同一张图只会上传一次**（按文件哈希持久缓存），不会反复占用素材库。
- 单篇指定封面：`--cover covers/某张图.png`（或环境变量 `PUBLISH_COVER`），优先级高于账号默认。
- 注意：微信草稿的封面必须走**永久素材**接口，「临时素材」3 天过期、不能用于草稿，所以没有采用临时上传方案。
- 想给某篇文章生成专属封面：直接对我说"给选题 X 生成封面"即可（内置图像生成），存到 `covers/` 后用 `--cover` 指定。

## 切换模型

`.env` 里改 `LLM_PROVIDER` 即可：

| provider | baseURL | 默认模型 | 备注 |
|---|---|---|---|
| `deepseek`（默认） | api.deepseek.com | v4-flash / v4-pro | |
| `moonshot` | api.moonshot.cn | kimi-k2.5 / kimi-k2.6 | 开放平台按量付费 |
| `custom` | 自定义 | 自定义 | 需配 `LLM_BASE_URL` / `LLM_MODEL_FLASH` / `LLM_MODEL_PRO` |

模型名、校验阈值（`MIN_ARTICLE_LEN`、`REQUIRED_SECTIONS`、`MAX_RETRIES`）和质量检查（摘要、引用、敏感词）等全部可用环境变量覆盖，见 `.env.example`。

## 文章索引与版本

Web 服务首次启动时会扫描一次 `output/`，将文章元数据、历史版本和旧版 `deliveries.jsonl` 发布记录同步到 `output/articles.sqlite`。之后文章列表、版本列表和发布记录直接从 SQLite 查询；正文、HTML、封面和历史正文仍保存在原有文件夹中，数据库损坏或删除后可通过重启服务从文件重建。

文章库中的删除操作会将文章文件夹移动到 `output/.trash/<文章 ID>/`，不会立即删除正文、历史版本、封面或日志。Web 控制台的“回收站”可以查看已移入的文章并恢复；恢复时若文章库中已存在同 ID 文章，会拒绝覆盖。

文章编辑、回滚、封面变更和发布会增量更新索引。Web 页面现在支持查看版本列表、逐行比较差异和确认回滚；版本 API 仍可通过 `/api/articles/<id>/versions` 使用，单个版本正文可通过 `/api/articles/<id>/versions/<version>` 读取。

如需把索引数据库放到其他位置，可配置 `ARTICLE_DB_FILE`（相对项目根目录解析）。

## 扩展新发布平台

1. 在 `src/publishers/` 新建 `<platform>.ts`，实现 `Publisher` 接口（`types.ts`）；
2. 在 `registry.ts` 里注册一行。

微信公众号实现（`wechat.ts`）可作参考：gettoken（缓存）→ add_material 传封面（按哈希持久缓存）→ draft/add。

## 类型检查

```bash
pnpm typecheck

# 回归测试
pnpm test
```
