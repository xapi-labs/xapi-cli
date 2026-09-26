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
so it isolates this milestone. Variable retention remains a separate contract.
`xapi-artifact.json` is produced by `loadWorkerArtifactInput` and includes expected
hash/size for cross-repository backend JSON and streamed-upload regression tests.

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
