import { dirname, isAbsolute, relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";

function isRelativeInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return (
    rel === "" || (rel !== ".." && !rel.startsWith(`..${requireSeparator()}`) && !isAbsolute(rel))
  );
}

function requireSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

/**
 * Check both lexical containment and the resolved filesystem path.
 * This rejects sibling-prefix paths (foo-bar) and symlinks escaping root.
 * For a not-yet-created target, the nearest existing parent is checked.
 */
export async function isInsideDir(candidate: string, root: string): Promise<boolean> {
  const rootAbs = resolve(root);
  const candidateAbs = resolve(candidate);
  if (!isRelativeInside(rootAbs, candidateAbs)) return false;

  let rootReal: string;
  try {
    rootReal = await realpath(rootAbs);
  } catch {
    return false;
  }

  let current = candidateAbs;
  while (true) {
    try {
      const resolved = await realpath(current);
      return isRelativeInside(rootReal, resolved);
    } catch {
      const parent = dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
}
