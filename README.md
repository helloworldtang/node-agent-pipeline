# node-agent-pipeline

用 **Node 生态 Agent 框架最新版（LangChain.js + LangGraph.js）** 跑通一条端到端的「公众号文章生产流水线」，把五个零件串起来，并闭环到「投草稿箱」：

| 零件 | 实现 | 代码位置 |
|---|---|---|
| **ReActAgent** | `createAgent`(flash) + 工具集，Thought→Action→Observation 循环 | `src/agents/reactAgent.ts` |
| **HarnessAgent** | 外层 StateGraph：防护栏 + 验证循环 + MemorySaver(上下文管理) | `src/harness/{state,nodes,graph}.ts` |
| **DeepSeek** | `ChatOpenAI` 走 OpenAI 兼容协议；flash 主控、pro 写作 | `src/llm.ts` |
| **Skill（排版）** | 自建 markdown-it + juice 内联渲染器，主题借鉴 doocs/md（star>1K） | `src/tools/formatSkill.ts` + `src/theme/doocs-default.css` |
| **MCP** | `@langchain/mcp-adapters` stdio 拉 `exomind mcp`，工具动态发现 | `src/tools/mcp.ts` |
| **subagent（写作）** | 独立 `createAgent`(pro)，用 `tool()` 包成 `delegate_to_writer` | `src/agents/writerAgent.ts` |
| **发布（可选闭环）** | `publish_wechat`：`POST /drafts` 注入正文 + `exomind draft wechat` | `src/tools/publishWechat.ts` |

## 流程

```
                HarnessAgent（外层 StateGraph + MemorySaver）
 ┌────────────────────────────────────────────────────────────┐
 │  防栏(入) → ReAct → 验证器 ──不过,带反馈回退──┐            │
 │                │ 通过                         │            │
 │                ▼                              │            │
 │           防栏(出) → END                      │            │
 └────────────────────────────────────────────────────────────┘
       ReActAgent 的工具:
         ① exomind MCP (search/query/entity/...)   ← 取素材
         ② delegate_to_writer                      ← 写作 subagent(pro)
         ③ format_wechat                           ← 排版 Skill
         ④ publish_wechat  (设 PUBLISH_ACCOUNT 才挂) ← 投草稿箱(闭环)
```

校验循环节点（`validator`）首轮强制精修一次（稳定演示一次打回），之后做真实校验（含「## 小结」+ ≥600 字），未过则带反馈回退到 react 重写，最多 `MAX_RETRIES` 次。

## 运行

前置：
- Node ≥ 23.6（用原生类型剥离直接跑 `.ts`，无需 tsx/babel）
- 环境变量 `DEEPSEEK_API_KEY` 已设置
- `exomind` CLI 已 `exomind login`（MCP 与 publish_wechat 复用其凭证）

```bash
pnpm install

# 默认：取材 → 写作 → 排版 → 落盘（不投公众号）
node src/index.ts "你的选题"

# 闭环：多一步，排版后自动投到指定公众号草稿箱
PUBLISH_ACCOUNT=ailang node src/index.ts "你的选题"
```

产出：`output/<时间戳>.md`（正文）+ `output/<时间戳>.html`（可直接粘贴进公众号编辑器）。设了 `PUBLISH_ACCOUNT` 时还会多一条草稿箱记录（`media_id` 前缀 `T1NF4457...` 表示真投成功）。

类型检查：`pnpm typecheck`

## exomind 在 demo 里承担的角色

> [**exomind**](https://github.com/helloworldtang/exomind-cli) 是一个跨平台知识库命令行客户端，通过 REST 与 ExoMind 知识库交互，提供 `ingest/query/search/entity/relations/stats` 等能力，也支持 `exomind mcp` 作为 stdio MCP server 接入 Agent，以及 `exomind draft wechat` 把草稿投递到微信公众号。本 demo 复用它做「取材」和「投递」。
>
> exomind CLI 默认连接 ExoMind 服务端 **<https://youhuale.cn/>** ——ExoMind 的官网与 Web 端，一个「个人知识复利引擎」：自动知识图谱、AI 跨域问答、FSRS-5 间隔复习，支持 Web / MCP / CLI 全链路接入。本 demo 通过 exomind CLI / MCP 调用的就是它的 API（CLI 需先 `exomind login` 配置凭证）。

- **进口（检索取材）**：`exomind mcp` 经 MCP 暴露 `search/query/entity/relations/ingest/stats`，主控 ReAct 在取材阶段调用。
- **出口（投递发布）**：`publish_wechat` 工具调 `POST /drafts` 注入正文 + `exomind draft wechat` 复用其「AI 出封面 + 调微信」链路。

两端都用上 exomind，流水线闭环。

## 关键技术决策 & 避坑

- **`createReactAgent`（`@langchain/langgraph/prebuilt`）在 LangGraph v1 已弃用** → 用 `langchain` 包的 `createAgent`（仍是 ReAct 模式）。注意系统提示词字段是 **`systemPrompt`**，不是 `prompt`/`messageModifier`。
- **DeepSeek 经 `@langchain/openai` 的 `ChatOpenAI` 接入**：`configuration: { baseURL: "https://api.deepseek.com/v1" }`，`model` 用 `deepseek-v4-flash` / `deepseek-v4-pro`（V4 时代，无 V3/R1）。
- **MCP 工具动态发现**：`MultiServerMCPClient({ exomind: { transport:"stdio", command:"exomind", args:["mcp"] } }).getTools()`，无需硬编码工具名；进程结束前 `client.close()` 防子进程泄漏。
- **subagent = 隔离上下文的子 agent**：写作子 agent 用独立 `thread_id`，主 ReAct 通过 `delegate_to_writer` 工具调用它。
- **HarnessAgent 的 checkpointer 只挂外层图**，内层 `createAgent` 不挂，避免双重 checkpoint。
- **publish_wechat 受 `PUBLISH_ACCOUNT` 控制**：默认不注册（避免每次跑都往草稿箱堆文章）；复用 exomind 的 `POST /drafts`（注入正文，CLI 没有 import 正文这步走 HTTP）+ `exomind draft wechat`（复用其出封面/调微信，这步走 child_process）。
- **排版 Skill 借鉴 doocs/md**：doocs/md 的 `@md/core` 是 private、`md-cli` 是 web 服务，不便直接调用；故自建 markdown-it 渲染 + juice 内联（微信不支持外部样式表），主题 CSS 解析了 doocs 的 CSS 变量。
- **替代方案（未采用）**：doocs/md 自带 `packages/mcp-server`，暴露 `render_markdown` 工具可直接把 Markdown 转 styled HTML；若要让「排版」本身也走 MCP，可用它替代自建渲染器。
- DeepSeek 的 `withStructuredOutput` 不稳，故校验器走**确定性规则**（长度 + 必需结构），不用结构化输出。
- 微信图文正文硬限 **20000 字符**（md 渲染 HTML 膨胀约 2.5x，代码块是大头），写公众号稿要控制代码块数量与篇幅。
