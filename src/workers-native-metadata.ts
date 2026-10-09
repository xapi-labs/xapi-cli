export class WorkerNativeMetadataError extends Error {
  constructor(message: string) { super(message); this.name = 'WorkerNativeMetadataError'; }
}

/** Ordinary native configuration has no supported-field allowlist.
 * Account/resource references and platform commit metadata are resolved separately.
 */
export function normalizeWorkerNativeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const fail = (message: string): never => { throw new WorkerNativeMetadataError(message); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Worker nativeMetadata must be a JSON object');
  const controlled = new Set(['bindings', 'main_module', 'body_part', 'compatibility_date',
    'compatibility_flags', 'assets', 'migrations', 'exports', 'containers', 'streaming_tail_consumers']);
  for (const key of Object.keys(value)) if (controlled.has(key))
    fail('Worker nativeMetadata.' + key + ' requires the owned deployment mapping');
  if (Object.hasOwn(value, 'tail_consumers')) {
    const tails = (value as Record<string, unknown>).tail_consumers;
    if (!Array.isArray(tails) || tails.some(t => !t || typeof t !== 'object' || Array.isArray(t) ||
      typeof t.service !== 'string' || !t.service.length ||
      (t.environment !== undefined && !['preview', 'production'].includes(t.environment)) ||
      t.namespace !== undefined))
      fail('Worker tail_consumers require owned Worker slug/ID and optional preview/production environment; namespace is platform-owned');
  }
  const seen = new Set<object>();
  const json = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || seen.has(item)) return fail('Worker nativeMetadata must contain lossless JSON values');
    seen.add(item);
    const result = Array.isArray(item) ? item.map(json)
      : Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, json(entry)]));
    seen.delete(item);
    return result;
  };
  const metadata = json(value) as Record<string, unknown>;
  if (metadata.keep_bindings !== undefined && (!Array.isArray(metadata.keep_bindings) ||
      metadata.keep_bindings.some(type => !['plain_text', 'json', 'secret_text', 'secret_key'].includes(type))))
    fail('Worker keep_bindings for resource references requires the owned deployment mapping');
  if (metadata.tags !== undefined && (!Array.isArray(metadata.tags) || metadata.tags.some(tag =>
      typeof tag !== 'string' || (tag.startsWith('xapi-deployment:') || tag.startsWith('xapi-operation:')))))
    fail('Worker tags must be strings and cannot replace the platform deployment identity');
  if (metadata.version_metadata !== undefined) {
    const version = metadata.version_metadata as Record<string, unknown>;
    if (!version || typeof version !== 'object' || Array.isArray(version) ||
        typeof version.binding !== 'string' || !version.binding.length || version.binding === 'XAPI_AI_BASE_URL' ||
        Object.keys(version).some(key => key !== 'binding')) fail('Invalid Worker version metadata binding');
  }
  const observability = metadata.observability as Record<string, unknown> | undefined;
  for (const section of [observability, observability?.logs, observability?.traces]) {
    const destinations = (section as Record<string, unknown>)?.destinations;
    if (destinations !== undefined && (!Array.isArray(destinations) || destinations.length))
      fail('Worker observability destinations require owned destination mapping');
  }
  return metadata;
}

/** version_metadata is a native built-in binding declaration, not an upload top-level field. */
export function workerNativeUploadMetadata(value: unknown): Record<string, unknown> {
  const {version_metadata: _version, keep_bindings: _keep, tags: _tags, tail_consumers: _tails, ...metadata} = normalizeWorkerNativeMetadata(value) || {};
  if ((metadata.placement as {mode?:unknown})?.mode === 'off') delete metadata.placement;
  return metadata;
}
