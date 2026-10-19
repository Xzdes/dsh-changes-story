/**
 * dsh-changes-story — web client half.
 *
 * Polls the host's `api/changes-story.latest` route and, when a story with an
 * unseen id arrives, opens a separate window (a fixed overlay card on the
 * `shell.overlay` slot) that explains every changed file in plain words.
 * The "open automatically" checkbox writes the host plugin's volatile
 * `autoOpen` Config field through the settings bridge (`remote.settings`),
 * so the preference applies live — no restart.
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

		/** Document-relative form of the host route, like the changed-files card uses. */
		var LATEST_ROUTE = "api/changes-story.latest";
		var SEEN_KEY = "dsh.changes-story.seen";
		var POLL_MS = 3000;

		var DICTS = {
			en: {
				title: "What changed, in plain words",
				close: "Close",
				done: "Got it",
				turn: "Step {turn}",
				fallback: "The model explanation was unavailable, so only the bare facts are shown.",
				more: "…and {count} more file(s) not listed here",
				empty: "No story for this file.",
				autoOpen: "Open automatically"
			},
			ru: {
				title: "Что поменялось — простыми словами",
				close: "Закрыть",
				done: "Понятно",
				turn: "Шаг {turn}",
				fallback: "Не удалось спросить модель, поэтому показаны только голые факты.",
				more: "…и ещё файлов: {count}",
				empty: "По этому файлу рассказа нет.",
				autoOpen: "Открывать автоматически"
			},
			zh: {
				title: "本次改动一览（通俗版）",
				close: "关闭",
				done: "知道了",
				turn: "第 {turn} 步",
				fallback: "模型解释不可用，只显示基本信息。",
				more: "……另外还有 {count} 个文件未列出",
				empty: "该文件没有说明。",
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

			function StoryWindow() {
				var pair = React.useState({ phase: "idle", story: null, open: false, autoOpen: true, settingsReady: false, revision: undefined, ns: undefined });
				var state = pair[0];
				var setState = pair[1];
				var stateRef = React.useRef(state);
				stateRef.current = state;

				var dismiss = React.useCallback(function () {
					var current = stateRef.current;
					if (current.story) writeSeen(current.story.id);
					setState(function (prev) {
						return Object.assign({}, prev, { open: false });
					});
				}, []);

				// Poll the host for the newest story.
				React.useEffect(function () {
					var cancelled = false;
					var inFlight = false;
					function poll() {
						if (cancelled || inFlight) return;
						inFlight = true;
						fetch(LATEST_ROUTE).then(function (response) {
							if (!response.ok) return null;
							return response.json();
						}).then(function (value) {
							if (cancelled || !value || typeof value !== "object") return;
							var autoOpen = value.autoOpen !== false;
							if (!isStory(value)) {
								setState(function (prev) {
									return Object.assign({}, prev, { phase: "ready", autoOpen: autoOpen });
								});
								return;
							}
							var seen = readSeen();
							setState(function (prev) {
								if (prev.story && prev.story.id === value.id) {
									return Object.assign({}, prev, { phase: "ready", autoOpen: autoOpen });
								}
								if (seen === 0) {
									// First run after install: never pop up an old story.
									writeSeen(value.id);
									return Object.assign({}, prev, { phase: "ready", story: value, open: false, autoOpen: autoOpen });
								}
								var isNew = value.id > seen;
								if (isNew) writeSeen(value.id);
								return Object.assign({}, prev, {
									phase: "ready",
									story: value,
									open: isNew && autoOpen ? true : prev.open,
									autoOpen: autoOpen
								});
							});
						}).catch(function () {
							// Offline or host busy: try again on the next tick.
						}).finally(function () {
							inFlight = false;
						});
					}
					poll();
					var timer = setInterval(poll, POLL_MS);
					return function () {
						cancelled = true;
						clearInterval(timer);
					};
				}, []);

				// Read the live autoOpen preference through the settings bridge.
				React.useEffect(function () {
					if (!settings || typeof settings.describe !== "function") return undefined;
					var cancelled = false;
					function load() {
						Promise.resolve(settings.describe()).then(function (answer) {
							if (cancelled) return;
							var view = findOwnNamespace(answer);
							if (!view) return;
							var value = (view && view.value) || {};
							setState(function (prev) {
								return Object.assign({}, prev, {
									settingsReady: true,
									revision: view.revision,
									ns: String(view.ns),
									autoOpen: typeof value.autoOpen === "boolean" ? value.autoOpen : prev.autoOpen
								});
							});
						}).catch(function () { /* bridge optional */ });
					}
					load();
					var timer = setInterval(load, 10000);
					return function () {
						cancelled = true;
						clearInterval(timer);
					};
				}, []);

				// Escape closes the window.
				React.useEffect(function () {
					if (!state.open) return undefined;
					function onKey(event) {
						if (event.key === "Escape") dismiss();
					}
					window.addEventListener("keydown", onKey);
					return function () {
						window.removeEventListener("keydown", onKey);
					};
				}, [state.open, dismiss]);

				function toggleAutoOpen(event) {
					var next = event.target.checked;
					setState(function (prev) {
						return Object.assign({}, prev, { autoOpen: next });
					});
					if (!settings || typeof settings.update !== "function" || !state.settingsReady || !state.ns) return;
					Promise.resolve(settings.update(state.ns, { autoOpen: next }, state.revision)).then(function (result) {
						var view = findOwnNamespace({ namespaces: [unwrapRemote(result)] }) || unwrapRemote(result);
						if (view && typeof view.revision !== "undefined") {
							setState(function (prev) {
								return Object.assign({}, prev, { revision: view.revision });
							});
						}
					}).catch(function () {
						setState(function (prev) {
							return Object.assign({}, prev, { autoOpen: !next });
						});
					});
				}

				if (!state.open || !state.story) return null;
				var story = state.story;

				return React.createElement("div", {
					style: styles.overlay,
					onClick: dismiss
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
								onClick: dismiss
							}, "✕")
						),
						React.createElement("div", { style: styles.body },
							React.createElement("div", null,
								React.createElement("h3", { style: styles.storyTitle }, story.title || t("title")),
								React.createElement("div", { style: styles.meta }, tt("turn", { turn: story.turn }))
							),
							story.fallback === true && React.createElement("p", { style: styles.notice }, t("fallback")),
							React.createElement("ul", { style: styles.list },
								story.files.map(function (file) {
									return React.createElement(FileRow, { key: file.display, file: file, t: t });
								})
							),
							typeof story.extra === "number" && story.extra > 0 &&
								React.createElement("p", { style: styles.notice }, tt("more", { count: story.extra })),
							typeof story.conclusion === "string" && story.conclusion !== "" &&
								React.createElement("p", { style: styles.conclusion }, story.conclusion)
						),
						React.createElement("div", { style: styles.footer },
							React.createElement("label", { style: styles.checkboxLabel },
								React.createElement("input", {
									type: "checkbox",
									checked: state.autoOpen,
									onChange: toggleAutoOpen
								}),
								t("autoOpen")
							),
							React.createElement("button", {
								type: "button",
								style: styles.doneButton,
								onClick: dismiss
							}, t("done"))
						)
					)
				);
			}

			ctx.slots.inject("shell.overlay", function () {
				return ctx.slots.register({
					name: "shell.overlay",
					id: "changes-story",
					label: function () { return t("title"); }
				}, StoryWindow);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
