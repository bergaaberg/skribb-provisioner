/**
 * Direct tests for the CloudflareApi client — independent of the
 * orchestrator. Covers HTTP envelope unwrapping, auth header injection,
 * and the WfP-specific endpoints.
 */
import { describe, expect, it } from "vitest";
import {
	CloudflareApi,
	CloudflareApiError,
	type Fetcher,
} from "../src/cloudflare-api.js";

function makeFakeFetch(
	handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetch: Fetcher; calls: Array<{ url: string; init: RequestInit }> } {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetch: Fetcher = async (input, init) => {
		const url = typeof input === "string" ? input : input.toString();
		const safe = init ?? {};
		calls.push({ url, init: safe });
		return handler(url, safe);
	};
	return { fetch, calls };
}

function envelope(body: object, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("CloudflareApi — common", () => {
	it("sends the bearer token on every request", async () => {
		const { fetch, calls } = makeFakeFetch(() =>
			envelope({
				success: true,
				result: { uuid: "x", name: "x", created_at: "" },
				errors: [],
				messages: [],
			}),
		);
		const api = new CloudflareApi({
			apiToken: "secret-token",
			accountId: "acct",
			fetch,
		});
		await api.createD1Database("x");
		expect(calls).toHaveLength(1);
		const headers = new Headers(calls[0]!.init.headers);
		expect(headers.get("Authorization")).toBe("Bearer secret-token");
	});

	it("unwraps the result on success", async () => {
		const { fetch } = makeFakeFetch(() =>
			envelope({
				success: true,
				result: { uuid: "abc", name: "my-db", created_at: "2026-05-28T00:00:00Z" },
				errors: [],
				messages: [],
			}),
		);
		const api = new CloudflareApi({ apiToken: "t", accountId: "a", fetch });
		const result = await api.createD1Database("my-db");
		expect(result.uuid).toBe("abc");
		expect(result.name).toBe("my-db");
	});

	it("throws CloudflareApiError with the error details on success=false", async () => {
		const { fetch } = makeFakeFetch(() =>
			envelope(
				{
					success: false,
					result: null,
					errors: [{ code: 7404, message: "database already exists" }],
					messages: [],
				},
				400,
			),
		);
		const api = new CloudflareApi({ apiToken: "t", accountId: "a", fetch });
		const err = await api.createD1Database("dup").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(CloudflareApiError);
		const cfErr = err as CloudflareApiError;
		expect(cfErr.status).toBe(400);
		expect(cfErr.cfErrors).toEqual([
			{ code: 7404, message: "database already exists" },
		]);
		expect(cfErr.message).toMatch(/database already exists/);
	});

	it("throws on non-JSON response with the HTTP status surfaced", async () => {
		const { fetch } = makeFakeFetch(
			() =>
				new Response("upstream HTML error page", {
					status: 502,
					headers: { "content-type": "text/html" },
				}),
		);
		const api = new CloudflareApi({ apiToken: "t", accountId: "a", fetch });
		const err = await api.createD1Database("x").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(CloudflareApiError);
		expect((err as CloudflareApiError).status).toBe(502);
	});
});

describe("CloudflareApi — Workers for Platforms", () => {
	it("createDispatchNamespace targets the right endpoint", async () => {
		const { fetch, calls } = makeFakeFetch(() =>
			envelope({
				success: true,
				result: {
					namespace_id: "ns-1",
					namespace_name: "skribb-tenants",
					created_on: "2026-05-28T00:00:00Z",
				},
				errors: [],
				messages: [],
			}),
		);
		const api = new CloudflareApi({
			apiToken: "t",
			accountId: "acct-123",
			fetch,
		});
		const ns = await api.createDispatchNamespace("skribb-tenants");
		expect(calls[0]!.url).toBe(
			"https://api.cloudflare.com/client/v4/accounts/acct-123/workers/dispatch/namespaces",
		);
		expect(calls[0]!.init.method).toBe("POST");
		expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
			name: "skribb-tenants",
		});
		expect(ns.namespace_id).toBe("ns-1");
	});

	it("uploadNamespaceScript targets the right endpoint and sends multipart", async () => {
		const captured: {
			url?: string;
			metadata?: string;
			modules: Array<{ name: string; body: string }>;
		} = { modules: [] };
		const { fetch } = makeFakeFetch(async (url, init) => {
			captured.url = url;
			const form = init.body as FormData;
			// Collect via forEach (typed on FormData; `entries` isn't in
			// lib.dom). Then resolve Blobs separately because forEach is
			// synchronous.
			const collected: Array<[string, Blob]> = [];
			form.forEach((value, partName) => {
				collected.push([partName, value as Blob]);
			});
			for (const [partName, blob] of collected) {
				if (partName === "metadata") {
					captured.metadata = await blob.text();
				} else {
					captured.modules.push({ name: partName, body: await blob.text() });
				}
			}
			return envelope({ success: true, result: null, errors: [], messages: [] });
		});
		const api = new CloudflareApi({ apiToken: "t", accountId: "a", fetch });
		await api.uploadNamespaceScript({
			namespace: "skribb-tenants",
			scriptName: "skribb-cms-alice",
			modules: [
				{ name: "entry.mjs", body: "export default {}" },
				{ name: "chunks/x.mjs", body: "export const x = 1;" },
			],
			mainModule: "entry.mjs",
			compatibilityDate: "2026-05-01",
			compatibilityFlags: ["nodejs_compat"],
			bindings: [{ type: "d1", name: "DB", id: "d1-x" }],
			tags: ["emdash-version:0.14.0"],
		});
		expect(captured.url).toBe(
			"https://api.cloudflare.com/client/v4/accounts/a/workers/dispatch/namespaces/skribb-tenants/scripts/skribb-cms-alice",
		);
		const meta = JSON.parse(captured.metadata!) as Record<string, unknown>;
		expect(meta.main_module).toBe("entry.mjs");
		expect(meta.compatibility_date).toBe("2026-05-01");
		expect(meta.compatibility_flags).toEqual(["nodejs_compat"]);
		expect(meta.tags).toEqual(["emdash-version:0.14.0"]);
		expect(meta.bindings).toEqual([{ type: "d1", name: "DB", id: "d1-x" }]);
		// Two modules sent, with their names as the form-part names.
		expect(captured.modules).toHaveLength(2);
		expect(captured.modules.map((m) => m.name).sort()).toEqual([
			"chunks/x.mjs",
			"entry.mjs",
		]);
		expect(
			captured.modules.find((m) => m.name === "entry.mjs")?.body,
		).toBe("export default {}");
	});

	it("rejects an upload with no modules", async () => {
		const { fetch } = makeFakeFetch(() =>
			envelope({ success: true, result: null, errors: [], messages: [] }),
		);
		const api = new CloudflareApi({ apiToken: "t", accountId: "a", fetch });
		await expect(
			api.uploadNamespaceScript({
				namespace: "ns",
				scriptName: "s",
				modules: [],
				mainModule: "x.mjs",
				compatibilityDate: "2026-01-01",
				bindings: [],
			}),
		).rejects.toThrow(/cannot be empty/i);
	});

	it("rejects when mainModule is not in the modules list", async () => {
		const { fetch } = makeFakeFetch(() =>
			envelope({ success: true, result: null, errors: [], messages: [] }),
		);
		const api = new CloudflareApi({ apiToken: "t", accountId: "a", fetch });
		await expect(
			api.uploadNamespaceScript({
				namespace: "ns",
				scriptName: "s",
				modules: [{ name: "a.mjs", body: "" }],
				mainModule: "not-in-list.mjs",
				compatibilityDate: "2026-01-01",
				bindings: [],
			}),
		).rejects.toThrow(/not in the modules list/i);
	});

	it("URL-encodes special characters in namespace + script names", async () => {
		const { fetch, calls } = makeFakeFetch(() =>
			envelope({ success: true, result: null, errors: [], messages: [] }),
		);
		const api = new CloudflareApi({ apiToken: "t", accountId: "a", fetch });
		await api.uploadNamespaceScript({
			namespace: "a/b",
			scriptName: "x y",
			modules: [{ name: "entry.mjs", body: "" }],
			mainModule: "entry.mjs",
			compatibilityDate: "2026-01-01",
			bindings: [],
		});
		expect(calls[0]!.url).toContain("/namespaces/a%2Fb/scripts/x%20y");
	});

	it("deleteNamespaceScript targets the right endpoint", async () => {
		const { fetch, calls } = makeFakeFetch(() =>
			envelope({ success: true, result: null, errors: [], messages: [] }),
		);
		const api = new CloudflareApi({ apiToken: "t", accountId: "a", fetch });
		await api.deleteNamespaceScript({
			namespace: "skribb-tenants",
			scriptName: "skribb-cms-alice",
		});
		expect(calls[0]!.init.method).toBe("DELETE");
		expect(calls[0]!.url).toContain(
			"/workers/dispatch/namespaces/skribb-tenants/scripts/skribb-cms-alice",
		);
	});
});
