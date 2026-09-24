import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const skill = readFileSync(
  new URL('../../skills/xapi/SKILL.md', import.meta.url),
  'utf8',
);
const guide = readFileSync(
  new URL('../../skills/xapi/guides/workers.md', import.meta.url),
  'utf8',
);
const standaloneDeployment = readFileSync(
  new URL('../../skills/xapi-workers/references/deployment.md', import.meta.url),
  'utf8',
);
const standaloneResources = readFileSync(
  new URL('../../skills/xapi-workers/references/resources.md', import.meta.url),
  'utf8',
);
const dedicatedSkill = readFileSync(
  new URL('../../skills/xapi-workers/SKILL.md', import.meta.url),
  'utf8',
);
const domainGuide = readFileSync(
  new URL('../../skills/xapi-workers/references/domains.md', import.meta.url),
  'utf8',
);
const domainConflictRecovery = readFileSync(
  new URL(
    '../../skills/xapi-workers/references/domain-conflict-recovery.md',
    import.meta.url,
  ),
  'utf8',
);

describe('bundled xAPI Workers skill guide', () => {
  it('routes hosted Worker tasks to the progressively loaded guide', () => {
    expect(skill).toContain('Read `guides/workers.md`');
    expect(skill).toContain('`workers init`');
    expect(skill).toContain('`workers promote --to production`');
  });

  it('combines xdomain ownership with native Worker Custom Domains safely', () => {
    expect(dedicatedSkill).toContain('[domains.md](references/domains.md)');
    expect(domainGuide).toContain('xapi workers domains attach');
    expect(domainGuide).toContain('domain.get');
    expect(domainGuide).toContain('dns.upsert');
    expect(domainGuide).toContain('dns.delete');
    expect(domainGuide).toContain('temporary TXT');
    expect(domainGuide).toContain('Cloudflare owns the final DNS record');
    expect(domainGuide).toContain('non-refundable');
    expect(domainGuide).toContain('Never invent missing contact fields');
    expect(domainGuide).not.toContain('wrangler deploy');
  });

  it('documents the administrator-only domain conflict recovery contract', () => {
    expect(dedicatedSkill).toContain(
      '[domain-conflict-recovery.md](references/domain-conflict-recovery.md)',
    );
    expect(domainConflictRecovery).toContain(
      'POST /api/admin/workers/domain-conflict-recovery',
    );
    expect(domainConflictRecovery).toContain('100117');
    expect(domainConflictRecovery).toContain('platform administrator');
    expect(domainConflictRecovery).toContain('fails closed');
    expect(domainConflictRecovery).toContain('does not detach or');
  });

  it('prefers project deployment and covers import, CI, recovery, and rollback boundaries', () => {
    expect(guide).toContain('xapi workers templates');
    expect(guide).toContain('xapi workers init my-agent --template persistent-agent');
    expect(guide).toContain('init --from-wrangler ./wrangler.jsonc');
    expect(guide).toContain('xapi workers plan --env preview');
    expect(guide).toContain('xapi workers push --env preview');
    expect(guide).toContain('xapi workers promote --to production');
    expect(guide).toContain('xapi workers rollback --env production');
    expect(guide).toContain('The project workflow does not require Git');
    expect(guide).toContain('--non-interactive');
    expect(guide).toContain('never deletes an extra stateful resource or Secret');
    expect(guide).toContain('does **not** restore or migrate KV');
    expect(guide).toContain('XAPI_API_HOST=api.test.xapi.to');
  });

  it('uses Artifact upload as the default and Sandbox only as an option', () => {
    expect(guide).toContain('workers upload <worker-id>');
    expect(guide).toContain('workers deploy <worker-id>');
    expect(guide).toContain('--artifact <artifact-id>');
    expect(guide).toContain('### Optional Sandbox build');
    expect(guide).toContain('"main": "worker.js"');
    expect(guide).toContain('--file dist/');
    expect(guide).toContain('--main worker.js');
    expect(guide).toContain("native static-assets upload");
    expect(guide).toContain('"directory": "dist/client"');
    expect(guide).toContain('`webAppReady: true`');
    expect(guide).not.toContain('--build <build-id>');
  });

  it('preserves key isolation, idempotency, budgets, and terminal status rules', () => {
    expect(guide).toContain('never embedded in a bundle');
    expect(guide).toContain('between $0.10 and $100 per day');
    expect(guide).toContain('Reuse an upload key only for identical normalized Artifact bytes');
    expect(guide).toContain('`status: ACTIVE`');
  });

  it('covers persistent agents, live capability diagnostics, billing, logs, and domains', () => {
    expect(guide).toContain('workers capabilities');
    expect(guide).toContain('--type do');
    expect(guide).toContain('--type queue');
    expect(guide).toContain('--type workflow');
    expect(guide).toContain('workers schedules create');
    expect(guide).toContain('Tail Worker console messages');
    expect(guide).toContain('fails closed');
    expect(guide).toContain('workers domains retry');
    expect(guide).toContain('D1 Edit');
  });

  it('keeps application resources independent from full-matrix acceptance', () => {
    for (const text of [guide, standaloneDeployment, standaloneResources]) {
      expect(text).toMatch(/separate disposable (?:acceptance )?Worker/);
      expect(text).toContain('application');
    }
    expect(standaloneResources).toContain('independent bindings');
  });
});
