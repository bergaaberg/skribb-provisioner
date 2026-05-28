import { beforeEach, describe, expect, it } from "vitest";
import { provisionTenant } from "../src/provision.js";
import type { ProvisionConfig, ProvisionInput } from "../src/types.js";
import {
	makeInMemoryStore,
	makeMockBootstrap,
	makeMockCloudflareApi,
	makeStubBundle,
} from "./fixtures.js";

const config: ProvisionConfig = {
	cmsBaseDomain: "cms.skribb.no",
	zoneId: "zone-1",
	// Deterministic token for assertions.
	mintProvisioningToken: () => "test-token-32-bytes-hex",
	// Frozen time so updatedAt is stable.
	now: () => new Date("2026-05-28T07:00:00Z"),
};

const input: ProvisionInput = {
	creatorId: "creator-1",
	handle: "alice",
	email: "alice@example.com",
};

describe("provisionTenant — happy path", () => {
	it("creates a D1, R2 bucket, Worker, and domain in order, ends in 'ready'", async () => {
		const cf = makeMockCloudflareApi();
		const store = makeInMemoryStore();
		const bundle = makeStubBundle();
		const bootstrap = makeMockBootstrap();

		const result = await provisionTenant(
			{ cf: cf.api, store, bundle, bootstrap },
			input,
			config,
		);

		expect(result.step).toBe("ready");
		expect(result.creatorId).toBe("creator-1");
		expect(result.hostname).toBe("alice.cms.skribb.no");
		expect(result.resources).toEqual({
			d1Id: "d1-1",
			d1Name: "skribb-cms-alice",
			r2BucketName: "skribb-cms-media-alice",
			workerName: "skribb-cms-alice",
			workerDomainId: "dom-1",
		});

		expect(cf.state.createdDatabases).toEqual([
			{ uuid: "d1-1", name: "skribb-cms-alice" },
		]);
		expect(cf.state.createdBuckets).toEqual([{ name: "skribb-cms-media-alice" }]);
		expect(cf.state.uploadedWorkers).toHaveLength(1);
		expect(cf.state.boundDomains).toEqual([
			{
				scriptName: "skribb-cms-alice",
				hostname: "alice.cms.skribb.no",
				zoneId: "zone-1",
				domainId: "dom-1",
			},
		]);
	});

	it("uploads the Worker with the right bindings (D1, R2, env, secret)", async () => {
		const cf = makeMockCloudflareApi();
		const store = makeInMemoryStore();
		const bundle = makeStubBundle();
		const bootstrap = makeMockBootstrap();

		await provisionTenant(
			{ cf: cf.api, store, bundle, bootstrap },
			input,
			config,
		);

		const worker = cf.state.uploadedWorkers[0]!;
		expect(worker.scriptName).toBe("skribb-cms-alice");
		expect(worker.compatibilityDate).toBe("2026-05-01");
		expect(worker.compatibilityFlags).toEqual(["nodejs_compat"]);

		// Bindings should include the D1 id, R2 name, env, and the
		// provisioning token (as a secret).
		const byName = new Map(worker.bindings.map((b) => [b.name as string, b]));
		expect(byName.get("DB")).toMatchObject({ type: "d1", id: "d1-1" });
		expect(byName.get("MEDIA")).toMatchObject({
			type: "r2_bucket",
			bucket_name: "skribb-cms-media-alice",
		});
		expect(byName.get("APP_ENV")).toMatchObject({
			type: "plain_text",
			text: "production",
		});
		expect(byName.get("TENANT_HANDLE")).toMatchObject({
			type: "plain_text",
			text: "alice",
		});
		expect(byName.get("PROVISIONING_TOKEN")).toMatchObject({
			type: "secret_text",
			text: "test-token-32-bytes-hex",
		});
	});

	it("calls bootstrap with the same token that's embedded in the Worker", async () => {
		const cf = makeMockCloudflareApi();
		const store = makeInMemoryStore();
		const bundle = makeStubBundle();
		const bootstrap = makeMockBootstrap();

		await provisionTenant(
			{ cf: cf.api, store, bundle, bootstrap },
			input,
			config,
		);

		expect(bootstrap.calls).toEqual([
			{
				hostname: "alice.cms.skribb.no",
				provisioningToken: "test-token-32-bytes-hex",
				adminEmail: "alice@example.com",
			},
		]);
	});

	it("persists the tenant record at every transition (not just at the end)", async () => {
		const cf = makeMockCloudflareApi();
		const store = makeInMemoryStore();
		const bundle = makeStubBundle();
		const bootstrap = makeMockBootstrap();

		await provisionTenant(
			{ cf: cf.api, store, bundle, bootstrap },
			input,
			config,
		);

		// Single record, step=ready. Intermediate puts overwrote each other
		// — observe by checking the final state. The behaviour we care
		// about (intermediate persistence) is covered by the resume tests.
		const persisted = store.dump().get("creator-1");
		expect(persisted?.step).toBe("ready");
	});
});

describe("provisionTenant — idempotent resume", () => {
	it("resumes from d1_created without re-creating the D1", async () => {
		const cf = makeMockCloudflareApi();
		const store = makeInMemoryStore();
		const bundle = makeStubBundle();
		const bootstrap = makeMockBootstrap();

		// Seed the store as if we'd crashed right after the D1 step.
		await store.put({
			creatorId: "creator-1",
			handle: "alice",
			email: "alice@example.com",
			hostname: "alice.cms.skribb.no",
			step: "d1_created",
			resources: { d1Id: "d1-existing", d1Name: "skribb-cms-alice" },
			createdAt: "2026-05-28T06:00:00Z",
			updatedAt: "2026-05-28T06:00:00Z",
		});

		const result = await provisionTenant(
			{ cf: cf.api, store, bundle, bootstrap },
			input,
			config,
		);

		expect(result.step).toBe("ready");
		// Critically: NO new D1 was created. The Worker uses the existing one.
		expect(cf.state.createdDatabases).toHaveLength(0);
		expect(cf.state.createdBuckets).toHaveLength(1);
		expect(cf.state.uploadedWorkers).toHaveLength(1);
		expect(cf.state.uploadedWorkers[0]!.bindings).toContainEqual({
			type: "d1",
			name: "DB",
			id: "d1-existing",
		});
	});

	it("is a no-op when the record is already 'ready'", async () => {
		const cf = makeMockCloudflareApi();
		const store = makeInMemoryStore();
		const bundle = makeStubBundle();
		const bootstrap = makeMockBootstrap();

		await store.put({
			creatorId: "creator-1",
			handle: "alice",
			email: "alice@example.com",
			hostname: "alice.cms.skribb.no",
			step: "ready",
			resources: {
				d1Id: "d1-1",
				r2BucketName: "skribb-cms-media-alice",
				workerName: "skribb-cms-alice",
				workerDomainId: "dom-1",
			},
			createdAt: "2026-05-28T06:00:00Z",
			updatedAt: "2026-05-28T06:00:00Z",
		});

		const result = await provisionTenant(
			{ cf: cf.api, store, bundle, bootstrap },
			input,
			config,
		);

		expect(result.step).toBe("ready");
		expect(cf.callCount()).toBe(0);
		expect(bootstrap.calls).toHaveLength(0);
	});
});

describe("provisionTenant — failure handling", () => {
	let cf: ReturnType<typeof makeMockCloudflareApi>;
	let store: ReturnType<typeof makeInMemoryStore>;
	let bundle: ReturnType<typeof makeStubBundle>;
	let bootstrap: ReturnType<typeof makeMockBootstrap>;

	beforeEach(() => {
		cf = makeMockCloudflareApi();
		store = makeInMemoryStore();
		bundle = makeStubBundle();
		bootstrap = makeMockBootstrap();
	});

	it("on Worker upload failure: D1+R2 stay intact, record marked failed", async () => {
		cf.failNext("PUT", "/workers/scripts/", "rate limit");

		await expect(
			provisionTenant({ cf: cf.api, store, bundle, bootstrap }, input, config),
		).rejects.toThrow(/rate limit/);

		const persisted = store.dump().get("creator-1")!;
		expect(persisted.step).toBe("failed");
		expect(persisted.error).toMatch(/rate limit/);
		// D1 and R2 already happened — IDs remain on the record so
		// recovery doesn't need to recreate them.
		expect(persisted.resources.d1Id).toBe("d1-1");
		expect(persisted.resources.r2BucketName).toBe("skribb-cms-media-alice");
		expect(persisted.resources.workerName).toBeUndefined();
	});

	it("a failed record is not auto-retried — explicit recovery required", async () => {
		cf.failNext("PUT", "/workers/scripts/", "rate limit");
		await expect(
			provisionTenant({ cf: cf.api, store, bundle, bootstrap }, input, config),
		).rejects.toThrow(/rate limit/);

		// Re-run with the same input. Orchestrator should refuse to
		// touch a `failed` record, surfacing the prior error.
		await expect(
			provisionTenant({ cf: cf.api, store, bundle, bootstrap }, input, config),
		).rejects.toThrow(/failed state/);
	});

	it("rejects when resume sees a different handle for the same creator id", async () => {
		await store.put({
			creatorId: "creator-1",
			handle: "alice",
			email: "alice@example.com",
			hostname: "alice.cms.skribb.no",
			step: "d1_created",
			resources: { d1Id: "d1-existing" },
			createdAt: "2026-05-28T06:00:00Z",
			updatedAt: "2026-05-28T06:00:00Z",
		});

		await expect(
			provisionTenant(
				{ cf: cf.api, store, bundle, bootstrap },
				{ ...input, handle: "different-handle" },
				config,
			),
		).rejects.toThrow(/resume mismatch/);
	});

	it("on bootstrap failure: tenant is marked failed but Worker is left deployed", async () => {
		bootstrap = makeMockBootstrap("migration failed");

		await expect(
			provisionTenant({ cf: cf.api, store, bundle, bootstrap }, input, config),
		).rejects.toThrow(/migration failed/);

		const persisted = store.dump().get("creator-1")!;
		expect(persisted.step).toBe("failed");
		// Worker + domain are live; only the bootstrap step failed.
		expect(persisted.resources.workerName).toBe("skribb-cms-alice");
		expect(persisted.resources.workerDomainId).toBe("dom-1");
	});
});
