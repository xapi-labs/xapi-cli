import { open } from "node:fs/promises";
import type { WorkerDomainChallenge } from "./workers-client.ts";

/** Read the public API's saved challenge without putting its token in shell history. */
export async function readWorkerDomainChallenge(
  path: string,
  environment: string,
): Promise<WorkerDomainChallenge> {
  const file = await open(path, "r");
  let source: string;
  try {
    if (!(await file.stat()).isFile()) throw new Error("Challenge must be a regular JSON file");
    const buffer = Buffer.alloc(65_537);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 65_536) throw new Error("Challenge file exceeds 64 KiB");
    source = buffer.subarray(0, length).toString("utf8");
  } finally {
    await file.close();
  }
  let value: WorkerDomainChallenge;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Challenge file is not valid JSON; save the domains challenge JSON response");
  }
  if (!value || typeof value !== "object" ||
      typeof value.challengeToken !== "string" || !value.challengeToken ||
      typeof value.hostname !== "string" || !value.hostname ||
      typeof value.environment !== "string" ||
      typeof value.expiresAt !== "string") {
    throw new Error("Challenge file is missing domain challenge metadata");
  }
  if (value.environment.toLowerCase() !== environment) {
    throw new Error("Challenge environment differs from --env; request a challenge for the intended environment");
  }
  if (!Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) {
    throw new Error("Domain challenge has expired; request a new challenge and update its TXT record");
  }
  // xAPI verifies the signed token's account, Worker, environment and hostname.
  // The local JSON metadata is only a user-facing preflight, never authorization.
  return value;
}
