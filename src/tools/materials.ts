// 素材工具：替代原项目的 exomind MCP「取材」环节
// 两种素材来源：
//   ① 启动时注入：--notes 文件 / materials/ 目录内容直接写进初始消息（index.ts 完成）
//   ② 运行中按需读取：list_materials / read_material 两个工具，agent 自己翻 materials/ 目录
import { readdir, readFile } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { tool } from "langchain";
import { z } from "zod";
import { MATERIALS_DIR, MAX_MATERIAL_CHARS } from "../config.ts";
import { isInsideDir } from "../util/paths.ts";

const TEXT_EXT = new Set([".md", ".txt", ".markdown"]);

async function listMaterialFiles(): Promise<string[]> {
  try {
    const entries = await readdir(MATERIALS_DIR, { withFileTypes: true });
    return entries
      .filter(
        (e) =>
          e.isFile() &&
          TEXT_EXT.has(extname(e.name).toLowerCase()) &&
          e.name.toLowerCase() !== "readme.md", // 目录说明书不算素材
      )
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** 启动时加载素材：汇总 materials/ 目录全部文本文件（供 index.ts 注入初始消息） */
export async function loadMaterialsFromDir(maxChars = MAX_MATERIAL_CHARS): Promise<string> {
  const files = await listMaterialFiles();
  if (files.length === 0) return "";
  const parts: string[] = [];
  let used = 0;
  for (const f of files) {
    const text = (await readFile(join(MATERIALS_DIR, f), "utf8")).trim();
    if (!text || used >= maxChars) continue;
    const prefix = `【素材：${f}】\n`;
    const remaining = Math.max(0, maxChars - used - prefix.length);
    const clipped = text.slice(0, remaining);
    parts.push(`${prefix}${clipped}`);
    used += prefix.length + clipped.length;
    if (clipped.length < text.length) {
      parts.push(`【素材上下文已限制为 ${maxChars} 字符；其余内容可用 read_material 按需读取】`);
      break;
    }
  }
  return parts.join("\n\n");
}

export const listMaterialsTool = tool(
  async () => {
    const files = await listMaterialFiles();
    return {
      dir: MATERIALS_DIR,
      files,
      hint: files.length > 0 ? "用 read_material 读取需要的文件" : "素材目录为空",
    };
  },
  {
    name: "list_materials",
    description: "列出本地素材目录 materials/ 里的笔记文件（.md/.txt）。写作前可先看看有哪些素材。",
    schema: z.object({}),
  },
);

export const readMaterialTool = tool(
  async ({ filename }) => {
    // 防目录穿越：只允许读素材目录内的文件
    const path = resolve(MATERIALS_DIR, filename);
    if (!(await isInsideDir(path, MATERIALS_DIR))) throw new Error("只允许读取素材目录内的文件");
    const content = await readFile(path, "utf8");
    return { filename, chars: content.length, content };
  },
  {
    name: "read_material",
    description:
      "读取素材目录里的某个笔记文件全文。先 list_materials 看有哪些文件，再按文件名读取。",
    schema: z.object({ filename: z.string().describe("素材文件名，如 notes.md") }),
  },
);
