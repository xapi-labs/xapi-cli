import type {WorkerBillingQuery} from './workers-client.ts';

type Row = Record<string, any>;
const decimal = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const integer = /^(0|[1-9][0-9]*)$/;
const qualities = ['COMPLETE','PARTIAL','INDETERMINATE'];
function invalid(): never {throw new Error('Invalid or changed usage page; complete usage read unavailable');}
function record(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Row;
}
function time(value: unknown): value is string {return typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));}
function text(value: unknown): value is string {return typeof value === 'string' && value.length > 0;}
function nullableText(value: unknown): boolean {return value === null || text(value);}
function quantity(value: unknown): boolean {return value === null || typeof value === 'string' && decimal.test(value);}
function coverage(value: unknown) {
  const item = record(value);
  if (!qualities.includes(item.status) || !Array.isArray(item.reasonCodes) || !item.reasonCodes.every(text)) invalid();
}
function summary(value: unknown): Row {
  const item = record(value), source = record(item.sourceSelection);
  if (!nullableText(item.resourceId) || !text(item.resourceKey) || !text(item.metric) || !quantity(item.quantity) ||
      !(item.eventCount === null || typeof item.eventCount === 'string' && integer.test(item.eventCount)) ||
      !['EVENT_SUM','CUMULATIVE_LATEST','UNRESOLVED'].includes(source.kind) ||
      !nullableText(source.provider) || !nullableText(source.dataset)) invalid();
  coverage(item.coverage);
  if (source.kind === 'EVENT_SUM' && item.eventCount === null ||
      source.kind === 'CUMULATIVE_LATEST' && item.eventCount !== null ||
      source.kind === 'UNRESOLVED' && (item.quantity !== null || item.coverage.status !== 'INDETERMINATE')) invalid();
  return item;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,canonical(value)]));
  return value;
}
const fingerprint = (value: unknown) => JSON.stringify(canonical(value));

/** Default continuation reads only PG aggregates. Pagination completion is not
 * metering completeness; totals/coverage belong to the full scope, never a page. */
export async function collectWorkerBillingUsage(
  fetchPage: (query: WorkerBillingQuery) => Promise<unknown>, query: WorkerBillingQuery = {}, signal?: AbortSignal,
  expectedScope?: {workerId: string; environment: string},
): Promise<unknown> {
  let first: Row | undefined, context: string | undefined;
  let nextQuery = {...query};
  const cursors = new Set<string>(query.cursor ? [query.cursor] : []);
  const groups = new Set<string>();
  const buckets = new Map<string, Row>();
  while (true) {
    signal?.throwIfAborted();
    const raw = await fetchPage(nextQuery);
    signal?.throwIfAborted();
    const page = record(raw), data = record(page.data);
    const hasAggregates = Object.hasOwn(data,'totals') || Object.hasOwn(data,'pagination') ||
      Array.isArray(data.buckets) && data.buckets.some((bucket:unknown)=>Object.hasOwn(record(bucket),'summaries'));
    // Older backend responses retain their read shape; never infer totals or
    // coverage from their diagnostic facts. Human output labels this limitation.
    if (!first && !hasAggregates) return raw;
    if (page.schemaVersion !== 1 || !text(page.snapshotId) || !time(page.snapshotTime) ||
        !text(page.workerId) || !['preview','production'].includes(page.environment) ||
        !(page.completeThrough === null || time(page.completeThrough)) || !qualities.includes(page.dataQuality) ||
        !time(data.from) || !time(data.to) || Date.parse(data.to) <= Date.parse(data.from) ||
        data.bucketSeconds !== 300 || !nullableText(data.metric) || !nullableText(data.resourceId) ||
        !Array.isArray(data.buckets) || !Array.isArray(data.totals) ||
        ![data.bucketCount,data.gapCount,data.partialCount].every(value=>Number.isSafeInteger(value) && value >= 0)) invalid();
    if (!first && (query.snapshotTime && Date.parse(query.snapshotTime) !== Date.parse(page.snapshotTime) ||
        query.from && Date.parse(query.from) !== Date.parse(data.from) || query.to && Date.parse(query.to) !== Date.parse(data.to) ||
        query.metric && query.metric !== data.metric || query.resourceId && query.resourceId !== data.resourceId ||
        expectedScope && (expectedScope.workerId !== page.workerId || expectedScope.environment !== page.environment))) invalid();
    const metrics = new Set<string>();
    for (const totalValue of data.totals) {
      const total = record(totalValue);
      if (!text(total.metric) || !quantity(total.quantity) || metrics.has(total.metric)) invalid();
      coverage(total.coverage);metrics.add(total.metric);
    }
    const current = fingerprint({schemaVersion:page.schemaVersion,workerId:page.workerId,environment:page.environment,
      snapshotId:page.snapshotId,snapshotTime:page.snapshotTime,completeThrough:page.completeThrough,dataQuality:page.dataQuality,
      from:data.from,to:data.to,metric:data.metric,resourceId:data.resourceId,bucketSeconds:data.bucketSeconds,
      bucketCount:data.bucketCount,gapCount:data.gapCount,partialCount:data.partialCount,
      totals:[...data.totals].sort((a,b)=>a.metric.localeCompare(b.metric))});
    if (context !== undefined && current !== context) invalid();
    context ??= current;first ??= page;
    let added = 0;
    for (const bucketValue of data.buckets) {
      const bucket = record(bucketValue);
      if (!time(bucket.start) || !time(bucket.end) || Date.parse(bucket.end)-Date.parse(bucket.start) !== 300_000 ||
          Date.parse(bucket.end) <= Date.parse(data.from) || Date.parse(bucket.start) >= Date.parse(data.to) ||
          !['COMPLETE','PARTIAL','GAP'].includes(bucket.status) || !Array.isArray(bucket.summaries) ||
          !Array.isArray(bucket.facts) || bucket.facts.length) invalid();
      const bucketKey = String(Date.parse(bucket.start)), existing = buckets.get(bucketKey);
      if (existing && (Date.parse(existing.end) !== Date.parse(bucket.end) || existing.status !== bucket.status)) invalid();
      const merged = existing || {...bucket,summaries:[]};
      for (const value of bucket.summaries) {
        const item = summary(value), key = JSON.stringify([Date.parse(bucket.start),item.resourceKey,item.metric]);
        if (groups.has(key)) invalid();
        groups.add(key);merged.summaries.push(item);added++;
      }
      buckets.set(bucketKey,merged);
    }
    const pagination = record(data.pagination);
    if (typeof pagination.hasMore !== 'boolean') invalid();
    if (!pagination.hasMore) {
      if (pagination.nextCursor !== null) invalid();
      return {...first,data:{...first.data,buckets:[...buckets.values()].sort((a,b)=>Date.parse(a.start)-Date.parse(b.start)),
        pagination:{hasMore:false,nextCursor:null}}};
    }
    if (!added || !text(pagination.nextCursor) || cursors.has(pagination.nextCursor)) invalid();
    cursors.add(pagination.nextCursor);
    nextQuery = {...query,snapshotTime:first.snapshotTime,from:first.data.from,to:first.data.to,
      metric:first.data.metric ?? undefined,resourceId:first.data.resourceId ?? undefined,cursor:pagination.nextCursor};
  }
}
