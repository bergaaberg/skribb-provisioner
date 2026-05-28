/**
 * Skribb tenant dispatcher.
 *
 * One Worker that owns the `*.cms.skribb.no/*` route. Every incoming
 * request is mapped (by Host header) to a script name in the dispatch
 * namespace and forwarded via `env.DISPATCH_NAMESPACE.get(name).fetch()`.
 *
 * Deployed once by the platform operator, lives in front of every
 * tenant. Per-tenant Workers (provisioned by `@skribb/provisioner`)
 * live inside `DISPATCH_NAMESPACE` and are invoked through this script.
 *
 * Errors that warrant a custom response, not a 5xx propagation:
 *   - host doesn't match `*.cms.skribb.no` → 404 "unknown host"
 *   - resolved script doesn't exist in the namespace → 404 "no tenant"
 *
 * Everything else (the tenant's own errors) is forwarded verbatim.
 */
import { resolveTenant } from "./host-resolver.js";

interface Env {
	/** Dispatch namespace binding declared in wrangler.jsonc. */
	DISPATCH_NAMESPACE: {
		get(scriptName: string): { fetch(request: Request): Promise<Response> };
	};
	/** Apex this dispatcher serves; baked in via `vars` in wrangler.jsonc. */
	CMS_BASE_DOMAIN: string;
	/** Script-name prefix used by the provisioner — must match. */
	SCRIPT_PREFIX: string;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const resolved = resolveTenant(
			{ cmsBaseDomain: env.CMS_BASE_DOMAIN, scriptPrefix: env.SCRIPT_PREFIX },
			url.host,
		);
		if (!resolved) {
			return new Response("Unknown host", {
				status: 404,
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
		}
		try {
			const tenant = env.DISPATCH_NAMESPACE.get(resolved.scriptName);
			return await tenant.fetch(request);
		} catch (err) {
			// The dispatch binding throws when the script doesn't exist —
			// surface that as a 404 rather than letting the dispatcher
			// itself look unhealthy.
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.toLowerCase().includes("not found") || msg.includes("does not exist")) {
				return new Response(
					`No tenant provisioned for "${resolved.handle}".`,
					{
						status: 404,
						headers: { "content-type": "text/plain; charset=utf-8" },
					},
				);
			}
			// Anything else: surface to the caller. The platform's logging
			// catches the trace.
			return new Response("Dispatcher error", {
				status: 502,
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
		}
	},
};
