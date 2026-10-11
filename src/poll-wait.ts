/** Wait until the polling clock reaches the target, even if a timer wakes early. */
export async function waitForPoll(delayMs: number, deadline?: number): Promise<void> {
  const target = Math.min(Date.now() + delayMs, deadline ?? Infinity);
  let remaining: number;
  while ((remaining = target - Date.now()) > 0) {
    await new Promise<void>(resolve => setTimeout(resolve, remaining));
  }
}
