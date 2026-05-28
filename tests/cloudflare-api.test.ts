/**
 * Direct tests for the CloudflareApi client — independent of the
 * orchestrator. Covers HTTP envelope unwrapping, auth header injection,
 * and error mapping.
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

describe("CloudflareApi", () => {
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

	it("targets the correct path for createD1Database", async () => {
		const { fetch, calls } = makeFakeFetch(() =>
			envelope({
				success: true,
				result: { uuid: "u", name: "n", created_at: "" },
				errors: [],
				messages: [],
			}),
		);
		const api = new CloudflareApi({
			apiToken: "t",
			accountId: "acct-123",
			fetch,
		});
		await api.createD1Database("my-db");
		expect(calls[0]!.url).toBe(
			"https://api.cloudflare.com/client/v4/accounts/acct-123/d1/database",
		);
		expect(calls[0]!.init.method).toBe("POST");
		expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ name: "my-db" });
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

	it("uploadWorker sends multipart with metadata and script parts", async () => {
		const captured: { metadata?: string; scriptBody?: string } = {};
		const { fetch } = makeFakeFetch(async (_url, init) => {
			const form = init.body as FormData;
			const metaPart = form.get("metadata") as Blob;
			captured.metadata = await metaPart.text();
			const scriptPart = form.get("worker.js") as Blob;
			captured.scriptBody = await scriptPart.text();
			return envelope({ success: true, result: null, errors: [], messages: [] });
		});
		const api = new CloudflareApi({ apiToken: "t", accountId: "a", fetch });
		await api.uploadWorker({
			scriptName: "worker-x",
			scriptBody: "export default {}",
			compatibilityDate: "2026-05-01",
			compatibilityFlags: ["nodejs_compat"],
			bindings: [{ type: "d1", name: "DB", id: "d1-x" }],
		});
		const meta = JSON.parse(captured.metadata!) as Record<string, unknown>;
		expect(meta.main_module).toBe("worker.js");
		expect(meta.compatibility_date).toBe("2026-05-01");
		expect(meta.compatibility_flags).toEqual(["nodejs_compat"]);
		expect(meta.bindings).toEqual([{ type: "d1", name: "DB", id: "d1-x" }]);
		expect(captured.scriptBody).toBe("export default {}");
	});

	it("bindWorkerCustomDomain returns the domain id for cleanup", async () => {
		const { fetch } = makeFakeFetch(() =>
			envelope({
				success: true,
				result: {
					id: "dom-99",
					zone_id: "z",
					hostname: "h",
					service: "s",
					environment: "production",
				},
				errors: [],
				messages: [],
			}),
		);
		const api = new CloudflareApi({ apiToken: "t", accountId: "a", fetch });
		const domain = await api.bindWorkerCustomDomain({
			scriptName: "s",
			hostname: "alice.cms.skribb.no",
			zoneId: "z",
		});
		expect(domain.id).toBe("dom-99");
	});
});
