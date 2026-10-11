# Retention, recovery and cleanup

Read current state and policy before choosing an action:

```sh
xapi workers retention show <worker-id> --env preview --format json
xapi workers retention quote <worker-id> --env preview --type WORKER --format json
xapi workers billing lifecycle <worker-id> --env preview --json
```

Before creation, give the informational retention reminder in SKILL.md; do not add a separate policy-confirmation step. When preparing funded resources, xAPI records the default policy atomically with the first retention hold. `retention accept` remains a compatibility command, not a prerequisite for new deployments.

Policy enrollment, quote display and funding are distinct. Plan displays server cost estimates; the CLI does not require a separate per-type quote or mandatory `--retention-price-version` to deploy. An explicitly supplied version is forwarded for server validation. The server performs the account balance and atomic hold checks, preserves funded policy/history, and does not reset paused/deleting state. Container funding is not a generic independent retention-product quote.

Both Preview and Production preserve an overdue environment for at least 168 hours. Remaining spendable retention funds extend preservation after that minimum; system cleanup is permitted only when those funds are exhausted. User deletion is unavailable during financial retention; add sufficient funds and explicitly recover first. System cleanup remains independent.

```sh
xapi workers retention resume <worker-id> --env preview
xapi workers retention delete <worker-id> --env preview --yes
```

Whole-project manual `retention pause` and `retention keep-paused` are unavailable. System funding protection still suspends execution when needed; recovery requires explicit `retention resume`. Schedule pause/resume by schedule ID and Queue consumer configure/disable remain independent native controls outside financial retention. They do not pause the whole project.

Resume/delete do not require automatic-maintenance switches. Existing joint resource funding also remains atomic when optional automatic retention is disabled; it still checks the actual account balance and accepted price version, and reuses the original hold on an identical request. A deposit does not authorize business resumption. Reserve exhaustion alone does not authorize early deletion. The system checks both the full seven-day minimum and actual protected-fund exhaustion before cleanup. A recorded time is a minimum guarantee, not a fixed deletion deadline. Running reserves are separate from protected retention funds. Read the actual lifecycle and operation receipts. If a requested resume/delete fails or remains incomplete, show the failed step and let the user decide whether to retry; never automatically replay their write or force a redeploy/edit a database flag. A pending script mutation can still require reconciliation to avoid changing the wrong native version.

After completed owner recovery, the API attempts the existing fenced postpaid publication immediately and reports `accessPreparation` as `PUBLISHED`, `PENDING` with a reason, or `DISABLED`. `PUBLISHED` confirms publication, not instantaneous public readiness; verify actual service access. `PENDING` does not undo recovery or authorize a replay: wait and retry service access, inspect billing/publication evidence if it persists. Ordinary background publication remains the recovery path, with the same account balance, fresh evidence and fixed expiry checks.

Lifecycle action requests wait up to 120 seconds because several upstream resources may need control or deletion. A timeout or socket/network disconnect means no complete response was received; the server may still finish. The CLI retains the original transport cause/code for diagnosis. Use `retention show` to read the recorded result before deciding whether to retry. The CLI reports `UNKNOWN` and does not resend the action. This transport wait is not a usage quota or a guaranteed completion deadline.

System funding suspension/retention deletion is a durable policy intent and is retried by the system after rechecking current policy, generation and native identity. Failed/expired management attempts must not indefinitely block stopping consumption. This differs from user-requested mutations, which are not automatically replayed. Missing final samples remain metering gaps; deletion permission does not itself authorize a refund or financial release.

## Status and bounded observation

A successful action response or an accepted/requested lifecycle intent is not completion. Read `billing lifecycle` for the same Worker and environment: `data.state` is the lifecycle projection; `phase`, `completedSteps` and `totalSteps` describe recorded step receipts, not an enumeration of every expected step. A complete receipt count, completed phase or absent `nextStep` alone does not prove the whole operation finished. Report `nextStep` and `blockerCodes` as returned, including failed steps and unresolved prerequisites.

After an action, use read-only follow-up commands with the original target:

```sh
xapi workers billing lifecycle <worker-id> --env preview
xapi workers retention show <worker-id> --env preview
xapi workers inspect <worker-id> --env preview
```

Substitute the actual Worker ID and environment. No wait is required. If polling is useful, choose a finite observation window and report the last observed state, blockers and remaining checks when it ends. Ending or interrupting local polling stops observation; it does not cancel the backend operation. Do not automatically repeat resume, delete or other mutations as a status check, and do not interpret failure or timeout as rollback.

`SUSPENDED_GRACE` means execution is paused: retained storage is not deleted or refunded by pausing, and retention charges may continue. `DELETED` still needs separate cleanup, final-metering and reserve-release evidence. Unknown collector freshness or missing samples mean unknown usage/cost, not zero.

An `ACTIVE` deployment is distinct from public availability. Inspection presents platform and active domain URLs separately, using reported HTTPS URLs or validated reported hostnames. An active domain can be platform-managed or custom; its presence does not change the canonical URL or establish readiness. Verify HTTPS reachability and application behavior separately; metadata inspection does not perform that probe.

For crash recovery, distinguish slow live ownership from an expired lease or exited process. Do not kill shared services to reproduce a failure. Use an isolated authorized test process/environment. Record deployment ID, lease/recovery state, delete intent and reserve changes; verify no script is recreated after deletion wins.

## Delete one Container Application

For an authorized individual application deletion, use the resource ID returned by xAPI:

```sh
xapi workers resources delete <worker-id> <resource-id> --env preview --yes
```

This does not delete its Durable Object, R2, D1 or other independent resources. Update the project declaration as well if future pushes should omit the Container; leaving it declared can request its creation on a later deployment. Use a complete manifest deployment when removing the declaration and updating code together.

Keep the operation ID and inspect its result. With the unified execution backend, an explicitly repeated delete can verify native absence and finish a lost local receipt without resending an uncertain DELETE. `worker_control_recover_through_deletion` directs recovery through this same resource endpoint. It does not mean a new resource should be created or the operation record discarded. If absence cannot be confirmed, report the pending result instead of repeatedly issuing changes. Resource disappearance alone does not prove final metering or release of all environment-level capacity; check those separately using billing/lifecycle evidence.

## End a test without deleting production

1. Inventory the test Worker/environment, resources, bindings, active jobs/schedules and test objects. Pause producers and schedules; preserve user data.
   Schedule list/pause commands take Worker/schedule IDs, not `--env`; verify each returned schedule's environment before pausing it. Save production deployment/resource and business-health baselines for the post-cleanup comparison.
2. Remove only authorized disposable objects and handle in-flight jobs. Whole-Worker cleanup can remove authorized disposable R2 objects; direct low-level bucket deletion still requires an empty bucket. Upstream cleanup failures or unknown in-flight writes may leave deletion incomplete. Use the project's authenticated application routes or supported resource interfaces for object/job cleanup; discover those routes in the project before use. This CLI does not provide a generic object purge or job-drain command. Missing cleanup or provider-proof access is an explicit remaining step, not permission to bypass xAPI with platform credentials.
3. Request **environment** deletion for an isolated preview test:

   ```sh
   xapi workers retention delete <worker-id> --env preview --yes
   ```

   `workers delete <worker-id> --yes` is whole-Worker deletion; use only when the whole project is disposable and authorized.
4. Read lifecycle, resources and public reachability for completion evidence. If polling, use a finite observation window; if it ends before a terminal outcome, report the pending state and read-only follow-up. An accepted request, deleted UI badge or retained historical deployment reference is not physical-destruction proof. If provider proof is unavailable to this key, report that limitation; don't treat an API visibility 404 alone as proof.
5. Query final retention/ledger evidence: unused reserve released, actual retention/cleanup charges accounted for, pending final metering and late adjustments identified. Verify a repeat read/recovery does not cause a second refund or resource resurrection.

Natural expiry refund is a separate test: use an isolated disposable environment and observe its actual policy trigger/deadline. Manual deletion cannot substitute for it. Keep billing evidence after cleanup and list residual resources or pending refunds explicitly.

Completed deletion publishes a terminal access tombstone without requiring an active deployment ID or settlement-queue readiness. Its publication checkpoint is separate from confirmed resource deletion; PUBLISHED means provider acceptance, not instantaneous global propagation. A failed internal tombstone publication is retried through the existing background publication queue without replaying the owner's resource deletion. Once an isolate observes the verified worker_deleted tombstone for that physical script identity, it keeps returning 410 after the ordinary five-minute allow-evidence period. Active execution permissions retain their absolute deadlines.
## Whole-Worker deletion response

`workers delete` waits up to 120 seconds, matching environment lifecycle actions. A timeout or socket/network disconnect means the outcome is **UNKNOWN**: the server may still finish. The CLI retains the original transport cause/code; a definite HTTP rejection remains an error, not success. The CLI never repeats this write. Read `workers get`, the selected environment's retention state and operation receipts before deciding on another owner action. A successful HTTP response and `DELETED` resources do not prove the 48-hour billing tail or retained capture queues have finished.
