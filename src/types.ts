/**
 * Public types for `@skribb/provisioner`.
 *
 * Targets Workers for Platforms (WfP). The per-tenant deploy unit is a
 * dispatch namespace script, not a bare Worker — so the state machine
 * doesn't need a per-tenant custom-domain binding step. Routing is
 * handled by a single dispatcher Worker (see ../dispatcher/).
 */

export type ProvisioningStep =
	/** Record created in store; no Cloudflare resources yet. */
	| "reserved"
	/** D1 database created. */
	| "d1_created"
	/** R2 bucket created. */
	| "r2_created"
	/** Namespace script uploaded with bindings. */
	| "script_uploaded"
	/** EmDash migrations run + initial admin user created. */
	| "bootstrapped"
	/** Provisioning complete; tenant is live behind the dispatcher. */
	| "ready"
	/** Provisioning aborted; manual recovery needed. */
	| "failed";

export interface TenantResources {
	d1Id?: string;
	d1Name?: string;
	r2BucketName?: string;
	/** Script name inside the dispatch namespace (e.g. "skribb-cms-alice"). */
	scriptName?: string;
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
		/** EmDash version this bundle ships with — recorded as a tag on the namespace script. */
		emdashVersion?: string;
	}>;
}

/**
 * Bootstraps a freshly-deployed tenant.
 *
 * The platform-side implementation does this as **two HTTP calls in
 * order** against the customer-facing hostname (the dispatcher Worker
 * routes both into the right namespace member):
 *
 *   1. `POST /_emdash/api/setup`
 *      body: { title, tagline: "", includeContent: false }
 *      no auth — EmDash self-locks once setup completes.
 *      Runs migrations + applies seed.
 *
 *   2. `POST /skribb/provision`
 *      body: { adminEmail, adminName? }
 *      auth: `Authorization: Bearer <provisioningToken>`.
 *      Creates the initial admin user.
 *
 * The two-call shape is forced by EmDash's middleware: it redirects
 * un-migrated requests for non-`/_emdash/*` routes to `/admin/setup`,
 * which means `/skribb/provision` can't bootstrap migrations itself.
 *
 * Split from the orchestrator so tests can replace it with a no-op.
 */
export interface BootstrapClient {
	bootstrap(input: {
		hostname: string;
		provisioningToken: string;
		adminEmail: string;
		/**
		 * Display title passed to EmDash's setup endpoint as the initial
		 * site title (becomes the publication's name in the admin UI).
		 * Typically the creator's display name or their handle.
		 */
		title: string;
	}): Promise<void>;
}

export interface ProvisionInput {
	/** Pre-allocated creator id. */
	creatorId: string;
	/** Validated, normalised subdomain. */
	handle: string;
	/** Validated email. */
	email: string;
	/**
	 * Display title for the publication — passed to EmDash's setup
	 * step as the initial site title. Optional; defaults to the
	 * handle (so a creator who chose `alice` gets a site titled
	 * "alice" until they edit it in the admin).
	 */
	title?: string;
}

export interface ProvisionConfig {
	/** e.g. "cms.skribb.no" — every tenant gets `<handle>.<cmsBaseDomain>`. */
	cmsBaseDomain: string;
	/**
	 * Dispatch namespace into which we upload tenant scripts. Created
	 * once at platform bootstrap time, then reused for every tenant.
	 */
	dispatchNamespace: string;
	/** Naming template helpers — keep all naming in one place. */
	naming?: {
		d1: (handle: string) => string;
		r2: (handle: string) => string;
		script: (handle: string) => string;
	};
	/**
	 * Generates a single-use token embedded in the deployed script as a
	 * binding and used by `BootstrapClient` to authenticate the
	 * bootstrap call. Default: 32 random bytes hex-encoded.
	 */
	mintProvisioningToken?: () => string;
	/**
	 * Override `Date.now`-driven timestamps for deterministic tests.
	 */
	now?: () => Date;
}
