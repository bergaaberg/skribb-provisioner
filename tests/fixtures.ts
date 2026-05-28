/**
 * Test fixtures — in-memory CF API + tenant store + bundle / bootstrap stubs.
 *
 * The CF mock matches requests by method + URL substring rather than full
 * URL parsing because the orchestrator only cares about *which* CF
 * resource it's touching, not about query params. The fake `fetch`
 * routes each (method, urlContains) to a handler that returns a CF
 * envelope-shaped Response.
 *
 * State on the mocks is intentionally observable from the test (created
 * D1s, R2 buckets, etc.) so assertions can confirm both control flow
 * (orchestrator order) and effects (right bindings, right names).
 */
import { CloudflareApi, type Fetcher } from "../src/cloudflare-api.js";
import type {
	BootstrapClient,
	BundleLoader,
	TenantRecord,
	TenantStore,
} from "../src/types.js";

interface CapturedScript {
	namespace: string;
	scriptName: string;
	scriptBody: string;
	bindings: Array<Record<string, unknown>>;
	compatibilityDate: string;
	compatibilityFlags: string[];
	tags?: string[];
}

export interface MockCloudflareApi {
	api: CloudflareApi;
	state: {
		createdDatabases: Array<{ uuid: string; name: string }>;
		createdBuckets: Array<{ name: string }>;
		createdNamespaces: Array<{ name: string }>;
		uploadedScripts: CapturedScript[];
	};
	/** Inject a one-shot failure on the next call matching `method + urlContains`. */
	failNext(method: string, urlContains: string, errorMessage: string): void;
	/** Total fetch calls observed. */
	callCount(): number;
}

export function makeMockCloudflareApi(): MockCloudflareApi {
	const state: MockCloudflareApi["state"] = {
		createdDatabases: [],
		createdBuckets: [],
		createdNamespaces: [],
		uploadedScripts: [],
	};
	let calls = 0;
	const failures: Array<{
		method: string;
		urlContains: string;
		message: string;
	}> = [];

	function envelope(success: boolean, result: unknown, errors: unknown[] = []) {
		return new Response(
			JSON.stringify({ success, result: success ? result : null, errors, messages: [] }),
			{ status: success ? 200 : 400, headers: { "content-type": "application/json" } },
		);
	}

	const fetch: Fetcher = async (input, init) => {
		calls++;
		const url = typeof input === "string" ? input : input.toString();
		const method = (init?.method ?? "GET").toUpperCase();

		// Check injected failures first.
		const failureIdx = failures.findIndex(
			(f) => f.method === method && url.includes(f.urlContains),
		);
		if (failureIdx >= 0) {
			const f = failures.splice(failureIdx, 1)[0]!;
			return envelope(false, null, [{ code: 10000, message: f.message }]);
		}

		// D1 create.
		if (method === "POST" && url.includes("/d1/database")) {
			const body = JSON.parse(init?.body as string) as { name: string };
			const uuid = `d1-${state.createdDatabases.length + 1}`;
			state.createdDatabases.push({ uuid, name: body.name });
			return envelope(true, {
				uuid,
				name: body.name,
				created_at: "2026-05-28T00:00:00Z",
			});
		}

		// R2 bucket create.
		if (method === "POST" && url.includes("/r2/buckets")) {
			const body = JSON.parse(init?.body as string) as { name: string };
			state.createdBuckets.push({ name: body.name });
			return envelope(true, { name: body.name });
		}

		// Dispatch namespace create.
		if (
			method === "POST" &&
			url.includes("/workers/dispatch/namespaces") &&
			!url.includes("/scripts/")
		) {
			const body = JSON.parse(init?.body as string) as { name: string };
			state.createdNamespaces.push({ name: body.name });
			return envelope(true, {
				namespace_id: `ns-${state.createdNamespaces.length}`,
				namespace_name: body.name,
				created_on: "2026-05-28T00:00:00Z",
			});
		}

		// Namespace script upload (PUT with multipart body).
		if (
			method === "PUT" &&
			url.includes("/workers/dispatch/namespaces/") &&
			url.includes("/scripts/")
		) {
			// Path: .../namespaces/{ns}/scripts/{script}
			const segments = url.split("/");
			const nsIdx = segments.indexOf("namespaces");
			const namespace = decodeURIComponent(segments[nsIdx + 1] ?? "");
			const scriptIdx = segments.indexOf("scripts");
			const scriptName = decodeURIComponent(segments[scriptIdx + 1] ?? "");
			const form = init?.body as FormData;
			const metadataPart = form.get("metadata");
			const metadata = JSON.parse(
				typeof metadataPart === "string"
					? metadataPart
					: await (metadataPart as Blob).text(),
			) as {
				bindings: Array<Record<string, unknown>>;
				compatibility_date: string;
				compatibility_flags: string[];
				tags?: string[];
			};
			const scriptPart = form.get("worker.js");
			const scriptBody =
				typeof scriptPart === "string"
					? scriptPart
					: await (scriptPart as Blob).text();
			state.uploadedScripts.push({
				namespace,
				scriptName,
				scriptBody,
				bindings: metadata.bindings,
				compatibilityDate: metadata.compatibility_date,
				compatibilityFlags: metadata.compatibility_flags,
				...(metadata.tags ? { tags: metadata.tags } : {}),
			});
			return envelope(true, null);
		}

		return envelope(false, null, [
			{ code: 7003, message: `Unmatched route: ${method} ${url}` },
		]);
	};

	const api = new CloudflareApi({
		apiToken: "test-token",
		accountId: "test-account",
		fetch,
	});

	return {
		api,
		state,
		failNext: (method, urlContains, errorMessage) => {
			failures.push({ method, urlContains, message: errorMessage });
		},
		callCount: () => calls,
	};
}

export function makeInMemoryStore(): TenantStore & {
	dump(): Map<string, TenantRecord>;
} {
	const records = new Map<string, TenantRecord>();
	return {
		async get(creatorId) {
			const r = records.get(creatorId);
			return r ? structuredClone(r) : null;
		},
		async put(record) {
			records.set(record.creatorId, structuredClone(record));
		},
		dump() {
			return records;
		},
	};
}

export function makeStubBundle(
	scriptBody = "/* skribb-cms bundle */",
	emdashVersion = "0.14.0",
): BundleLoader {
	return {
		async load() {
			return {
				scriptBody,
				compatibilityDate: "2026-05-01",
				compatibilityFlags: ["nodejs_compat"],
				emdashVersion,
			};
		},
	};
}

export interface MockBootstrap extends BootstrapClient {
	calls: Array<{ hostname: string; provisioningToken: string; adminEmail: string }>;
}

export function makeMockBootstrap(failNext?: string): MockBootstrap {
	const calls: MockBootstrap["calls"] = [];
	let pendingFailure = failNext;
	return {
		calls,
		async bootstrap(input) {
			calls.push(input);
			if (pendingFailure) {
				const msg = pendingFailure;
				pendingFailure = undefined;
				throw new Error(msg);
			}
		},
	};
}
