# @skribb/provisioner

Per-creator EmDash provisioning for skribb, targeting **Workers for Platforms**.

Companion to [bergaaberg/skribb-cms#1](https://github.com/bergaaberg/skribb-cms/issues/1)
(the Option C spike). This package is the Option B path — one fresh
EmDash deployment per creator, fully automated, behind a single
dispatcher Worker.

> Status: orchestration + dispatcher PoC. The state machine + Cloudflare
> API client + dispatcher Worker + tests are real and shippable. Wiring
> into skribb.no's onboarding flow, the deployed-bundle pipeline, and
> the bootstrap endpoint on the skribb-cms template are still to do.

## Architecture

```
                       *.cms.skribb.no/*
                              │
                              ▼
                  ┌───────────────────────┐
                  │  skribb-dispatcher    │  (this repo, dispatcher/)
                  │  • parses Host header │
                  │  • DISPATCH_NAMESPACE │
                  │    .get(name).fetch() │
                  └───────────┬───────────┘
                              │
       ┌──────────────────────┼──────────────────────┐
       ▼                      ▼                      ▼
  skribb-cms-alice      skribb-cms-bob         skribb-cms-...
   (D1 + R2 + bundle)    (D1 + R2 + bundle)    (D1 + R2 + bundle)
                                                each provisioned by
                                                @skribb/provisioner
```

**Components:**

- **`@skribb/provisioner`** (this package) — TypeScript library used
  by skribb.no's onboarding handler. Creates D1, R2, and uploads the
  tenant's user Worker into the dispatch namespace.
- **`dispatcher/`** — a small Worker the platform operator deploys
  once. Owns the wildcard route, parses the Host header, forwards
  every request to the right namespace member.
- **Per-tenant Workers** — each creator's EmDash instance, deployed
  inside the dispatch namespace.

## Why Workers for Platforms

- **No script-count cap on the per-tenant unit.** Workers Paid has a
  hard 500/account limit; WfP lifts it (1000 included + overage). The
  $20/mo platform fee is cheap insurance against a forced
  mid-pilot rearchitecture.
- **Native fleet management.** Tags on namespace scripts let us later
  filter "all tenants on EmDash 0.14" for batch redeploys.
- **Native isolation.** Cloudflare-enforced separation between
  tenants; no shared isolate, no cache-pollution class of bug.
- **Bundled headroom.** WfP includes 2× requests + 2× CPU vs Workers
  Paid for the same overage rate. Break-even with WP usage past ~10M
  requests/mo or ~30M CPU-ms/mo across all tenants combined.

See the rationale in [bergaaberg/skribb#1](https://github.com/bergaaberg/skribb/issues/1) thread.

## Public surface

```ts
import { CloudflareApi, provisionTenant } from "@skribb/provisioner";

const cf = new CloudflareApi({
  apiToken: env.CLOUDFLARE_API_TOKEN,
  accountId: env.CLOUDFLARE_ACCOUNT_ID,
});

const result = await provisionTenant(
  {
    cf,
    store: kyselyBackedTenantStore(env.DB),
    bundle: bundleFromR2(env.CMS_ARTIFACTS),
    bootstrap: httpsBootstrapClient(),
  },
  { creatorId, handle, email },
  {
    cmsBaseDomain: "cms.skribb.no",
    dispatchNamespace: "skribb-tenants",
  },
);
```

Returns a `TenantRecord` whose `step` field will be either `"ready"`
(success) or `"failed"` (caller catches the error and surfaces it).

State machine: `reserved → d1_created → r2_created → script_uploaded → bootstrapped → ready`.

Each transition is one Cloudflare API call followed by a
`store.put()`. A crash mid-provision leaves the record at the last
completed step; re-running picks up from there. A `failed` record
won't auto-retry — recovery is an explicit operation.

## What's NOT in scope here

- **The skribb-cms bundle pipeline.** Production needs CI to build the
  Astro+EmDash artifact and stash it somewhere this provisioner can
  fetch from (`BundleLoader` impl). The PoC uses a stub.
- **The bootstrap endpoint on skribb-cms.** The deployed tenant
  Worker needs to expose `/_skribb/provision` (POST, auth via the
  `PROVISIONING_TOKEN` secret binding) that runs EmDash migrations
  and creates the initial admin user. Contract named in
  `BootstrapClient`; implementation lives on the skribb-cms side.
- **The dispatch namespace itself.** One-time platform setup, not
  per-tenant. `CloudflareApi.createDispatchNamespace()` is exposed
  for bootstrap scripts but the orchestrator assumes the namespace
  already exists.
- **The control-plane UI.** Listing tenants, retrying failures,
  un-provisioning. skribb.no admin tooling, not this library.
- **Bump fanout.** When EmDash bumps, you redeploy N tenants. Same CF
  client, similar state-machine shape, separate function — out of
  scope here.

## Wiring sketch — skribb.no `/api/onboarding`

```ts
// apps/web/src/app/api/onboarding/route.ts (sketch)
import { CloudflareApi, provisionTenant } from "@skribb/provisioner";
import { kyselyTenantStore, bundleFromR2, httpsBootstrap } from "./adapters";

export async function POST(req: Request) {
  const { handle, email } = parseAndValidate(await req.formData());
  const creatorId = ulid();

  // 1. Reserve in skribb's own DB
  await env.DB.insertInto("writers")
    .values({ id: creatorId, handle, email, cms_status: "provisioning" })
    .execute();

  // 2. Provision the EmDash instance behind the dispatcher
  try {
    const tenant = await provisionTenant(
      {
        cf: new CloudflareApi({
          apiToken: env.CF_API_TOKEN,
          accountId: env.CF_ACCOUNT_ID,
        }),
        store: kyselyTenantStore(env.DB),
        bundle: bundleFromR2(env.CMS_ARTIFACTS),
        bootstrap: httpsBootstrap(),
      },
      { creatorId, handle, email },
      { cmsBaseDomain: "cms.skribb.no", dispatchNamespace: "skribb-tenants" },
    );
    await env.DB.updateTable("writers")
      .set({ cms_status: "ready", cms_url: `https://${tenant.hostname}` })
      .where("id", "=", creatorId)
      .execute();
    return Response.redirect(`https://${tenant.hostname}/_skribb/sso?...`);
  } catch (err) {
    // Tenant record is in the "failed" state — surface to admin
    // tooling. Don't auto-retry; the orchestrator refuses.
    return new Response("Provisioning failed; we've been alerted.", {
      status: 500,
    });
  }
}
```

## Test coverage

```sh
pnpm test         # 29 tests across three suites:
                  #   cloudflare-api.test.ts (9)  — HTTP envelope, auth, WfP endpoints
                  #   provision.test.ts      (11) — orchestration:
                  #                                · happy path (5)
                  #                                · idempotent resume (2)
                  #                                · failure handling (4)
                  #   dispatcher/host-resolver (9) — host → script name parsing
pnpm typecheck    # tsc --noEmit
```

The provision tests run against an in-memory CF API mock that captures
every request — assertions cover both control flow (D1 before R2
before script upload before bootstrap) and effects (right namespace,
right bindings, right tags, right token).

The dispatcher tests are pure: they cover the host-parsing logic in
isolation. The runtime dispatch call (`env.DISPATCH_NAMESPACE.get(...).fetch(...)`)
isn't mocked — that surface is small enough to verify in staging
rather than ceremonially-tested.

## Open design questions

- **Where does the bundle live?** Two candidates: build artifact in
  R2 (fast, simple, requires CI to push); npm registry tarball (mature
  versioning, slower to fetch). Probably R2 keyed by EmDash version.
- **R2 bucket per tenant vs shared bucket with prefix?** Currently
  per-bucket (matches the D1-per-tenant model). If R2 bucket counts
  become a concern at scale, the prefix-based pattern from the Option
  C spike is portable here.
- **How does the creator's first session start?** After
  `provisionTenant` returns, the response is a redirect to the new
  EmDash instance. That redirect needs to carry a signed token the
  EmDash side trusts (separate from `PROVISIONING_TOKEN` which is
  one-shot). Likely: skribb.no signs a short-lived JWT; the deployed
  Worker has skribb.no's public key as a binding and validates.
- **EmDash version-bump fanout.** Cross-cutting; separate
  `bumpTenant(creatorId)` function alongside this one. Likely
  filter-by-tag → re-upload bundle → re-run migrations.
