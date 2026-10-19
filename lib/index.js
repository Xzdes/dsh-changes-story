/**
 * dsh-changes-story — host half.
 *
 * After a turn's file changes are recorded (the `workspace/changes` session
 * event appended by @deepseek-ai/dsh-workspace-changes), this plugin asks the
 * session's own model route for a short plain-language explanation of every
 * changed file and serves the newest story to the browser through one
 * authenticated GET route. The web client opens it in a separate window.
 *
 * Stories live in memory only, like the change summaries themselves: a host
 * restart forgets them. Subagent sessions never record changes, so they never
 * produce stories.
 *
 * `enabled`, `autoOpen`, and `language` are volatile Config fields: read them
 * through `.get()`; the loader commits live edits in place, so the client
 * toggle applies without a fiber restart.
 */
import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";

/** Cordis plugin name used by loader diagnostics. */
const name = "changes-story";

/** Services required: HTTP route fence, per-turn change summaries, model calls. */
const inject = ["connection", "workspaceChanges", "llm"];

/** Live-editable fields are volatile; limits and the route override are static. */
const Config = z.object({
	/** Master switch: no stories are generated while off. */
	enabled: z.boolean().default(true).volatile(),
	/** Whether the browser opens the story window on its own. */
	autoOpen: z.boolean().default(true).volatile(),
	/** Language the stories are written in ("ru", "en", ...). */
	language: z.string().default("ru").volatile(),
	/** Maximum files explained per turn; the rest is summarized as a count. */
	maxFiles: z.number().step(1).min(1).max(50).default(12),
	/** Diff characters per file handed to the model; 0 sends no diffs. */
	maxDiffChars: z.number().step(1).min(0).default(3000),
	/** Output token cap for the story request. */
	maxOutputTokens: z.number().step(1).min(128).default(1500),
	/** End-to-end deadline for one story generation. */
	timeoutMs: z.number().step(1).min(1000).default(90000),
	/** Explicit route override; without it the session's last route is used. */
	provider: z.string(),
	model: z.string()
});

/** Authenticated GET route serving the newest story (global or per session). */
const LATEST_PATH = "/api/changes-story.latest";
const GET_PATH = "/api/changes-story.get";
const TURNS_PATH = "/api/changes-story.turns";
/** Debounce between a changes event and the story request, so a turn-end re-record replaces the pending one. */
const DEBOUNCE_MS = 1500;

const SYSTEM_PROMPT = [
	"You explain code changes to a complete beginner who has never programmed.",
	"Given a JSON object with the files changed in one work turn (name, added/deleted line counts, diff excerpt), answer with ONE JSON object and nothing else — no Markdown, no code fences, no commentary:",
	'{"title": string, "files": [{"i": number, "story": string}], "conclusion": string}',
	"- title: 3-7 words naming what this turn did overall.",
	"- files: one entry per input file, i is the file's index. story is 1-2 short sentences: what this file is for and what changed in it, in everyday words. No jargon: say \"page\", \"button\", \"list\", \"settings\" instead of function or class names. Never quote code.",
	"- conclusion: one sentence on what the user can now see or do differently.",
	"Write every text in the language named by the input's \"language\" field.",
	"If a diff is empty, infer from the file name and line counts, and keep the story humble."
].join("\n");

/** Minimal user-message shape accepted by the LLM stream options. */
function userMessage(text) {
	return {
		role: "user",
		id: randomUUID(),
		content: [{ type: "text", text }],
		source: { kind: "dsh-changes-story" }
	};
}

/** Flatten a served comparison into compact +/- lines for the model. */
function renderDiff(diff) {
	const lines = [];
	for (const hunk of diff.hunks ?? []) {
		for (const line of hunk.lines ?? []) {
			if (line.startsWith("+") || line.startsWith("-")) lines.push(line);
		}
	}
	return lines.join("\n");
}

/** Take the first {...} span of the model output and validate the story shape. */
function parseStoryJson(text, count) {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	let value;
	try {
		value = JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null) return null;
	const title = typeof value.title === "string" && value.title.trim() !== "" ? value.title.trim() : null;
	const conclusion = typeof value.conclusion === "string" ? value.conclusion.trim() : "";
	const stories = new Map();
	if (Array.isArray(value.files)) {
		for (const item of value.files) {
			if (typeof item !== "object" || item === null) continue;
			if (!Number.isSafeInteger(item.i) || item.i < 0 || item.i >= count) continue;
			if (typeof item.story !== "string" || item.story.trim() === "") continue;
			stories.set(item.i, item.story.trim());
		}
	}
	if (title === null && stories.size === 0) return null;
	return { title: title ?? "", stories, conclusion };
}

/** Plain-facts fallback used when no model route is known or the request fails. */
function fallbackStory(entries, total) {
	return {
		title: null,
		conclusion: "",
		stories: new Map(entries.map((entry, index) => [
			index,
			`${entry.display}: +${entry.added} / -${entry.deleted}`
		])),
		fallback: true,
		extra: Math.max(0, total - entries.length)
	};
}

function apply(ctx, config) {
	/** Stories per session id: turn -> story (oldest turns trimmed past the cap). */
	const stories = new Map();
	/** Newest story overall. */
	let latest = null;
	let counter = 0;
	/** How many turns of stories one session keeps in memory. */
	const MAX_TURNS_PER_SESSION = 50;

	function rememberStory(sessionId, turn, story) {
		let byTurn = stories.get(sessionId);
		if (byTurn === undefined) {
			byTurn = new Map();
			stories.set(sessionId, byTurn);
		}
		byTurn.delete(turn);
		byTurn.set(turn, story);
		while (byTurn.size > MAX_TURNS_PER_SESSION) byTurn.delete(byTurn.keys().next().value);
		latest = story;
	}

	function latestOf(sessionId) {
		const byTurn = stories.get(sessionId);
		if (byTurn === undefined || byTurn.size === 0) return undefined;
		return byTurn.get([...byTurn.keys()].at(-1));
	}
	/** Last main-request route seen per session id. */
	const routes = new Map();
	/** Pending debounce timers per session:turn key. */
	const timers = new Map();
	/** In-flight generations per session:seq key. */
	const running = new Map();
	const lifetime = new AbortController();

	function resolveRoute(session) {
		if (config.provider !== undefined && config.model !== undefined) {
			return { provider: config.provider, model: config.model };
		}
		return routes.get(session.id);
	}

	async function writeStoryWithModel(session, turn, entries, signal) {
		const route = resolveRoute(session);
		if (route === undefined) return null;
		const input = JSON.stringify({
			language: config.language.get(),
			turn,
			files: entries.map((entry, index) => ({
				i: index,
				file: entry.display,
				added: entry.added,
				deleted: entry.deleted,
				diff: entry.diff
			}))
		});
		const call = await ctx.llm.prepareCall({ ...route, maxTokens: config.maxOutputTokens }, signal);
		const options = {
			...call.config,
			messages: [userMessage(input)],
			system: SYSTEM_PROMPT,
			sessionId: session.id,
			purpose: "changes-story",
			signal
		};
		let text = "";
		let finish;
		for await (const chunk of call.stream(options)) {
			signal.throwIfAborted();
			if (chunk.type === "text-delta") text += chunk.text;
			else if (chunk.type === "finish") finish = chunk.reason;
		}
		if (finish !== undefined && finish.kind !== "stop") return null;
		return parseStoryJson(text, entries.length);
	}

	async function generate(session, seq, turn) {
		const key = `${session.id}:${seq}`;
		if (running.has(key)) return running.get(key);
		const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(config.timeoutMs)]);
		const task = (async () => {
			const summary = ctx.workspaceChanges.summary(session.id, seq);
			if (summary === undefined || !Array.isArray(summary.files) || summary.files.length === 0) return;
			const listed = summary.files.slice(0, config.maxFiles);
			const entries = [];
			for (let index = 0; index < listed.length; index += 1) {
				const file = listed[index];
				let diffText = "";
				if (config.maxDiffChars > 0) {
					try {
						const diff = await ctx.workspaceChanges.diff(session.id, seq, index, signal);
						if (diff !== undefined && diff.kind === "text") diffText = renderDiff(diff).slice(0, config.maxDiffChars);
					} catch {
						// A missing comparison only shortens the model's context.
					}
				}
				entries.push({ display: file.display, added: file.added, deleted: file.deleted, diff: diffText });
			}
			signal.throwIfAborted();
			let parsed = null;
			try {
				parsed = await writeStoryWithModel(session, turn, entries, signal);
			} catch (error) {
				if (!signal.aborted) ctx.logger.warn(`changes-story: model request failed: ${error?.message ?? error}`);
			}
			const base = parsed ?? fallbackStory(entries, summary.total ?? summary.files.length);
			const story = {
				id: ++counter,
				sessionId: session.id,
				turn,
				seq,
				createdAt: new Date().toISOString(),
				title: base.title,
				conclusion: base.conclusion,
				fallback: base.fallback === true,
				extra: base.extra ?? Math.max(0, (summary.total ?? summary.files.length) - entries.length),
				files: entries.map((entry, index) => ({
					display: entry.display,
					added: entry.added,
					deleted: entry.deleted,
					story: base.stories.get(index) ?? ""
				}))
			};
			rememberStory(session.id, turn, story);
		})().catch((error) => {
			if (!signal.aborted) ctx.logger.warn(`changes-story: generation failed: ${error?.message ?? error}`);
		}).finally(() => {
			running.delete(key);
		});
		running.set(key, task);
		return task;
	}

	ctx.on("session/event", (session, event) => {
		if (event.type === "request/header") {
			const header = event.data?.header?.config;
			if (typeof header?.provider === "string" && typeof header?.model === "string") {
				routes.set(session.id, { provider: header.provider, model: header.model });
			}
			return;
		}
		if (event.type !== "workspace/changes") return;
		if (!config.enabled.get()) return;
		const turn = event.data?.turn;
		if (!Number.isSafeInteger(turn)) return;
		// Debounce per turn: a turn-end re-record replaces the pending request.
		const timerKey = `${session.id}:${turn}`;
		const previous = timers.get(timerKey);
		if (previous !== undefined) clearTimeout(previous);
		timers.set(timerKey, setTimeout(() => {
			timers.delete(timerKey);
			void generate(session, event.seq, turn);
		}, DEBOUNCE_MS));
	});

	ctx.on("session/disposed", (session) => {
		routes.delete(session.id);
		stories.delete(session.id);
	});

	ctx.connection.fetch.register({
		path: LATEST_PATH,
		methods: ["GET"],
		requestBody: "buffered",
		fetch: (request) => {
			const sessionId = new URL(request.url).searchParams.get("sessionId");
			const story = sessionId !== null && sessionId !== "" ? latestOf(sessionId) : latest;
			if (story === undefined || story === null) {
				return Promise.resolve(Response.json({ id: 0, autoOpen: config.autoOpen.get() }, { headers: { "cache-control": "no-store" } }));
			}
			return Promise.resolve(Response.json({ ...story, autoOpen: config.autoOpen.get() }, { headers: { "cache-control": "no-store" } }));
		}
	});

	ctx.connection.fetch.register({
		path: GET_PATH,
		methods: ["GET"],
		requestBody: "buffered",
		fetch: (request) => {
			const url = new URL(request.url);
			const sessionId = url.searchParams.get("sessionId");
			const turn = Number(url.searchParams.get("turn"));
			const story = sessionId !== null && Number.isSafeInteger(turn) ? stories.get(sessionId)?.get(turn) : undefined;
			if (story === undefined) {
				return Promise.resolve(Response.json({ id: 0 }, { headers: { "cache-control": "no-store" } }));
			}
			return Promise.resolve(Response.json(story, { headers: { "cache-control": "no-store" } }));
		}
	});

	ctx.connection.fetch.register({
		path: TURNS_PATH,
		methods: ["GET"],
		requestBody: "buffered",
		fetch: (request) => {
			const sessionId = new URL(request.url).searchParams.get("sessionId");
			const byTurn = sessionId !== null ? stories.get(sessionId) : undefined;
			const turns = byTurn === undefined ? [] : [...byTurn.keys()];
			return Promise.resolve(Response.json({ turns }, { headers: { "cache-control": "no-store" } }));
		}
	});

	ctx.effect(() => () => {
		lifetime.abort();
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
	});
}

export { Config, apply, inject, name };
