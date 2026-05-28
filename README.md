# @skribb/provisioner

Per-creator EmDash provisioning for skribb.

Companion to [bergaaberg/skribb-cms#1](https://github.com/bergaaberg/skribb-cms/issues/1)
(the Option C spike). This package explores **Option B** — one fresh
EmDash Worker per creator, fully automated.

> Status: orchestration PoC. The state machine + Cloudflare API client
> + tests are real and shippable. Wiring into skribb.no's onboarding
> flow, the deployed-bundle pipeline, and the bootstrap endpoint on
> the skribb-cms template are still to do.

## What this is

A small TypeScript library that takes a creator handle + email and:

1. Creates a per-tenant D1 database via the Cloudflare API.
2. Creates a per-tenant R2 bucket.
3. Uploads a Worker bundle (the skribb-cms template) with bindings
   for that creator's D1 + R2.
4. Binds `<handle>.cms.skribb.no` to the new Worker.
5. Calls the new Worker's bootstrap endpoint to run EmDash migrations
   and create the initial admin user.

The state machine persists after every step, so a crash mid-provision
can resume from the last completed step rather than restart.

## Why a separate package

skribb.no (the platform) will import this from its onboarding handler,
but the package itself doesn't depend on any framework. Library-shaped
keeps it portable, testable in plain Node, and reusable if we ever run
provisioning from a CLI / background queue rather than HTTP.

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
    zoneId: env.CLOUDFLARE_ZONE_ID,
  },
);
```

Returns a `TenantRecord` whose `step` field will be either `"ready"`
(success) or `"failed"` (caller catches the error and surfaces it).

## What's NOT in scope here

- **The skribb-cms bundle pipeline.** Production needs CI to build the
  Astro+EmDash artifact and stash it somewhere this provisioner can
  fetch from (`BundleLoader` impl). The PoC uses a stub.
- **The bootstrap endpoint on skribb-cms.** The deployed Worker needs
  to expose `/_skribb/provision` (POST, auth via the `PROVISIONING_TOKEN`
  secret binding) that runs EmDash migrations and creates the initial
  admin. Contract is named in `BootstrapClient`; implementation lives
  on the skribb-cms side.
- **The control-plane UI.** Listing tenants, retrying failures,
  un-provisioning. These are skribb.no admin tooling, not part of this
  library.
- **Cost-of-ownership concerns.** Deploy fanout on EmDash version
  bumps, tenant quota enforcement, billing. Out of scope.

## Wiring sketch — skribb.no `/api/onboarding`

```ts
// apps/web/src/app/api/onboarding/route.ts (sketch)
import {
  CloudflareApi,
  provisionTenant,
} from "@skribb/provisioner";
import { kyselyTenantStore, bundleFromR2, httpsBootstrap } from "./adapters";

export async function POST(req: Request) {
  const { handle, email } = parseAndValidate(await req.formData());
  const creatorId = ulid();

  // 1. Reserve in skribb's own DB
  await env.DB.insertInto("writers")
    .values({ id: creatorId, handle, email, cms_status: "provisioning" })
    .execute();

  // 2. Provision the EmDash instance
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
      { cmsBaseDomain: "cms.skribb.no", zoneId: env.CF_ZONE_ID },
    );
    await env.DB.updateTable("writers")
      .set({ cms_status: "ready", cms_url: `https://${tenant.hostname}` })
      .where("id", "=", creatorId)
      .execute();
    return Response.redirect(`https://${tenant.hostname}/_skribb/sso?...`);
  } catch (err) {
    // Tenant record is in the "failed" state in our table — surface to
    // admin tooling for manual recovery. Don't auto-retry; the
    // orchestrator refuses to touch a failed record.
    return new Response("Provisioning failed; we've been alerted.", {
      status: 500,
    });
  }
}
```

## Test coverage

```sh
pnpm test         # 17 tests:
                  #   cloudflare-api.test.ts (7) — HTTP envelope, auth, error mapping
                  #   provision.test.ts     (10) — orchestration:
                  #                                · happy path (3)
                  #                                · idempotent resume (2)
                  #                                · failure handling (5)
pnpm typecheck    # tsc --noEmit
```

The provision tests exercise the state machine against an in-memory
CF API mock that captures every request — assertions cover both
control flow (D1 before Worker before domain) and effects (right
bindings, right names, right token).

## Open design questions

- **Where does the bundle live?** Two candidates: build artifact in R2
  (fast, simple, requires CI to push); npm registry tarball (mature
  versioning, slower to fetch). Probably R2 keyed by EmDash version.
- **R2 bucket per tenant vs shared bucket with prefix?** Per-bucket is
  the consistent answer given D1 is per-tenant — but if R2's bucket
  limit becomes a concern at scale, the shared-bucket-with-prefix
  pattern from the Option C spike is portable here.
- **How does the creator's first session start?** After
  `provisionTenant` returns, the response is a redirect to the new
  EmDash instance. That redirect needs to carry a signed token the
  EmDash side trusts (separate from `PROVISIONING_TOKEN` which is
  one-shot). Likely: skribb.no signs a short-lived JWT; the deployed
  Worker has skribb.no's public key as a binding and validates.
- **What happens at EmDash bump time?** Cross-cutting concern, not a
  provisioner question per se. Likely: a separate `bumpTenant(creatorId)`
  function that re-uploads the Worker bundle and re-runs migrations.
  Same Cloudflare client, similar state-machine shape.
