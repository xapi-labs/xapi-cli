// Class names are inserted into generated module source. Binding names are
// JSON object keys and do not need JavaScript identifier syntax or a size cap.
export const WORKER_CLASS_IDENTIFIER = /^[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*$/u;
export function isWorkerBindingName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Secret declarations may repeat each other, but cannot share a non-Secret binding. */
export function conflictingWorkerSecretBinding(
  requiredSecrets: readonly string[],
  bindingNames: readonly string[],
): string | undefined {
  const occupied = new Set(bindingNames);
  return requiredSecrets.find(name => occupied.has(name));
}
