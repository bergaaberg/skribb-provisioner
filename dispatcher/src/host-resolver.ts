/**
 * Pure host → namespace member resolution for the dispatcher Worker.
 *
 * Lives in its own file (no Cloudflare imports) so it can be
 * unit-tested in plain Node. The dispatcher Worker just wires this
 * helper to its dispatch namespace binding.
 *
 * Mirroring the host→binding scheme used in the Option C spike keeps
 * naming consistent across both candidate architectures.
 */

export interface HostResolverConfig {
	/** Apex this dispatcher handles, e.g. "cms.skribb.no". */
	cmsBaseDomain: string;
	/** Prefix applied to the script name. e.g. "skribb-cms-" + handle. */
	scriptPrefix: string;
}

export interface ResolvedTenant {
	/** Lowercase subdomain extracted from the host. */
	handle: string;
	/** Script name to look up in the dispatch namespace. */
	scriptName: string;
}

/**
 * Resolve a request's `Host` header (or URL host) to a tenant script
 * name. Returns `null` when:
 *   - host doesn't end in the configured base domain
 *   - host has no subdomain (apex itself)
 *   - subdomain isn't a single label
 *   - subdomain contains characters outside the valid script-name set
 *
 * Strict matching by design: bad hosts return null, the dispatcher
 * returns 404 — no fallback tenant, no implicit lookup.
 */
export function resolveTenant(
	config: HostResolverConfig,
	host: string,
): ResolvedTenant | null {
	if (!host) return null;
	// Strip the port if present (`alice.cms.skribb.no:4321` → `alice.cms.skribb.no`).
	const bareHost = host.split(":")[0]?.toLowerCase() ?? "";
	const baseSuffix = `.${config.cmsBaseDomain.toLowerCase()}`;
	if (!bareHost.endsWith(baseSuffix)) return null;
	if (bareHost.length === baseSuffix.length) return null; // exactly the apex
	const handle = bareHost.slice(0, bareHost.length - baseSuffix.length);
	// Single-label subdomain (no further dots), worker-script-safe chars.
	if (!/^[a-z0-9][a-z0-9-]*$/.test(handle)) return null;
	return {
		handle,
		scriptName: `${config.scriptPrefix}${handle}`,
	};
}
