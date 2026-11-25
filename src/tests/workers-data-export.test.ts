import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, readFileSync, rmSync, statSync, symlinkSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { request as nativeRequest } from 'undici/index.js';
import { HttpError } from '../client.ts';
import { workerDataExportRequest } from '../workers-client.ts';
import { DataExportError, exportWorkerData, streamExportDownload, validateExportDownload,
  type DataExportClient, type DownloadTransport, type R2ExportObject } from '../workers-data-export.ts';

const roots: string[] = [];
let fetchMock: ReturnType<typeof spyOn> | undefined;
afterEach(() => { fetchMock?.mockRestore(); fetchMock = undefined; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'workers-export-')));
  chmodSync(path, 0o700); roots.push(path); return path;
}
const apiOptions = { apiHost: 'test.xapi.to', apiKey: 'SECRET_XAPI_KEY' };
const descriptor = () => ({ method: 'GET', url: 'https://1ad59b064bfa3690063414a9906129e4.r2.cloudflarestorage.com/native/file?secret=SIGNED_SECRET', expiresAt: new Date(Date.now() + 60_000).toISOString() });
const input = (output: string, extra = {}) => ({ workerId: 'worker', environment: 'preview', binding: 'DB', output, ...extra });
function fixture(kind: 'd1' | 'r2', handler: (path: string, body?: Record<string, unknown>, timeout?: number) => Promise<unknown>): DataExportClient {
  return {
    listWorkerResources: async () => [{ id: 'resource', bindingName: 'DB', type: kind === 'd1' ? 'D1_DATABASE' : 'R2_BUCKET', status: 'ACTIVE' }],
    workerDataExportRequest: async (_options, id, environment, resource, path, body, timeout) => {
      expect(id).toBe('worker'); expect(environment).toBe('preview'); expect(resource).toBe('resource');
      return handler(path, body, timeout);
    },
  };
}
const noDownload = async () => ({ bytes: 0, sha256: createHash('sha256').update('').digest('hex'), headers: {} });
function manifest(path: string) { return readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)); }
async function getError(promise: Promise<unknown>): Promise<DataExportError> {
  try { await promise; throw Error('Expected failure'); } catch (error) { expect(error).toBeInstanceOf(DataExportError); return error as DataExportError; }
}

for (const path of ['/data-exports', '/data-exports/job/download', '/r2/export-download']) {
  test(`export POST ${path} is scoped, encoded, and never replayed after 503 or response loss`, async () => {
    fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('SECRET_ERROR https://bad.invalid?secret=foo', { status: 503 })) as any;
    await expect(workerDataExportRequest(apiOptions, 'w/id', 'preview', 'r/id', path, {})).rejects.toBeInstanceOf(HttpError);
    expect(fetchMock!.mock.calls.length).toBe(1);
    const [url, options] = fetchMock!.mock.calls[0] as any[];
    expect(url).toBe(`https://test.xapi.to/api/v1/workers/w%2Fid/environments/preview/resources/r%2Fid${path}`);
    expect(options.method).toBe('POST'); expect(options.body).toBe('{}'); expect(options.redirect).toBe('manual');
    expect(new Headers(options.headers).get('XAPI-KEY')).toBe(apiOptions.apiKey);
    fetchMock!.mockRejectedValue(new Error('ECONNRESET response lost'));
    await expect(workerDataExportRequest(apiOptions, 'w', 'preview', 'r', path, {})).rejects.toThrow('response lost');
    expect(fetchMock!.mock.calls.length).toBe(2);
  });
}

describe('download descriptor isolation', () => {
  test('accepts observed D1 service account and jurisdiction R2 endpoints without account-prefix restriction', () => {
    expect(validateExportDownload(descriptor()).url).toContain('.r2.cloudflarestorage.com/');
    expect(validateExportDownload({ ...descriptor(), url: 'https://account.eu.r2.cloudflarestorage.com/bucket/key' }).url).toContain('.eu.r2.');
  });
  for (const url of ['http://account.r2.cloudflarestorage.com/x', 'https://account.r2.cloudflarestorage.com.evil.test/x',
    'https://r2.cloudflarestorage.com/x', 'https://api.cloudflare.com/x', 'https://d1.cloudflare-d1.com/x',
    'https://bucket.r2.dev/x', 'https://account.cloudflarestorage.com/x', 'https://account.r2.cloudflarestorage.com:8443/x',
    'https://user:password@account.r2.cloudflarestorage.com/x', 'https://account..r2.cloudflarestorage.com/x',
    'https://account.r2.cloudflarestorage.com/x#fragment']) {
    test(`rejects unsupported descriptor endpoint ${url}`, () => expect(() => validateExportDownload({ ...descriptor(), url })).toThrow(DataExportError));
  }
  for (const headers of [{ authheader: 'SECRET' }, { 'XAPI-KEY': 'SECRET' }, { Authorization: 'Bearer SECRET' },
    { Cookie: 'SECRET' }, { Host: 'evil.test' }, { 'If-Match': 'ok\r\nXAPI-KEY: SECRET' }, { 'if-match': 'a', 'If-Match': 'b' }]) {
    test('rejects supplied authentication and unapproved headers before making any request', async () => {
      let calls = 0;
      const file = await open(join(root(), 'private'), 'wx', 0o600);
      try { await expect(streamExportDownload({ ...descriptor(), headers }, file, undefined,
        { transport: (async () => { calls++; throw Error('must not run'); }) as DownloadTransport })).rejects.toThrow('headers'); }
      finally { await file.close(); }
      expect(calls).toBe(0);
    });
  }
  test('rejects expired or invalid expiry without showing URL or headers', () => {
    for (const expiresAt of ['invalid', new Date(Date.now() - 1000).toISOString()]) {
      try { validateExportDownload({ ...descriptor(), expiresAt }); throw Error('expected reject'); }
      catch (error) { expect(String(error)).not.toContain('SIGNED_SECRET'); expect(error).toBeInstanceOf(DataExportError); }
    }
  });
});

async function localDownload(handler: (request: Request) => Response | Promise<Response>, run: (transport: DownloadTransport) => Promise<void>) {
  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    requests++;
    expect(request.headers.has('authheader')).toBe(false); expect(request.headers.has('XAPI-KEY')).toBe(false);
    expect(request.headers.has('authorization')).toBe(false); expect(request.headers.has('cookie')).toBe(false);
    return handler(request);
  } });
  const transport = ((url: unknown, options: any) => {
    expect(String(url)).toStartWith('https://'); expect(options.maxRedirections).toBe(0);
    expect(Object.keys(options.headers).every(name => name.toLowerCase() === 'if-match')).toBe(true);
    return nativeRequest(`http://127.0.0.1:${server.port}/fixture`, options);
  }) as DownloadTransport;
  try { await run(transport); } finally { server.stop(true); }
  return requests;
}

test('direct download rejects redirects and does not leak redirect location, key, or provider body', async () => {
  for (const status of [301,302,307,308,403,412,500]) {
    const file = await open(join(root(), 'out'), 'wx', 0o600);
    try {
      const calls = await localDownload(() => new Response('SECRET_PROVIDER_BODY', { status, headers: { location: 'https://evil.test/?SIGNED_SECRET' } }), async transport => {
        const error = await getError(streamExportDownload(descriptor(), file, undefined, { transport }));
        expect(error.details.httpStatus).toBe(status);
        expect(JSON.stringify(error.details) + error.message).not.toMatch(/SIGNED_SECRET|SECRET_PROVIDER_BODY|SECRET_XAPI_KEY|evil\.test/);
      });
      expect(calls).toBe(1);
    } finally { await file.close(); }
  }
});

test('streams progressing files beyond idle budget, preserves raw gzip bytes/metadata, handles partial local writes', async () => {
  const target = join(root(), 'stream');
  const file = await open(target, 'wx', 0o600);
  const buffer = gzipSync(Buffer.from('SQL fixture '.repeat(10000)));
  let writeCalls = 0;
  const partialFile = { write: async (chunk: Buffer, offset: number, size: number) => {
    writeCalls++;
    return file.write(chunk, offset, Math.min(5, size));
  }, sync: () => file.sync() } as any;
  const before = performance.now();
  try {
    await localDownload(request => {
      expect(request.headers.get('if-match')).toBe('fixture-etag');
      const stream = new ReadableStream({ async start(controller) {
        for (let offset = 0; offset < buffer.length; offset += 32) {
          controller.enqueue(buffer.subarray(offset, offset + 32));
          await new Promise(resolve => setTimeout(resolve, 80));
        }
        controller.close();
      } });
      return new Response(stream, { headers: { etag: '"fixture-etag"', 'content-length': String(buffer.length),
        'content-encoding': 'gzip', 'content-type': 'application/sql', 'x-amz-meta-user': 'original-metadata',
        'set-cookie': 'NEVER_STORE_COOKIE' } });
    }, async transport => {
      const pending = streamExportDownload(descriptor(), partialFile, { key: '../private', size: buffer.length, etag: 'fixture-etag' }, { transport, budgets: { connect: 5000, idle: 300 } });
      await new Promise(resolve => setTimeout(resolve, 190));
      expect(statSync(target).size).toBeGreaterThan(0);
      expect(statSync(target).size).toBeLessThan(buffer.length);
      const receipt = await pending;
      expect(receipt.bytes).toBe(buffer.length); expect(receipt.sha256).toBe(createHash('sha256').update(buffer).digest('hex'));
      expect(receipt.headers['content-encoding']).toBe('gzip'); expect(receipt.headers['x-amz-meta-user']).toBe('original-metadata');
      expect(receipt.headers).not.toHaveProperty('set-cookie');
    });
    expect(performance.now() - before).toBeGreaterThan(300);
    expect(writeCalls).toBeGreaterThan(10); expect(readFileSync(target).equals(buffer)).toBe(true);
  } finally { await file.close(); }
});

test('local write/sync failures report safe disk errors without private paths or keys', async () => {
  for (const phase of ['write', 'sync']) {
    const target = await open(join(root(), 'disk-error'), 'wx', 0o600);
    const privateError = Object.assign(new Error('PRIVATE_PATH SIGNED_SECRET SECRET_XAPI_KEY'), { code: 'ENOSPC' });
    const file = {
      write: phase === 'write' ? async () => { throw privateError; } : (...args: any[]) => (target.write as any)(...args),
      sync: phase === 'sync' ? async () => { throw privateError; } : () => target.sync(),
    } as any;
    try {
      await localDownload(() => new Response('fixture'), async transport => {
        const error = await getError(streamExportDownload(descriptor(), file, undefined, { transport }));
        expect(error.message).toContain('local disk space');
        expect(error.details.systemCode).toBe('ENOSPC');
        expect(JSON.stringify(error.details) + error.message).not.toMatch(/PRIVATE_PATH|SIGNED_SECRET|SECRET_XAPI_KEY/);
      });
    } finally { await target.close(); }
  }
});

test('body no-progress timeout terminates stalled download without raw transport error', async () => {
  const file = await open(join(root(), 'stalled'), 'wx', 0o600);
  try {
    await localDownload(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } })), async transport => {
      const error = await getError(streamExportDownload(descriptor(), file, undefined, { transport, budgets: { connect: 1000, idle: 50 } }));
      expect(error.message).toContain('timed out'); expect(error.message).not.toContain('SIGNED_SECRET');
    });
  } finally { await file.close(); }
});

test('rejects ETag, declared size, and actual byte mismatch', async () => {
  const expected: R2ExportObject = { key: 'key', size: 3, etag: 'version' };
  for (const response of [() => new Response('123', { headers: { etag: 'changed' } }),
    () => new Response('12', { headers: { etag: '"version"' } }),
    () => new Response('1234', { headers: { etag: 'version' } }),
    () => new Response(new ReadableStream({start(controller){controller.enqueue(Buffer.from('12'));controller.close();}}), {headers:{etag:'version'}}),
    () => new Response(new ReadableStream({start(controller){controller.enqueue(Buffer.from('1234'));controller.close();}}), {headers:{etag:'version'}})]) {
    const file = await open(join(root(), 'object'), 'wx', 0o600);
    try { await localDownload(response, async transport => {
      await expect(streamExportDownload(descriptor(), file, expected, { transport })).rejects.toBeInstanceOf(DataExportError);
    }); } finally { await file.close(); }
  }
});

test('D1 start, native uppercase poll, download and explicit resume preserve job identity', async () => {
  const output = join(root(), 'data.sql'); const calls: any[] = [], progress: unknown[] = [];
  let polls = 0;
  const api = fixture('d1', async (path, body, timeout) => {
    calls.push({ path, body, timeout });
    if (path === '/data-exports') return { exportId: 'job-1', status: 'PENDING', url: 'SECRET_MUST_NOT_PRINT' };
    if (path.endsWith('/download')) return descriptor();
    return { exportId: 'job-1', status: ++polls < 2 ? 'PENDING' : 'COMPLETE', result: { signed_url: 'SECRET_MUST_NOT_PRINT' } };
  });
  const runtime = { download: noDownload, sleep: async () => {}, progress: (state: unknown) => progress.push(state) };
  const result = await exportWorkerData('d1', api, apiOptions, input(output), runtime);
  expect(result.exportId).toBe('job-1'); expect(result.status).toBe('completed');
  expect(calls.map(call => call.path)).toEqual(['/data-exports','/data-exports/job-1','/data-exports/job-1','/data-exports/job-1/download']);
  expect(JSON.stringify(result) + JSON.stringify(progress) + readFileSync(output + '.manifest.jsonl','utf8')).not.toContain('SECRET');
  expect(statSync(output).mode & 0o777).toBe(0o600); expect(statSync(output + '.manifest.jsonl').mode & 0o777).toBe(0o600);
  calls.length = 0;
  await exportWorkerData('d1', api, apiOptions, input(join(root(), 'resume.sql'), { exportId: 'job-1' }), runtime);
  expect(calls.map(call => call.path)).toEqual(['/data-exports/job-1', '/data-exports/job-1/download']);
});

test('D1 polling deadline uses remaining request budget and preserves resumable job ID', async () => {
  let time = 0, starts = 0;
  const api = fixture('d1', async (path, _body, timeout) => {
    if (path === '/data-exports') starts++;
    else { expect(timeout).toBeLessThanOrEqual(100); time += 90; }
    return { exportId: 'resume-id', status: 'PENDING' };
  });
  const error = await getError(exportWorkerData('d1', api, apiOptions, input(join(root(),'timeout.sql')), {
    now: () => time, sleep: async ms => { time += ms; }, pollTimeoutMs: 100,
  }));
  expect(error.details.exportId).toBe('resume-id'); expect(error.message).toContain('resume'); expect(starts).toBe(1);
  expect(time).toBe(100);
});

test('D1 identity mismatch / failure / unsupported state do not fetch a descriptor', async () => {
  for (const state of [{ exportId: 'other', status: 'COMPLETE' }, { exportId: 'j', status: 'FAILED', error: { code: 'SECRET_RAW', message: 'https://bad/?SIGNED_SECRET' } },
    { exportId: 'j', status: 'UNSAFE_UNKNOWN_STATE' }]) {
    const calls: string[] = [];
    const output = join(root(),'failure.sql');
    const api = fixture('d1', async path => { calls.push(path); return path === '/data-exports' ? { exportId: 'j', status: 'PENDING' } : state; });
    const error = await getError(exportWorkerData('d1', api, apiOptions, input(output), { sleep: async () => {} }));
    expect(calls).toEqual(['/data-exports','/data-exports/j']);
    expect(JSON.stringify(error.details) + error.message + readFileSync(output + '.manifest.jsonl','utf8')).not.toMatch(/SECRET|https:/);
    expect(error.details.exportId).toBe('j');
  }
});

test('lost D1 start is UNKNOWN, while descriptor failures preserve HTTP status and never replay POST', async () => {
  for (const phase of ['start','descriptor']) {
    let starts = 0, downloads = 0;
    const api = fixture('d1', async path => {
      if (path === '/data-exports') { starts++; if (phase === 'start') throw new HttpError(503, 'SECRET https://bad/'); return { exportId: 'j', status: 'COMPLETE' }; }
      downloads++; throw new HttpError(403, 'SECRET https://bad/');
    });
    const error = await getError(exportWorkerData('d1', api, apiOptions, input(join(root(),'lost.sql')), { download: noDownload }));
    expect(starts).toBe(1); expect(downloads).toBe(phase === 'start' ? 0 : 1);
    expect(error.details.httpStatus).toBe(phase === 'start' ? 503 : 403);
    expect(error.details.status).toBe(phase === 'start' ? 'unknown' : 'partial');
    expect(error.message).not.toMatch(/SECRET|https:/);
  }
});

test('R2 paginates only after bounded workers finish, maps arbitrary keys privately to unique hashes', async () => {
  const output = join(root(),'objects');
  const keys = ['../escape','/absolute','a/b','a_b','中文','e\u0301','é','CON','__proto__','测试/line\nname.txt'];
  const objects = keys.map(key => ({ key, size: Buffer.byteLength(key), etag: createHash('md5').update(key).digest('hex') }));
  let active = 0, peak = 0, downloaded = 0; const listCalls: string[] = [];
  const api = fixture('r2', async (path, body) => {
    if (path.startsWith('/r2/export-objects')) {
      listCalls.push(path);
      if (listCalls.length === 1) return { objects: objects.slice(0,6), nextCursor: 'cursor/+&' };
      expect(active).toBe(0); expect(downloaded).toBe(6); return { objects: objects.slice(6), nextCursor: null };
    }
    expect(path).toBe('/r2/export-download');
    expect(body?.etag).toBe(objects.find(object => object.key === body?.key)?.etag);
    return descriptor();
  });
  const result = await exportWorkerData('r2', api, apiOptions, input(output), {
    download: async (_descriptor, file, expected) => {
      active++; peak = Math.max(active,peak); await new Promise(resolve => setTimeout(resolve,10));
      const buffer = Buffer.from(expected!.key); await file.writeFile(buffer); await file.sync(); active--; downloaded++;
      return { bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), headers: { etag: expected!.etag, 'x-amz-meta-user': 'original' } };
    },
  });
  expect(peak).toBe(4); expect(result.completed).toBe(keys.length); expect(result.pages).toBe(2);
  expect(listCalls).toEqual(['/r2/export-objects','/r2/export-objects?cursor=cursor%2F%2B%26']);
  expect(statSync(output).mode & 0o777).toBe(0o700); expect(statSync(join(output,'manifest.jsonl')).mode & 0o777).toBe(0o600);
  const rows = manifest(join(output,'manifest.jsonl')).filter(row => row.type === 'object' && row.status === 'completed');
  expect(new Set(rows.map(row => row.filename)).size).toBe(keys.length);
  for (const row of rows) {
    expect(row.filename).toMatch(/^[a-f0-9]{64}\.bin$/); expect(row.headers['x-amz-meta-user']).toBe('original');
    expect(readFileSync(join(output,row.filename),'utf8')).toBe(row.key); expect(statSync(join(output,row.filename)).mode & 0o777).toBe(0o600);
  }
  expect(JSON.stringify(result)).not.toContain('SIGNED_SECRET'); expect(result).not.toHaveProperty('objects');
});

test('R2 duplicate keys/hash collisions and ETag changes fail without overwriting previous file', async () => {
  const output = join(root(),'objects'); const object = { key: '../collision', size: 0, etag: 'old' }; let pages = 0;
  const api = fixture('r2', async path => path.startsWith('/r2/export-objects') ?
    { objects: [object], nextCursor: ++pages === 1 ? 'next' : null } : descriptor());
  const error = await getError(exportWorkerData('r2', api, apiOptions, input(output), { download: noDownload }));
  expect(error.details.completed).toBe(1); expect(error.details.status).toBe('partial');
  expect(error.message).not.toContain(object.key);
  const rows = manifest(join(output,'manifest.jsonl')); expect(rows.at(-1).status).toBe('partial');
  expect(rows.filter(row => row.type === 'object' && row.status === 'completed')).toHaveLength(1);
});

test('R2 failure waits for in-flight downloads, preserves successes and fails without raw object key', async () => {
  const output = join(root(),'partial'); let active = 0;
  const objects = Array.from({length:8}, (_, i) => ({ key: 'SECRET_KEY_'+i, size: 0, etag: 'e' }));
  const api = fixture('r2', async path => path.startsWith('/r2/export-objects') ? { objects } : descriptor());
  const error = await getError(exportWorkerData('r2', api, apiOptions, input(output), { download: async (_descriptor, _file, expected) => {
    active++; await new Promise(resolve => setTimeout(resolve, expected!.key.endsWith('0') ? 1 : 30)); active--;
    if (expected!.key.endsWith('0')) throw new Error('SECRET_KEY_0 https://SIGNED_SECRET'); return noDownload();
  } }));
  expect(active).toBe(0); expect(error.details.completed).toBe(3); expect(error.details.status).toBe('partial');
  expect(error.message + JSON.stringify(error.details)).not.toContain('SECRET');
  const rows = manifest(join(output,'manifest.jsonl')); expect(rows.filter(row => row.type === 'object' && row.status === 'partial')).toHaveLength(4);
  expect(rows.at(-1).completed).toBe(3);
});

test('R2 rejects oversized pages, repeating cursors and caps total page traversal with bounded memory', async () => {
  for (const scenario of ['oversized','repeat','bound']) {
    let calls = 0;
    const api = fixture('r2', async () => {
      calls++; return scenario === 'oversized' ? { objects: Array(201).fill({key:'k',size:0,etag:'e'}) } : { objects: [], nextCursor: scenario === 'repeat' ? 'same' : String(calls) };
    });
    const error = await getError(exportWorkerData('r2', api, apiOptions, input(join(root(),'pages')), { maxPages: 3 }));
    expect(error.details.status).toBe('partial'); expect(calls).toBe(scenario === 'oversized' ? 1 : scenario === 'repeat' ? 2 : 3);
  }
});

test('fresh outputs reject symlink leaves/ancestors, existing files/directories, untrusted writable parents before API writes', async () => {
  const base = root(), existing = join(base,'existing'); writeFileSync(existing,'DO_NOT_CLOBBER');
  const link = join(base,'link'); symlinkSync(existing,link);
  const directory = join(base,'existing-dir'); mkdirSync(directory, {mode:0o700});
  const linkDir = join(base,'link-dir'); symlinkSync(directory,linkDir);
  const shared = join(base,'shared'); mkdirSync(shared, {mode:0o777}); chmodSync(shared,0o777);
  let calls = 0;
  const api = fixture('d1', async () => { calls++; return {exportId:'j',status:'COMPLETE'}; });
  for (const output of [existing,link,join(linkDir,'data.sql'),join(shared,'data.sql')])
    await expect(exportWorkerData('d1',api,apiOptions,input(output),{download:noDownload})).rejects.toBeInstanceOf(DataExportError);
  for (const output of [directory,linkDir])
    await expect(exportWorkerData('r2',api,apiOptions,input(output),{download:noDownload})).rejects.toBeInstanceOf(DataExportError);
  expect(calls).toBe(0); expect(readFileSync(existing,'utf8')).toBe('DO_NOT_CLOBBER');
});

test('EXPIRED job advises explicit new export and never requests another descriptor or start', async () => {
  const calls: string[] = [];
  const api = fixture('d1', async path => {
    calls.push(path);
    return { exportId: 'expired-job', status: 'EXPIRED', createdAt: '2026-10-11T01:00:00Z', updatedAt: '2026-10-11T01:15:00Z',
      expiresAt: '2026-10-11T01:15:00Z', pollAfterMs: 2000, errorCode: 'SECRET_IGNORE' };
  });
  const error = await getError(exportWorkerData('d1', api, apiOptions, input(join(root(),'expired.sql'), {exportId:'expired-job'})));
  expect(calls).toEqual(['/data-exports/expired-job']); expect(error.details.status).toBe('expired');
  expect(error.details.exportId).toBe('expired-job'); expect(error.details).not.toHaveProperty('resume');
  expect(error.message).toContain('omit --export-id'); expect(JSON.stringify(error.details)).not.toContain('SECRET');
});

test('accepts opaque cursors up to 24000 bytes, forwards exactly, rejects oversized Unicode cursors', async () => {
  const cursor = 'c'.repeat(24000); let calls = 0;
  const api = fixture('r2', async path => {
    calls++;
    if (calls === 1) return {objects:[],nextCursor:cursor};
    expect(path).toBe('/r2/export-objects?cursor=' + cursor); return {objects:[],nextCursor:null};
  });
  const result = await exportWorkerData('r2',api,apiOptions,input(join(root(),'cursor')));
  expect(result.pages).toBe(2);
  const bad = fixture('r2', async () => ({objects:[],nextCursor:'中'.repeat(8001)}));
  await expect(exportWorkerData('r2',bad,apiOptions,input(join(root(),'oversized-cursor')))).rejects.toThrow('page');
});

test('descriptor method and ETag must match the exact object before any download', async () => {
  let requests = 0;
  const file = await open(join(root(),'etag'),'wx',0o600);
  const transport = (async () => {requests++; throw Error('must not run');}) as DownloadTransport;
  try {
    for (const value of [{...descriptor(),method:'POST'}, {...descriptor(),headers:{'If-Match':'different-version'}}]) {
      await expect(streamExportDownload(value,file,{key:'k',etag:'"opaque-multipart-2"',size:0},{transport})).rejects.toBeInstanceOf(DataExportError);
    }
  } finally {await file.close();}
  expect(requests).toBe(0);
});

test('signed If-Match is transmitted byte for byte rather than requoted', async () => {
  for (const etag of ['aabbccddeeff00112233445566778899','"opaque-multipart-etag-2"']) {
    const file = await open(join(root(),'signed-header'),'wx',0o600);
    try {
      await localDownload(request => {
        expect(request.headers.get('if-match')).toBe(etag);
        return new Response('', {headers:{etag}});
      }, async transport => {
        await streamExportDownload({...descriptor(),headers:{'If-Match':etag}},file,
          {key:'测试/line\nname.txt',size:0,etag}, {transport});
      });
    } finally {await file.close();}
  }
});

test('signed URL spelling is retained exactly and ambiguous normalized paths fail closed', () => {
  const url = 'https://Service.r2.cloudflarestorage.com/backup/%E6%B5%8B%E8%AF%95?X-Amz-Date=20261011T123456Z&value=a%2fb&value=%2F';
  expect(validateExportDownload({...descriptor(),url}).url).toBe(url);
  for (const path of ['/a/../b','/a/./b','/a/%2e%2E/b','/a/%2E/b','/a/..%2e/b/../c','/a\\b']) {
    expect(() => validateExportDownload({...descriptor(),url:'https://native.r2.cloudflarestorage.com'+path})).toThrow(DataExportError);
  }
  expect(() => validateExportDownload({...descriptor(),url:'https://native.r2.cloudflarestorage.com:443/a'})).toThrow(DataExportError);
});

test('invalid resume ID never echoes an untrusted URL into safe error details', async () => {
  const api=fixture('d1',async()=>{throw Error('must not contact API');});
  const error=await getError(exportWorkerData('d1',api,apiOptions,input(join(root(),'invalid.sql'),{exportId:'https://SIGNED_SECRET'})));
  expect(error.message+JSON.stringify(error.details)).not.toMatch(/SIGNED_SECRET|https:/);expect(error.details).not.toHaveProperty('exportId');
});
