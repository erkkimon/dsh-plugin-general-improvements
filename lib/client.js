window.__ModuleLoader__.load({
	id: "dsh-plugin-general-improvements",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// dsh-plugin-general-improvements — Web client half.
		//
		// Improvement 1: sidebar attention marks.
		//   * red dot on a session row whose last turn ended badly (error /
		//     interrupted / blocked / max-tokens / non-user abort) — it never
		//     goes away by itself, only via the context menu ("Mark as cleared");
		//   * green dot for sessions the user marked unread by hand
		//     ("Mark as unread"), cleared when the session is opened again or
		//     via "Mark as read".
		// The shipped rows are not re-implemented: the plugin resolves each
		// rendered `[role=treeitem]` row back to its session id through the React
		// fiber props (fallback: title matching) and tags it with data
		// attributes; a small stylesheet draws the marks. The data comes from the
		// `improvementsAttention` session projection (live, on the session list
		// snapshot), the host route `/dsh-plugin-general-improvements/state` (cold sessions +
		// manual flags) and the `api-session/error` remote event (immediate).

		var ATTENTION_KEY = "improvementsAttention";
		var ROUTE = "/general-improvements";
		var ATTR = "data-dsh-imp";
		var CSS = [
			// The marked row hides the shipped status slot and draws its own mark in
			// front of the title, at the exact place the shipped dot sits.
			//
			// COLOUR IS NEVER THE ONLY SIGNAL. The two states differ by SHAPE
			// first — "!" in a ring for an error, a filled dot for unread — so
			// they stay distinguishable with any colour vision (the shipped
			// palette's error/success pair is red/green, the worst case). Colour
			// is a redundant second cue only, and every mark also carries a
			// `title` in words.
			'[role="treeitem"][' + ATTR + '] > [class*="_slot"]{display:none}',
			'[role="treeitem"][' + ATTR + '] > [class*="_title"]{margin-left:0!important}',
			'[role="treeitem"][' + ATTR + '] > [class*="_title"]::before{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:14px;height:14px;flex:none;margin:0 5px 0 1px;vertical-align:middle;position:relative;top:-1px;font-style:normal;font-variant:normal}',
			// Error: an exclamation mark inside a ring — a warning badge, legible
			// as a shape even in greyscale.
			'[role="treeitem"][' + ATTR + '="error"] > [class*="_title"]::before{content:"!";border:1.5px solid currentColor;border-radius:50%;font-size:10px;font-weight:700;line-height:1;letter-spacing:0;color:var(--dsw-alias-state-error-primary,#e5484d)}',
			// Unread: a plain filled dot, echoing the shipped "new message" dot.
			'[role="treeitem"][' + ATTR + '="unread"] > [class*="_title"]::before{content:"";border-radius:50%;background-image:radial-gradient(circle,currentColor 0 3.5px,transparent 3.5px);color:var(--dsw-alias-state-success-primary,#30a46c)}',
			// Context menu (mirrors the design tokens of the shipped menus).
			'.dshimp-menu{position:fixed;z-index:10000;min-width:180px;padding:4px;border-radius:8px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-elevated,#fff));border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.18));font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);user-select:none}',
			'.dshimp-menu-item{display:flex;align-items:center;gap:8px;padding:3px 7px;border-radius:5px;cursor:pointer;white-space:nowrap}',
			'.dshimp-menu-item:hover,.dshimp-menu-item:focus{background:var(--dsw-alias-interactive-bg-hover);outline:none}',
			'.dshimp-menu-item[aria-disabled="true"]{color:var(--dsw-alias-label-tertiary);cursor:default}',
			'.dshimp-menu-item[aria-disabled="true"]:hover{background:transparent}',
			// Menu glyphs carry the same shapes as the row marks, so the menu
			// teaches what the mark in the sidebar means.
			'.dshimp-menu-dot{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:14px;height:14px;flex:none;margin:0;font-size:10px;font-weight:700;line-height:1;font-style:normal}',
			'.dshimp-menu-dot.error{content:"";border:1.5px solid currentColor;border-radius:50%;color:var(--dsw-alias-state-error-primary,#e5484d)}',
			'.dshimp-menu-dot.error::before{content:"!"}',
			'.dshimp-menu-dot.unread{border-radius:50%;background-image:radial-gradient(circle,currentColor 0 3.5px,transparent 3.5px);color:var(--dsw-alias-state-success-primary,#30a46c)}',
			// "Clear it" / "mark read" actions: a struck-through ring, i.e. the
			// removal of a mark, again a shape rather than an absence of colour.
			'.dshimp-menu-dot.none{border:1.5px solid currentColor;border-radius:50%;color:var(--dsw-alias-label-tertiary);position:relative;overflow:hidden}',
			'.dshimp-menu-dot.none::after{content:"";position:absolute;left:-2px;right:-2px;top:50%;height:1.5px;background:currentColor;transform:rotate(-45deg)}',
			'.dshimp-menu-dot.blank{border:none;background:none}',
			// Screen-reader-only state text on a marked row.
			'[role="treeitem"] > .dshimp-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
			'.dshimp-menu-sep{height:1px;margin:4px 2px;background:var(--dsw-alias-border-l1,rgba(0,0,0,.08))}',
			'.dshimp-menu-info{padding:3px 7px;max-width:320px;white-space:normal;word-break:break-word;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px}'
		].join("\n");

		// ------------------------------------------------------------------
		// Helpers
		// ------------------------------------------------------------------

		function fiberOf(el) {
			for (var key in el) if (key.indexOf("__reactFiber$") === 0) return el[key];
			return null;
		}

		/** Session id of a rendered row, from the owning component's props. */
		function sessionIdFromFiber(row) {
			var fiber = fiberOf(row);
			var hops = 0;
			while (fiber && hops < 40) {
				var props = fiber.memoizedProps;
				if (props && typeof props === "object") {
					if (props.node && typeof props.node.id === "string") return props.node.id;
					if (props.result && typeof props.result.id === "string") return props.result.id;
				}
				fiber = fiber.return;
				hops++;
			}
			return null;
		}

		function isSessionRow(el) {
			if (!el || el.getAttribute("role") !== "treeitem") return false;
			var cls = typeof el.className === "string" ? el.className : "";
			return cls.indexOf("sessionRow") !== -1 || cls.indexOf("searchResultRow") !== -1;
		}

		function closestSessionRow(el) {
			while (el && el !== document.body) {
				if (el.nodeType === 1 && isSessionRow(el)) return el;
				el = el.parentNode;
			}
			return null;
		}

		function postJson(url, body) {
			return fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			}).then(function (res) {
				if (!res.ok) throw new Error("HTTP " + res.status);
				return res.json();
			});
		}

		// ------------------------------------------------------------------
		// Model
		// ------------------------------------------------------------------

		function createModel(ctx) {
			var flags = {};          // sessionId → { clearedSeq, clearedAt, unread }
			var coldAttention = {};  // sessionId → lastError (from the host route)
			var transient = {};      // sessionId → { message, at } (api-session/error before the projection lands)
			var listeners = [];
			var listSnapshot = null;

			function notify() {
				for (var i = 0; i < listeners.length; i++) listeners[i]();
			}

			function snapshot() {
				var store = ctx.sessions.list;
				listSnapshot = store.getSnapshot ? store.getSnapshot() : listSnapshot;
				return listSnapshot;
			}

			function rowOf(id) {
				var snap = listSnapshot || snapshot();
				return snap && snap.byId ? snap.byId[id] : undefined;
			}

			/** Newest known attention record for one session. */
			function attentionOf(id) {
				var row = rowOf(id);
				var live = row && row.projectionValues ? row.projectionValues[ATTENTION_KEY] : undefined;
				var lastError = live && live.lastError ? live.lastError : (coldAttention[id] || null);
				var t = transient[id];
				if (t && (!lastError || t.at > (lastError.time || 0))) {
					return { kind: "error", message: t.message, seq: Number.MAX_SAFE_INTEGER, time: t.at, transient: true };
				}
				return lastError;
			}

			function flagsOf(id) {
				return flags[id] || { clearedSeq: -1, clearedAt: 0, unread: false };
			}

			function errorShown(id) {
				var err = attentionOf(id);
				if (!err) return null;
				var f = flagsOf(id);
				if (err.transient) return err.time > f.clearedAt ? err : null;
				return err.seq > f.clearedSeq ? err : null;
			}

			/** What to draw for a row: "error" | "unread" | null (spinner/shipped state wins while running). */
			function markOf(id) {
				var row = rowOf(id);
				if (row && row.running) return null;
				if (errorShown(id)) return "error";
				if (flagsOf(id).unread) return "unread";
				return null;
			}

			var refreshTimer = null;
			function refresh() {
				return fetch(ROUTE + "/state", { cache: "no-store" }).then(function (res) {
					if (!res.ok) throw new Error("HTTP " + res.status);
					return res.json();
				}).then(function (data) {
					flags = data.flags || {};
					coldAttention = data.attention || {};
					// A transient mark is superseded once the durable projection carries it.
					for (var id in transient) {
						var row = rowOf(id);
						var live = row && row.projectionValues ? row.projectionValues[ATTENTION_KEY] : undefined;
						var durable = live && live.lastError ? live.lastError : coldAttention[id];
						if (durable && (durable.time || 0) >= transient[id].at - 5000) delete transient[id];
					}
					notify();
				}).catch(function (error) {
					console.warn("[dsh-plugin-general-improvements] state refresh failed:", error);
				});
			}
			function scheduleRefresh(delay) {
				if (refreshTimer !== null) clearTimeout(refreshTimer);
				refreshTimer = setTimeout(function () { refreshTimer = null; refresh(); }, delay);
			}

			function clearError(id) {
				var f = flagsOf(id);
				var err = attentionOf(id);
				flags[id] = { clearedSeq: err && !err.transient ? err.seq : f.clearedSeq, clearedAt: Date.now(), unread: f.unread };
				delete transient[id];
				notify();
				return postJson(ROUTE + "/flags/" + encodeURIComponent(id), { clear: true }).then(function (r) {
					if (r && r.flags) { flags[id] = r.flags; notify(); }
				}).catch(function (error) { console.warn("[dsh-plugin-general-improvements] clear failed:", error); });
			}

			function setUnread(id, unread) {
				var f = flagsOf(id);
				flags[id] = { clearedSeq: f.clearedSeq, clearedAt: f.clearedAt, unread: unread };
				notify();
				return postJson(ROUTE + "/flags/" + encodeURIComponent(id), { unread: unread }).then(function (r) {
					if (r && r.flags) { flags[id] = r.flags; notify(); }
				}).catch(function (error) { console.warn("[dsh-plugin-general-improvements] unread update failed:", error); });
			}

			function noteTransientError(id, message) {
				transient[id] = { message: typeof message === "string" ? message : String(message), at: Date.now() };
				notify();
				scheduleRefresh(1500);
			}

			return {
				subscribe: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (l) { return l !== fn; }); }; },
				snapshot: snapshot,
				rowOf: rowOf,
				markOf: markOf,
				errorShown: errorShown,
				flagsOf: flagsOf,
				refresh: refresh,
				scheduleRefresh: scheduleRefresh,
				clearError: clearError,
				setUnread: setUnread,
				noteTransientError: noteTransientError,
				dispose: function () { if (refreshTimer !== null) clearTimeout(refreshTimer); listeners = []; }
			};
		}

		// ------------------------------------------------------------------
		// DOM decoration
		// ------------------------------------------------------------------

		function createDecorator(model) {
			var raf = 0;

			function decorateRow(row) {
				var id = sessionIdFromFiber(row);
				if (id === null) return;
				row.setAttribute("data-dsh-imp-id", id);
				var mark = model.markOf(id);
				if (mark === null) {
					if (row.hasAttribute(ATTR)) row.removeAttribute(ATTR);
					if (row.hasAttribute("data-dsh-imp-label")) row.removeAttribute("data-dsh-imp-label");
					if (row.hasAttribute("data-dsh-imp-title")) { row.removeAttribute("title"); row.removeAttribute("data-dsh-imp-title"); }
					var stale = row.querySelector(":scope > .dshimp-sr");
					if (stale !== null) stale.remove();
					return;
				}
				if (row.getAttribute(ATTR) !== mark) row.setAttribute(ATTR, mark);
				// The state is always available as words too — a shape plus a
				// colour still fails a screen reader, and a tooltip is the one
				// place the full error text fits.
				var text;
				if (mark === "error") {
					var err = model.errorShown(id);
					text = "Failed: " + (err ? err.message : "") + "\n(right-click → Mark as cleared)";
				} else {
					text = "Marked unread\n(right-click → Mark as read)";
				}
				if (row.getAttribute("title") !== text) { row.setAttribute("title", text); row.setAttribute("data-dsh-imp-title", "1"); }
				var label = mark === "error" ? "failed" : "unread";
				if (row.getAttribute("data-dsh-imp-label") !== label) row.setAttribute("data-dsh-imp-label", label);
				// Announce the state to assistive tech, not just to the eye.
				var sr = row.querySelector(":scope > .dshimp-sr");
				if (sr === null) {
					sr = document.createElement("span");
					sr.className = "dshimp-sr";
					row.appendChild(sr);
				}
				var srText = mark === "error" ? "Session failed. " : "Marked unread. ";
				if (sr.textContent !== srText) sr.textContent = srText;
			}

			function decorateAll() {
				raf = 0;
				model.snapshot();
				var rows = document.querySelectorAll('[role="tree"] [role="treeitem"]');
				for (var i = 0; i < rows.length; i++) if (isSessionRow(rows[i])) decorateRow(rows[i]);
			}

			function schedule() {
				if (raf !== 0) return;
				raf = requestAnimationFrame(decorateAll);
			}

			/** True when a childList record is only our own screen-reader span. */
			function isOwnNodes(list) {
				for (var i = 0; i < list.length; i++) {
					var n = list[i];
					if (n.nodeType !== 1 || !n.classList || !n.classList.contains("dshimp-sr")) return false;
				}
				return list.length > 0;
			}

			var observer = new MutationObserver(function (records) {
				for (var i = 0; i < records.length; i++) {
					var r = records[i];
					// Ignore our own writes (otherwise decorating re-triggers this
					// observer and the rAF pass loops forever) and the menu itself.
					if (r.type === "attributes" && r.attributeName && r.attributeName.indexOf("data-dsh-imp") === 0) continue;
					if (r.type === "childList" && isOwnNodes(r.addedNodes) && r.removedNodes.length === 0) continue;
					if (r.type === "characterData" && r.target.parentNode && r.target.parentNode.classList && r.target.parentNode.classList.contains("dshimp-sr")) continue;
					if (r.target && r.target.nodeType === 1 && r.target.closest && r.target.closest(".dshimp-menu")) continue;
					schedule();
					return;
				}
			});
			observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "aria-selected"] });

			return {
				schedule: schedule,
				dispose: function () {
					observer.disconnect();
					if (raf !== 0) cancelAnimationFrame(raf);
					var rows = document.querySelectorAll("[" + ATTR + "],[data-dsh-imp-id]");
					for (var i = 0; i < rows.length; i++) {
						rows[i].removeAttribute(ATTR);
						rows[i].removeAttribute("data-dsh-imp-id");
						rows[i].removeAttribute("data-dsh-imp-label");
						if (rows[i].hasAttribute("data-dsh-imp-title")) { rows[i].removeAttribute("title"); rows[i].removeAttribute("data-dsh-imp-title"); }
					}
					var spans = document.querySelectorAll(".dshimp-sr");
					for (var j = 0; j < spans.length; j++) spans[j].remove();
				}
			};
		}

		// ------------------------------------------------------------------
		// Context menu
		// ------------------------------------------------------------------

		function createContextMenu(model, decorator) {
			var menu = null;

			function close() {
				if (menu === null) return;
				menu.remove();
				menu = null;
				document.removeEventListener("mousedown", onDocumentMouseDown, true);
				document.removeEventListener("keydown", onKeyDown, true);
				window.removeEventListener("blur", close);
				window.removeEventListener("resize", close);
				document.removeEventListener("scroll", close, true);
			}
			function onDocumentMouseDown(e) {
				if (menu !== null && !menu.contains(e.target)) close();
			}
			function onKeyDown(e) {
				if (e.key === "Escape") { e.preventDefault(); close(); }
			}

			function item(label, dotClass, onSelect, disabled) {
				var el = document.createElement("div");
				el.className = "dshimp-menu-item";
				el.setAttribute("role", "menuitem");
				el.tabIndex = disabled ? -1 : 0;
				if (disabled) el.setAttribute("aria-disabled", "true");
				var dot = document.createElement("span");
				dot.className = "dshimp-menu-dot " + dotClass;
				el.appendChild(dot);
				el.appendChild(document.createTextNode(label));
				if (!disabled) {
					var run = function (e) { e.preventDefault(); e.stopPropagation(); close(); onSelect(); };
					el.addEventListener("click", run);
					el.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") run(e); });
				}
				return el;
			}

			function open(id, x, y) {
				close();
				var err = model.errorShown(id);
				var unread = model.flagsOf(id).unread;
				var row = model.rowOf(id);

				menu = document.createElement("div");
				menu.className = "dshimp-menu";
				menu.setAttribute("role", "menu");

				if (err) {
					var info = document.createElement("div");
					info.className = "dshimp-menu-info";
					info.textContent = err.message;
					menu.appendChild(info);
				}
				menu.appendChild(item(
					err ? "Mark as cleared" : (row && row.running ? "Working — nothing to clear" : "No error to clear"),
					err ? "error" : "none",
					function () { model.clearError(id).then(decorator.schedule); },
					!err
				));
				menu.appendChild(item(
					unread ? "Mark as read" : "Mark as unread",
					unread ? "none" : "unread",
					function () { model.setUnread(id, !unread).then(decorator.schedule); }
				));
				var sep = document.createElement("div");
				sep.className = "dshimp-menu-sep";
				menu.appendChild(sep);
				menu.appendChild(item("Copy session id", "blank", function () {
					if (navigator.clipboard) navigator.clipboard.writeText(id).catch(function () {});
				}));

				document.body.appendChild(menu);
				// Keep it on screen.
				var rect = menu.getBoundingClientRect();
				var left = Math.min(x, window.innerWidth - rect.width - 8);
				var top = Math.min(y, window.innerHeight - rect.height - 8);
				menu.style.left = Math.max(4, left) + "px";
				menu.style.top = Math.max(4, top) + "px";

				document.addEventListener("mousedown", onDocumentMouseDown, true);
				document.addEventListener("keydown", onKeyDown, true);
				window.addEventListener("blur", close);
				window.addEventListener("resize", close);
				document.addEventListener("scroll", close, true);
				var first = menu.querySelector('.dshimp-menu-item:not([aria-disabled="true"])');
				if (first) first.focus();
			}

			function onContextMenu(e) {
				var row = closestSessionRow(e.target);
				if (row === null) return;
				var id = row.getAttribute("data-dsh-imp-id") || sessionIdFromFiber(row);
				if (id === null) return;
				e.preventDefault();
				e.stopPropagation();
				open(id, e.clientX, e.clientY);
			}
			document.addEventListener("contextmenu", onContextMenu, true);

			return {
				dispose: function () {
					close();
					document.removeEventListener("contextmenu", onContextMenu, true);
				}
			};
		}

		// ------------------------------------------------------------------
		// Plugin
		// ------------------------------------------------------------------

		// ------------------------------------------------------------------
		// Composer clipboard buttons (improvement 3): copy the whole draft,
		// paste from the clipboard without summoning the virtual keyboard.
		// ------------------------------------------------------------------

		var react = require("react");

		function ClipIcon(props) {
			var h = react.createElement;
			var paths;
			if (props.kind === "copy") {
				paths = [h("rect", { key: "a", x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.75 }), h("path", { key: "b", d: "M10.5 3.75v-.25a1.75 1.75 0 0 0-1.75-1.75h-4.5A1.75 1.75 0 0 0 2.5 3.5v4.5a1.75 1.75 0 0 0 1.75 1.75h.25" })];
			} else if (props.kind === "paste") {
				paths = [h("rect", { key: "a", x: 3, y: 3, width: 10, height: 11, rx: 1.75 }), h("path", { key: "b", d: "M6 3V2.5A.75.75 0 0 1 6.75 1.75h2.5A.75.75 0 0 1 10 2.5V3M6 8.25h4M6 10.75h2.5" })];
			} else if (props.kind === "ok") {
				paths = [h("path", { key: "a", d: "m3.25 8.5 3 3 6.5-7" })];
			} else {
				paths = [h("path", { key: "a", d: "m4 4 8 8M12 4l-8 8" })];
			}
			return h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, paths);
		}

		/** Legacy copy for non-secure contexts (plain-HTTP LAN access has no navigator.clipboard). */
		function legacyCopy(text) {
			var area = document.createElement("textarea");
			area.value = text;
			area.setAttribute("readonly", "");
			area.setAttribute("inputmode", "none");
			area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
			var previous = document.activeElement;
			document.body.appendChild(area);
			area.select();
			var ok = false;
			try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
			area.remove();
			if (previous && typeof previous.focus === "function" && previous !== document.body) {
				try { previous.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
			}
			return ok;
		}

		function copyText(text) {
			if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
				return navigator.clipboard.writeText(text).catch(function () {
					if (!legacyCopy(text)) throw new Error("copy blocked");
				});
			}
			return legacyCopy(text) ? Promise.resolve() : Promise.reject(new Error("copy unavailable"));
		}

		function ClipButton(props) {
			var buttonRef = props.buttonRef || react.useRef(null);
			var pair = react.useState("");
			var className = pair[0];
			var setClassName = pair[1];
			// Borrow the composer "+" button's class so the theme matches (hashed CSS modules).
			react.useLayoutEffect(function () {
				var button = buttonRef.current;
				var tools = button && button.closest("[data-composer-card]");
				var sibling = tools && tools.querySelector('button[aria-haspopup="listbox"]');
				if (sibling) setClassName(sibling.className);
			}, []);
			var label = props.state === "err" ? props.errorText : props.label;
			return react.createElement("button", {
				ref: buttonRef,
				type: "button",
				className: className,
				"aria-label": props.label,
				title: label,
				disabled: props.disabled,
				// Never take focus: a focus move on the editor is what raises the phone keyboard.
				onPointerDown: function (event) { event.preventDefault(); },
				onMouseDown: function (event) { event.preventDefault(); },
				onClick: props.onClick
			}, react.createElement(ClipIcon, { kind: props.state === "ok" ? "ok" : props.state === "err" ? "err" : props.icon }));
		}

		/**
		 * Run a draft write without letting the editor raise the phone keyboard.
		 * Lexical focuses the editor when the document is rewritten; a focused
		 * editable with inputmode!="none" summons the virtual keyboard. So: park
		 * inputmode at "none" for the write, and drop focus again if the editor
		 * was not focused before. Focus, if it was already there, stays.
		 */
		function writeWithoutKeyboard(anchor, write) {
			var card = anchor && anchor.closest("[data-composer-card]");
			var editor = card && card.querySelector('[contenteditable="true"]');
			if (!editor) { write(); return; }
			var wasFocused = document.activeElement === editor;
			var previous = editor.getAttribute("inputmode");
			editor.setAttribute("inputmode", "none");
			write();
			setTimeout(function () {
				if (!wasFocused && document.activeElement === editor) editor.blur();
				if (previous === null) editor.removeAttribute("inputmode");
				else editor.setAttribute("inputmode", previous);
			}, 60);
		}

		function ClipboardButtons(props) {
			var draft = props.useInput(function (s) { return s.draft; });
			var draftRef = react.useRef(draft);
			draftRef.current = draft;
			var actionsRef = react.useRef(props.inputActions);
			actionsRef.current = props.inputActions;
			var copyPair = react.useState("");
			var pastePair = react.useState("");
			var errPair = react.useState("");
			var timerRef = react.useRef(null);
			var pasteButtonRef = react.useRef(null);
			function buttonRefOf() { return pasteButtonRef.current; }
			react.useEffect(function () { return function () { clearTimeout(timerRef.current); }; }, []);

			function flash(setter, state, message) {
				setter(state);
				errPair[1](message || "");
				clearTimeout(timerRef.current);
				timerRef.current = setTimeout(function () { copyPair[1](""); pastePair[1](""); errPair[1](""); }, 1600);
			}

			function onCopy() {
				var text = draftRef.current;
				if (!text) return;
				copyText(text).then(
					function () { flash(copyPair[1], "ok"); },
					function () { flash(copyPair[1], "err", "Copy blocked by the browser"); }
				);
			}

			function onPaste() {
				var api = navigator.clipboard;
				if (!api || typeof api.readText !== "function") {
					flash(pastePair[1], "err", "Paste needs HTTPS (secure context)");
					return;
				}
				api.readText().then(function (text) {
					if (!text) { flash(pastePair[1], "err", "Clipboard is empty"); return; }
					// setDraft rewrites the editor document without focusing it, so the keyboard stays down.
					// The clipboard text lands at the end of the draft.
					var current = draftRef.current || "";
					writeWithoutKeyboard(buttonRefOf(), function () { actionsRef.current.setDraft(current + text); });
					flash(pastePair[1], "ok");
				}, function () {
					flash(pastePair[1], "err", "Clipboard access denied");
				});
			}

			return react.createElement(react.Fragment, null,
				react.createElement(LocationButton, null),
				react.createElement(ClipButton, { icon: "copy", label: "Copy message", state: copyPair[0], errorText: errPair[0], disabled: !draft, onClick: onCopy }),
				react.createElement(ClipButton, { buttonRef: pasteButtonRef, icon: "paste", label: "Paste from clipboard", state: pastePair[0], errorText: errPair[0], disabled: false, onClick: onPaste })
			);
		}


		// ------------------------------------------------------------------
		// Location sharing (improvement 4). OPT-IN: a browser only reports
		// coordinates after the user turns the pin button on AND grants the
		// browser's own permission prompt. The report goes to this DSH host
		// only; the host adds it to the model's context.
		// ------------------------------------------------------------------

		var LOC_KEY = "dsh-general-improvements-share-location";
		var LOC_EVERY_MS = 5 * 60 * 1000;
		var locListeners = [];
		var locState = { on: false, status: "off", detail: "" }; // status: off | pending | ok | err

		// A phone has no hover, so a tooltip is invisible: say what happened
		// in a short-lived banner as well.
		function toast(text, isError) {
			var el = document.createElement("div");
			el.setAttribute("role", isError ? "alert" : "status");
			el.style.cssText = "position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 96px);transform:translateX(-50%);width:max-content;max-width:88vw;box-sizing:border-box;padding:10px 14px;border-radius:12px;font:14px/1.35 system-ui,sans-serif;z-index:2147483647;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.3);background:" + (isError ? "#b3261e" : "#1a7f37");
			var body = document.createElement("div");
			body.textContent = text;
			body.style.cssText = "user-select:text;-webkit-user-select:text;word-break:break-word";
			el.appendChild(body);
			if (isError) {
				// Errors are hard to retype or dictate on a phone: always copyable.
				var row = document.createElement("div");
				row.style.cssText = "display:flex;gap:8px;margin-top:8px;justify-content:flex-end";
				var mk = function (label, fn) {
					var b = document.createElement("button");
					b.type = "button";
					b.textContent = label;
					b.style.cssText = "font:inherit;font-weight:600;padding:5px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.7);background:transparent;color:#fff";
					b.addEventListener("click", fn);
					return b;
				};
				var copyBtn = mk("Copy", function () {
					copyText(text).then(function () { copyBtn.textContent = "Copied"; }, function () { copyBtn.textContent = "Copy failed"; });
				});
				row.appendChild(copyBtn);
				row.appendChild(mk("Close", function () { el.remove(); }));
				el.appendChild(row);
			}
			document.body.appendChild(el);
			setTimeout(function () { if (el.isConnected) el.remove(); }, isError ? 60000 : 2500);
		}

		function locSet(patch) {
			if (patch.status === "err" && patch.detail) toast(patch.detail, true);
			// Success toast is off (noise once the feature works). Uncomment to debug:
			// if (patch.status === "ok" && patch.detail && locState.status !== "ok") toast(patch.detail, false);
			for (var k in patch) locState[k] = patch[k];
			locListeners.slice().forEach(function (fn) { fn(); });
		}

		function locReport(fromGesture) {
			if (!navigator.geolocation) {
				locSet({ status: "err", detail: "This browser has no geolocation" });
				return Promise.resolve();
			}
			locSet({ status: "pending", detail: "" });
			return new Promise(function (resolve) {
				navigator.geolocation.getCurrentPosition(function (pos) {
					var c = pos.coords;
					var conn = navigator.connection || {};
					postJson(ROUTE + "/context", {
						lat: c.latitude,
						lon: c.longitude,
						accuracy: c.accuracy,
						network: { type: conn.type || null, effectiveType: conn.effectiveType || null },
						device: window.matchMedia && window.matchMedia("(pointer: coarse)").matches ? "mobile" : "desktop"
					}).then(function () {
						locSet({ status: "ok", detail: "Location shared (\u00b1" + Math.round(c.accuracy) + " m)" });
					}, function (e) {
						locSet({ status: "err", detail: "Host refused the location: " + e.message });
					}).then(resolve);
				}, function (err) {
					var denied = err && err.code === 1;
					if (denied) {
						try { localStorage.removeItem(LOC_KEY); } catch (_) { /* ignore */ }
						// Ask the browser WHICH layer said no, instead of guessing.
						var policy = document.featurePolicy || document.permissionsPolicy;
						var policyAllows = policy && policy.allowsFeature ? policy.allowsFeature("geolocation") : null;
						var permQuery = navigator.permissions && navigator.permissions.query
							? navigator.permissions.query({ name: "geolocation" }).then(function (p) { return p.state; }, function () { return "unknown"; })
							: Promise.resolve("unknown");
						permQuery.then(function (perm) {
							var framed = window.self !== window.top;
							var diag = " [secure=" + window.isSecureContext + ", framed=" + framed + ", policy=" + policyAllows + ", permission=" + perm + "]";
							var why;
							if (!window.isSecureContext) why = "Location needs HTTPS (secure context).";
							else if (policyAllows === false) why = "Location blocked: this page is framed without geolocation permission. Reload the app fully or update Multi-DSH.";
							else if (perm === "denied") why = "Location blocked for this site. Allow it in Chrome/Android site settings, and check the phone's location switch is on.";
							else why = "Location was refused.";
							locSet({ on: false, status: "err", detail: why + diag });
						});
						return resolve();
					} else if (err && err.code === 2) {
						locSet({ on: false, status: "err", detail: "No position available (is the phone's location switched on?)" });
					} else {
						locSet({ on: false, status: "err", detail: "Timed out waiting for a position" });
					}
					resolve();
				}, { enableHighAccuracy: false, timeout: 20000, maximumAge: LOC_EVERY_MS / 2 });
			});
		}

		function locEnable() {
			try { localStorage.setItem(LOC_KEY, "1"); } catch (_) { /* ignore */ }
			locSet({ on: true });
			return locReport(true);
		}

		function locDisable() {
			try { localStorage.removeItem(LOC_KEY); } catch (_) { /* ignore */ }
			locSet({ on: false, status: "off", detail: "" });
			return postJson(ROUTE + "/context", { clear: true }).catch(function () { /* host gone: nothing to clear */ });
		}

		/** Background refresh while enabled; returns a disposer. */
		function locStart() {
			var enabled = false;
			try { enabled = localStorage.getItem(LOC_KEY) === "1"; } catch (_) { /* ignore */ }
			if (enabled) { locSet({ on: true }); locReport(false); }
			var timer = setInterval(function () { if (locState.on && document.visibilityState === "visible") locReport(false); }, LOC_EVERY_MS);
			var onVisible = function () { if (locState.on && document.visibilityState === "visible") locReport(false); };
			document.addEventListener("visibilitychange", onVisible);
			return function () { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
		}

		function PinIcon() {
			var h = react.createElement;
			return h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
				h("path", { d: "M8 14.25s4.5-4.1 4.5-7.75a4.5 4.5 0 0 0-9 0C3.5 10.15 8 14.25 8 14.25z" }),
				h("circle", { cx: 8, cy: 6.5, r: 1.6 }));
		}

		function LocationButton() {
			var tick = react.useState(0);
			react.useEffect(function () {
				var fn = function () { tick[1](function (n) { return n + 1; }); };
				locListeners.push(fn);
				return function () { locListeners = locListeners.filter(function (f) { return f !== fn; }); };
			}, []);
			var on = locState.on;
			var title = on
				? "Sharing your location with the agent (click to stop). " + locState.detail
				: "Share my location with the agent" + (locState.detail ? " \u2014 " + locState.detail : "");
			var buttonRef = react.useRef(null);
			var pair = react.useState("");
			react.useLayoutEffect(function () {
				var button = buttonRef.current;
				var card = button && button.closest("[data-composer-card]");
				var sibling = card && card.querySelector('button[aria-haspopup="listbox"]');
				if (sibling) pair[1](sibling.className);
			}, []);
			return react.createElement("button", {
				ref: buttonRef,
				type: "button",
				className: pair[0],
				"aria-label": "Share location with the agent",
				"aria-pressed": on,
				title: title,
				style: on ? { color: locState.status === "err" ? "#c0392b" : "#1a7f37" } : undefined,
				onPointerDown: function (e) { e.preventDefault(); },
				onMouseDown: function (e) { e.preventDefault(); },
				onClick: function () { if (on) locDisable(); else locEnable(); }
			}, react.createElement(PinIcon, null));
		}

		function apply(ctx) {
			ctx.effect(function () { return locStart(); });
			ctx.slots.inject("conversation.input.left", function* () {
				yield ctx.slots.register({ name: "conversation.input.left", id: "general-improvements-clipboard", order: 50 }, ClipboardButtons);
			});
			ctx.effect(function () {
				var style = document.createElement("style");
				style.setAttribute("data-dsh-plugin-general-improvements", "");
				style.textContent = CSS;
				document.head.appendChild(style);
				return function () { style.remove(); };
			});

			ctx.effect(function () {
				var model = createModel(ctx);
				var decorator = createDecorator(model);
				var menu = createContextMenu(model, decorator);
				var disposers = [];

				disposers.push(model.subscribe(decorator.schedule));

				// List snapshot changes (projection frames, running flips, new rows).
				var store = ctx.sessions.list;
				var lastCurrent;
				var knownIds = "";
				var initialised = false;
				var onList = function () {
					var snap = model.snapshot();
					if (snap) {
						// Opening a session reads it: drop a manual unread mark on that transition.
						if (initialised && snap.current && snap.current !== lastCurrent && model.flagsOf(snap.current).unread) {
							model.setUnread(snap.current, false);
						}
						lastCurrent = snap.current;
						initialised = true;
						var ids = snap.ids ? snap.ids.join("\n") : "";
						if (ids !== knownIds) {
							knownIds = ids;
							model.scheduleRefresh(500);
						}
					}
					decorator.schedule();
				};
				if (store && typeof store.subscribe === "function") disposers.push(store.subscribe(onList));
				onList();

				// Immediate mark on a live error, before its turn/end reaches the wire.
				if (ctx.remote && typeof ctx.remote.$on === "function") {
					var off = ctx.remote.$on("api-session/error", function (sessionId, message) {
						model.noteTransientError(sessionId, message);
					});
					if (typeof off === "function") disposers.push(off);
				}

				var onVisible = function () { if (document.visibilityState === "visible") model.scheduleRefresh(200); };
				document.addEventListener("visibilitychange", onVisible);

				model.refresh();

				return function () {
					document.removeEventListener("visibilitychange", onVisible);
					for (var i = disposers.length - 1; i >= 0; i--) { try { disposers[i](); } catch (_) { /* ignore */ } }
					menu.dispose();
					decorator.dispose();
					model.dispose();
				};
			});
		}

		exports.apply = apply;
		exports.inject = ["sessions", "remote", "slots"];
		return module.exports;
	}
});
