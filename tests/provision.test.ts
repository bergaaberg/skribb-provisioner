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
	dispatchNamespace: "skribb-tenants",
	mintProvisioningToken: () => "test-token-32-bytes-hex",
	now: () => new Date("2026-05-28T07:00:00Z"),
};

const input: ProvisionInput = {
	creatorId: "creator-1",
	handle: "alice",
	email: "alice@example.com",
};

describe("provisionTenant — happy path", () => {
	it("creates D1, R2, and a namespace script in order, ends in 'ready'", async () => {
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
			scriptName: "skribb-cms-alice",
		});

		expect(cf.state.createdDatabases).toEqual([
			{ uuid: "d1-1", name: "skribb-cms-alice" },
		]);
		expect(cf.state.createdBuckets).toEqual([{ name: "skribb-cms-media-alice" }]);
		expect(cf.state.uploadedScripts).toHaveLength(1);
		expect(cf.state.uploadedScripts[0]!.namespace).toBe("skribb-tenants");
		expect(cf.state.uploadedScripts[0]!.scriptName).toBe("skribb-cms-alice");
	});

	it("uploads the namespace script with the right bindings", async () => {
		const cf = makeMockCloudflareApi();
		const store = makeInMemoryStore();
		const bundle = makeStubBundle();
		const bootstrap = makeMockBootstrap();

		await provisionTenant(
			{ cf: cf.api, store, bundle, bootstrap },
			input,
			config,
		);

		const script = cf.state.uploadedScripts[0]!;
		expect(script.compatibilityDate).toBe("2026-05-01");
		expect(script.compatibilityFlags).toEqual(["nodejs_compat"]);

		const byName = new Map(script.bindings.map((b) => [b.name as string, b]));
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

	it("tags the namespace script with the EmDash version", async () => {
		// Tags let us later filter/find "all tenants on EmDash 0.14" for
		// batch redeploys. WfP supports this natively.
		const cf = makeMockCloudflareApi();
		const store = makeInMemoryStore();
		const bundle = makeStubBundle("/* body */", "0.14.0");
		const bootstrap = makeMockBootstrap();

		await provisionTenant(
			{ cf: cf.api, store, bundle, bootstrap },
			input,
			config,
		);

		expect(cf.state.uploadedScripts[0]!.tags).toEqual([
			"emdash-version:0.14.0",
		]);
	});

	it("calls bootstrap with the same token that's embedded in the script", async () => {
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
				// Defaults to the handle when not provided.
				title: "alice",
			},
		]);
	});

	it("passes an explicit title to bootstrap when provided", async () => {
		const cf = makeMockCloudflareApi();
		const store = makeInMemoryStore();
		const bundle = makeStubBundle();
		const bootstrap = makeMockBootstrap();

		await provisionTenant(
			{ cf: cf.api, store, bundle, bootstrap },
			{ ...input, title: "Alice's Letters" },
			config,
		);

		expect(bootstrap.calls[0]?.title).toBe("Alice's Letters");
	});

	it("does NOT touch domain binding or namespace creation (per-tenant)", async () => {
		// Sanity check that we're really on the WfP shape: dispatch
		// namespace is operator-owned, custom domains are dispatcher-owned.
		const cf = makeMockCloudflareApi();
		const store = makeInMemoryStore();
		const bundle = makeStubBundle();
		const bootstrap = makeMockBootstrap();

		await provisionTenant(
			{ cf: cf.api, store, bundle, bootstrap },
			input,
			config,
		);

		expect(cf.state.createdNamespaces).toEqual([]);
	});
});

describe("provisionTenant — idempotent resume", () => {
	it("resumes from d1_created without re-creating the D1", async () => {
		const cf = makeMockCloudflareApi();
		const store = makeInMemoryStore();
		const bundle = makeStubBundle();
		const bootstrap = makeMockBootstrap();

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
		expect(cf.state.createdDatabases).toHaveLength(0);
		expect(cf.state.createdBuckets).toHaveLength(1);
		expect(cf.state.uploadedScripts).toHaveLength(1);
		expect(cf.state.uploadedScripts[0]!.bindings).toContainEqual({
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
				scriptName: "skribb-cms-alice",
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

	it("on script upload failure: D1+R2 stay intact, record marked failed", async () => {
		cf.failNext("PUT", "/workers/dispatch/namespaces/", "rate limit");

		await expect(
			provisionTenant({ cf: cf.api, store, bundle, bootstrap }, input, config),
		).rejects.toThrow(/rate limit/);

		const persisted = store.dump().get("creator-1")!;
		expect(persisted.step).toBe("failed");
		expect(persisted.error).toMatch(/rate limit/);
		expect(persisted.resources.d1Id).toBe("d1-1");
		expect(persisted.resources.r2BucketName).toBe("skribb-cms-media-alice");
		expect(persisted.resources.scriptName).toBeUndefined();
	});

	it("a failed record is not auto-retried — explicit recovery required", async () => {
		cf.failNext("PUT", "/workers/dispatch/namespaces/", "rate limit");
		await expect(
			provisionTenant({ cf: cf.api, store, bundle, bootstrap }, input, config),
		).rejects.toThrow(/rate limit/);
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

	it("on bootstrap failure: tenant is marked failed but script is left in the namespace", async () => {
		bootstrap = makeMockBootstrap("migration failed");

		await expect(
			provisionTenant({ cf: cf.api, store, bundle, bootstrap }, input, config),
		).rejects.toThrow(/migration failed/);

		const persisted = store.dump().get("creator-1")!;
		expect(persisted.step).toBe("failed");
		// Script is live in the namespace; the dispatcher will route to
		// it. Only bootstrap (migrations + admin user) needs retry.
		expect(persisted.resources.scriptName).toBe("skribb-cms-alice");
	});
});
