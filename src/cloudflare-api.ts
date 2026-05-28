/**
 * Minimal Cloudflare REST API client — only the endpoints provisioning needs.
 *
 * Each method is a thin wrapper around one HTTP call. Response unwrapping
 * (`{ success, errors, result }` → throw on failure, return `result`) lives
 * in `request()`. Idempotency, retry, and orchestration belong to the
 * caller (`provision.ts`), not here.
 *
 * Constructor takes an optional `fetch` impl so tests can pass an
 * in-memory mock without monkey-patching globals.
 *
 * Coverage scope:
 *   - D1: create
 *   - R2: create bucket
 *   - Workers: upload script (single-module), bind custom domain
 *   - Generic: HTTP DELETE (used by `cleanup()` paths in the orchestrator)
 *
 * Out of scope (deliberately): D1 query (we use a deployed Worker for that),
 * KV/Queue/DO provisioning (not needed for the EmDash template), zone DNS
 * record creation (custom domain binding via Workers handles DNS itself).
 *
 * Cloudflare API ref:
 *   https://developers.cloudflare.com/api/
 */

export type Fetcher = (
	input: string | URL,
	init?: RequestInit,
) => Promise<Response>;

export interface CloudflareApiOptions {
	apiToken: string;
	accountId: string;
	/** Override for tests. Defaults to global `fetch`. */
	fetch?: Fetcher;
	/** Override for tests / CF API regions. Defaults to the public endpoint. */
	baseUrl?: string;
}

export interface D1Database {
	uuid: string;
	name: string;
	created_at: string;
}

export interface R2Bucket {
	name: string;
	creation_date?: string;
}

export interface WorkerDomain {
	id: string;
	zone_id: string;
	hostname: string;
	service: string;
	environment: string;
}

/**
 * Worker script upload binding metadata. The Workers REST API accepts a
 * superset of these; we only use the kinds the EmDash template needs.
 *
 * Names mirror wrangler.jsonc / workers script-metadata for predictability.
 */
export type WorkerBinding =
	| { type: "d1"; name: string; id: string }
	| { type: "r2_bucket"; name: string; bucket_name: string }
	| { type: "plain_text"; name: string; text: string }
	| { type: "secret_text"; name: string; text: string };

export interface WorkerUploadInput {
	/** Worker script name (URL-safe). */
	scriptName: string;
	/** The compiled bundle. */
	scriptBody: string;
	/** Bindings injected at the script's `env`. */
	bindings: WorkerBinding[];
	/** Compatibility date (e.g. "2026-05-01"). */
	compatibilityDate: string;
	/** Compatibility flags (e.g. ["nodejs_compat"]). */
	compatibilityFlags?: string[];
}

interface CfEnvelope<T> {
	success: boolean;
	errors: Array<{ code: number; message: string }>;
	messages: Array<{ code: number; message: string }>;
	result: T | null;
}

export class CloudflareApiError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly cfErrors: Array<{ code: number; message: string }>,
	) {
		super(message);
		this.name = "CloudflareApiError";
	}
}

export class CloudflareApi {
	private readonly token: string;
	private readonly accountId: string;
	private readonly fetch: Fetcher;
	private readonly baseUrl: string;

	constructor(opts: CloudflareApiOptions) {
		this.token = opts.apiToken;
		this.accountId = opts.accountId;
		this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
		this.baseUrl = opts.baseUrl ?? "https://api.cloudflare.com/client/v4";
	}

	// ── HTTP plumbing ────────────────────────────────────────────────────

	private async request<T>(
		method: string,
		path: string,
		init?: { body?: BodyInit; headers?: HeadersInit },
	): Promise<T> {
		const url = `${this.baseUrl}${path}`;
		const headers = new Headers(init?.headers);
		headers.set("Authorization", `Bearer ${this.token}`);
		const res = await this.fetch(url, {
			method,
			headers,
			...(init?.body !== undefined ? { body: init.body } : {}),
		});
		// Cloudflare always wraps JSON responses in the envelope, but some
		// endpoints (Workers script upload on success) return 200 with an
		// envelope that has `result: null` plus a meta object. Treat
		// `success: true` as canonical regardless of `result`.
		let envelope: CfEnvelope<T>;
		try {
			envelope = (await res.json()) as CfEnvelope<T>;
		} catch {
			throw new CloudflareApiError(
				`Cloudflare API non-JSON response (HTTP ${res.status}) at ${method} ${path}`,
				res.status,
				[],
			);
		}
		if (!envelope.success) {
			const summary = envelope.errors
				.map((e) => `${e.code}: ${e.message}`)
				.join("; ");
			throw new CloudflareApiError(
				`Cloudflare API ${method} ${path} failed (HTTP ${res.status}): ${summary || "no error detail"}`,
				res.status,
				envelope.errors,
			);
		}
		return envelope.result as T;
	}

	// ── D1 ───────────────────────────────────────────────────────────────

	createD1Database(name: string): Promise<D1Database> {
		return this.request<D1Database>("POST", `/accounts/${this.accountId}/d1/database`, {
			body: JSON.stringify({ name }),
			headers: { "content-type": "application/json" },
		});
	}

	deleteD1Database(uuid: string): Promise<null> {
		return this.request<null>(
			"DELETE",
			`/accounts/${this.accountId}/d1/database/${encodeURIComponent(uuid)}`,
		);
	}

	// ── R2 ───────────────────────────────────────────────────────────────

	createR2Bucket(name: string): Promise<R2Bucket> {
		return this.request<R2Bucket>("POST", `/accounts/${this.accountId}/r2/buckets`, {
			body: JSON.stringify({ name }),
			headers: { "content-type": "application/json" },
		});
	}

	deleteR2Bucket(name: string): Promise<null> {
		return this.request<null>(
			"DELETE",
			`/accounts/${this.accountId}/r2/buckets/${encodeURIComponent(name)}`,
		);
	}

	// ── Workers ──────────────────────────────────────────────────────────

	/**
	 * Upload a Worker script. Single-module ES Modules format
	 * (multipart, with the metadata part declaring the main module). The
	 * caller supplies the already-bundled script body as a string.
	 *
	 * The CF API supports multi-module deploys (each module a separate
	 * form part) — we don't need that here because the EmDash + skribb-cms
	 * template ships as a single bundled script via the Astro Cloudflare
	 * adapter.
	 */
	async uploadWorker(input: WorkerUploadInput): Promise<null> {
		const form = new FormData();
		const metadata = {
			main_module: "worker.js",
			compatibility_date: input.compatibilityDate,
			compatibility_flags: input.compatibilityFlags ?? [],
			bindings: input.bindings,
		};
		form.append(
			"metadata",
			new Blob([JSON.stringify(metadata)], { type: "application/json" }),
		);
		form.append(
			"worker.js",
			new Blob([input.scriptBody], { type: "application/javascript+module" }),
			"worker.js",
		);
		return this.request<null>(
			"PUT",
			`/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(input.scriptName)}`,
			{ body: form },
		);
	}

	deleteWorker(scriptName: string): Promise<null> {
		return this.request<null>(
			"DELETE",
			`/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(scriptName)}`,
		);
	}

	/**
	 * Bind a custom domain (e.g. `<creator>.cms.skribb.no`) to a deployed
	 * Worker. Cloudflare provisions DNS and TLS automatically; the API
	 * returns a domain id we can use to detach later.
	 */
	bindWorkerCustomDomain(input: {
		scriptName: string;
		hostname: string;
		zoneId: string;
		environment?: string;
	}): Promise<WorkerDomain> {
		return this.request<WorkerDomain>(
			"PUT",
			`/accounts/${this.accountId}/workers/domains`,
			{
				body: JSON.stringify({
					environment: input.environment ?? "production",
					hostname: input.hostname,
					service: input.scriptName,
					zone_id: input.zoneId,
				}),
				headers: { "content-type": "application/json" },
			},
		);
	}

	deleteWorkerDomain(domainId: string): Promise<null> {
		return this.request<null>(
			"DELETE",
			`/accounts/${this.accountId}/workers/domains/${encodeURIComponent(domainId)}`,
		);
	}
}
