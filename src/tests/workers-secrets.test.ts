import {describe,expect,it} from 'bun:test';
import {parseWorkerSecretEnv,WORKERS_HELP} from '../commands/workers.ts';

describe('Workers secret input',()=>{
  it('parses local env content in memory without expanding or printing values',()=>{
    expect(parseWorkerSecretEnv("MODEL_KEY='private-value'\n# ignored\nOTHER=literal-$MODEL_KEY\n")).toEqual({MODEL_KEY:'private-value',OTHER:'literal-$MODEL_KEY'});
  });

  it('documents environment, stdin, batch apply and provider status workflows',()=>{
    expect(WORKERS_HELP).toContain('--from-env VARIABLE | --stdin | --env-file .env');
    expect(WORKERS_HELP).toContain('secrets apply');
    expect(WORKERS_HELP).toContain('secrets status');
    expect(WORKERS_HELP).not.toContain('--value VALUE');
  });
});


it('env-file input preserves provider names without prototype mutation',()=>{
  const values=parseWorkerSecretEnv('_nativeToken=synthetic\nnative-token=synthetic\n原生Token=synthetic\n'+'Native'+'X'.repeat(75)+'=synthetic\n__proto__=synthetic');
  expect(Object.keys(values)).toHaveLength(5);
  expect(values['__proto__']).toBe('synthetic');
  expect(Object.getPrototypeOf(values)).toBeNull();
});
