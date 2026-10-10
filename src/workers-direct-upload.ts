import {
  HttpError,
  isRetryableRequestError,
  createArtifactControlSession,
  createArtifactUploadTransport,
  WorkerObjectUploadError,
} from './client.ts';
import {
  workerArtifactDirectUpload,
  type WorkerArtifactUploadRequest,
} from './workers-artifact.ts';

type UploadPage = {
  uploadId: string;
  expiresAt: string;
  nextCursor: number | null;
  files: Array<{
    sha256: string;
    size: number;
    url: string;
    headers: Record<string, string>;
  }>;
};
type UploadStatus = {
  uploadId: string;
  status: string;
  artifact?: unknown;
  progress?: { stage: string; completedFiles: number; totalFiles: number };
  error?: { code: string; status?: number };
};
const CONFIRM_STATUS_ATTEMPTS = 5;
const CONFIRM_STATUS_INTERVAL_MS = 1_000;

export class WorkerArtifactObjectUploadError extends Error {
  readonly recovery: Record<string, unknown>;
  constructor(workerId: string, uploadId: string, failure: WorkerObjectUploadError) {
    const next = `xapi workers upload-status ${JSON.stringify(workerId)} --upload ${uploadId}`;
    super(failure.message + `; upload ID ${uploadId}; query with ${next}`);
    this.name = 'WorkerArtifactObjectUploadError';
    this.recovery = {errorCode: 'worker_artifact_object_upload_failed', uploadId,
      ...failure.diagnostic, next};
  }
}

// Presigned object headers may include provider extensions. Reject credentials
// and routing/framing overrides rather than allowlisting signing headers.
const UNSAFE_OBJECT_HEADERS = new Set([
  'authorization', 'cookie', 'cookie2', 'set-cookie', 'xapi-key', 'x-api-key', 'xapi-api-key',
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length',
  'te', 'trailer', 'upgrade', 'expect', 'forwarded', 'via',
  'origin', 'referer', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip',
]);

function objectUploadHeaders(value: unknown, checksum: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Worker object authorization headers');
  const result: Record<string, string> = Object.create(null);
  let size = 0;
  for (const [name, content] of Object.entries(value)) {
    const key = name.toLowerCase();
    if (
      name.length > 256 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      typeof content !== 'string' || Buffer.byteLength(content) > 8192 ||
      /[\x00-\x08\x0a-\x1f\x7f]|[^\x00-\xff]/.test(content) ||
      UNSAFE_OBJECT_HEADERS.has(key) || /^(proxy-|sec-|x-forwarded-)/.test(key) ||
      Object.hasOwn(result, key)
    )
      throw new Error('Invalid Worker object authorization headers');
    size += Buffer.byteLength(name) + Buffer.byteLength(content) + 4;
    if (size > 65536)
      throw new Error('Invalid Worker object authorization headers');
    result[key] = content;
  }
  if (result['x-amz-checksum-sha256'] !== checksum)
    throw new Error('Worker upload checksum authorization mismatch');
  if (!Object.hasOwn(result, 'content-type'))
    result['content-type'] = 'application/octet-stream';
  return result;
}

/** A sent confirmation can still commit; preparing another upload is not recovery. */
export class WorkerArtifactConfirmationPendingError extends Error {
  readonly recovery: Record<string, unknown>;
  constructor(
    uploadId: string,
    idempotencyKey: string,
    status: string,
    statusEndpoint: string,
    failure: unknown,
  ) {
    super(
      'Worker Artifact confirmation is unresolved; no deployment was started',
    );
    this.name = 'WorkerArtifactConfirmationPendingError';
    this.recovery = {
      errorCode: 'worker_artifact_confirmation_pending',
      uploadId,
      idempotencyKey,
      status,
      statusEndpoint,
      firstFailure: {
        type: failure instanceof Error ? failure.name : 'UnknownError',
        ...(failure instanceof HttpError ? { status: failure.status } : {}),
      },
      next:
        'Use workers upload-status <worker-id> --upload ' +
        uploadId +
        '; once READY, rerun the original workers push command to reuse the immutable Artifact',
    };
  }
}

export async function uploadDirectWorkerArtifact(
  input: WorkerArtifactUploadRequest,
  apiUrl: string,
  headers: HeadersInit,
  timeoutMs = 900_000,
  callerSignal?: AbortSignal,
  onProgress?: (message: string) => void,
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error('Upload timeout must be positive');
  const prepared = workerArtifactDirectUpload(input);
  const controller = new AbortController();
  const cancel = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) cancel();
  else callerSignal?.addEventListener('abort', cancel, { once: true });
  let timer = setTimeout(
    () =>
      controller.abort(
        new Error(
          'Worker upload time limit reached; no deployment was started',
        ),
      ),
    timeoutMs,
  );
  const signal = controller.signal;
  const objectTransport = createArtifactUploadTransport();
  const controlSession = createArtifactControlSession();
  let lastProgressAt = 0;
  const progress = (message: string, force = false) => {
    if (force || Date.now() - lastProgressAt > 2000) {
      lastProgressAt = Date.now();
      onProgress?.(message);
    }
  };
  const directRequest = <T,>(url: string, init: RequestInit, budget: number, retries: number) =>
    controlSession.request<T>(url, init, budget, retries);
  const workerId = decodeURIComponent(
    new URL(apiUrl).pathname.split('/').at(-2)!,
  );
  const readyArtifact = (value: unknown) => {
    const artifact = value as Record<string, unknown> | undefined;
    if (
      !artifact ||
      typeof artifact !== 'object' ||
      Array.isArray(artifact) ||
      typeof artifact.id !== 'string' ||
      !artifact.id ||
      artifact.contentSha256 !== prepared.identity.contentSha256 ||
      artifact.sizeBytes !== prepared.identity.sizeBytes ||
      (artifact.workerId !== undefined && artifact.workerId !== workerId) ||
      (artifact.idempotencyKey !== undefined &&
        artifact.idempotencyKey !== input.idempotencyKey)
    )
      throw new Error(
        'Worker confirmed artifact does not match the upload identity',
      );
    return artifact;
  };
  let observedStatus = 'UNAVAILABLE';
  const recoverReady = async (uploadId: string, attempts = 1) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      signal.throwIfAborted();
      let status: UploadStatus | undefined;
      let statusRead = false;
      try {
        status = await directRequest<UploadStatus>(
          apiUrl + '/' + encodeURIComponent(uploadId) + '/status',
          { headers, signal },
          5_000,
          0,
        );
        statusRead = true;
      } catch (error) {
        signal.throwIfAborted();
        // Older control planes do not expose status; retain the original failure.
        if (error instanceof HttpError && [404, 405].includes(error.status)) {
          observedStatus = 'UNAVAILABLE';
          return undefined;
        }
        if (
          !isRetryableRequestError(error) &&
          !(error instanceof HttpError && error.status >= 500)
        )
          throw error;
        observedStatus = 'UNAVAILABLE';
        if (attempt === attempts - 1) return undefined;
      }
      if (statusRead && !status)
        throw new Error('Invalid Worker upload status');
      if (status) {
        if (status.uploadId !== uploadId)
          throw new Error('Invalid Worker upload status');
        observedStatus = status.status;
        if (status.status === 'READY') return readyArtifact(status.artifact);
        if (status.status === 'EXPIRED') return undefined;
        if (status.status === 'FAILED')
          throw new Error(
            `Worker Artifact confirmation failed (${status.error?.code || 'worker_artifact_confirmation_failed'}); retry the original push`,
          );
        if (status.progress)
          progress(
            `Artifact ${status.progress.stage}: ${status.progress.completedFiles}/${status.progress.totalFiles} files`,
          );
        if (!['UPLOADING', 'QUEUED', 'CONFIRMING'].includes(status.status))
          throw new Error('Invalid Worker upload status');
      }
      if (attempt < attempts - 1)
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          }, CONFIRM_STATUS_INTERVAL_MS);
          signal.addEventListener('abort', onAbort, { once: true });
        });
    }
    return undefined;
  };
  try {
    signal.throwIfAborted();
    let page = await directRequest<UploadPage>(
      apiUrl,
      { method: 'POST', headers, body: JSON.stringify(prepared.input), signal },
      60_000,
      0,
    );
    const uploadId = page.uploadId;
    if (typeof uploadId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(uploadId))
      throw new Error('Invalid Worker upload session');
    const sent = new Set<string>(),
      authorizedHashes = new Set<string>();
    let cursor = 0;
    let uploadedBytes = 0;
    progress(`Uploading ${prepared.files.size} files to R2; upload ID ${uploadId}; query with xapi workers upload-status ${JSON.stringify(workerId)} --upload ${uploadId}`, true);
    while (true) {
      if (page.uploadId !== uploadId || !Array.isArray(page.files))
        throw new Error('Invalid Worker upload authorization');
      const authorized = page.files.map((item) => {
        signal.throwIfAborted();
        const bytes = prepared.files.get(item.sha256);
        if (
          !bytes ||
          bytes.length !== item.size ||
          authorizedHashes.has(item.sha256)
        )
          throw new Error(
            'Worker upload authorization does not match the artifact',
          );
        const target = new URL(item.url),
          api = new URL(apiUrl);
        const local = ['127.0.0.1', 'localhost', '[::1]'];
        const native =
          target.protocol === 'https:' &&
          target.hostname.endsWith('.r2.cloudflarestorage.com');
        const test =
          local.includes(api.hostname) &&
          local.includes(target.hostname) &&
          target.protocol === 'http:';
        if ((!native && !test) || target.username || target.password)
          throw new Error('Invalid temporary Worker object channel');
        const checksum = Buffer.from(item.sha256, 'hex').toString('base64');
        const uploadHeaders = objectUploadHeaders(item.headers, checksum);
        authorizedHashes.add(item.sha256);
        return { item, bytes, uploadHeaders };
      });
      let next = 0,
        failed: unknown;
      await Promise.all(
        Array.from({ length: Math.min(8, authorized.length) }, async () => {
          while (next < authorized.length && !failed) {
            const { item, bytes, uploadHeaders } = authorized[next++];
            try {
              await objectTransport.upload(
                item.url,
                bytes,
                uploadHeaders,
                signal,
              );
              sent.add(item.sha256);
              uploadedBytes += bytes.length;
              progress(
                `Uploaded ${sent.size}/${prepared.files.size} files (${uploadedBytes} bytes)`,
              );
            } catch (error) {
              // Preserve the first object failure; sibling cancellation does not
              // identify another failed object or imply anything about R2 state.
              if (!failed) {
                failed = error instanceof WorkerObjectUploadError
                  ? new WorkerArtifactObjectUploadError(workerId, uploadId, error) : error;
                controller.abort(failed);
              }
            }
          }
        }),
      );
      if (failed) throw failed;
      if (page.nextCursor === null) break;
      if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= cursor)
        throw new Error('Invalid Worker upload pagination');
      cursor = page.nextCursor;
      page = await directRequest<UploadPage>(
        apiUrl + '/' + encodeURIComponent(uploadId) + '?cursor=' + cursor,
        { headers, signal },
        30_000,
        1,
      );
    }
    if (sent.size !== prepared.files.size) {
      // A concurrent confirmation can compact a reused session between pages.
      const ready = await recoverReady(uploadId);
      if (ready) return ready;
      throw new Error('Worker upload has missing files');
    }
    signal.throwIfAborted();
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        controller.abort(
          new Error('Worker Artifact confirmation wait expired'),
        ),
      timeoutMs,
    );
    progress('Upload complete; confirming immutable Artifact', true);
    try {
      const result = await directRequest<unknown>(
        apiUrl + '/' + encodeURIComponent(uploadId) + '/confirm',
        {
          method: 'POST',
          headers,
          signal,
          body: JSON.stringify({ async: true }),
        },
        30_000,
        0,
      );
      if (result && typeof result === 'object' && 'uploadId' in result) {
        if ((result as UploadStatus).uploadId !== uploadId)
          throw new Error('Invalid Worker upload status');
        const ready = await recoverReady(
          uploadId,
          Math.ceil(timeoutMs / CONFIRM_STATUS_INTERVAL_MS),
        );
        if (ready) return ready;
        throw new WorkerArtifactConfirmationPendingError(
          uploadId,
          input.idempotencyKey,
          observedStatus,
          new URL(apiUrl).pathname +
            '/' +
            encodeURIComponent(uploadId) +
            '/status',
          new Error('Confirmation has no final result'),
        );
      }
      return readyArtifact(result);
    } catch (error) {
      if (signal.aborted)
        throw new WorkerArtifactConfirmationPendingError(
          uploadId,
          input.idempotencyKey,
          observedStatus,
          new URL(apiUrl).pathname +
            '/' +
            encodeURIComponent(uploadId) +
            '/status',
          error,
        );
      if (
        !(error instanceof SyntaxError) &&
        !isRetryableRequestError(error) &&
        !(error instanceof HttpError && error.status >= 500)
      )
        throw error;
      let ready;
      try {
        ready = await recoverReady(uploadId, CONFIRM_STATUS_ATTEMPTS);
        if (!ready && ['QUEUED', 'CONFIRMING'].includes(observedStatus))
          ready = await recoverReady(
            uploadId,
            Math.ceil(timeoutMs / CONFIRM_STATUS_INTERVAL_MS),
          );
      } catch (recoveryError) {
        if (signal.aborted)
          throw new WorkerArtifactConfirmationPendingError(
            uploadId,
            input.idempotencyKey,
            observedStatus,
            new URL(apiUrl).pathname +
              '/' +
              encodeURIComponent(uploadId) +
              '/status',
            error,
          );
        throw recoveryError;
      }
      if (ready) return ready;
      throw new WorkerArtifactConfirmationPendingError(
        uploadId,
        input.idempotencyKey,
        observedStatus,
        new URL(apiUrl).pathname +
          '/' +
          encodeURIComponent(uploadId) +
          '/status',
        error,
      );
    }
  } finally {
    await Promise.all([objectTransport.close(), controlSession.close()]);
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', cancel);
  }
}
