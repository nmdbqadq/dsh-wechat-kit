/**
 * dsh-wechat-groupchat — Cordis host plugin entry.
 *
 * Loaded through the bundle's `cordis.patch.yml`. The plugin owns one WeChat
 * (iLink) bot account, one long-poll loop, and one DSH session per WeChat
 * conversation. It talks to the Host only through `ctx.get(...)` service
 * lookups and `ctx.on(...)` events, so it carries no runtime dependency on
 * `@deepseek-ai/*` packages.
 *
 * Surfaces it adds:
 *   - `/wechat-group/`                the control page (status, QR, rules)
 *   - `/wechat-group/api/status`      JSON status
 *   - `/wechat-group/api/config`      POST a config patch
 *   - `/wechat-group/api/relogin`     POST, start a fresh QR login
 *   - `/wechat-group/api/logout`      POST, drop the token
 *   - `/wechat-group/qr.png|.svg`     the current login code
 *
 * The page is a standalone document, not an iframe inside the DSH shell: it is
 * opened in its own tab, so it cannot borrow the shell's theme and carries its
 * own light/dark styling.
 *
 * Reloads are handled through `live`: a Host that swaps the plugin (HMR, or the
 * bundle being toggled) leaves the earlier HTTP registrations in place until its
 * fiber finishes tearing down, so handlers read the current bridge instead of
 * closing over the one that created them. A previous instance is also stopped
 * explicitly — two long-poll loops against one bot token would steal each
 * other's messages.
 */
import { WeChatBridge } from "./src/bridge.js";
import { normalizeConfig, storageDirFor } from "./src/config.js";
import { Store } from "./src/store.js";
import { renderPage } from "./src/page.js";
import { qrPng, qrSvg } from "./src/qr-png.js";

export const name = "dsh-wechat-groupchat";
export const inject = [];

/**
 * Process-wide control surface shared by every generation of this module.
 *
 * A reload (HMR, or the bundle being toggled) evaluates this file again, so a
 * module-level variable would start empty while the previous generation's HTTP
 * routes are still registered and still point at the previous bridge — the page
 * then reports a dead instance while a live one polls. Anchoring the same object
 * on `globalThis` keeps both facts singular: `bridge` is always the newest
 * instance, and `routes` holds the disposers needed to take the paths over
 * cleanly instead of colliding with them.
 *
 * `webserver.register` throws on a duplicate (kind, path) and returns a disposer;
 * a generation that never recorded its disposers (any build without this file)
 * leaves the path occupied, so the takeover path below also reclaims our own
 * paths from the registry's tables.
 */
const CONTROL = Symbol.for("dsh-wechat-groupchat.control");
const control = globalThis[CONTROL] ??= { bridge: undefined, routes: [] };

/** The session id of whatever the Host handed us (session object or agent). */
function sessionIdFrom(value) {
    if (!value || typeof value !== "object") return undefined;
    for (const candidate of [value.id, value.header?.id, value.session?.header?.id, value.session?.id]) {
        if (typeof candidate === "string" && candidate !== "") return candidate;
    }
    return undefined;
}

function sendJson(res, statusCode, value) {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(value));
}

async function readJsonBody(req) {
    if (req.body !== undefined && req.body !== null && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
        return req.body;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > 256 * 1024) throw new Error("请求体过大");
        chunks.push(buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (text === "") return {};
    return JSON.parse(text);
}

/** Register one route, taking the path over from an earlier generation if needed. */
function registerRoute(webServer, log, route) {
    try {
        control.routes.push(webServer.register(route));
        return;
    }
    catch (error) {
        const table = route.kind === "exact" ? webServer.exact : webServer.prefixes;
        if (table && typeof table.delete === "function" && table.has(route.path)) {
            table.delete(route.path);
            try {
                control.routes.push(webServer.register(route));
                log(`took over ${route.path} from an earlier instance`);
                return;
            }
            catch (retryError) {
                log(`registering ${route.path} failed: ${String(retryError)}`);
                return;
            }
        }
        log(`registering ${route.path} failed: ${String(error)}`);
    }
}

export function apply(ctx, rawConfig = {}) {
    const rowConfig = normalizeConfig(rawConfig);
    // The storage directory is deliberately not page-editable: it is where the
    // token lives, so it belongs to the patch layer only.
    const storageDir = storageDirFor(rowConfig);
    const store = new Store(storageDir);
    const config = normalizeConfig({ ...rowConfig, ...store.readConfig() });
    const bridge = new WeChatBridge(ctx, config, store, storageDir);
    const previous = control.bridge;
    control.bridge = bridge;
    if (previous !== undefined && previous !== bridge) {
        void Promise.resolve(previous.stop()).catch(() => {});
    }
    // Release the previous generation's paths before claiming them again, so a
    // reload never has to fight its own predecessor for a route.
    for (const dispose of control.routes.splice(0)) {
        try {
            dispose();
        }
        catch {
            // The old table is gone with its own service; nothing to release.
        }
    }
    const log = (line) => bridge.log(line);

    // ── Assistant output → WeChat ──
    ctx.on("session/event", (session, event) => {
        const sessionId = sessionIdFrom(session);
        if (sessionId === undefined) return;
        control.bridge?.handleSessionEvent(sessionId, event);
    });
    ctx.on("agent/error", (payload) => {
        control.bridge?.handleAgentError(payload);
    });

    // ── Control page and JSON endpoints ──
    if (typeof ctx.inject === "function") {
        ctx.inject(["webServer"], (httpCtx) => {
            const webServer = httpCtx.get("webServer");
            if (!webServer || typeof webServer.register !== "function") return;

            registerRoute(webServer, log, {
                kind: "exact",
                path: "/wechat-group/",
                handler: (_req, res) => {
                    res.setHeader("Content-Type", "text/html; charset=utf-8");
                    res.setHeader("Cache-Control", "no-store");
                    res.end(renderPage());
                },
            });

            registerRoute(webServer, log, {
                kind: "exact",
                path: "/wechat-group/api/status",
                handler: (_req, res) => {
                    const current = control.bridge;
                    if (!current) {
                        sendJson(res, 503, { phase: "stopped", error: "插件已停止" });
                        return;
                    }
                    sendJson(res, 200, current.getStatus());
                },
            });

            registerRoute(webServer, log, {
                kind: "exact",
                path: "/wechat-group/api/config",
                handler: async (req, res) => {
                    const current = control.bridge;
                    if (!current) {
                        sendJson(res, 503, { ok: false, message: "插件已停止" });
                        return;
                    }
                    try {
                        const patch = await readJsonBody(req);
                        const allowed = [
                            "groupChatEnabled", "groupReplyWhen", "botNames", "groupKeywords",
                            "allowedUsers", "allowedGroups", "groupCooldownSeconds", "maxReplyChars",
                            "dmAutoReply", "reportErrors",
                        ];
                        const clean = {};
                        for (const key of allowed) {
                            if (patch[key] !== undefined) clean[key] = patch[key];
                        }
                        store.writeConfig(clean);
                        // Re-normalize against the patch layer so an HTTP body can
                        // never introduce a key the schema does not own.
                        const next = normalizeConfig({ ...rowConfig, ...store.readConfig() });
                        current.updateConfig(next);
                        sendJson(res, 200, { ok: true, message: "已保存", config: next });
                    }
                    catch (error) {
                        sendJson(res, 400, { ok: false, message: String(error instanceof Error ? error.message : error) });
                    }
                },
            });

            registerRoute(webServer, log, {
                kind: "exact",
                path: "/wechat-group/api/relogin",
                handler: async (_req, res) => {
                    const current = control.bridge;
                    if (!current) {
                        sendJson(res, 503, { ok: false, message: "插件已停止" });
                        return;
                    }
                    sendJson(res, 200, await current.relogin());
                },
            });

            registerRoute(webServer, log, {
                kind: "exact",
                path: "/wechat-group/api/logout",
                handler: async (_req, res) => {
                    const current = control.bridge;
                    if (!current) {
                        sendJson(res, 503, { ok: false, message: "插件已停止" });
                        return;
                    }
                    sendJson(res, 200, await current.logout());
                },
            });

            registerRoute(webServer, log, {
                kind: "exact",
                path: "/wechat-group/qr.png",
                handler: (_req, res) => {
                    const url = control.bridge?.qrUrl;
                    if (!url) {
                        res.statusCode = 404;
                        res.end("no QR available");
                        return;
                    }
                    res.setHeader("Content-Type", "image/png");
                    res.setHeader("Cache-Control", "no-store");
                    res.end(qrPng(url));
                },
            });

            registerRoute(webServer, log, {
                kind: "exact",
                path: "/wechat-group/qr.svg",
                handler: (_req, res) => {
                    const url = control.bridge?.qrUrl;
                    if (!url) {
                        res.statusCode = 404;
                        res.end("no QR available");
                        return;
                    }
                    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
                    res.setHeader("Cache-Control", "no-store");
                    res.end(qrSvg(url));
                },
            });
            log("control page registered at /wechat-group/");
        });
    }

    // ── Lifecycle ──
    // This host's cordis does not treat a plugin's return value as a disposer,
    // so the cleanup goes through `ctx.effect` (and the return value is kept for
    // hosts that do use it). `bridge.stop()` is idempotent either way.
    const dispose = () => {
        if (control.bridge === bridge) control.bridge = undefined;
        return bridge.stop();
    };
    if (typeof ctx.effect === "function") ctx.effect(() => dispose);
    void bridge.start().catch((error) => {
        console.error(`[wechat-groupchat] start failed: ${String(error)}`);
    });

    return dispose;
}

export { storageDirFor };
