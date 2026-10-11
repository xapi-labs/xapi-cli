import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, type FileHandle } from 'node:fs/promises';
import { dirname, parse, resolve, sep } from 'node:path';
import { Agent, request as directRequest, type Dispatcher } from 'undici/index.js';
import { HttpError } from './client.ts';
import type { WorkersClientOptions } from './workers-client.ts';

export interface DataExportJob {
  exportId: string; status: 'PENDING' | 'COMPLETE' | 'FAILED' | 'EXPIRED';
  createdAt?: string; updatedAt?: string; expiresAt?: string; pollAfterMs?: number;
}
export interface DataExportDownload { method: 'GET'; url: string; expiresAt: string; headers?: Record<string, string> }
export interface R2ExportObject { key: string; size: number; etag: string }
export interface R2ExportPage { objects: R2ExportObject[]; nextCursor?: string | null }
export interface DataExportClient {
  listWorkerResources(options: WorkersClientOptions, id: string, environment: string): Promise<unknown>;
  workerDataExportRequest(options: WorkersClientOptions, id: string, environment: string,
    resourceId: string, path: string, body?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}
export class DataExportError extends Error {
  constructor(message: string, public readonly details: Record<string, unknown> = {}) { super(message); }
}
const failure = (reason: string, details: Record<string, unknown> = {}) => new DataExportError(reason, details);
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('Invalid export response');
  return value as Record<string, unknown>;
}
function job(value: unknown): DataExportJob {
  const raw = record(value);
  if (typeof raw.exportId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(raw.exportId) ||
    typeof raw.status !== 'string' || !['PENDING','COMPLETE','FAILED','EXPIRED'].includes(raw.status))
    throw failure('Invalid D1 export job');
  const result: DataExportJob = { exportId: raw.exportId, status: raw.status as DataExportJob['status'] };
  for (const field of ['createdAt', 'updatedAt', 'expiresAt'] as const) {
    if (raw[field] !== undefined) {
      if (typeof raw[field] !== 'string' || !Number.isFinite(Date.parse(raw[field]))) throw failure('Invalid D1 export timestamp');
      result[field] = new Date(raw[field]).toISOString();
    }
  }
  if (raw.pollAfterMs !== undefined) {
    if (typeof raw.pollAfterMs !== 'number' || !Number.isFinite(raw.pollAfterMs) || raw.pollAfterMs < 0)
      throw failure('Invalid D1 export polling interval');
    result.pollAfterMs = raw.pollAfterMs;
  }
  return result;
}
function page(value: unknown): R2ExportPage {
  const raw = record(value);
  if (!Array.isArray(raw.objects) || raw.objects.length > 200 ||
    (raw.nextCursor != null && (typeof raw.nextCursor !== 'string' || !raw.nextCursor || Buffer.byteLength(raw.nextCursor) > 24_000)))
    throw failure('Invalid or oversized R2 export page');
  const objects = raw.objects.map(value => {
    const object = record(value);
    if (typeof object.key !== 'string' || !object.key || Buffer.byteLength(object.key) > 1024 ||
      !Number.isSafeInteger(object.size) || Number(object.size) < 0 ||
      typeof object.etag !== 'string' || !object.etag || object.etag.length > 1024 || /[\r\n]/.test(object.etag))
      throw failure('Invalid R2 export object');
    return { key: object.key, size: object.size as number, etag: object.etag };
  });
  return { objects, nextCursor: raw.nextCursor as string | null | undefined };
}

/** Observed native D1 and R2 endpoint suffix; never normalize signed URL bytes. */
export function validateExportDownload(value: unknown): DataExportDownload {
  const raw = record(value);
  const source = typeof raw.url === 'string' ? raw.url : '';
  const parts = /^https:\/\/([^/?#]+)([^?#]*)(?:\?[^#]*)?$/i.exec(source);
  let target: URL;
  try { target = new URL(source); } catch { throw failure('Invalid export download descriptor'); }
  if (raw.method !== 'GET' || typeof raw.url !== 'string' || target.protocol !== 'https:' || target.username || target.password ||
    !parts || !/^[a-zA-Z0-9.-]+$/.test(parts[1]) || /[\u0000-\u0020\u007f\\]/.test(source) ||
    parts[2].split('/').some(segment => ['.','..'].includes(segment.replace(/%2e/gi, '.'))) ||
    target.hash || target.port ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.r2\.cloudflarestorage\.com$/.test(target.hostname) ||
    typeof raw.expiresAt !== 'string' || !Number.isFinite(Date.parse(raw.expiresAt)) || Date.parse(raw.expiresAt) <= Date.now())
    throw failure('Unsupported or expired export download descriptor');
  const headers: Record<string, string> = Object.create(null);
  if (raw.headers !== undefined) {
    for (const [name, value] of Object.entries(record(raw.headers))) {
      // Authentication, cookies, host overrides and opaque headers are forbidden.
      if (name.toLowerCase() !== 'if-match' || typeof value !== 'string' || !value || /[\r\n]/.test(value) ||
        Object.hasOwn(headers, name.toLowerCase())) throw failure('Unsupported export download headers');
      headers[name.toLowerCase()] = value;
    }
  }
  return { method: 'GET', url: source, expiresAt: raw.expiresAt, headers };
}

const normalizeEtag = (etag: string) => etag.startsWith('"') && etag.endsWith('"') ? etag.slice(1,-1) : etag;
export type DownloadTransport = typeof directRequest;
export interface DownloadSettings {
  transport?: DownloadTransport; dispatcher?: Dispatcher; budgets?: { connect: number; idle: number };
}
export interface DownloadReceipt { bytes: number; sha256: string; headers: Record<string, string> }
/** Dedicated transport carries only explicitly approved object headers, never CLI credentials.
 * Undici request preserves compressed bytes; connect/header/body-idle budgets have no total cap. */
export async function streamExportDownload(value: unknown, file: FileHandle, expected?: R2ExportObject,
  settings: DownloadSettings = {}): Promise<DownloadReceipt> {
  const transport = settings.transport || directRequest;
  const budgets = settings.budgets || { connect: 30_000, idle: 60_000 };
  const descriptor = validateExportDownload(value);
  const headers = { ...descriptor.headers };
  if (expected) {
    if (headers['if-match'] && normalizeEtag(headers['if-match']) !== normalizeEtag(expected.etag))
      throw failure('Download ETag descriptor mismatch');
    // If-Match can participate in the signature: preserve descriptor bytes.
    headers['if-match'] ??= expected.etag;
  }
  const agent = settings.dispatcher ? undefined : new Agent({ connections: 4, connect: { timeout: budgets.connect } });
  let phase = 'connection';
  let body: Awaited<ReturnType<DownloadTransport>>['body'] | undefined;
  try {
    const response = await transport(descriptor.url, { method: 'GET', headers, dispatcher: settings.dispatcher || agent,
      maxRedirections: 0, headersTimeout: budgets.connect, bodyTimeout: budgets.idle });
    body = response.body;
    // Rejected HTTP/metadata responses have no iterator consuming the abort.
    body.on('error', () => {});
    phase = 'download';
    if (response.statusCode !== 200) {
      response.body.destroy();
      throw failure(response.statusCode >= 300 && response.statusCode < 400 ? 'Export download redirect rejected' : 'Export download HTTP failure',
        { httpStatus: response.statusCode });
    }
    const metadata: Record<string, string> = Object.create(null);
    for (const [name, value] of Object.entries(response.headers)) {
      // Metadata is private local manifest content; cookies and redirect URLs are never retained.
      if (typeof value === 'string' && (['etag','content-length','content-type','content-encoding','content-language',
        'content-disposition','cache-control','expires','last-modified'].includes(name) || name.startsWith('x-amz-meta-')))
        metadata[name] = value;
    }
    const length = metadata['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) {
      response.body.destroy(); throw failure('Invalid download content length');
    }
    if (expected && (normalizeEtag(metadata.etag || '') !== normalizeEtag(expected.etag) ||
      (length !== undefined && Number(length) !== expected.size))) {
      response.body.destroy(); throw failure('R2 object changed or download metadata mismatch');
    }
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (!Number.isSafeInteger(bytes) || (expected && bytes > expected.size) ||
        (length !== undefined && bytes > Number(length))) {
        response.body.destroy(); throw failure('Downloaded size mismatch');
      }
      hash.update(buffer);
      let offset = 0;
      while (offset < buffer.length) {
        const result = await file.write(buffer, offset, buffer.length - offset);
        if (!result.bytesWritten) throw failure('Local export write failed');
        offset += result.bytesWritten;
      }
    }
    if ((expected && bytes !== expected.size) || (length !== undefined && bytes !== Number(length)))
      throw failure('Downloaded size mismatch');
    await file.sync();
    return { bytes, sha256: hash.digest('hex'), headers: metadata };
  } catch (error) {
    if (error instanceof DataExportError) throw error;
    throw failure(`Export ${phase} failed or timed out`);
  } finally {
    body?.destroy();
    await agent?.destroy().catch(() => undefined);
  }
}

async function checkParent(path: string) {
  const parent = dirname(path), root = parse(parent).root;
  let current = root;
  for (const segment of parent.slice(root.length).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw failure('Export output parent must contain no symlinks');
    // Trust only the current user and system root. Non-sticky shared writable
    // ancestors allow another user to rename an otherwise protected leaf.
    const uid = process.getuid?.();
    if ((uid !== undefined && info.uid !== uid && info.uid !== 0) ||
      ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0))
      throw failure('Export output parent is not trusted; choose an owned private directory');
  }
}
async function privateFile(path: string) {
  return open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
}
interface ExportOptions {
  workerId: string; environment: string; binding: string; output: string; exportId?: string;
}
export interface ExportRuntime {
  download?: typeof streamExportDownload; now?: () => number; sleep?: (ms: number) => Promise<void>;
  downloadTransport?: DownloadTransport;
  pollTimeoutMs?: number; maxPages?: number;
  progress?: (job: DataExportJob) => void;
}
export async function exportWorkerData(kind: 'd1' | 'r2', api: DataExportClient, options: WorkersClientOptions,
  input: ExportOptions, runtime: ExportRuntime = {}) {
  let phase = 'output', completed = 0, bytes = 0, pages = 0;
  let exportId: string | undefined;
  const path = resolve(input.output);
  let manifest: FileHandle | undefined, d1File: FileHandle | undefined;
  const downloadAgent = new Agent({ connections: 4, connect: { timeout: 30_000 } });
  let manifestQueue = Promise.resolve();
  const append = (value: unknown) => {
    manifestQueue = manifestQueue.then(async () => { await manifest!.writeFile(JSON.stringify(value) + '\n'); await manifest!.sync(); });
    return manifestQueue;
  };
  try {
    if (input.exportId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(input.exportId)) throw failure('Invalid --export-id');
    exportId = input.exportId;
    if (kind === 'r2' && exportId) throw failure('--export-id is only supported for D1');
    await checkParent(path);
    if (kind === 'r2') {
      await mkdir(path, { mode: 0o700 }); // exclusive; existing directories are never reused
      manifest = await privateFile(resolve(path, 'manifest.jsonl'));
    } else {
      // Reserve sidecar first; neither it nor the SQL file may be replaced.
      manifest = await privateFile(path + '.manifest.jsonl');
      d1File = await privateFile(path);
    }
    await append({ type: 'export', version: 1, kind, workerId: input.workerId, environment: input.environment,
      binding: input.binding, status: 'partial' });
    phase = 'binding';
    const response = await api.listWorkerResources(options, input.workerId, input.environment);
    const resources = Array.isArray(response) ? response : record(response).data;
    if (!Array.isArray(resources)) throw failure('Invalid resource list response');
    const matches = resources.filter(value => {
      const resource = record(value);
      return resource.bindingName === input.binding && resource.status === 'ACTIVE' &&
        String(resource.type).toLowerCase() === (kind === 'd1' ? 'd1_database' : 'r2_bucket');
    });
    if (matches.length !== 1 || typeof matches[0].id !== 'string' || !matches[0].id)
      throw failure('Exactly one ACTIVE binding of the selected export type is required');
    const resourceId = matches[0].id as string;
    const call = (path: string, body?: Record<string, unknown>, timeout?: number) =>
      api.workerDataExportRequest(options, input.workerId, input.environment, resourceId, path, body, timeout);
    const download: typeof streamExportDownload = runtime.download || ((value, file, expected) =>
      streamExportDownload(value, file, expected, { dispatcher: downloadAgent, transport: runtime.downloadTransport }));
    if (kind === 'd1') {
      const now = runtime.now || (() => performance.now());
      const deadline = now() + Math.min(runtime.pollTimeoutMs ?? 600_000, 600_000);
      phase = exportId ? 'poll' : 'start';
      let state = exportId ? undefined : job(await call('/data-exports', {}, Math.min(30_000, deadline - now())));
      if (state) exportId = state.exportId;
      if (state) { await append({ type: 'job', ...state }); runtime.progress?.(state); }
      phase = 'poll';
      while (!state || state.status === 'PENDING') {
        const remaining = deadline - now();
        if (remaining <= 0) throw failure('D1 export polling timed out; resume with --export-id');
        if (state) await (runtime.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))))(Math.min(Math.max(250, Math.min(state.pollAfterMs ?? 2000, 30_000)), remaining));
        const budget = deadline - now();
        if (budget <= 0) throw failure('D1 export polling timed out; resume with --export-id');
        state = job(await call('/data-exports/' + encodeURIComponent(exportId!), undefined, Math.min(30_000, budget)));
        if (state.exportId !== exportId) throw failure('D1 export job identity mismatch');
        runtime.progress?.(state);
      }
      if (state.status === 'EXPIRED') throw failure('D1 export job expired; start a new export with a fresh --output and omit --export-id',
        { status: 'expired', next: 'Start a new D1 export with a fresh --output; omit --export-id' });
      if (state.status === 'FAILED') throw failure('D1 export job failed', { status: 'failed' });
      phase = 'descriptor';
      const descriptor = await call('/data-exports/' + encodeURIComponent(exportId!) + '/download', {});
      phase = 'download';
      const receipt = await download(descriptor, d1File!);
      bytes = receipt.bytes; completed = 1;
      await append({ type: 'file', exportId, status: 'completed', ...receipt });
    } else {
      let cursor: string | undefined;
      for (;;) {
        phase = 'list';
        if (pages >= (runtime.maxPages ?? 100_000)) throw failure('R2 export page safety bound reached');
        const result = page(await call('/r2/export-objects' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : '')));
        pages++;
        if (result.nextCursor === cursor && cursor) throw failure('R2 export cursor did not advance');
        phase = 'download';
        let index = 0, firstError: unknown;
        await Promise.all(Array.from({ length: Math.min(4, result.objects.length) }, async () => {
          while (!firstError && index < result.objects.length) {
            const object = result.objects[index++];
            const filename = createHash('sha256').update(object.key, 'utf8').digest('hex') + '.bin';
            let file: FileHandle | undefined;
            try {
              file = await privateFile(resolve(path, filename));
              await append({ type: 'object', ...object, filename, status: 'partial' });
              const descriptor = await call('/r2/export-download', { key: object.key, etag: object.etag });
              const receipt = await download(descriptor, file, object);
              completed++; bytes += receipt.bytes;
              await append({ type: 'object', ...object, filename, status: 'completed', ...receipt });
            } catch (error) {
              firstError ??= error;
            } finally { try { await file?.close(); } catch { firstError ??= failure('Local export file close failed'); } }
          }
        }));
        if (firstError) throw firstError;
        await append({ type: 'page', pages, completed, bytes, status: 'completed' });
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
    }
    await append({ type: 'result', status: 'completed', completed, bytes, pages, ...(exportId ? { exportId } : {}) });
    return { status: 'completed', kind, output: path, manifest: kind === 'r2' ? resolve(path, 'manifest.jsonl') : path + '.manifest.jsonl',
      completed, bytes, pages, ...(exportId ? { exportId } : {}) };
  } catch (error) {
    const details = { phase, status: phase === 'start' ? 'unknown' : 'partial', completed, bytes, pages,
      ...(exportId ? { exportId, ...(error instanceof DataExportError && ['failed','expired'].includes(String(error.details.status)) ? {} :
        { resume: 'Use the same Worker, environment and binding with --export-id and a fresh --output' }) } : {}),
      ...(error instanceof HttpError ? { httpStatus: error.status } : {}),
      ...(error instanceof DataExportError ? error.details : {}) };
    if (manifest) await append({ type: 'result', ...details }).catch(() => undefined);
    throw failure(error instanceof DataExportError ? error.message : `Worker data export ${phase} failed`, details);
  } finally {
    await downloadAgent.destroy().catch(() => undefined);
    await Promise.all([manifest?.close(), d1File?.close()]);
  }
}
