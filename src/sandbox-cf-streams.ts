import { WebSocket } from 'undici';
import { once } from 'node:events';

async function write(stream: NodeJS.WriteStream, bytes: Uint8Array) {
  if (!stream.write(bytes)) await once(stream, 'drain');
}

/** Native filesystem events are JSON records, not terminal/log bytes. */
export async function consumeCfFileEvents(url: string) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new Error('File watch connection failed: HTTP ' + response.status);
    if (!response.body) throw new Error('File watch connection has no response body');
    let pending = '', ended = false;
    const decoder = new TextDecoder();
    const frame = async (value: string) => {
      const event = value.split('\n').find(line => line.startsWith('event: '))?.slice(7);
      const data = value.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
      if (!data) return;
      const payload = JSON.parse(data);
      if (event === 'error') throw new Error(payload.error ?? 'Native file watch failed');
      if (event === 'end') { ended = true; return; }
      await write(process.stdout, Buffer.from(JSON.stringify({ event, ...payload }) + '\n'));
    };
    for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(chunk, { stream: true });
      let split: number;
      while ((split = pending.indexOf('\n\n')) !== -1) {
        const value = pending.slice(0, split); pending = pending.slice(split + 2);
        await frame(value);
      }
    }
    pending += decoder.decode();
    if (pending.trim() || !ended) throw new Error('Native file watch ended without its completion frame');
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    controller.abort(); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
}

export async function consumeCfLogs(url: string) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  let response: Response | undefined;
  try {
    response = await fetch(url, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new Error('Log connection failed: HTTP ' + response.status);
    if (!response.body) throw new Error('Log connection has no response body');
    let pending = '', ended = false; const decoder = new TextDecoder();
    const readFrame = async (frame: string) => {
      const event = frame.split('\n').find(x => x.startsWith('event: '))?.slice(7);
      const data = frame.split('\n').filter(x => x.startsWith('data: ')).map(x => x.slice(6)).join('\n');
      if (!data) return;
      const payload = JSON.parse(data);
      if (event === 'stdout' || event === 'stderr') {
        if (typeof payload.data !== 'string') throw new Error('Invalid native log byte frame');
        await write(event === 'stdout' ? process.stdout : process.stderr, Buffer.from(payload.data, 'base64'));
      } else if (event === 'error') throw new Error(payload.error ?? 'Native log stream failed');
      else if (event === 'end') ended = true;
    };
    for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(chunk, { stream: true }); let split;
      while ((split = pending.indexOf('\n\n')) !== -1) { const frame = pending.slice(0, split); pending = pending.slice(split + 2); await readFrame(frame); }
    }
    pending += decoder.decode();
    if (pending.trim() || !ended) throw new Error('Native log stream ended without its completion frame');
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    controller.abort(); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
}

export async function consumeCfTerminal(url: string) {
  const socket = new WebSocket(url); socket.binaryType = 'arraybuffer';
  const raw = process.stdin.isTTY && process.stdin.isRaw;
  let opened = false, writes = Promise.resolve();
  const send = (bytes: Buffer) => { if (socket.readyState === WebSocket.OPEN) socket.send(bytes); };
  const resize = () => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 })); };
  const endInput = () => { if (socket.readyState === WebSocket.OPEN) socket.send(new Uint8Array([4])); };
  const stop = () => socket.close(1000, 'Client closed');
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => {
        opened = true;
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        process.stdin.on('data', send); process.stdin.once('end', endInput); process.stdin.resume();
        process.stdout.on('resize', resize); resize();
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
      });
      socket.addEventListener('message', event => {
        writes = writes.then(async () => {
          if (typeof event.data === 'string') await write(process.stderr, Buffer.from(event.data + '\n'));
          else await write(process.stdout, new Uint8Array(event.data as ArrayBuffer));
        }).catch(error => { socket.close(); reject(error); });
      });
      socket.addEventListener('error', () => reject(new Error('Native terminal connection failed')));
      socket.addEventListener('close', event => {
        void writes.then(() => opened && event.code === 1000 ? resolve() : reject(new Error('Native terminal closed: ' + event.code)));
      });
    });
  } finally {
    process.stdin.removeListener('data', send); process.stdin.removeListener('end', endInput); process.stdin.pause();
    process.stdout.removeListener('resize', resize); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (process.stdin.isTTY) process.stdin.setRawMode(Boolean(raw));
    if (socket.readyState < WebSocket.CLOSING) socket.close();
  }
}
