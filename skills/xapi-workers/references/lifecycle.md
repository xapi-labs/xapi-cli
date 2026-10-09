# Retention, recovery and cleanup

Read current state and policy before choosing an action:

```sh
xapi workers retention show <worker-id> --env preview --format json
xapi workers retention quote <worker-id> --env preview --type WORKER --format json
xapi workers billing lifecycle <worker-id> --env preview --json
```

A quote is not policy acceptance. If already authorized, accept the returned exact version:

```sh
xapi workers retention accept <worker-id> --env preview --price-version <returned-version> --yes
```

Acceptance records the returned price/policy version. Both Preview and Production preserve an overdue environment for at least 168 hours. After that minimum, remaining spendable retention funds extend preservation; system cleanup is permitted only when those funds are exhausted. Owner deletion remains available at any time. Do not request approval again when that policy and scope are already authorized. Provision with the same accepted version where required. Different resource types can have separate quotes; inspect the API response instead of copying an old price version.

```sh
xapi workers retention pause <worker-id> --env preview
xapi workers retention resume <worker-id> --env preview
xapi workers retention keep-paused <worker-id> --env preview
```

Manual pause, low balance and pending deletion are distinct. Owner pause/resume/delete do not require automatic-maintenance switches. Existing joint resource funding also remains atomic when optional automatic retention is disabled; it still checks the actual account balance and accepted price version, and reuses the original hold on an identical request. A deposit does not authorize business resumption. Reserve exhaustion alone does not authorize early deletion. The system checks both the full seven-day minimum and actual protected-fund exhaustion before cleanup. A recorded time is a minimum guarantee, not a fixed deletion deadline. Running reserves are separate from protected retention funds. Read the actual lifecycle and operation receipts. If a requested pause/delete fails or remains incomplete, show the failed step and let the user decide whether to retry; never automatically replay their write or force a redeploy/edit a database flag. A pending script mutation can still require reconciliation to avoid changing the wrong native version.

After completed owner recovery, the API attempts the existing fenced postpaid publication immediately and reports `accessPreparation` as `PUBLISHED`, `PENDING` with a reason, or `DISABLED`. `PUBLISHED` confirms publication, not instantaneous public readiness; verify actual service access. `PENDING` does not undo recovery or authorize a replay: wait and retry service access, inspect billing/publication evidence if it persists. Ordinary background publication remains the recovery path, with the same account balance, fresh evidence and fixed expiry checks.

Lifecycle action requests wait up to 120 seconds because several upstream resources may need control or deletion. A timeout means the response was not received; the server may still finish. Use `retention show` to read the recorded result before deciding whether to retry. The CLI reports `UNKNOWN` and does not resend the action. This transport wait is not a usage quota or a guaranteed completion deadline.

For crash recovery, distinguish slow live ownership from an expired lease or exited process. Do not kill shared services to reproduce a failure. Use an isolated authorized test process/environment. Record deployment ID, lease/recovery state, delete intent and reserve changes; verify no script is recreated after deletion wins.

## End a test without deleting production

1. Inventory the test Worker/environment, resources, bindings, active jobs/schedules and test objects. Pause producers and schedules; preserve user data.
   Schedule list/pause commands take Worker/schedule IDs, not `--env`; verify each returned schedule's environment before pausing it. Save production deployment/resource and business-health baselines for the post-cleanup comparison.
2. Remove only authorized disposable objects and handle in-flight jobs. Whole-Worker cleanup can remove authorized disposable R2 objects; direct low-level bucket deletion still requires an empty bucket. Upstream cleanup failures or unknown in-flight writes may leave deletion incomplete. Use the project's authenticated application routes or supported resource interfaces for object/job cleanup; discover those routes in the project before use. This CLI does not provide a generic object purge or job-drain command. Missing cleanup or provider-proof access is an explicit remaining step, not permission to bypass xAPI with platform credentials.
3. Request **environment** deletion for an isolated preview test:

   ```sh
   xapi workers retention delete <worker-id> --env preview --yes
   ```

   `workers delete <worker-id> --yes` is whole-Worker deletion; use only when the whole project is disposable and authorized.
4. Poll lifecycle, resources and public reachability to a terminal outcome. An accepted request, deleted UI badge or retained historical deployment reference is not physical-destruction proof. If provider proof is unavailable to this key, report that limitation; don't treat an API visibility 404 alone as proof.
5. Query final retention/ledger evidence: unused reserve released, actual retention/cleanup charges accounted for, pending final metering and late adjustments identified. Verify a repeat read/recovery does not cause a second refund or resource resurrection.

Natural expiry refund is a separate test: use an isolated disposable environment and observe its actual policy trigger/deadline. Manual deletion cannot substitute for it. Keep billing evidence after cleanup and list residual resources or pending refunds explicitly.

Completed deletion publishes a terminal access tombstone without requiring an active deployment ID or settlement-queue readiness. Its publication checkpoint is separate from confirmed resource deletion; PUBLISHED means provider acceptance, not instantaneous global propagation. A failed internal tombstone publication is retried through the existing background publication queue without replaying the owner's resource deletion. Once an isolate observes the verified worker_deleted tombstone for that physical script identity, it keeps returning 410 after the ordinary five-minute allow-evidence period. Active execution permissions retain their absolute deadlines.
# Whole-Worker deletion response

`workers delete` waits up to 120 seconds, matching environment lifecycle actions. A timeout means the outcome is **UNKNOWN**: the server may still finish. The CLI never repeats this write. Read `workers get`, the selected environment's retention state and operation receipts before deciding on another owner action. A successful HTTP response and `DELETED` resources do not prove the 48-hour billing tail or retained capture queues have finished.
