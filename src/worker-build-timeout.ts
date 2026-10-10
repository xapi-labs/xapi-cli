/** A caller-selected build budget, with no xAPI product ceiling. */
export function workerBuildTimeout(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value);
  const scale = {ms:1,s:1000,m:60000,h:3600000}[match?.[2] as 'ms'|'s'|'m'|'h'] ?? 1;
  const milliseconds = match ? Number(match[1]) * scale : NaN;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) throw new Error('--build-timeout must be a positive duration, for example 30m');
  return milliseconds;
}
