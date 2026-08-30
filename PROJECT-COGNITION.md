# node-agent-pipeline 项目认知与架构体系文档

本文档全面梳理与沉淀 `node-agent-pipeline` 项目的整体架构、核心设计理念、各模块技术实现、关键数据流及扩展机制。

---

## 1. 项目定位与核心价值

`node-agent-pipeline` 是一个专为**个人公众号文章持续生产、润色、管理与一键直投**打造的端到端生产流水线与工作台系统。

### 1.1 核心工作流
1. **探讨与取材**：支持用户将日常与 AI 探讨的记录或要点沉淀在本地笔记中（`materials/` 目录或直接输入），主控智能体优先基于本地笔记提炼核心观点，避免 AI 无根基的泛泛而谈。
2. **高质量写作与排版**：采用主控智能体（ReAct）+ 写作子智能体（SubAgent，上下文隔离，高质量 Pro 模型）分层协同，结合基于 doocs/md 的 CSS 样式自动内联技术，一键生成符合微信公众号视觉排版规范的 HTML。
3. **确定性质量闭环**：通过外层 Harness 状态图（StateGraph）提供入口与出口防护栏（Guardrails）、确定性规则校验器（Validator）以及轻量级局部修订节点（Refine），确保产出质量与稳定性。
4. **官方 API 一键直投**：直连微信公众号官方开放平台接口（支持多账号管理），实现永久封面上传缓存、正文插图自动转存微信图床、草稿箱一键投递与幂等防重。
5. **全生命周期管理**：提供基于 Node.js 原生 `node:sqlite` + 文件夹落盘的双层文章管理、正文多版本比对与回滚、AI 智能封面设计与生成、SSE 实时运行日志流以及轻量级 Web 控制台。

---

## 2. 系统全局架构与分层设计

系统整体采用**分层解耦、原生轻量（KISS 原则）、健壮优先**的设计：

```
+-------------------------------------------------------------------------------+
|                                Web 控制台                                     |
|           (React 18 + TypeScript + Vite + SSE 实时流 + 差异对比回滚)             |
+-------------------------------------------------------------------------------+
                                      │ HTTP / SSE
+-------------------------------------------------------------------------------+
|                              Web 服务与 API 层                                 |
|      (node:http 零第三方框架、进程并发控制、流式上传、安全沙箱、API Token 鉴权)     |
+-------------------------------------------------------------------------------+
                                      │ 触发运行 / CLI 驱动
+-------------------------------------------------------------------------------+
|                       HarnessAgent 状态机与质量守护层                         |
|   ┌───────────────────────────────────────────────────────────────────────┐   |
|   │ input_guardrail  ──>  react (主控)  ──>  validator                    │   |
|   │       │                     │                 │ (未通过且未超限)       │   |
|   │       │ (非法)              │ (产出正文/HTML)  ▼                       │   |
|   │       ▼                     │               refine (轻量修稿+重排版)    │   |
|   │      END                    ▼                 │                       │   |
|   │   output_guardrail <────────┴─────────────────┘ (通过/超限降级)       │   |
|   └───────────────────────────────────────────────────────────────────────┘   |
+-------------------------------------------------------------------------------+
        │                                                     │
        ▼                                                     ▼
+───────────────────────────+                         +─────────────────────────+
|      Agent 协同层         |                         |       工具与能力层       |
| 1. ReAct 主控 Agent       |                         | 1. Format Skill (排版)  |
|    - 任务拆解与编排       | ── 委托写作 (隔离上下文) ─> | 2. Materials (素材管理)  |
| 2. Writer SubAgent        |                         | 3. Publish (发布门面)   |
|    - Pro 模型独立写长文   |                         | 4. Cover/ImageGen (生图)|
| 3. Refiner 修订器         |                         | 5. Quality (质量核验)   |
+───────────────────────────+                         +─────────────────────────+
                                                              │
                                                              ▼
+-------------------------------------------------------------------------------+
|                           底层发布抽象与存储适配层                             |
|  - Publisher 抽象 (WeChat 官方 API 实现：Token 缓存 / 封面插图哈希缓存 / 草稿添加) |
|  - 存储双层设计：output/<id>/ 物理文件夹 + Node.js 原生 SQLite 索引元数据数据库     |
|  - LLM 工厂：支持 DeepSeek / Moonshot(Kimi) / 任意 OpenAI 兼容服务无缝切换       |
+-------------------------------------------------------------------------------+
```

---

## 3. 核心机制与模块剖析

### 3.1 HarnessAgent：状态机与质量防护回路
- **状态统一管理 (`src/harness/state.ts`)**：定义了 `messages`、`topic`、`notes`、`retryCount`、`article`、`html`、`valid`、`inputOk`、`outputOk`、`publishOk`、`status`（`success` / `degraded` / `failed`）等核心字段。
- **单层 Checkpointer 机制 (`src/harness/graph.ts`)**：仅在外层 Harness 挂载 `MemorySaver`，内层主控 Agent 不挂 Checkpointer，避免了嵌套状态覆盖和持久化冲突。
- **确定性校验与局部精修 (`src/harness/nodes.ts`)**：
  - `inputGuardrail`：拦截过短（<2字）或过长（>200字）的不合法选题。
  - `validator`：进行字数（`MIN_ARTICLE_LEN`）、必选小节（`REQUIRED_SECTIONS`）的确定性检查。
  - `refineNode`：若校验不通过且未达最大重试（`MAX_RETRIES`），仅将当前草稿与错误反馈送入修稿器，只修有问题的部分并直接重新排版，**无需重复运行主控 ReAct Agent**，大幅节省 Token 与耗时。
  - `outputGuardrail`：检查 HTML 结构完整性、正文存在性以及质量规则（`inspectArticleQuality`），给出最终的运行状态。

### 3.2 双层 Agent 架构与上下文隔离
- **主控 Agent (`src/agents/reactAgent.ts`)**：
  - 基于 LangChain.js v1 的 `createAgent`，选用快、function-calling 稳定的 Flash 级别模型（如 DeepSeek V4 Flash 或 Kimi 2.5）。
  - 主控仅负责战略决策：提炼素材 -> 委托写作 -> 请求排版 -> 请求发布。
- **写作 SubAgent (`src/agents/writerAgent.ts`)**：
  - 独立创建 Agent 并包装为 `delegate_to_writer` 工具提供给主控。
  - 选用创作能力更强的 Pro 级别模型（如 DeepSeek V4 Pro 或 Kimi 2.6），并内置模型不可用时的 Flash 降级容灾。
  - 独立分配 `thread_id`，隔离长文生成的大量 Token，保证主控上下文干净清爽。

### 3.3 微信排版 Skill (`src/tools/formatSkill.ts`)
- 基于 `markdown-it` 解析 Markdown，并读取 `theme/doocs-default.css` 经典主题。
- 使用 `juice.inlineContent` 将 CSS 样式计算并直接内联到每个 HTML 元素的 `style` 属性中。
- 生成的 HTML 无论直接用于微信官方草稿 API，还是复制到富文本编辑器中，均能保持完整样式。

### 3.4 微信官方发布引擎 (`src/publishers/wechat.ts`)
- **平台解耦设计**：通过 `Publisher` 统一接口（`types.ts`）与注册中心（`registry.ts`），未来可无缝扩展知乎、掘金、微信小报童等平台。
- **Token 智能缓存**：内存缓存 `access_token`，并在过期前 5 分钟自动提前刷新。
- **封面与插图按哈希永久缓存**：
  - 微信草稿封面要求必须使用永久素材接口（`material/add_material`），系统计算图片 MD5 结合 AppID 缓存至 `.wechat-cover-cache.json`，同一封面永不重复上传。
  - 正文中的本地相对路径插图（如 `![](images/pic.png)`）在投递前会自动扫描，通过 `media/uploadimg` 上传至微信 CDN 图床并自动替换 HTML 中的 `src`，同样使用 `.wechat-img-cache.json` 进行哈希去重缓存。
- **幂等防重投机制**：结合发布平台、账号、标题、内容生成幂等键，避免误操作导致重复创建草稿。

### 3.5 双层存储与版本历史 (`src/articles.ts`, `src/article-db.ts`)
- **物理文件存储**：每个文章实体对应独立文件夹 `output/<article-id>/`：
  - `article.md`（正文 Markdown）
  - `article.html`（排版后 HTML）
  - `cover.<ext>`（封面图片）
  - `images/`（本地插图存放目录）
  - `readme.log`（流转、编辑与投递日志）
  - `run.json`（运行指标、Token 消耗、耗时记录）
  - `history/`（历史版本快照）
- **SQLite 索引元数据**：
  - 选用 Node 22 原生 `node:sqlite`（无第三方原生编译依赖）。
  - 开启 WAL 模式、外键关联、索引优化，负责文章列表、投递记录的高效检索与增量同步。
  - **支持灾难恢复**：若 SQLite 数据库被删除，服务重启时可自动扫描 `output/` 文件夹重建完整索引。
- **版本比对与回滚**：编辑文章保存前自动生成历史快照，前端可逐行计算 LCS Diff 比对并支持一键回滚。

### 3.6 安全与运维控制 (`src/server.ts`, `src/settings.ts`)
- **零框架 HTTP 服务**：采用 Node.js 原生 `node:http` 实现，极简低开销。
- **安全防线**：
  - 严格限制默认仅监听本机回环地址（`127.0.0.1`）；若需开放外部监听，强制要求配置 `API_TOKEN`。
  - 所有文件读写操作均通过 `isInsideDir` 校验，杜绝路径穿越（Path Traversal）与符号链接逃逸。
  - 请求体大小硬性限制（`API_MAX_BODY_BYTES`），图片上传采用文件流直接落地。
- **任务并发与进程治理**：
  - 限制单流水线并发（`MAX_CONCURRENT_RUNS`），防止并发耗尽 API 速率。
  - 支持通过 Web 界面中断当前后台子进程。
- **配置热生效**：设置修改即时写入 `.env` 并同步 `process.env`，敏感 API Key 自动掩码保护。

---

## 4. 关键数据流转图

### 4.1 文章生产全链路时序
```
[用户/Web/CLI]
      │ 输入：选题 topic + 可选素材 notes + 可选发布账号
      ▼
[Harness: inputGuardrail] ──(校验不合法)──> [结束: Status=failed]
      │ (校验合法)
      ▼
[Harness: reactNode]
      │  Thought: 分析素材需求
      ├─> (可选) 调用 list_materials / read_material 读取本地素材
      │  Thought: 规划大纲并委托写作
      ├─> 调用 delegate_to_writer ──> [Writer SubAgent (Pro模型)] ──> 返回完整 Markdown
      │  Thought: 执行排版
      ├─> 调用 format_wechat ──> [Format Skill (doocs/md + juice)] ──> 返回内联 HTML
      │  (可选) Thought: 执行草稿发布
      └─> 调用 publish_article ──> [WeChat Publisher] ──> 上传素材并建草稿
      ▼
[Harness: validator] ──(字数/结构不足 且 retryCount < MAX_RETRIES)──> [Harness: refineNode]
      │ (校验通过 或 达到重试上限)                                              │ (修订正文+重新排版)
      ▼                                                                        │
[Harness: outputGuardrail] <───────────────────────────────────────────────────┘
      │ 终验正文、HTML有效性及质量问题
      ▼
[落盘存储 & SQLite 索引更新] ──> output/<id>/ (article.md / article.html / readme.log / run.json)
```

---

## 5. 项目工程结构映射表

```
node-agent-pipeline/
├── config/
│   ├── accounts.example.json   # 微信公众号账号配置模版
│   └── accounts.json           # 微信公众号账号实名配置（AppID, AppSecret, 默认封面）
├── covers/                     # 默认封面图库与生成封面存放目录
├── materials/                  # 本地素材与探讨笔记目录（支持 .md / .txt）
├── output/                     # 文章物理存储目录、SQLite 数据库及缓存文件
│   ├── <article-id>/           # 单篇文章全量资产（md/html/cover/images/log/run/versions）
│   ├── articles.sqlite         # 文章元数据与版本索引 SQLite 数据库
│   ├── deliveries.jsonl        # 投递历史日志
│   ├── .wechat-cover-cache.json# 微信封面永久素材 media_id 缓存
│   └── .wechat-img-cache.json  # 微信正文插图 URL 缓存
├── src/
│   ├── agents/
│   │   ├── reactAgent.ts       # 主控 ReAct Agent 装配
│   │   └── writerAgent.ts      # 写作 SubAgent 与修稿器（上下文隔离）
│   ├── harness/
│   │   ├── graph.ts            # LangGraph 状态图组装与 Checkpointer
│   │   ├── nodes.ts            # 防护栏、校验器、修稿等核心节点实现
│   │   └── state.ts            # Harness 全局状态 Schema 定义
│   ├── publishers/
│   │   ├── registry.ts         # 发布平台注册中心
│   │   ├── types.ts            # Publisher 抽象接口定义
│   │   └── wechat.ts           # 微信公众号官方 API 发布实现
│   ├── tools/
│   │   ├── coverDesign.ts      # 基于 LLM 的文章封面画面提示词提取
│   │   ├── formatSkill.ts      # 排版工具（Markdown -> 内联 CSS HTML）
│   │   ├── imagegen.ts         # 通用 OpenAI 兼容 AI 生图客户端
│   │   ├── materials.ts        # 本地素材读取与列表工具
│   │   ├── mcp.ts              # 通用 MCP 工具动态挂载
│   │   ├── publish.ts          # 发布工具包装与幂等记录
│   │   └── quality.ts          # 轻量级确定性质量规则检查
│   ├── util/
│   │   ├── files.ts            # 原子化文件写入与复制
│   │   ├── http.ts             # 带重试和超时的 HTTP 客户端
│   │   ├── messages.ts         # LangChain 消息解析工具
│   │   └── paths.ts            # 路径边界安全检查
│   ├── article-db.ts           # 基于 node:sqlite 的文章元数据索引数据库
│   ├── articles.ts             # 文章库物理文件管理与版本维护
│   ├── config.ts               # 全局环境变量与预设配置
│   ├── index.ts                # CLI 命令行运行入口
│   ├── llm.ts                  # LLM 客户端工厂（支持多供应商切换与降级）
│   ├── server.ts               # Web 后端服务（原生 node:http + SSE + REST API）
│   └── settings.ts             # 运行时配置读写与 .env 热更新
├── test/
│   ├── article-db.test.ts      # SQLite 数据库单元测试
│   └── regression.test.ts      # Harness 回归测试与路径安全测试
├── web/                        # Web 前端控制台源码 (Vite + React + TS)
│   ├── src/
│   │   ├── App.tsx             # 控制台主界面与交互逻辑
│   │   ├── api.ts              # API 通信层与 SSE 订阅
│   │   ├── styles.css          # 前端样式表
│   │   └── main.tsx            # React 挂载入口
│   └── vite.config.ts          # Vite 配置文件（开发代理与端口）
├── PROJECT-COGNITION.md        # 项目认知与架构体系文档
├── PROJECT-DIFFERENCES.md      # 与原项目对比差异说明
├── package.json                # 项目依赖与启动脚本
├── tsconfig.json               # TypeScript 编译配置
└── README.md                   # 快速上手与使用文档
```

---

## 6. 当前系统认知小结

1. **架构成熟度**：整个项目摆脱了外部黑盒知识库的强依赖，演化为一个闭环、可本地化独立运行、且具备生产可用性的个人公众号生产工作台。
2. **扩展性极佳**：LLM 供应商（DeepSeek/Moonshot/OpenAI 兼容）、生图供应商（通义万相/火山豆包/智谱等）、发布平台（WeChat/知乎等）、素材输入方式（本地/Inline/MCP）均已高度模块化解耦。
3. **安全与健壮性**：具有完备的路径沙箱检查、原子写入、Token 刷新/封面缓存容错、确定性校验循环与优雅降级机制。
