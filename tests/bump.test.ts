import { describe, expect, it } from "vitest";
import { bumpTenant } from "../src/bump.js";
import type { ProvisionConfig, TenantRecord } from "../src/types.js";
import {
	makeInMemoryStore,
	makeMockCloudflareApi,
	makeStubBundle,
} from "./fixtures.js";

const config: ProvisionConfig = {
	cmsBaseDomain: "cms.skribb.no",
	dispatchNamespace: "skribb-tenants",
	mintProvisioningToken: () => "rotated-token-32-bytes-hex",
	now: () => new Date("2026-05-29T07:00:00Z"),
};

function makeReadyTenant(overrides?: Partial<TenantRecord>): TenantRecord {
	return {
		creatorId: "creator-1",
		handle: "alice",
		email: "alice@example.com",
		hostname: "alice.cms.skribb.no",
		step: "ready",
		resources: {
			d1Id: "d1-1",
			d1Name: "skribb-cms-alice",
			r2BucketName: "skribb-cms-media-alice",
			scriptName: "skribb-cms-alice",
			currentEmdashVersion: "0.14.0",
			currentBundleSha: "abc1234567",
		},
		createdAt: "2026-05-28T07:00:00Z",
		updatedAt: "2026-05-28T07:00:00Z",
		...overrides,
	};
}

describe("bumpTenant — happy path", () => {
	it("re-uploads when the bundle SHA changes, records new version", async () => {
		const cf = makeMockCloudflareApi();
		const store = makeInMemoryStore();
		await store.put(makeReadyTenant());
		const bundle = makeStubBundle("/* new body */", "0.15.0", "def7654321");

		const result = await bumpTenant(
			{ cf: cf.api, store, bundle },
			{ creatorId: "creator-1" },
			config,
		);

		expect(result).toEqual({
			creatorId: "creator-1",
			updated: true,
			previousEmdashVersion: "0.14.0",
			previousBundleSha: "abc1234567",
			newEmdashVersion: "0.15.0",
			newBundleSha: "def7654321",
		});
		expect(cf.state.uploadedScripts).toHaveLength(1);
		expect(cf.state.uploadedScripts[0]!.scriptName).toBe("skribb-cms-alice");

		const persisted = store.dump().get("creator-1")!;
		expect(persisted.resources.currentEmdashVersion).toBe("0.15.0");
		expect(persisted.resources.currentBundleSha).toBe("def7654321");
	});

	it("preserves D1 and R2 bindings from the existing record", async () => {
		const cf = makeMockCloudflareApi();
		const store = makeInMemoryStore();
		await store.put(makeReadyTenant());
		const bundle = makeStubBundle("/* body */", "0.15.0", "def7654321");

		await bumpTenant(
			{ cf: cf.api, store, bundle },
			{ creatorId: "creator-1" },
			config,
		);

		const bindings = cf.state.uploadedScripts[0]!.bindings;
		const byName = new Map(bindings.map((b) => [b.name as string, b]));
		expect(byName.get("DB")).toMatchObject({ type: "d1", id: "d1-1" });
		expect(byName.get("MEDIA")).toMatchObject({
			type: "r2_bucket",
			bucket_name: "skribb-cms-media-alice",
		});
		expect(byName.get("TENANT_HANDLE")).toMatchObject({
			type: "plain_text",
			text: "alice",
		});
	});

	it("rotates PROVISIONING_TOKEN to a fresh value on every bump", async () => {
		// Defensive rotation: the old token's purpose was the one-shot
		// bootstrap, which already happened. The new token won't be
		// used (skribb/provision will 409) but rotating dead-letters
		// any leaked copy.
		const cf = makeMockCloudflareApi();
		const store = makeInMemoryStore();
		await store.put(makeReadyTenant());
		const bundle = makeStubBundle("/* body */", "0.15.0", "def7654321");

		await bumpTenant(
			{ cf: cf.api, store, bundle },
			{ creatorId: "creator-1" },
			config,
		);

		const bindings = cf.state.uploadedScripts[0]!.bindings;
		const tokenBinding = bindings.find((b) => b.name === "PROVISIONING_TOKEN");
		expect(tokenBinding).toMatchObject({
			type: "secret_text",
			text: "rotated-token-32-bytes-hex",
		});
	});

	it("updates the script tags (emdash-version + bundle-sha)", async () => {
		const cf = makeMockCloudflareApi();
		const store = makeInMemoryStore();
		await store.put(makeReadyTenant());
		const bundle = makeStubBundle("/* body */", "0.15.0", "def7654321");

		await bumpTenant(
			{ cf: cf.api, store, bundle },
			{ creatorId: "creator-1" },
			config,
		);

		expect(cf.state.uploadedScripts[0]!.tags).toEqual([
			"emdash-version:0.15.0",
			"bundle-sha:def7654321",
		]);
	});
});

describe("bumpTenant — no-op", () => {
	it("returns updated=false when the bundle SHA matches and force=false", async () => {
		const cf = makeMockCloudflareApi();
		const store = makeInMemoryStore();
		await store.put(makeReadyTenant());
		const bundle = makeStubBundle("/* body */", "0.14.0", "abc1234567");

		const result = await bumpTenant(
			{ cf: cf.api, store, bundle },
			{ creatorId: "creator-1" },
			config,
		);

		expect(result.updated).toBe(false);
		expect(cf.callCount()).toBe(0);
	});

	it("re-uploads even when SHA matches if force=true", async () => {
		const cf = makeMockCloudflareApi();
		const store = makeInMemoryStore();
		await store.put(makeReadyTenant());
		const bundle = makeStubBundle("/* body */", "0.14.0", "abc1234567");

		const result = await bumpTenant(
			{ cf: cf.api, store, bundle },
			{ creatorId: "creator-1", force: true },
			config,
		);

		expect(result.updated).toBe(true);
		expect(cf.state.uploadedScripts).toHaveLength(1);
	});
});

describe("bumpTenant — failure cases", () => {
	it("rejects when the tenant doesn't exist", async () => {
		const cf = makeMockCloudflareApi();
		const store = makeInMemoryStore();
		const bundle = makeStubBundle();
		await expect(
			bumpTenant(
				{ cf: cf.api, store, bundle },
				{ creatorId: "ghost" },
				config,
			),
		).rejects.toThrow(/not found/);
	});

	it("rejects when step !== ready (mid-provision tenant)", async () => {
		const cf = makeMockCloudflareApi();
		const store = makeInMemoryStore();
		await store.put(makeReadyTenant({ step: "bootstrapped" }));
		const bundle = makeStubBundle();
		await expect(
			bumpTenant(
				{ cf: cf.api, store, bundle },
				{ creatorId: "creator-1" },
				config,
			),
		).rejects.toThrow(/expected "ready"/);
	});

	it("rejects when scriptName is missing from the record", async () => {
		const cf = makeMockCloudflareApi();
		const store = makeInMemoryStore();
		const t = makeReadyTenant();
		delete t.resources.scriptName;
		await store.put(t);
		const bundle = makeStubBundle();
		await expect(
			bumpTenant(
				{ cf: cf.api, store, bundle },
				{ creatorId: "creator-1" },
				config,
			),
		).rejects.toThrow(/scriptName is missing/);
	});

	it("rejects when D1 / R2 are missing from the record (can't rebuild bindings)", async () => {
		const cf = makeMockCloudflareApi();
		const store = makeInMemoryStore();
		const t = makeReadyTenant();
		delete t.resources.d1Id;
		await store.put(t);
		const bundle = makeStubBundle();
		await expect(
			bumpTenant(
				{ cf: cf.api, store, bundle },
				{ creatorId: "creator-1" },
				config,
			),
		).rejects.toThrow(/D1 \/ R2/);
	});
});
