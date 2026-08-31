import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadMaterialsFromDir } from "../tools/materials.ts";

export interface CollectNotesOptions {
  inline?: string;
  notesFile?: string;
  /** Web runs pass false so only explicitly supplied notes are used. */
  includeDirectory?: boolean;
  /** Optional injection point for tests or callers that already loaded directory notes. */
  directoryNotes?: string;
}

export function shouldAutoLoadMaterials(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUTO_LOAD_MATERIALS !== "0";
}

/** Collect explicit notes and, when enabled, the CLI's implicit materials directory notes. */
export async function collectNotes(options: CollectNotesOptions = {}): Promise<string> {
  const parts: string[] = [];
  const inline = (options.inline ?? "").trim();
  if (inline) parts.push(`【探讨笔记】\n${inline}`);

  if (options.notesFile) {
    const text = (await readFile(resolve(process.cwd(), options.notesFile), "utf8")).trim();
    if (text) parts.push(`【笔记：${options.notesFile}】\n${text}`);
  }

  if (options.includeDirectory ?? shouldAutoLoadMaterials()) {
    const dirNotes = options.directoryNotes ?? (await loadMaterialsFromDir());
    if (dirNotes) parts.push(dirNotes);
  }
  return parts.join("\n\n");
}
