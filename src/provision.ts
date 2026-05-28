/**
 * Tenant provisioning orchestrator.
 *
 * Shape: a state machine over a `TenantRecord`. Each transition is one
 * Cloudflare API call followed by `store.put(record)`. If a transition
 * throws, the record stays at the previous step — the next call to
 * `provisionTenant` for the same creator picks up from there.
 *
 * Each step body is wrapped in `step(record, target, fn)` which:
 *   - skips if the record is already at `target` or beyond
 *   - runs `fn` to update the record's resources
 *   - advances the step
 *   - persists
 *
 * The state machine ordering matters: D1 + R2 must exist *before* the
 * Worker upload (their ids/names go into the Worker's bindings); domain
 * binding requires the Worker to exist; bootstrap requires the domain
 * to be live. If a downstream step fails, the upstream resources stay
 * intact — re-running picks them up by id from the persisted record.
 *
 * What this module does NOT do:
 *   - delete resources on failure. Cleanup is a separate operation
 *     surfaced via the `failed` state; the assumption is that orphaned
 *     resources are cheap (a few cents/month max) and recovery is
 *     manual review-friendly.
 *   - validate the input (handle / email shape). The caller — skribb.no's
 *     onboarding handler — is responsible for that.
 *   - charge / bill / enforce quotas. Separate concern.
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
	"worker_uploaded",
	"domain_bound",
	"bootstrapped",
	"ready",
];

function rank(step: ProvisioningStep): number {
	const i = STEP_ORDER.indexOf(step);
	// `failed` sorts as -1 so step() never skips on a failed record —
	// the orchestrator should explicitly recover before continuing.
	return i;
}

const DEFAULT_NAMING = {
	d1: (handle: string) => `skribb-cms-${handle}`,
	r2: (handle: string) => `skribb-cms-media-${handle}`,
	worker: (handle: string) => `skribb-cms-${handle}`,
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

	// Helper: run a transition only if we're behind the target step.
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

	await step("worker_uploaded", async (cur) => {
		if (!cur.resources.d1Id || !cur.resources.r2BucketName) {
			throw new Error(
				"worker_uploaded: missing prerequisite resources (d1 or r2)",
			);
		}
		const bundleData = await deps.bundle.load();
		await deps.cf.uploadWorker({
			scriptName: naming.worker(input.handle),
			scriptBody: bundleData.scriptBody,
			compatibilityDate: bundleData.compatibilityDate,
			compatibilityFlags: bundleData.compatibilityFlags,
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
		return { workerName: naming.worker(input.handle) };
	});

	await step("domain_bound", async (cur) => {
		if (!cur.resources.workerName) {
			throw new Error("domain_bound: missing worker");
		}
		const domain = await deps.cf.bindWorkerCustomDomain({
			scriptName: cur.resources.workerName,
			hostname,
			zoneId: config.zoneId,
		});
		return { workerDomainId: domain.id };
	});

	await step("bootstrapped", async () => {
		await deps.bootstrap.bootstrap({
			hostname,
			provisioningToken,
			adminEmail: input.email,
		});
		return {};
	});

	await step("ready", async () => ({}));

	return record;
}
