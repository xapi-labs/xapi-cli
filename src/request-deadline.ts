/** Node coerces timers above this value to 1ms instead of waiting. */
export const REQUEST_TIMER_CHUNK_MS = 2_147_483_647;

/** Preserve ordinary timer semantics, chaining only values above Node's limit. */
export function requestDeadline(callback: () => void, timeoutMs: number) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= REQUEST_TIMER_CHUNK_MS) {
    const timer = setTimeout(callback, timeoutMs);
    return { dispose: () => clearTimeout(timer) };
  }
  let remaining = timeoutMs;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    const chunk = Math.min(remaining, REQUEST_TIMER_CHUNK_MS);
    timer = setTimeout(() => {
      remaining -= chunk;
      if (remaining > 0) schedule();
      else callback();
    }, chunk);
  };
  schedule();
  return { dispose: () => clearTimeout(timer) };
}
