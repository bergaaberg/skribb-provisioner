/**
 * Minimal Cloudflare REST API client — Workers for Platforms shape.
 *
 * Targets the WfP deployment model: a single dispatch namespace owns
 * every tenant's user Worker; a separate dispatcher Worker (deployed
 * by the operator, see ../dispatcher/) routes requests to namespace
 * members by host header.
 *
 * Constructor takes an optional `fetch` impl so tests can pass an
 * in-memory mock without monkey-patching globals.
 *
 * Coverage scope:
 *   - D1: create, delete
 *   - R2: create bucket, delete bucket
 *   - Workers for Platforms:
 *       - dispatch namespace: create (one-time, operator setup)
 *       - namespace script: upload (per-tenant), delete
 *
 * Out of scope (deliberately):
 *   - Bare Workers script upload — WfP uses namespace scripts instead.
 *   - Per-tenant custom domain binding — WfP routes via the dispatcher.
 *   - D1 query (use a deployed Worker), KV / Queue / DO provisioning.
 *
 * Cloudflare API reference:
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

export interface DispatchNamespace {
	namespace_id: string;
	namespace_name: string;
	created_on?: string;
}

/**
 * Worker script upload binding metadata.
 *
 * For namespace scripts the binding kinds are the same as bare scripts —
 * the deployment surface differs but the runtime shape doesn't.
 */
export type WorkerBinding =
	| { type: "d1"; name: string; id: string }
	| { type: "r2_bucket"; name: string; bucket_name: string }
	| { type: "plain_text"; name: string; text: string }
	| { type: "secret_text"; name: string; text: string };

/**
 * One module file within a Worker bundle. Multi-module uploads send
 * each module as its own multipart form part — `name` becomes the
 * part name and `body` becomes the file content.
 *
 * `name` must be the module's filename relative to the bundle root
 * (e.g. `"entry.mjs"`, `"chunks/foo.mjs"`). Imports inside the
 * modules reference each other by these same names.
 */
export interface ScriptModule {
	name: string;
	body: string | Uint8Array;
	/**
	 * MIME type for the upload. Defaults to
	 * `"application/javascript+module"` (ESM). Use
	 * `"application/wasm"` for `.wasm` modules, `"text/javascript"` for
	 * service-worker-format scripts.
	 */
	contentType?: string;
}

export interface NamespaceScriptUploadInput {
	/** Dispatch namespace name (e.g. "skribb-tenants"). */
	namespace: string;
	/** Per-tenant script name (e.g. "skribb-cms-alice"). */
	scriptName: string;
	/**
	 * The compiled bundle as one or more modules. For Astro+Cloudflare
	 * builds processed through `wrangler deploy --dry-run --outdir`,
	 * this is ~270 ESM modules. Single-file Workers can pass a
	 * one-element array.
	 */
	modules: ScriptModule[];
	/**
	 * Name of the module to use as the script entry. Must be one of
	 * `modules[].name`. Embedded in the metadata as `main_module`.
	 */
	mainModule: string;
	/** Bindings injected at the script's `env`. */
	bindings: WorkerBinding[];
	/** Compatibility date (e.g. "2026-05-01"). */
	compatibilityDate: string;
	/** Compatibility flags (e.g. ["nodejs_compat"]). */
	compatibilityFlags?: string[];
	/**
	 * Optional tags — WfP uses these for fleet-wide management
	 * (filtering, bulk operations). Useful for things like
	 * "find all tenants pinned to EmDash 0.14".
	 */
	tags?: string[];
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

	// ── Workers for Platforms ────────────────────────────────────────────

	/**
	 * Create a dispatch namespace. One-time operator setup, not a
	 * per-tenant call. Exposed here so the platform's bootstrapping
	 * script (or onboarding admin tooling) can ensure idempotency
	 * without going through wrangler.
	 */
	createDispatchNamespace(name: string): Promise<DispatchNamespace> {
		return this.request<DispatchNamespace>(
			"POST",
			`/accounts/${this.accountId}/workers/dispatch/namespaces`,
			{
				body: JSON.stringify({ name }),
				headers: { "content-type": "application/json" },
			},
		);
	}

	/**
	 * Upload a user Worker into a dispatch namespace.
	 *
	 * Sends each module as its own multipart form part. Metadata
	 * declares `main_module` (one of the module names) plus bindings,
	 * compatibility settings, and optional tags. Caller is responsible
	 * for ensuring `mainModule` references a module present in
	 * `modules` — we validate that upfront with a clear error.
	 */
	async uploadNamespaceScript(input: NamespaceScriptUploadInput): Promise<null> {
		if (input.modules.length === 0) {
			throw new Error("uploadNamespaceScript: `modules` cannot be empty.");
		}
		const moduleNames = new Set(input.modules.map((m) => m.name));
		if (!moduleNames.has(input.mainModule)) {
			throw new Error(
				`uploadNamespaceScript: \`mainModule\` "${input.mainModule}" is not in the modules list (have: ${[...moduleNames].slice(0, 5).join(", ")}${moduleNames.size > 5 ? ", ..." : ""}).`,
			);
		}

		const form = new FormData();
		const metadata = {
			main_module: input.mainModule,
			compatibility_date: input.compatibilityDate,
			compatibility_flags: input.compatibilityFlags ?? [],
			bindings: input.bindings,
			...(input.tags ? { tags: input.tags } : {}),
		};
		form.append(
			"metadata",
			new Blob([JSON.stringify(metadata)], { type: "application/json" }),
		);
		for (const mod of input.modules) {
			const ct = mod.contentType ?? "application/javascript+module";
			// Cast through `BlobPart`: `Uint8Array<ArrayBufferLike>`
			// isn't assignable to `BlobPart` under strict TS even
			// though it's valid at runtime — the union of ArrayBuffer
			// and SharedArrayBuffer is the upstream type wart.
			form.append(
				mod.name,
				new Blob([mod.body as BlobPart], { type: ct }),
				mod.name,
			);
		}
		return this.request<null>(
			"PUT",
			`/accounts/${this.accountId}/workers/dispatch/namespaces/${encodeURIComponent(input.namespace)}/scripts/${encodeURIComponent(input.scriptName)}`,
			{ body: form },
		);
	}

	deleteNamespaceScript(input: { namespace: string; scriptName: string }): Promise<null> {
		return this.request<null>(
			"DELETE",
			`/accounts/${this.accountId}/workers/dispatch/namespaces/${encodeURIComponent(input.namespace)}/scripts/${encodeURIComponent(input.scriptName)}`,
		);
	}
}
