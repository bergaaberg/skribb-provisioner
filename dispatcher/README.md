# skribb-dispatcher

Single Worker that routes `*.cms.skribb.no/*` to the right tenant inside
the `skribb-tenants` dispatch namespace.

Deployed once by the platform operator. Per-tenant Workers (provisioned
by `@skribb/provisioner`) live inside the dispatch namespace; this
script is the only thing the public DNS points at.

## How routing works

1. Cloudflare matches `*.cms.skribb.no/*` to this Worker via the wildcard
   route in `wrangler.jsonc`.
2. `src/worker.ts` reads the request's `Host` header.
3. `src/host-resolver.ts` extracts the handle (`alice.cms.skribb.no` →
   `alice` → script `skribb-cms-alice`).
4. `env.DISPATCH_NAMESPACE.get(scriptName).fetch(request)` forwards the
   request to the tenant's user Worker.

## Deploying

```sh
# One-time: create the dispatch namespace (the wrangler.jsonc binding
# refers to it, but doesn't create it). Use the provisioner's
# CloudflareApi.createDispatchNamespace, or:
wrangler dispatch-namespace create skribb-tenants

# Then deploy this script:
wrangler deploy
```

The dispatcher must be deployed *before* any tenant is provisioned —
otherwise the wildcard route has nothing to land on.

## Tests

```sh
cd ..
pnpm test  # runs the host-resolver suite from the package root
```

The dispatcher is intentionally thin: the only non-trivial logic is
host parsing, which is fully unit-tested. The runtime dispatch call
(`env.DISPATCH_NAMESPACE.get(...).fetch(...)`) is exercised in
production / staging; mocking workerd's dispatch binding adds more
ceremony than value at this layer.

## Failure modes

| Situation | Response |
| --- | --- |
| Host doesn't match `*.cms.skribb.no` | 404 "Unknown host" |
| Subdomain has invalid chars (e.g. `_` or `!`) | 404 "Unknown host" |
| Resolved script doesn't exist in the namespace | 404 "No tenant provisioned for ..." |
| Tenant Worker throws | 502 "Dispatcher error" (tenant errors propagate via response, this only fires for binding-level failures) |
