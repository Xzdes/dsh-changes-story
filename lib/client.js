/**
 * dsh-changes-story — web client half.
 *
 * Two contributions:
 *  - a "Story" button in the per-turn action strip
 *    (`conversation.chat.assistant-actions`, next to Copy/Like/Dislike) on
 *    every turn that has a story; clicking it opens the story window with
 *    that turn's story. The strip carries no turn number in props, so the
 *    button reads it from the enclosing [data-turn-tail] element;
 *  - the story window itself (`shell.overlay`), which also opens on its own
 *    when a turn produced a fresh story and `autoOpen` is on.
 *
 * The window polls the host's `api/changes-story.latest` route every few
 * seconds. The "open automatically" checkbox writes the host plugin's
 * volatile `autoOpen` Config field through the settings bridge
 * (`remote.settings`), so the preference applies live — no restart.
 *
 * Hand-written in the DSH lazy-CJS bundle format; no build step.
 */
window.__ModuleLoader__.load({
	id: "dsh-changes-story",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");

		/** Services this plugin touches — the fiber starts once all are active. */
		var inject = ["slots", "locale", "remote.settings"];

		/** Document-relative form of the host routes, like the changed-files card uses. */
		var LATEST_ROUTE = "api/changes-story.latest";
		var GET_ROUTE = "api/changes-story.get";
		var TURNS_ROUTE = "api/changes-story.turns";
		var SEEN_KEY = "dsh.changes-story.seen";
		var BOOT_KEY = "dsh.changes-story.boot";
		var POLL_MS = 3000;
		var TURNS_POLL_MS = 4000;

		var DICTS = {
			en: {
				title: "What changed, in plain words",
				button: "Story",
				buttonHint: "Open the plain-words story of the latest changes",
				close: "Close",
				done: "Got it",
				turn: "Step {turn}",
				fallback: "The model explanation was unavailable, so only the bare facts are shown.",
				more: "…and {count} more file(s) not listed here",
				empty: "No story for this file.",
				none: "No stories yet. They appear after a step that changed files.",
				autoOpen: "Open automatically"
			},
			ru: {
				title: "Что поменялось — простыми словами",
				button: "Рассказ",
				buttonHint: "Открыть рассказ о последних изменениях простыми словами",
				close: "Закрыть",
				done: "Понятно",
				turn: "Шаг {turn}",
				fallback: "Не удалось спросить модель, поэтому показаны только голые факты.",
				more: "…и ещё файлов: {count}",
				empty: "По этому файлу рассказа нет.",
				none: "Рассказов пока нет. Они появляются после шагов, где менялись файлы.",
				autoOpen: "Открывать автоматически"
			},
			zh: {
				title: "本次改动一览（通俗版）",
				button: "改动解读",
				buttonHint: "打开最近一次改动的通俗说明",
				close: "关闭",
				done: "知道了",
				turn: "第 {turn} 步",
				fallback: "模型解释不可用，只显示基本信息。",
				more: "……另外还有 {count} 个文件未列出",
				empty: "该文件没有说明。",
				none: "还没有解读。改动文件的步骤完成后会自动生成。",
				autoOpen: "自动打开"
			}
		};

		function readSeen() {
			try {
				var value = Number(window.localStorage.getItem(SEEN_KEY) || "0");
				return Number.isSafeInteger(value) ? value : 0;
			} catch (_) {
				return 0;
			}
		}
		function writeSeen(id) {
			try {
				window.localStorage.setItem(SEEN_KEY, String(id));
			} catch (_) {
				// Private mode: the window simply reopens next time.
			}
		}
		function readBoot() {
			try {
				return window.localStorage.getItem(BOOT_KEY) || "";
			} catch (_) {
				return "";
			}
		}
		function writeBoot(bootId) {
			try {
				window.localStorage.setItem(BOOT_KEY, bootId);
			} catch (_) {
				// Same private-mode shrug as writeSeen.
			}
		}

		function isStory(value) {
			if (typeof value !== "object" || value === null) return false;
			if (!Number.isSafeInteger(value.id) || value.id < 1) return false;
			if (typeof value.sessionId !== "string" || !Number.isSafeInteger(value.turn)) return false;
			if (!Array.isArray(value.files)) return false;
			return value.files.every(function (file) {
				return typeof file === "object" && file !== null &&
					typeof file.display === "string" &&
					Number.isSafeInteger(file.added) && Number.isSafeInteger(file.deleted) &&
					typeof file.story === "string";
			});
		}

		/** Unwrap the {ok, value} envelope that the Remote gateway returns. */
		function unwrapRemote(result) {
			if (result && typeof result === "object" && typeof result.value !== "undefined" && result.ok === true) return result.value;
			return result;
		}

		/** Find this plugin's namespace view in a settings describe() answer. */
		function findOwnNamespace(answer) {
			var inner = unwrapRemote(answer);
			var namespaces = inner && typeof inner === "object" && Array.isArray(inner.namespaces) ? inner.namespaces : (Array.isArray(inner) ? inner : undefined);
			if (!Array.isArray(namespaces)) return undefined;
			return namespaces.find(function (view) {
				return String(view && view.ns).indexOf("changes-story") !== -1;
			});
		}

		/** Minimal external store shared by the window and the composer button. */
		function createStore(initial) {
			var value = initial;
			var listeners = new Set();
			return {
				getSnapshot: function () { return value; },
				set: function (next) {
					value = next;
					listeners.forEach(function (listener) { listener(); });
				},
				update: function (patch) {
					value = Object.assign({}, value, patch);
					listeners.forEach(function (listener) { listener(); });
				},
				subscribe: function (listener) {
					listeners.add(listener);
					return function () { listeners.delete(listener); };
				}
			};
		}

		var styles = {
			overlay: {
				position: "fixed",
				inset: 0,
				zIndex: 10000,
				background: "rgba(0, 0, 0, 0.45)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				padding: "24px"
			},
			card: {
				background: "var(--dsw-alias-bg-layer-1, #20222a)",
				color: "var(--dsw-alias-label-primary, #e8e8e8)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35))",
				borderRadius: "12px",
				boxShadow: "0 16px 48px rgba(0,0,0,0.4)",
				width: "100%",
				maxWidth: "640px",
				maxHeight: "80vh",
				display: "flex",
				flexDirection: "column",
				overflow: "hidden"
			},
			header: {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: "12px",
				padding: "12px 16px",
				borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35))"
			},
			headerTitle: { margin: 0, fontSize: "15px", fontWeight: 600 },
			closeButton: {
				border: "none",
				background: "transparent",
				color: "inherit",
				fontSize: "18px",
				lineHeight: 1,
				cursor: "pointer",
				padding: "4px 8px",
				borderRadius: "6px",
				opacity: 0.7
			},
			body: { padding: "12px 16px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "12px" },
			storyTitle: { margin: 0, fontSize: "16px", fontWeight: 600 },
			meta: { opacity: 0.65, fontSize: "12px" },
			list: { display: "flex", flexDirection: "column", gap: "10px", margin: 0, padding: 0, listStyle: "none" },
			file: {
				border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35))",
				borderRadius: "8px",
				padding: "8px 12px"
			},
			name: { fontFamily: "monospace", fontSize: "13px", wordBreak: "break-all" },
			counts: { fontSize: "12px", marginLeft: "8px", whiteSpace: "nowrap" },
			plus: { color: "var(--dsw-alias-state-success-primary, #2da44e)" },
			minus: { color: "var(--dsw-alias-state-error-primary, #cf222e)" },
			storyText: { margin: "6px 0 0", fontSize: "14px", lineHeight: 1.5 },
			conclusion: { margin: 0, fontSize: "14px", lineHeight: 1.5, fontWeight: 500 },
			notice: { margin: 0, fontSize: "12px", opacity: 0.65 },
			emptyState: { margin: 0, fontSize: "14px", lineHeight: 1.5, opacity: 0.75 },
			footer: {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: "12px",
				padding: "12px 16px",
				borderTop: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35))"
			},
			checkboxLabel: { display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "13px", cursor: "pointer", opacity: 0.85 },
			doneButton: {
				border: "none",
				borderRadius: "8px",
				padding: "6px 16px",
				fontSize: "13px",
				fontWeight: 600,
				cursor: "pointer",
				background: "var(--dsw-alias-brand-primary, #4c6ef5)",
				color: "#fff"
			},
			tailButton: {
				display: "inline-flex",
				alignItems: "center",
				gap: "4px",
				font: "inherit",
				fontSize: "12px",
				lineHeight: "16px",
				padding: "2px 8px",
				borderRadius: "6px",
				cursor: "pointer",
				color: "inherit",
				whiteSpace: "nowrap",
				border: "none",
				background: "transparent",
				opacity: 0.85
			}
		};

		function FileRow(props) {
			var file = props.file;
			return React.createElement("li", { style: styles.file },
				React.createElement("div", null,
					React.createElement("span", { style: styles.name }, file.display),
					React.createElement("span", { style: styles.counts },
						React.createElement("span", { style: styles.plus }, "+" + file.added),
						" ",
						React.createElement("span", { style: styles.minus }, "-" + file.deleted)
					)
				),
				React.createElement("p", { style: styles.storyText }, file.story === "" ? props.t("empty") : file.story)
			);
		}

		function apply(ctx) {
			var slots = ctx.get("slots");
			var locale = ctx.get("locale");
			var settings = ctx.get("remote.settings");
			if (!slots) return;
			if (locale) {
				ctx.effect(function () {
					return locale.register("changes-story", DICTS);
				}, "changes-story: dictionaries");
			}
			var t = locale
				? locale.bind("changes-story")
				: function (key) { return (DICTS.en[key] || key); };
			function tt(key, params) {
				var text = String(t(key));
				if (params) for (var name in params) text = text.replace("{" + name + "}", String(params[name]));
				return text;
			}

			var store = createStore({ story: null, open: false, empty: false, autoOpen: true, settingsReady: false, revision: undefined, ns: undefined });

			var controller = {
				dismiss: function () {
					var current = store.getSnapshot();
					if (current.story) writeSeen(current.story.id);
					store.update({ open: false });
				},
				/** A turn-tail button: open the window with that turn's story. */
				openTurn: function (sessionId, turn) {
					fetch(GET_ROUTE + "?sessionId=" + encodeURIComponent(sessionId) + "&turn=" + turn).then(function (response) {
						if (!response.ok) return null;
						return response.json();
					}).then(function (value) {
						if (isStory(value)) {
							store.update({ story: value, open: true, empty: false });
							writeSeen(value.id);
						} else {
							store.update({ story: null, open: true, empty: true });
						}
					}).catch(function () {
						// Host unreachable: leave the window as it is.
					});
				},
				toggleAutoOpen: function (next) {
					var state = store.getSnapshot();
					store.update({ autoOpen: next });
					if (!settings || typeof settings.update !== "function" || !state.settingsReady || !state.ns) return;
					Promise.resolve(settings.update(state.ns, { autoOpen: next }, state.revision)).then(function (result) {
						var view = unwrapRemote(result);
						if (view && typeof view.revision !== "undefined") store.update({ revision: view.revision });
					}).catch(function () {
						store.update({ autoOpen: !next });
					});
				},
				poll: function () {
					return fetch(LATEST_ROUTE).then(function (response) {
						if (!response.ok) return null;
						return response.json();
					}).then(function (value) {
						if (!value || typeof value !== "object") return;
						var autoOpen = value.autoOpen !== false;
						if (!isStory(value)) {
							store.update({ autoOpen: autoOpen });
							return;
						}
						var current = store.getSnapshot();
						if (current.story && current.story.id === value.id) {
							store.update({ autoOpen: autoOpen });
							return;
						}
						// While the window is open (maybe on an older story the
						// reader picked from a turn tail) never swap its content.
						if (current.open) {
							store.update({ autoOpen: autoOpen });
							return;
						}
						// A host restart resets story ids to 1, so the persisted
						// "seen" marker would suppress everything new. Reset it
						// when the boot id changes; a restarted host has no
						// backlog, so the first story of a new boot IS fresh.
						var boot = typeof value.bootId === "string" ? value.bootId : "";
						var storedBoot = readBoot();
						var freshBoot = storedBoot !== "" && boot !== "" && boot !== storedBoot;
						if (boot !== "" && boot !== storedBoot) {
							writeBoot(boot);
							writeSeen(0);
						}
						var seen = readSeen();
						if (seen === 0 && !freshBoot) {
							// First run after install: never pop up an old story.
							writeSeen(value.id);
							store.update({ story: value, autoOpen: autoOpen });
							return;
						}
						var isNew = value.id > seen;
						if (isNew) writeSeen(value.id);
						store.update({
							story: value,
							open: isNew && autoOpen,
							autoOpen: autoOpen
						});
					}).catch(function () {
						// Offline or host busy: try again on the next tick.
					});
				}
			};

			// Poll the host for the newest story while this plugin lives.
			var pollTimer = setInterval(controller.poll, POLL_MS);
			controller.poll();
			ctx.effect(function () {
				return function () { clearInterval(pollTimer); };
			}, "changes-story: polling");

			// Track the live autoOpen preference through the settings bridge.
			if (settings && typeof settings.describe === "function") {
				var loadSettings = function () {
					Promise.resolve(settings.describe()).then(function (answer) {
						var view = findOwnNamespace(answer);
						if (!view) return;
						var value = (view && view.value) || {};
						var patch = { settingsReady: true, revision: view.revision, ns: String(view.ns) };
						if (typeof value.autoOpen === "boolean") patch.autoOpen = value.autoOpen;
						store.update(patch);
					}).catch(function () { /* bridge optional */ });
				};
				loadSettings();
				var settingsTimer = setInterval(loadSettings, 10000);
				ctx.effect(function () {
					return function () { clearInterval(settingsTimer); };
				}, "changes-story: settings");
			}

			// --- Which turns have stories (drives the tail buttons) -------------
			// One shared cache; each mounted tail button refcounts its session so
			// polling stops when nothing is visible anymore.
			var turnsStore = createStore({ v: 0 });
			var turnsData = new Map();
			var turnsRefs = new Map();
			var turnsTimer = null;
			function refreshTurns(sessionId) {
				return fetch(TURNS_ROUTE + "?sessionId=" + encodeURIComponent(sessionId)).then(function (response) {
					if (!response.ok) return null;
					return response.json();
				}).then(function (value) {
					if (!value || !Array.isArray(value.turns)) return;
					turnsData.set(sessionId, new Set(value.turns.filter(function (n) { return Number.isSafeInteger(n); })));
					turnsStore.update({ v: turnsStore.getSnapshot().v + 1 });
				}).catch(function () {
					// Try again on the next tick.
				});
			}
			function tickTurns() {
				turnsRefs.forEach(function (_, sessionId) { refreshTurns(sessionId); });
			}
			function subscribeTurns(sessionId, listener) {
				turnsRefs.set(sessionId, (turnsRefs.get(sessionId) || 0) + 1);
				var unsubscribe = turnsStore.subscribe(listener);
				if (turnsTimer === null) turnsTimer = setInterval(tickTurns, TURNS_POLL_MS);
				refreshTurns(sessionId);
				return function () {
					unsubscribe();
					var rest = (turnsRefs.get(sessionId) || 1) - 1;
					if (rest <= 0) {
						turnsRefs.delete(sessionId);
						turnsData.delete(sessionId);
					} else {
						turnsRefs.set(sessionId, rest);
					}
					if (turnsRefs.size === 0 && turnsTimer !== null) {
						clearInterval(turnsTimer);
						turnsTimer = null;
					}
				};
			}
			function hasTurnStory(sessionId, turn) {
				var set = turnsData.get(sessionId);
				return set !== undefined && set.has(turn);
			}
			ctx.effect(function () {
				return function () {
					if (turnsTimer !== null) clearInterval(turnsTimer);
				};
			}, "changes-story: turns polling");

			function StoryWindow() {
				var state = React.useSyncExternalStore(store.subscribe, store.getSnapshot);

				// Escape closes the window.
				React.useEffect(function () {
					if (!state.open) return undefined;
					function onKey(event) {
						if (event.key === "Escape") controller.dismiss();
					}
					window.addEventListener("keydown", onKey);
					return function () {
						window.removeEventListener("keydown", onKey);
					};
				}, [state.open]);

				if (!state.open) return null;
				var story = state.story;

				return React.createElement("div", {
					style: styles.overlay,
					onClick: controller.dismiss
				},
					React.createElement("div", {
						style: styles.card,
						role: "dialog",
						"aria-modal": "true",
						onClick: function (event) { event.stopPropagation(); }
					},
						React.createElement("div", { style: styles.header },
							React.createElement("h2", { style: styles.headerTitle }, t("title")),
							React.createElement("button", {
								type: "button",
								style: styles.closeButton,
								title: t("close"),
								"aria-label": t("close"),
								onClick: controller.dismiss
							}, "✕")
						),
						React.createElement("div", { style: styles.body },
							!story && React.createElement("p", { style: styles.emptyState }, t("none")),
							story && React.createElement("div", null,
								React.createElement("h3", { style: styles.storyTitle }, story.title || t("title")),
								React.createElement("div", { style: styles.meta }, tt("turn", { turn: story.turn }))
							),
							story && story.fallback === true && React.createElement("p", { style: styles.notice }, t("fallback")),
							story && React.createElement("ul", { style: styles.list },
								story.files.map(function (file) {
									return React.createElement(FileRow, { key: file.display, file: file, t: t });
								})
							),
							story && typeof story.extra === "number" && story.extra > 0 &&
								React.createElement("p", { style: styles.notice }, tt("more", { count: story.extra })),
							story && typeof story.conclusion === "string" && story.conclusion !== "" &&
								React.createElement("p", { style: styles.conclusion }, story.conclusion)
						),
						React.createElement("div", { style: styles.footer },
							React.createElement("label", { style: styles.checkboxLabel },
								React.createElement("input", {
									type: "checkbox",
									checked: state.autoOpen,
									onChange: function (event) { controller.toggleAutoOpen(event.target.checked); }
								}),
								t("autoOpen")
							),
							React.createElement("button", {
								type: "button",
								style: styles.doneButton,
								onClick: controller.dismiss
							}, t("done"))
						)
					)
				);
			}

			/** Action-strip button under a turn: opens that turn's story on demand. */
			function TurnStoryButton(props) {
				var sessionId = props.sessionId;
				var anchor = React.useRef(null);
				var turnState = React.useState(null);
				var turn = turnState[0];
				var setTurn = turnState[1];
				var force = React.useReducer(function (x) { return x + 1; }, 0)[1];
				React.useEffect(function () {
					if (typeof sessionId !== "string" || sessionId === "") return undefined;
					// The strip's props carry no turn number; the enclosing tail
					// element exposes it as a data attribute.
					var host = anchor.current && anchor.current.closest("[data-turn-tail]");
					if (host) {
						var value = Number(host.getAttribute("data-turn-tail"));
						if (Number.isSafeInteger(value)) setTurn(value);
					}
					return subscribeTurns(sessionId, force);
				}, [sessionId]);
				if (!Number.isSafeInteger(turn)) {
					// First render only exists to find the enclosing tail element.
					return React.createElement("span", { ref: anchor, style: { display: "none" } });
				}
				if (typeof sessionId !== "string" || !hasTurnStory(sessionId, turn)) return null;
				return React.createElement("button", {
					type: "button",
					onClick: function () { controller.openTurn(sessionId, turn); },
					title: t("buttonHint"),
					style: styles.tailButton
				}, "📖 " + t("button"));
			}

			ctx.slots.inject("shell.overlay", function () {
				return ctx.slots.register({
					name: "shell.overlay",
					id: "changes-story",
					label: function () { return t("title"); }
				}, StoryWindow);
			});
			ctx.slots.inject("conversation.chat.assistant-actions", function () {
				return ctx.slots.register({
					name: "conversation.chat.assistant-actions",
					id: "changes-story",
					order: 30,
					inject: function (sessionId) { return { sessionId: sessionId }; },
					label: function () { return t("button"); }
				}, TurnStoryButton);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
