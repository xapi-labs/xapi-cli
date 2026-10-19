import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { HttpError, uploadRequest } from './client.ts';
import { scheme } from './config.ts';

const MAX_LOGO_SIZE = 10 * 1024 * 1024;

function imageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
}

async function readLogo(path: string): Promise<{ bytes: Buffer; mime: string }> {
  let handle;
  try {
    handle = await open(path, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('LOGO must be a regular image file.');
    if (stat.size > MAX_LOGO_SIZE) throw new Error('LOGO exceeds the 10 MB limit.');
    // Bound the read even if the file grows after stat().
    const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_LOGO_SIZE + 1));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_LOGO_SIZE || offset > stat.size) throw new Error('LOGO changed while being read; retry with a stable file.');
    const content = bytes.subarray(0, offset);
    const mime = imageMime(content);
    if (!mime) throw new Error('Unsupported LOGO format. Use JPG, PNG, GIF or WebP.');
    return { bytes: content, mime };
  } catch (error: any) {
    if (error?.code === 'ENOENT') throw new Error('LOGO file does not exist. Check --logo-file.');
    if (error?.code === 'EACCES' || error?.code === 'EPERM') throw new Error('LOGO file is not readable. Check file permissions.');
    if (error?.code) throw new Error('Cannot read LOGO file. Check --logo-file and file permissions.');
    throw error;
  } finally {
    await handle?.close();
  }
}

/** Upload with the platform API Key; storage credentials stay on the server. */
export async function uploadProviderLogo(apiHost: string, apiKey: string, path: string): Promise<string> {
  const { bytes, mime } = await readLogo(path);
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(bytes)], { type: mime }), basename(path));
  let response: any;
  try {
    response = await uploadRequest(`${scheme(apiHost)}://${apiHost}/api/api-services/agent/logo`, {
      method: 'POST', headers: { 'XAPI-KEY': apiKey }, body: form,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      const hint = error.status === 401 ? 'Check your API Key.'
        : error.status === 403 ? 'Grant service:create and check API Key IP restrictions.'
        : error.status === 404 ? 'The server must support provider LOGO uploads.'
        : error.status === 413 ? 'Use an image up to 10 MB.'
        : 'Check image format and server image storage configuration.';
      throw new Error(`LOGO upload failed (HTTP ${error.status}). ${hint} Service was not created.`);
    }
    // Avoid exposing a response body, URL or credentials from a transport error.
    throw new Error('LOGO upload failed. Check network access and server image storage, then retry. Service was not created.');
  }
  const url = response?.url ?? response?.data?.url;
  try {
    if (typeof url !== 'string') throw new Error();
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
  } catch {
    throw new Error('LOGO upload returned no valid image URL. Service was not created.');
  }
  return url;
}
