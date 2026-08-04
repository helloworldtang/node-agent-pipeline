// 排版 Skill：Markdown → 微信公众号可用的「内联样式」HTML
// 主题借鉴 doocs/md 经典主题（见 ../theme/doocs-default.css，star>1K 的微信排版头号项目）
import MarkdownIt from "markdown-it";
import juice from "juice";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tool } from "langchain";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));
const THEME_CSS = readFileSync(resolve(__dirname, "../theme/doocs-default.css"), "utf8");

const md = new MarkdownIt({
  html: false,
  breaks: false,
  linkify: true,
});

/**
 * 把 Markdown 渲染为微信可粘贴的内联样式 HTML。
 * 流程对齐 doocs/md：markdown 渲染 → 外包容器 → juice 把 CSS 内联进 style=""（微信不支持外部/页内样式表）
 */
export function renderMarkdownToWeChatHtml(markdown: string): string {
  const inner = md.render(markdown);
  const wrapped = `<section class="md-output">\n${inner}</section>`;
  return juice.inlineContent(wrapped, THEME_CSS, { inlinePseudoElements: false });
}

/** 排版工具：挂在主 ReAct Agent 上，作为「Skill」能力的入口 */
export const formatWeChatTool = tool(
  async ({ markdown }) => {
    const html = renderMarkdownToWeChatHtml(markdown);
    return {
      html,
      chars: markdown.length,
      html_chars: html.length,
    };
  },
  {
    name: "format_wechat",
    description:
      "排版 Skill：把完整 Markdown 正文转成可直接粘贴进微信公众号编辑器的带样式 HTML（借鉴 doocs/md 经典主题，样式已内联）。返回 { html, chars, html_chars }。调用后请用一句话告知用户排版完成，切勿在回复里复述 HTML 内容。",
    schema: z.object({
      markdown: z.string().describe("要排版的完整 Markdown 正文（含标题/段落/列表/代码/引用等）"),
    }),
  }
);
