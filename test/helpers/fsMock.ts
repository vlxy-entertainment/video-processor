import { vi } from 'vitest';

/**
 * In-memory fs fake covering the promises + sync surface the code uses. Files
 * are stored as real Buffers so byte-surgery runs for real.
 */
export function makeFsMock(initial: Record<string, Buffer> = {}) {
  const files = new Map<string, Buffer>(Object.entries(initial));

  const promises = {
    mkdir: vi.fn(async () => undefined),
    readdir: vi.fn(async (dir: string) =>
      [...files.keys()]
        .filter(p => p.startsWith(dir))
        .map(p => p.slice(dir.length + 1))
    ),
    readFile: vi.fn(async (p: string, enc?: string) => {
      const b = files.get(p);
      if (!b) throw new Error(`ENOENT: ${p}`);
      return enc ? b.toString(enc as BufferEncoding) : b;
    }),
    writeFile: vi.fn(async (p: string, data: Buffer | string) => {
      files.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data));
    }),
    stat: vi.fn(async (p: string) => ({ size: files.get(p)?.length ?? 0 })),
    unlink: vi.fn(async (p: string) => { files.delete(p); }),
    rm: vi.fn(async () => undefined),
    access: vi.fn(async (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); }),
  };

  const fsSync = {
    existsSync: vi.fn((p: string) => files.has(p)),
    readFileSync: vi.fn((p: string) => {
      const b = files.get(p);
      if (!b) throw new Error(`ENOENT: ${p}`);
      return b;
    }),
    writeFileSync: vi.fn((p: string, data: Buffer | string) => {
      files.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data));
    }),
    createReadStream: vi.fn((p: string) => ({ path: p, _read: () => undefined })),
  };

  return { files, promises, fsSync };
}
