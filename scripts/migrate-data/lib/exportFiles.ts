/**
 * Downloads every Supabase Storage object listed in the snapshot, keeping its exact key, and
 * records size + SHA-256 so the R2 copy can be proven identical. Read-only on Supabase.
 */
import { createHash } from 'node:crypto';
import type { StorageObjectRow } from './exportDatabase.ts';

export interface FileStore {
  /** Size and SHA-256 of an already downloaded file, or null when it is not there. */
  stat(path: string): Promise<{ size: number; sha256: string } | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
}

export interface ExportedFile {
  bucket: string;
  key: string;
  path: string;
  size: number;
  sha256: string;
  mimetype: string | null;
}

export interface FileExportResult {
  files: ExportedFile[];
  failed: { bucket: string; key: string; error: string }[];
  bytes: number;
}

export interface FileExportOptions {
  supabaseUrl: string;
  serviceKey: string;
  fetch?: typeof fetch;
  concurrency?: number;
  retries?: number;
  onFile?: (done: number, total: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Each path segment encoded on its own, so `/` stays a separator. */
export function objectUrl(supabaseUrl: string, bucket: string, key: string): string {
  const path = key.split('/').map(encodeURIComponent).join('/');
  return `${supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${path}`;
}

/**
 * New `sb_secret_…` keys go in `apikey` only (they are not JWTs). The legacy service-role JWT is
 * sent in both headers, as supabase-js does.
 */
export function authHeaders(serviceKey: string): Record<string, string> {
  if (serviceKey.startsWith('sb_secret_')) return { apikey: serviceKey };
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
}

/** Rejects keys that could escape the output folder. Storage keys never contain these. */
export function safeLocalPath(bucket: string, key: string): string {
  const parts = [bucket, ...key.split('/')];
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\\') || p.includes('\0'))) {
    throw new Error(`Unsafe storage key: ${bucket}/${key}`);
  }
  return `files/${parts.join('/')}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function exportFiles(
  objects: StorageObjectRow[],
  store: FileStore,
  options: FileExportOptions
): Promise<FileExportResult> {
  const doFetch = options.fetch ?? fetch;
  const concurrency = options.concurrency ?? 6;
  const retries = options.retries ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const headers = authHeaders(options.serviceKey);

  const files: ExportedFile[] = [];
  const failed: FileExportResult['failed'] = [];
  let next = 0;
  let done = 0;

  async function one(object: StorageObjectRow): Promise<void> {
    const path = safeLocalPath(object.bucket, object.name);

    // Resume: a file already on disk with the expected size is kept.
    const existing = await store.stat(path);
    if (existing && object.size != null && existing.size === object.size) {
      files.push({ bucket: object.bucket, key: object.name, path, ...existing, mimetype: object.mimetype });
      return;
    }

    let lastError = '';
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
      try {
        const res = await doFetch(objectUrl(options.supabaseUrl, object.bucket, object.name), { headers });
        if (!res.ok) {
          lastError = `HTTP ${res.status}`;
          if (isRetryable(res.status)) continue;
          break;
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (object.size != null && bytes.byteLength !== object.size) {
          lastError = `size ${bytes.byteLength}, expected ${object.size}`;
          continue;
        }
        await store.write(path, bytes);
        files.push({
          bucket: object.bucket,
          key: object.name,
          path,
          size: bytes.byteLength,
          sha256: sha256(bytes),
          mimetype: object.mimetype,
        });
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    failed.push({ bucket: object.bucket, key: object.name, error: lastError });
  }

  async function worker(): Promise<void> {
    while (next < objects.length) {
      const object = objects[next++];
      await one(object);
      options.onFile?.(++done, objects.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, objects.length) }, worker));

  files.sort((a, b) => a.path.localeCompare(b.path));
  failed.sort((a, b) => `${a.bucket}/${a.key}`.localeCompare(`${b.bucket}/${b.key}`));
  return { files, failed, bytes: files.reduce((n, f) => n + f.size, 0) };
}
