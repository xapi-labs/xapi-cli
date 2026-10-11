# Native Wrangler upload fixtures

Generated locally with Wrangler **4.131.0**, Node **22.22.3**, on 2026-09-26.
These are unmodified multipart bodies, not hand-authored approximations.
No credentials, account requests, or live deployment were used.

To reproduce each directory, put `index.ts` at `src/index.ts`, install the exact
Wrangler version outside the fixture, then run:

```sh
wrangler deploy --dry-run --config wrangler.jsonc \
  --outfile worker.bundle --outdir dist --dispatch-namespace fixture-native-options
```

The initial capture ran under macOS `sandbox-exec` with `(deny network*)` and an
empty credential environment. Multipart boundaries may vary; compare part bytes
and the canonical xAPI Artifact hash instead of the whole multipart body.

`observability-maps` is derived from a full-options case with `keep_vars` removed,
so it isolates the observability/source-map contract.
`xapi-artifact.json` is produced by `loadWorkerArtifactInput` and includes expected
hash/size for cross-repository backend JSON and streamed-upload regression tests.

`full-options` preserves the original root `keep_vars: true` capture. Its canonical
CLI Artifact is 2348 bytes with SHA256
`107df2f3c4cd9a32d2e65bf438c3b245fd90f4e3d2386ec292ce1a7e3389335c`.
The backend's `wrangler-full-options-cli-artifact.json` records the exact CLI
bytes and a supplementary case adding a native JSON-string binding; tests check
encoding, streaming, manifest storage and hydration against that capture. The
supplementary case is synthetic metadata, not a second live Cloudflare result.

The uploaded map has 819 bytes and SHA256
`ce272e4bc27548a6c05e4bc1fbbd8d7b6b34b94d9f4d899a5d056b6a1b13ef89`.
Its `sources` is `["src/index.ts"]` and `sourceRoot` is `""`, unlike the local
outdir map (`["../src/index.ts"]`, `"dist"`). Do not rewrite or substitute it.

`export-destinations` dry-run succeeds even for fictitious account target names.
xAPI must reject these until tenant ownership mapping exists. Dry-run success
is not proof that Cloudflare accepted the upload, exported logs, or remapped stacks.

References:
- https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/observability/
- https://developers.cloudflare.com/workers/observability/source-maps/
