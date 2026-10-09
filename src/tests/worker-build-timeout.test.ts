import { expect, it } from 'bun:test';
import { workerBuildTimeout } from '../worker-build-timeout.ts';
it('accepts caller durations beyond previous defaults and rejects invalid durations before work', () => {
  expect(workerBuildTimeout('45m')).toBe(2700000);
  expect(workerBuildTimeout('2h')).toBe(7200000);
  expect(workerBuildTimeout('0.5s')).toBe(500);
  for(const invalid of ['true','-1s','0','1week','1.01ms'])expect(()=>workerBuildTimeout(invalid)).toThrow('positive duration');
});
