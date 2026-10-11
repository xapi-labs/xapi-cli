import { describe, expect, it } from 'bun:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { sandboxFileUpload } from '../sandbox-client.ts';

describe('Sandbox binary upload client', () => {
  it('streams a binary file once with a provider path and exact bytes', async () => {
    let calls = 0;
    const bytes = Buffer.alloc(20 * 1024 * 1024, 0xff);
    const server = createServer(async (request, response) => {
      calls++; expect(request.url).toBe('/providers/daytona/v1/sandboxes/owned/files/upload?path=%2Ftmp%2Ffile%20');
      expect(request.headers['content-type']).toBe('application/octet-stream');
      expect(request.headers['xapi-key']).toBe('synthetic-key');
      const hash = createHash('sha256'); let size = 0;
      for await (const chunk of request) { size += chunk.length; hash.update(chunk); }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ path: '/tmp/file ', bytes: size, hash: hash.digest('hex') }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const result = await sandboxFileUpload({ sandboxHost: `http://127.0.0.1:${(server.address() as any).port}`, provider: 'daytona', apiKey: 'synthetic-key' }, 'owned', '/tmp/file ', Readable.from([bytes]));
      expect(result.bytes).toBe(bytes.length); expect(result.hash).toBe(createHash('sha256').update(bytes).digest('hex')); expect(calls).toBe(1);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('does not replay an upstream failure', async () => {
    let calls = 0;
    const server = createServer(async (request, response) => {
      calls++; for await (const _chunk of request) {};
      response.writeHead(502, { 'content-type': 'application/json' }); response.end(JSON.stringify({ message: 'write result unknown' }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      await expect(sandboxFileUpload({ sandboxHost: `http://127.0.0.1:${(server.address() as any).port}`, apiKey: 'synthetic-key' }, 'owned', 'file', Readable.from([Buffer.from('data')]))).rejects.toThrow('write result unknown');
      expect(calls).toBe(1);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
