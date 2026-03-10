import { promises as fs } from "node:fs";
import path from "node:path";

export async function listFilesRecursive(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const resolved = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listFilesRecursive(resolved);
      }
      return [resolved];
    })
  );

  return files.flat();
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const contents = await fs.readFile(filePath, "utf8");
  return JSON.parse(contents) as T;
}
