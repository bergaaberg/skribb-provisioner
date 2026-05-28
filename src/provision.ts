/**
 * Tenant provisioning orchestrator — Workers for Platforms shape.
 *
 * The state machine is one step shorter than the bare-Workers version:
 * routing is handled by the operator's dispatcher Worker (see
 * ../dispatcher/), so there's no per-tenant custom-domain binding to
 * sequence.
 *
 * State machine:
 *   reserved → d1_created → r2_created → script_uploaded → bootstrapped → ready
 *
 * Each transition is one Cloudflare API call followed by
 * `store.put(record)`. If a transition throws, the record stays at
 * the previous step and is marked `failed` — the next call to
 * `provisionTenant` for the same creator will throw `failed state`
 * until recovery is explicit.
 *
 * Resource ordering matters: D1 + R2 must exist *before* the namespace
 * script upload (their ids/names go into the script's bindings). The
 * bootstrap step requires the script to be live in the namespace; the
 * dispatcher Worker routes the bootstrap request to the new tenant.
 *
 * What this module does NOT do:
 *   - delete resources on failure (cleanup is a separate operation
 *     surfaced via the `failed` state)
 *   - validate input (handle / email shape) — skribb.no's onboarding
 *     handler is responsible
 *   - charge / bill / enforce quotas — separate concern
 *   - create the dispatch namespace itself — that's a one-time
 *     operator setup, not per-tenant
 */

import type { CloudflareApi } from "./cloudflare-api.js";
import type {
	BootstrapClient,
	BundleLoader,
	ProvisionConfig,
	ProvisionInput,
	ProvisioningStep,
	TenantRecord,
	TenantResources,
	TenantStore,
} from "./types.js";

export interface ProvisionDeps {
	cf: CloudflareApi;
	store: TenantStore;
	bundle: BundleLoader;
	bootstrap: BootstrapClient;
}

const STEP_ORDER: ProvisioningStep[] = [
	"reserved",
	"d1_created",
	"r2_created",
	"script_uploaded",
	"bootstrapped",
	"ready",
];

function rank(step: ProvisioningStep): number {
	return STEP_ORDER.indexOf(step);
}

const DEFAULT_NAMING = {
	d1: (handle: string) => `skribb-cms-${handle}`,
	r2: (handle: string) => `skribb-cms-media-${handle}`,
	script: (handle: string) => `skribb-cms-${handle}`,
};

function defaultMintToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function now(config: ProvisionConfig): string {
	return (config.now ? config.now() : new Date()).toISOString();
}

export async function provisionTenant(
	deps: ProvisionDeps,
	input: ProvisionInput,
	config: ProvisionConfig,
): Promise<TenantRecord> {
	const naming = config.naming ?? DEFAULT_NAMING;
	const hostname = `${input.handle}.${config.cmsBaseDomain}`;

	let record: TenantRecord = (await deps.store.get(input.creatorId)) ?? {
		creatorId: input.creatorId,
		handle: input.handle,
		email: input.email,
		hostname,
		step: "reserved",
		resources: {},
		createdAt: now(config),
		updatedAt: now(config),
	};

	// Defensive: if a previous run left us in a failed state, surface that
	// rather than silently retrying. Recovery is an explicit operation.
	if (record.step === "failed") {
		throw new Error(
			`Tenant ${input.creatorId} is in failed state. Resolve via the recovery flow before re-provisioning. Last error: ${record.error}`,
		);
	}

	// On resume, sanity-check that input matches the persisted record. A
	// changed handle / email mid-provision would be a caller bug.
	if (
		record.handle !== input.handle ||
		record.email !== input.email ||
		record.hostname !== hostname
	) {
		throw new Error(
			`Tenant ${input.creatorId} resume mismatch: persisted record has handle=${record.handle}, email=${record.email}, hostname=${record.hostname}; input has handle=${input.handle}, email=${input.email}, hostname=${hostname}.`,
		);
	}

	const provisioningToken = (
		config.mintProvisioningToken ?? defaultMintToken
	)();

	const step = async (
		target: ProvisioningStep,
		fn: (current: TenantRecord) => Promise<Partial<TenantResources>>,
	): Promise<void> => {
		if (rank(record.step) >= rank(target)) return;
		try {
			const patch = await fn(record);
			record = {
				...record,
				step: target,
				resources: { ...record.resources, ...patch },
				updatedAt: now(config),
			};
			await deps.store.put(record);
		} catch (err) {
			record = {
				...record,
				step: "failed",
				error: err instanceof Error ? err.message : String(err),
				updatedAt: now(config),
			};
			await deps.store.put(record);
			throw err;
		}
	};

	await step("d1_created", async () => {
		const db = await deps.cf.createD1Database(naming.d1(input.handle));
		return { d1Id: db.uuid, d1Name: db.name };
	});

	await step("r2_created", async () => {
		const bucket = await deps.cf.createR2Bucket(naming.r2(input.handle));
		return { r2BucketName: bucket.name };
	});

	await step("script_uploaded", async (cur) => {
		if (!cur.resources.d1Id || !cur.resources.r2BucketName) {
			throw new Error(
				"script_uploaded: missing prerequisite resources (d1 or r2)",
			);
		}
		const bundleData = await deps.bundle.load();
		const scriptName = naming.script(input.handle);
		await deps.cf.uploadNamespaceScript({
			namespace: config.dispatchNamespace,
			scriptName,
			scriptBody: bundleData.scriptBody,
			compatibilityDate: bundleData.compatibilityDate,
			compatibilityFlags: bundleData.compatibilityFlags,
			tags: bundleData.emdashVersion
				? [`emdash-version:${bundleData.emdashVersion}`]
				: undefined,
			bindings: [
				{ type: "d1", name: "DB", id: cur.resources.d1Id },
				{
					type: "r2_bucket",
					name: "MEDIA",
					bucket_name: cur.resources.r2BucketName,
				},
				{ type: "plain_text", name: "APP_ENV", text: "production" },
				{
					type: "plain_text",
					name: "TENANT_HANDLE",
					text: input.handle,
				},
				{
					type: "secret_text",
					name: "PROVISIONING_TOKEN",
					text: provisioningToken,
				},
			],
		});
		return { scriptName };
	});

	await step("bootstrapped", async () => {
		await deps.bootstrap.bootstrap({
			hostname,
			provisioningToken,
			adminEmail: input.email,
			title: input.title ?? input.handle,
		});
		return {};
	});

	await step("ready", async () => ({}));

	return record;
}
