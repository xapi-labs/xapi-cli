import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as config from '../config.ts';
import {
  SANDBOX_HELP,
  sandboxCreate,
  sandboxExec,
  sandboxExtension,
  sandboxOfferings,
  sandboxPort,
  sandboxQuote,
} from '../commands/sandbox.ts';

const guide = readFileSync(new URL('../../skills/xapi/guides/sandbox.md', import.meta.url), 'utf8');
type HelpCommand = (args: string[], flags: Record<string, string>) => Promise<void>;

describe('Sandbox public contract discovery through help', () => {
  const spies: Array<ReturnType<typeof spyOn>> = [];
  let printed: string[];

  beforeEach(() => {
    printed = [];
    spies.push(spyOn(console, 'log').mockImplementation(value => { printed.push(String(value)); }));
    spies.push(spyOn(process, 'exit').mockImplementation(code => { throw new Error(`help-exit:${code}`); }));
    spies.push(spyOn(config, 'getConfig').mockImplementation(() => { throw new Error('help read configuration'); }));
    spies.push(spyOn(globalThis, 'fetch').mockRejectedValue(new Error('help dispatched HTTP')));
  });

  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore();
  });

  async function helpText(command: HelpCommand): Promise<string> {
    await expect(command([], { help: 'true' })).rejects.toThrow('help-exit:0');
    expect(config.getConfig).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    return printed.join('\n');
  }

  it('discovers extension selection and published-prefix pinning before configuration', async () => {
    const offerings = await helpText(sandboxOfferings);
    expect(offerings).toContain('published host prefix');
    expect(offerings).toContain('extension inputSchema');
    expect(SANDBOX_HELP).toContain('extension:cloudflare.files.watch');
    expect(guide).toContain("Use its `provider.hostPrefix`");
    expect(guide).toContain('or the prefix published for an older deployment');
    expect(guide).toContain('`capabilities.extensionIds`');
  });

  it('makes all accepted requirement fields and exact-create selection discoverable', async () => {
    const quote = await helpText(sandboxQuote);
    for (const field of [
      'environmentId', 'cpu', 'memoryGiB', 'volumeGiB', 'gpu', 'regions',
      'capabilities', 'minContinuousRuntimeSeconds',
    ]) {
      expect(quote).toContain(`${field}:`);
      expect(guide).toContain(`\`${field}\``);
    }
    expect(quote).toContain('resource max fields are not requirements fields');
    expect(quote).toContain('quote has no --offering-id flag');
    expect(quote).toContain('create --offering-id');
    expect(quote).toContain('--quote-id');
    const create = await helpText(sandboxCreate);
    expect(create).toContain('cannot be combined with requirements or --max-hourly-usd');
  });

  it('publishes single-dispatch exec and foreground-session cancellation differences', async () => {
    const exec = await helpText(sandboxExec);
    expect(exec).toContain('command POSTs are not automatically retried');
    expect(exec).toContain('Ordinary exec has no caller --idempotency-key');
    expect(exec).toContain('Daytona deletes its');
    expect(exec).toContain('private foreground session');
    expect(exec).toContain('--background retains its provider session');
    expect(guide).not.toContain('Stopping the output stream does not implicitly kill the upstream process');
    expect(guide).toContain('Vercel\'s detached native foreground command continues');
  });

  it('distinguishes common protocol capabilities and native extension limits', async () => {
    const extension = await helpText(sandboxExtension);
    expect(extension).toContain('extension:<ID>');
    expect(extension).toContain('terminal/snapshot=false does not disable');
    expect(extension).toContain('vercel.snapshot.list uses native input.limit 1-50');
    expect(extension).toContain('page is empty');
    expect(guide).toContain('Native `.list` accepts `limit` from 1 to 50');
  });

  it('explains native preview authentication before opening a browser', async () => {
    const port = await helpText(sandboxPort);
    expect(port).toContain('Include returned headers');
    expect(port).toContain('x-daytona-preview-token');
    expect(port).toContain('without that header can receive 401');
    expect(port).toContain('vercel.update');
    expect(guide).toContain('port publication does not promise browser access without configuration');
  });
});
