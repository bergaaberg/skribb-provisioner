/**
 * Bump a tenant's deployed Worker to a fresh bundle.
 *
 * Use cases:
 *   - EmDash version bump — the bundle CI pushes a new
 *     `bundles/v<X>+latest.tar.gz`; we re-deploy each existing tenant
 *     against it.
 *   - Bug fix in the skribb-cms template — same bundle pipeline,
 *     same fanout shape.
 *   - Recovery — `force: true` re-uploads even if the SHA matches
 *     (e.g. when a tenant's script got corrupted out-of-band).
 *
 * Not for:
 *   - New creators — that's `provisionTenant`.
 *   - Deleted creators — separate `unprovisionTenant` (not yet
 *     implemented; tracked as a follow-up).
 *
 * Shape:
 *   - No state machine. The upload itself is atomic at the CF API;
 *     if it fails, the old script is still live. A retry just calls
 *     the same upload again.
 *   - Idempotent by default: if the tenant's recorded
 *     `currentBundleSha` matches the bundle's `gitShortSha`, skip
 *     the upload. Pass `{ force: true }` to override.
 *   - Reads existing D1 / R2 / scriptName from the tenant record.
 *     Does NOT re-create resources.
 *
 * Side effects:
 *   - One CF API call (the namespace script PUT).
 *   - One store.put() to update `resources.currentEmdashVersion` and
 *     `resources.currentBundleSha`.
 *
 * Token rotation:
 *   - The PROVISIONING_TOKEN binding is re-set to a fresh random
 *     value on every bump. The original token is dead — its purpose
 *     was the one-shot bootstrap call, which has already happened
 *     (or recovery is needed via separate flow). Rotating defends
 *     against the case where the original token leaked.
 *   - SKRIBB_SSO_SECRET is the platform team's responsibility — set
 *     out-of-band per tenant via the secrets API. This function does
 *     not touch it; secrets configured outside the script-upload
 *     metadata persist across uploads.
 */

import type { CloudflareApi } from "./cloudflare-api.js";
import type {
	BundleLoader,
	ProvisionConfig,
	TenantStore,
} from "./types.js";

export interface BumpDeps {
	cf: CloudflareApi;
	store: TenantStore;
	bundle: BundleLoader;
}

export interface BumpInput {
	creatorId: string;
	/**
	 * If true, re-upload even when the tenant's recorded bundle SHA
	 * matches the bundle being installed. Useful for recovery; not
	 * needed for normal batch fanout.
	 */
	force?: boolean;
}

export interface BumpResult {
	creatorId: string;
	/** `false` when the tenant was already on this bundle and force=false. */
	updated: boolean;
	previousEmdashVersion?: string;
	previousBundleSha?: string;
	newEmdashVersion?: string;
	newBundleSha?: string;
}

function defaultMintToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function bumpTenant(
	deps: BumpDeps,
	input: BumpInput,
	config: ProvisionConfig,
): Promise<BumpResult> {
	const record = await deps.store.get(input.creatorId);
	if (!record) {
		throw new Error(`Tenant ${input.creatorId}: not found.`);
	}
	if (record.step !== "ready") {
		throw new Error(
			`Tenant ${input.creatorId}: step is "${record.step}", expected "ready". Resume provisioning before bumping.`,
		);
	}
	if (!record.resources.scriptName) {
		throw new Error(
			`Tenant ${input.creatorId}: resources.scriptName is missing; cannot bump.`,
		);
	}
	if (!record.resources.d1Id || !record.resources.r2BucketName) {
		throw new Error(
			`Tenant ${input.creatorId}: missing D1 / R2 in resources; cannot rebuild bindings.`,
		);
	}

	const bundleData = await deps.bundle.load();

	if (
		!input.force &&
		bundleData.gitShortSha &&
		record.resources.currentBundleSha === bundleData.gitShortSha
	) {
		return {
			creatorId: input.creatorId,
			updated: false,
			previousEmdashVersion: record.resources.currentEmdashVersion,
			previousBundleSha: record.resources.currentBundleSha,
			newEmdashVersion: record.resources.currentEmdashVersion,
			newBundleSha: record.resources.currentBundleSha,
		};
	}

	const tags: string[] = [];
	if (bundleData.emdashVersion) {
		tags.push(`emdash-version:${bundleData.emdashVersion}`);
	}
	if (bundleData.gitShortSha) {
		tags.push(`bundle-sha:${bundleData.gitShortSha}`);
	}

	// Mint a fresh PROVISIONING_TOKEN on every bump. The original
	// token's job is done — re-setting it dead-letters any leaked
	// copy. /skribb/provision will 409 if anyone tries to use the
	// new one (admin user already exists).
	const provisioningToken = (
		config.mintProvisioningToken ?? defaultMintToken
	)();

	await deps.cf.uploadNamespaceScript({
		namespace: config.dispatchNamespace,
		scriptName: record.resources.scriptName,
		modules: bundleData.modules,
		mainModule: bundleData.mainModule,
		compatibilityDate: bundleData.compatibilityDate,
		compatibilityFlags: bundleData.compatibilityFlags,
		tags: tags.length > 0 ? tags : undefined,
		bindings: [
			{ type: "d1", name: "DB", id: record.resources.d1Id },
			{
				type: "r2_bucket",
				name: "MEDIA",
				bucket_name: record.resources.r2BucketName,
			},
			{ type: "plain_text", name: "APP_ENV", text: "production" },
			{ type: "plain_text", name: "TENANT_HANDLE", text: record.handle },
			{
				type: "secret_text",
				name: "PROVISIONING_TOKEN",
				text: provisioningToken,
			},
		],
	});

	const previousEmdashVersion = record.resources.currentEmdashVersion;
	const previousBundleSha = record.resources.currentBundleSha;
	const now = (config.now ? config.now() : new Date()).toISOString();

	await deps.store.put({
		...record,
		resources: {
			...record.resources,
			...(bundleData.emdashVersion
				? { currentEmdashVersion: bundleData.emdashVersion }
				: {}),
			...(bundleData.gitShortSha
				? { currentBundleSha: bundleData.gitShortSha }
				: {}),
		},
		updatedAt: now,
	});

	return {
		creatorId: input.creatorId,
		updated: true,
		previousEmdashVersion,
		previousBundleSha,
		newEmdashVersion: bundleData.emdashVersion,
		newBundleSha: bundleData.gitShortSha,
	};
}
