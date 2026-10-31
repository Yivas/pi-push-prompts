/**
 * Test-only outbound boundary for Pi's built-in provider adapters.
 *
 * A session created through the public SDK does not expose the adapter's `fetch` option, and each
 * adapter falls back to `globalThis.fetch` when it builds its client. This module replaces that global
 * for the duration of a test, so the serialized JSON body each adapter sends is captured where it
 * leaves the process. Pi internals and provider code stay untouched.
 *
 * Every other URL or method fails closed and is recorded, so an unexpected outbound route fails the
 * test instead of reaching the network. A request without a string body throws without being recorded;
 * it is a harness error, not a routing decision.
 *
 * The OpenAI Responses and Google Generative AI routes and their minimal success streams were observed
 * against the real adapters in this harness, not assumed from their public docs.
 */

/** The exact route the built-in Anthropic Messages adapter uses for streaming requests (observed). */
export const SYNTHETIC_ANTHROPIC_URL = "https://api.anthropic.com/v1/messages?beta=true";
/** The exact route the built-in OpenAI Responses adapter uses (observed). */
export const SYNTHETIC_OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
/** The exact route shape the built-in Google Generative AI adapter uses (observed). */
export const SYNTHETIC_GOOGLE_URL_PATTERN =
	/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[^/]+:streamGenerateContent\?alt=sse$/;

export type SyntheticProvider = "anthropic" | "openai" | "google";
export const SYNTHETIC_REPLY_TEXT = "Synthetic reply from the fake transport.";

export interface CapturedRequest {
	readonly provider: SyntheticProvider;
	readonly method: string;
	readonly headers: Record<string, string>;
	readonly body: string;
}

export interface SyntheticTransport {
	readonly requests: readonly CapturedRequest[];
	/** Blocked routes seen so far; reading them clears the list, so a test can assert an expected block. */
	takeBlockedUrls(): string[];
	restore(): void;
}

export interface TransportOptions {
	/**
	 * Awaited after a request is recorded and before its synthetic response is returned. A test owns the
	 * promise, so the request can be held at the external boundary. Undefined means no hold.
	 */
	readonly beforeResponse?: (requestIndex: number) => Promise<void> | undefined;
	/**
	 * Test-owned response for a recorded request. Undefined keeps the default success stream for the
	 * provider, so a test can return a provider error for one attempt and let the next one succeed.
	 */
	readonly responseFor?: (requestIndex: number, request: CapturedRequest) => Response | undefined;
}

export function installSyntheticTransport(options: TransportOptions = {}): SyntheticTransport {
	const originalFetch = globalThis.fetch;
	const requests: CapturedRequest[] = [];
	const blockedUrls: string[] = [];

	const block = (url: string): never => {
		blockedUrls.push(url);
		throw new Error(`Blocked outbound request during harness test: ${url}`);
	};

	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const request = input instanceof Request ? input : undefined;
		const url = request?.url ?? String(input);
		const provider = providerFor(url);
		if (!provider) {
			return block(url);
		}

		const method = (request?.method ?? init?.method ?? "GET").toUpperCase();
		if (method !== "POST") {
			return block(`${method} ${url}`);
		}

		const body = typeof init?.body === "string" ? init.body : await request?.text();
		if (typeof body !== "string") {
			throw new Error("Expected the provider adapter to send a serialized string body");
		}

		const captured: CapturedRequest = {
			provider,
			method,
			headers: Object.fromEntries(new Headers(init?.headers ?? request?.headers)),
			body,
		};
		requests.push(captured);
		await options.beforeResponse?.(requests.length - 1);
		return options.responseFor?.(requests.length - 1, captured) ?? syntheticSuccessStream(provider);
	}) as typeof globalThis.fetch;

	return {
		requests,
		takeBlockedUrls() {
			return blockedUrls.splice(0);
		},
		restore() {
			globalThis.fetch = originalFetch;
		},
	};
}

function providerFor(url: string): SyntheticProvider | undefined {
	if (url === SYNTHETIC_ANTHROPIC_URL) {
		return "anthropic";
	}
	if (url === SYNTHETIC_OPENAI_RESPONSES_URL) {
		return "openai";
	}
	if (SYNTHETIC_GOOGLE_URL_PATTERN.test(url)) {
		return "google";
	}
	return undefined;
}

/** Provider error body shaped for the adapter that receives it. The status decides retry and overflow. */
export function syntheticErrorResponse(status: number, message: string): Response {
	return new Response(JSON.stringify({ type: "error", error: { type: "synthetic_error", message } }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** Minimal Anthropic Messages tool-call stream: one tool_use block with complete JSON input. */
export function syntheticAnthropicToolCallStream(toolCall: {
	readonly id: string;
	readonly name: string;
	readonly argumentsJson: string;
}): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_synthetic_tool_0001",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4-5",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: toolCall.id, name: toolCall.name, input: {} },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: toolCall.argumentsJson },
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "tool_use", stop_sequence: null },
			usage: { output_tokens: 1 },
		},
		{ type: "message_stop" },
	];
	return sseResponse(events);
}

function syntheticSuccessStream(provider: SyntheticProvider): Response {
	switch (provider) {
		case "anthropic":
			return syntheticAnthropicStream();
		case "openai":
			return syntheticOpenAIResponsesStream();
		case "google":
			return syntheticGoogleStream();
	}
}

/** Minimal Anthropic Messages event stream with one text block and a clean stop. */
function syntheticAnthropicStream(): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_synthetic_0001",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4-5",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: SYNTHETIC_REPLY_TEXT } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 1 },
		},
		{ type: "message_stop" },
	];
	return sseResponse(events);
}

/** Minimal OpenAI Responses event stream: one completed message with usage. */
function syntheticOpenAIResponsesStream(): Response {
	const messageId = "msg_synthetic_openai_0001";
	const events = [
		{
			type: "response.created",
			response: { id: "resp_synthetic_0001", status: "in_progress" },
		},
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { id: messageId, type: "message", role: "assistant", status: "in_progress", content: [] },
		},
		{
			type: "response.output_text.delta",
			output_index: 0,
			item_id: messageId,
			delta: SYNTHETIC_REPLY_TEXT,
		},
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				id: messageId,
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: SYNTHETIC_REPLY_TEXT }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_synthetic_0001",
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		},
	];
	return sseResponse(events);
}

/** Minimal Google Generative AI chunk stream: one text part and usage metadata. */
function syntheticGoogleStream(): Response {
	const chunk = {
		responseId: "google_synthetic_0001",
		candidates: [
			{
				content: { role: "model", parts: [{ text: SYNTHETIC_REPLY_TEXT }] },
				finishReason: "STOP",
			},
		],
		usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
	};
	return sseResponse([chunk], false);
}

/** Serializes events in the `event:` + `data:` frame shape the provider SDKs parse. */
function sseResponse(events: readonly object[], includeEventName = true): Response {
	const body = events
		.map((event) => {
			const name = "type" in event ? String(event.type) : "message";
			const data = `data: ${JSON.stringify(event)}\n\n`;
			return includeEventName ? `event: ${name}\n${data}` : data;
		})
		.join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
