/**
 * Minimal Open WebUI HTTP client.
 *
 * Everything goes through the user's API key (`Authorization: Bearer sk-…`); Open
 * WebUI resolves the user from the key, so no user id header is needed.
 */
import type { Config } from "./config.ts";

export class OwuiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "OwuiError";
		this.status = status;
	}
}

export interface RequestOptions {
	query?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
	signal?: AbortSignal;
	timeoutMs?: number;
}

function describe(err: unknown): string {
	if (err instanceof Error) {
		if (err.name === "TimeoutError" || err.name === "AbortError") return "request aborted";
		const cause = (err as { cause?: { code?: string; message?: string } }).cause;
		return cause?.code || cause?.message || err.message;
	}
	return String(err);
}

/** Open WebUI returns `{detail: string}` or `{detail: [{msg, loc}]}` or plain text. */
function errorDetail(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	try {
		const parsed = JSON.parse(trimmed) as { detail?: unknown };
		const detail = parsed?.detail;
		if (typeof detail === "string") return detail;
		if (Array.isArray(detail)) {
			const parts = detail
				.map((entry) => {
					if (!entry || typeof entry !== "object") return String(entry);
					const { msg, loc } = entry as { msg?: string; loc?: unknown[] };
					return [Array.isArray(loc) ? loc.join(".") : "", msg].filter(Boolean).join(": ");
				})
				.filter(Boolean);
			if (parts.length) return parts.join("; ");
		}
	} catch {
		// Not JSON: fall through to the raw body.
	}
	return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

export class OwuiClient {
	private readonly config: Config;

	constructor(config: Config) {
		this.config = config;
	}

	private buildUrl(path: string, query?: RequestOptions["query"]): string {
		const url = new URL(this.config.baseUrl + path);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
		return url.toString();
	}

	async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
		const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
		const startedAt = Date.now();
		const signals = [AbortSignal.timeout(timeoutMs)];
		if (options.signal) signals.push(options.signal);

		let response: Response;
		try {
			response = await fetch(this.buildUrl(path, options.query), {
				method,
				headers: {
					Authorization: `Bearer ${this.config.apiKey}`,
					Accept: "application/json",
					...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
				signal: AbortSignal.any(signals),
			});
		} catch (err) {
			const elapsed = Date.now() - startedAt;
			if (options.signal?.aborted) throw new OwuiError(0, "cancelled");
			const reason =
				err instanceof Error && err.name === "AbortError"
					? `aborted after ${elapsed}ms (timeout budget ${timeoutMs}ms)`
					: `${describe(err)} after ${elapsed}ms`;
			throw new OwuiError(0, `cannot reach Open WebUI at ${this.config.baseUrl}: ${reason}`);
		}

		const body = await response.text();
		if (!response.ok) {
			const detail = errorDetail(body);
			const hint =
				response.status === 401
					? "OPENWEBUI_API_KEY was rejected"
					: response.status === 403
						? "the API key is not allowed to call this endpoint"
						: undefined;
			throw new OwuiError(
				response.status,
				[`${response.status} ${response.statusText}`.trim(), detail, hint].filter(Boolean).join(" — "),
			);
		}

		if (!body) return undefined as T;
		try {
			return JSON.parse(body) as T;
		} catch {
			return body as unknown as T;
		}
	}

	get<T>(path: string, options?: Omit<RequestOptions, "body">): Promise<T> {
		return this.request<T>("GET", path, options);
	}

	/** For endpoints that return a file body instead of JSON (e.g. skill files). */
	async getBytes(
		path: string,
		options?: Omit<RequestOptions, "body">,
	): Promise<{ contentType: string; bytes: Uint8Array }> {
		const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs;
		const signals = [AbortSignal.timeout(timeoutMs)];
		if (options?.signal) signals.push(options.signal);

		let response: Response;
		try {
			response = await fetch(this.buildUrl(path, options?.query), {
				method: "GET",
				headers: { Authorization: `Bearer ${this.config.apiKey}` },
				signal: AbortSignal.any(signals),
			});
		} catch (err) {
			if (options?.signal?.aborted) throw new OwuiError(0, "cancelled");
			throw new OwuiError(0, `cannot reach Open WebUI at ${this.config.baseUrl} (${describe(err)})`);
		}

		if (!response.ok) {
			const detail = errorDetail(await response.text().catch(() => ""));
			throw new OwuiError(
				response.status,
				[`${response.status} ${response.statusText}`.trim(), detail].filter(Boolean).join(" — "),
			);
		}
		return {
			contentType: response.headers.get("content-type") ?? "application/octet-stream",
			bytes: new Uint8Array(await response.arrayBuffer()),
		};
	}

	post<T>(path: string, body?: unknown, options?: Omit<RequestOptions, "body">): Promise<T> {
		return this.request<T>("POST", path, { ...options, body });
	}

	delete<T>(path: string, options?: Omit<RequestOptions, "body">): Promise<T> {
		return this.request<T>("DELETE", path, options);
	}
}
