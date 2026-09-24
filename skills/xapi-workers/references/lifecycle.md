# Retention, recovery and cleanup

Read current state and policy before choosing an action:

```sh
xapi workers retention show <worker-id> --env preview --format json
xapi workers retention quote <worker-id> --env preview --type WORKER --format json
xapi workers billing lifecycle <worker-id> --env preview --json
```

Before creation, give the informational retention reminder in SKILL.md; do not add a separate policy-confirmation step. With retention enabled, xAPI records the default policy atomically with the first retention hold. `retention accept` remains a compatibility command, not a prerequisite for new deployments.

Policy enrollment and price selection are different: provision with the current quoted `--retention-price-version` where required, using the user's existing deployment authorization. Different resource types can have separate quotes; inspect the API response instead of copying an old price version. Automatic enrollment does not bypass balance checks, reset paused/deleting state, or rewrite a previously funded policy.

```sh
xapi workers retention pause <worker-id> --env preview
xapi workers retention resume <worker-id> --env preview
xapi workers retention keep-paused <worker-id> --env preview
```

Use actions permitted by the current lifecycle. Manual pause, low balance and pending deletion are distinct. A deposit doesn't prove reserve replenishment or automatic resumption. Retention-v3 can start cleanup at the reserve cleanup threshold; an estimate in hours is not necessarily a fixed expiry. Read actual deadlines and reserve budget. A 409 or PENDING_DELETION needs inspection of blockers and operation history, not a forced redeploy or edited database flag.

System retention pause/delete is a durable policy intent and is retried by the system after rechecking current policy, generation and native identity. Failed/expired management attempts must not indefinitely block stopping consumption. This differs from user-requested mutations, which are not automatically replayed. Missing final samples remain metering gaps; deletion permission does not itself authorize a refund or financial release.

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
2. Remove only authorized disposable objects and handle in-flight jobs. Nonempty R2 buckets may block deletion. Use the project's authenticated application routes or supported resource interfaces for object/job cleanup; discover those routes in the project before use. This CLI does not provide a generic object purge or job-drain command. Missing cleanup or provider-proof access is an explicit remaining step, not permission to bypass xAPI with platform credentials.
3. Request **environment** deletion for an isolated preview test:

   ```sh
   xapi workers retention delete <worker-id> --env preview --yes
   ```

   `workers delete <worker-id> --yes` is whole-Worker deletion; use only when the whole project is disposable and authorized.
4. Poll lifecycle, resources and public reachability to a terminal outcome. An accepted request, deleted UI badge or retained historical deployment reference is not physical-destruction proof. If provider proof is unavailable to this key, report that limitation; don't treat an API visibility 404 alone as proof.
5. Query final retention/ledger evidence: unused reserve released, actual retention/cleanup charges accounted for, pending final metering and late adjustments identified. Verify a repeat read/recovery does not cause a second refund or resource resurrection.

Natural expiry refund is a separate test: use an isolated disposable environment and observe its actual policy trigger/deadline. Manual deletion cannot substitute for it. Keep billing evidence after cleanup and list residual resources or pending refunds explicitly.
