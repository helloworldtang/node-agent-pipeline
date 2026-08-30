import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Write next to the destination and replace it with a single rename. */
export async function atomicWriteFile(
  path: string,
  data: string | Uint8Array,
  encoding?: BufferEncoding,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(tmp, data, encoding ? { encoding } : undefined);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Copy a file atomically, so readers never observe a partially copied image. */
export async function atomicCopyFile(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const tmp = `${destination}.tmp-${randomUUID()}`;
  try {
    await copyFile(source, tmp);
    await rename(tmp, destination);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}
