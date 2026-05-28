/**
 * Public types for `@skribb/provisioner`.
 */

export type ProvisioningStep =
	/** Record created in store; no Cloudflare resources yet. */
	| "reserved"
	/** D1 database created. */
	| "d1_created"
	/** R2 bucket created. */
	| "r2_created"
	/** Worker script uploaded with bindings. */
	| "worker_uploaded"
	/** Custom domain bound to the worker. */
	| "domain_bound"
	/** EmDash migrations run + initial admin user created. */
	| "bootstrapped"
	/** Provisioning complete; tenant is live. */
	| "ready"
	/** Provisioning aborted; manual recovery needed. */
	| "failed";

export interface TenantResources {
	d1Id?: string;
	d1Name?: string;
	r2BucketName?: string;
	workerName?: string;
	workerDomainId?: string;
}

export interface TenantRecord {
	/** Stable id, allocated by the caller (skribb.no) before provisioning starts. */
	creatorId: string;
	/** Creator-chosen subdomain (e.g. "alice"). Becomes part of the hostname. */
	handle: string;
	/** Owner email — used for the initial EmDash admin user. */
	email: string;
	/** `<handle>.cms.skribb.no`. Derived from handle + the cms base domain. */
	hostname: string;
	/** Where we are in the state machine. */
	step: ProvisioningStep;
	/** Cloudflare resource IDs / names, populated as each step lands. */
	resources: TenantResources;
	/** Last error message, when step === "failed". */
	error?: string;
	createdAt: string;
	updatedAt: string;
}

/**
 * Storage contract for tenant records. Production impl is a Kysely-backed
 * table on skribb.no's D1. Test impl is in-memory.
 *
 * `put` is the only write — provisioning never deletes records. Cleanup of
 * failed/abandoned tenants is a separate operation.
 */
export interface TenantStore {
	get(creatorId: string): Promise<TenantRecord | null>;
	put(record: TenantRecord): Promise<void>;
}

/**
 * Loads the pre-built skribb-cms Worker bundle. Production impl fetches a
 * tarball from R2 or a registry; test impl returns a stub string. Pulling
 * this out as a dependency keeps the orchestrator free of file IO.
 */
export interface BundleLoader {
	load(): Promise<{
		scriptBody: string;
		compatibilityDate: string;
		compatibilityFlags?: string[];
	}>;
}

/**
 * Bootstraps a freshly-deployed tenant Worker: runs EmDash migrations
 * and creates the initial admin user. Implementation calls the deployed
 * Worker's `/_skribb/provision` endpoint with a one-time provisioning
 * token (also injected as a binding at upload time).
 *
 * Split from the orchestrator so tests can replace it with a no-op. The
 * skribb-cms template owns the `/_skribb/provision` route on its side.
 */
export interface BootstrapClient {
	bootstrap(input: {
		hostname: string;
		provisioningToken: string;
		adminEmail: string;
	}): Promise<void>;
}

export interface ProvisionInput {
	/** Pre-allocated creator id. */
	creatorId: string;
	/** Validated, normalised subdomain. */
	handle: string;
	/** Validated email. */
	email: string;
}

export interface ProvisionConfig {
	/** e.g. "cms.skribb.no" — every tenant gets `<handle>.<cmsBaseDomain>`. */
	cmsBaseDomain: string;
	/** Cloudflare zone id for `skribb.no`. */
	zoneId: string;
	/** Naming template helpers — keep all naming in one place. */
	naming?: {
		d1: (handle: string) => string;
		r2: (handle: string) => string;
		worker: (handle: string) => string;
	};
	/**
	 * Generates a single-use token embedded in the deployed Worker as a
	 * binding and used by `BootstrapClient` to authenticate the bootstrap
	 * call. Default: 32 random bytes hex-encoded.
	 */
	mintProvisioningToken?: () => string;
	/**
	 * Override `Date.now`-driven timestamps for deterministic tests.
	 */
	now?: () => Date;
}
