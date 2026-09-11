import type { WorkerBillingQuery } from "./workers-client.ts";

type Page = Record<string, any>;

/** Fetch a single UTC billing-day snapshot; never silently return a partial ledger. */
export async function collectWorkerBillingLedger(
  fetchPage: (query: WorkerBillingQuery) => Promise<unknown>,
  query: WorkerBillingQuery = {},
  maxPages = 100,
): Promise<Page> {
  if (query.cursor) throw new Error("--all cannot be combined with --cursor");
  let first: Page | undefined;
  let cursor: string | undefined;
  let snapshotTime = query.snapshotTime;
  const cursors = new Set<string>();
  const ids = new Set<string>();
  const entries: unknown[] = [];
  const pageSnapshotIds: (string | null)[] = [];
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    const page = await fetchPage({ ...query, limit: query.limit ?? "100", snapshotTime, cursor }) as Page;
    if (!page || typeof page.snapshotTime !== "string" || !Number.isFinite(Date.parse(page.snapshotTime)) ||
        !Array.isArray(page.data?.entries) || typeof page.data.hasMore !== "boolean") {
      throw new Error("Invalid ledger page; complete ledger unavailable");
    }
    if (snapshotTime && Date.parse(page.snapshotTime) !== Date.parse(snapshotTime)) {
      throw new Error("Ledger snapshot changed; refusing to mix billing periods");
    }
    if (first && (page.workerId !== first.workerId || page.environment !== first.environment)) {
      throw new Error("Ledger scope changed during pagination");
    }
    pageSnapshotIds.push(typeof page.snapshotId === "string" ? page.snapshotId : null);
    first ??= page;
    snapshotTime = page.snapshotTime;
    for (const entry of page.data.entries) {
      if (!entry || typeof entry.id !== "string" || !entry.id || ids.has(entry.id)) {
        throw new Error("Missing or duplicate ledger entry ID; complete ledger unavailable");
      }
      ids.add(entry.id);
      entries.push(entry);
    }
    if (!page.data.hasMore) {
      return { ...first, data: { ...first.data, entries, hasMore: false, nextCursor: null },
        pagination: { pages: pageNumber, entries: entries.length, complete: true, pageSnapshotIds } };
    }
    const next = page.data.nextCursor;
    if (typeof next !== "string" || !next || cursors.has(next)) {
      throw new Error("Missing or repeated ledger cursor; complete ledger unavailable");
    }
    cursors.add(next);
    cursor = next;
  }
  throw new Error(`Ledger exceeds ${maxPages} pages; use manual --cursor pagination at the same --snapshot-time`);
}
