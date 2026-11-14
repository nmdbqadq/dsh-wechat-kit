/**
 * The bridge: one WeChat bot account ⇄ one DSH session per conversation.
 *
 * The shape of the problem, because it is what the design follows:
 *
 *   - iLink delivers every inbound message with `from_user_id` and `group_id`.
 *     A 1:1 message carries `group_id: ""`, so a non-blank `group_id` is "this
 *     came from a group" and the group id is the address a reply must use.
 *   - Outbound addressing is the same field for both kinds: `to_user_id` is the
 *     peer id for a DM and the group id for a group. The reply is routed by the
 *     echoed `context_token` of the message being answered, so the token is kept
 *     per conversation and sent back with every reply.
 *   - A group is many people and one conversation: without a policy the bot
 *     answers every message (spam), and every member's turn shares one context.
 *     The policy below defaults to "answer only when addressed", and gives each
 *     group its own session so a group never reads another's history.
 *
 * Everything stateful that must survive a restart lives in `Store`; everything
 * that must not leak lives only in memory (context tokens, send counters).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { login, loadToken, LoginCancelledError } from "./ilink/auth.js";
import { startMonitor, clearSyncBuf } from "./ilink/monitor.js";
import { sendTextMessage, sanitizeWeChatText, splitText } from "./ilink/send.js";
import { MessageType, MessageItemType, MessageState } from "./ilink/types.js";
import { qrPng, qrSvg } from "./qr-png.js";
import { createUserMessage } from "./messages.js";
import { agentSetup } from "./agent-setup.js";
import { toWeChatText, preview, shortId } from "./format.js";
import { idList, workspaceFor } from "./config.js";

/** iLink locks a chat after ten consecutive bot messages; stay well below it. */
const SEND_WINDOW_MS = 10 * 60_000;
const SEND_WINDOW_MAX = 8;
/** How many segments one reply may occupy before the rest is dropped. */
const MAX_SEGMENTS = 4;
const SEGMENT_GAP_MS = 350;

const DM_HINT = "（提示：这条消息来自微信私聊。回复会原样发到微信，写成两三句口语化的短句，不要用 Markdown 标题和表格，代码块会退化成一堆反引号。）";
const GROUP_HINT = "（提示：这条消息来自微信群聊，群里有多个成员，你看不到他们的昵称，只会看到一个 id 尾巴。只回应当前这条消息，用「你」称呼对方，不要提到别人的私聊内容。）";
/** How long a session may wait on the workspace registry before delivery wins. */
const WORKSPACE_ATTACH_TIMEOUT_MS = 8000;
/** Durable log cap; the file is truncated by whole lines once it passes this. */
const LOG_FILE_MAX_BYTES = 256 * 1024;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function mintSessionId() {
    return `session-${crypto.randomUUID()}`;
}

function blankToUndefined(value) {
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Concatenate the text blocks of an assistant message. */
function messageText(content) {
    if (!Array.isArray(content)) return "";
    return content
        .filter((block) => block && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n")
        .trim();
}

/**
 * Normalize one iLink message into the fields the routing needs.
 * Returns undefined for anything that must not reach an agent at all.
 */
export function normalizeInbound(raw) {
    if (!raw || typeof raw !== "object") return undefined;
    // Our own outbound echo: never feed it back to the model.
    if (raw.message_type !== undefined && raw.message_type !== MessageType.USER) return undefined;
    if (raw.message_state !== undefined
        && raw.message_state !== MessageState.NEW
        && raw.message_state !== MessageState.FINISH) return undefined;

    const senderId = blankToUndefined(raw.from_user_id);
    if (senderId === undefined) return undefined;
    const groupId = blankToUndefined(raw.group_id);
    const conversationId = groupId ?? senderId;

    const items = Array.isArray(raw.item_list) ? raw.item_list : [];
    let text = "";
    let quoted;
    for (const item of items) {
        if (!item || typeof item !== "object") continue;
        if (item.ref_msg && typeof item.ref_msg.title === "string" && item.ref_msg.title.trim() !== "") {
            quoted = item.ref_msg.title.trim();
        }
        if (text !== "") continue;
        if (item.type === MessageItemType.TEXT && typeof item.text_item?.text === "string") {
            text = item.text_item.text;
        }
        else if (item.type === MessageItemType.VOICE && typeof item.voice_item?.text === "string") {
            // WeChat transcribes inbound voice before delivery; this is that text.
            text = item.voice_item.text;
        }
    }

    const id = String(raw.message_id ?? raw.client_id ?? "");
    return {
        id,
        senderId,
        groupId,
        conversationId,
        isGroup: groupId !== undefined,
        text,
        quoted,
        contextToken: blankToUndefined(raw.context_token),
        time: typeof raw.create_time_ms === "number" ? raw.create_time_ms : Date.now(),
        itemCount: items.length,
    };
}

/**
 * Was the bot addressed by name?
 *
 * iLink does not hand out the group @-list, so this is a text heuristic on the
 * FIRST line only: a leading `@name`, the name at a word boundary, or one of the
 * configured keywords. False negatives are the safe direction — a missed
 * mention costs one unanswered message, a false positive makes the bot talk over
 * a live conversation.
 */
export function mentionsBot(text, { names = [], keywords = [] } = {}) {
    const source = typeof text === "string" ? text : "";
    if (source.trim() === "") return false;
    const firstLine = source
        .split("\n")[0]
        .replace(/[\u2005\u00a0\u3000]/g, " ")
        .replace(/＠/g, "@");
    const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const name of names) {
        const trimmed = String(name ?? "").trim();
        if (trimmed === "") continue;
        if (new RegExp(`(^|\\s)@?${escape(trimmed)}`, "i").test(firstLine)) return true;
    }
    const lowered = firstLine.toLowerCase();
    for (const keyword of keywords) {
        const trimmed = String(keyword ?? "").trim().toLowerCase();
        if (trimmed !== "" && lowered.includes(trimmed)) return true;
    }
    return false;
}

export class WeChatBridge {
    constructor(ctx, config, store, storageDir) {
        this.ctx = ctx;
        this.config = config;
        this.store = store;
        this.storageDir = storageDir;
        this.workspace = workspaceFor(config, storageDir);

        /** @type {{ token?: string, baseUrl?: string, accountId?: string, userId?: string } | undefined} */
        this.token = loadToken(storageDir) ?? undefined;

        this.phase = "starting";
        this.error = "";
        this.qrUrl = "";
        this.qrSvg = "";
        this.qrPath = "";
        this.qrUpdatedAt = 0;

        this.started = false;
        this.stopPromise = undefined;
        this.monitorAbort = undefined;
        this.monitorDone = undefined;
        this.loginAbort = undefined;
        this.retryTimer = undefined;

        /** conversationId → last seen context token (routes the reply). */
        this.contextTokens = new Map();
        /** sessionId → { conversationId, at } for turns this bridge started. */
        this.pendingTurns = new Map();
        /** sessionId → last assistant text of the running turn. */
        this.turnText = new Map();
        /** sessionId → "dm" | "group", for the first-message hint only. */
        this.hinted = new Set();
        /** conversationId → { count, since } */
        this.sendWindows = new Map();
        /** conversationId → timestamp of the last proactive group reply. */
        this.lastGroupReplyAt = new Map();
        /** Rolling in-memory log tail (the page shows it, and it survives no restart). */
        this.logLines = [];
    }

    // ───────────────────────────── lifecycle ─────────────────────────────

    async start() {
        if (this.started) return;
        this.started = true;
        this.log(`start: ${this.token?.token ? `saved token for ${this.token.accountId ?? "unknown bot"}` : "no token"} · workspace ${this.workspace}`);
        try {
            fs.mkdirSync(this.workspace, { recursive: true });
        }
        catch (error) {
            console.error(`[wechat-groupchat] creating the workspace failed: ${String(error)}`);
        }
        if (this.token?.token) {
            this.startMonitor();
            return;
        }
        if (this.config.autoStart === false) {
            this.phase = "no-token";
            return;
        }
        await this.scanLogin();
    }

    /** Idempotent teardown: the host may dispose twice (effect + return value). */
    stop() {
        this.stopPromise ??= (async () => {
            this.phase = "stopped";
            if (this.retryTimer !== undefined) {
                clearTimeout(this.retryTimer);
                this.retryTimer = undefined;
            }
            try {
                this.loginAbort?.abort();
            }
            catch {
                // A dead controller is already stopped.
            }
            await this.stopMonitor();
        })();
        return this.stopPromise;
    }

    async stopMonitor() {
        const abort = this.monitorAbort;
        this.monitorAbort = undefined;
        if (!abort) return;
        try {
            abort.abort();
        }
        catch {
            // already aborted
        }
        try {
            await this.monitorDone;
        }
        catch {
            // the loop reports its own failures
        }
    }

    startMonitor() {
        void this.stopMonitor().then(() => {
            if (this.phase === "stopped") return;
            const abort = new AbortController();
            this.monitorAbort = abort;
            this.monitorDone = startMonitor({
                baseUrl: this.token?.baseUrl || this.config.baseUrl,
                token: this.token?.token,
                storageDir: this.storageDir,
                abortSignal: abort.signal,
                log: (line) => this.log(line),
                onMessage: (raw) => {
                    void this.handleRawMessage(raw);
                },
                onSessionInvalid: () => {
                    this.phase = "reconnecting";
                    this.log("iLink session invalid; rebuilding it");
                },
                onSessionRecovered: () => {
                    if (this.phase === "reconnecting") this.phase = "connected";
                },
                onSessionGiveUp: () => {
                    this.phase = "error";
                    this.error = "机器人会话已失效，需要在登录页重新扫码";
                },
            }).catch((error) => {
                if (abort.signal.aborted) return;
                this.phase = "error";
                this.error = `监控循环退出：${String(error)}`;
                console.error(`[wechat-groupchat] monitor loop exited: ${String(error)}`);
            });
            if (this.phase !== "error") this.phase = "connected";
        });
    }

    // ───────────────────────────── QR login ─────────────────────────────

    /** Run the QR login flow, publishing the code for the page and the chat. */
    async scanLogin({ fresh = false } = {}) {
        if (fresh) {
            this.token = undefined;
            clearSyncBuf(this.storageDir);
            try {
                fs.rmSync(path.join(this.storageDir, "auth", "token.json"), { force: true });
            }
            catch {
                // best effort
            }
        }
        // A second click while a flow is running replaces it instead of leaving
        // two loops polling status against two different QR codes.
        try {
            this.loginAbort?.abort();
        }
        catch {
            // already aborted
        }
        await this.stopMonitor();
        this.phase = "waiting-scan";
        this.error = "";
        const abort = new AbortController();
        this.loginAbort = abort;
        try {
            const data = await login({
                baseUrl: this.config.baseUrl,
                botType: this.config.botType || undefined,
                storageDir: this.storageDir,
                log: (line) => this.log(line),
                renderQrUrl: (url) => this.publishQr(url),
                abortSignal: abort.signal,
            });
            this.token = data;
            this.qrUrl = "";
            this.qrSvg = "";
            this.phase = "connected";
            this.log(`logged in as ${data.accountId ?? "unknown bot"}`);
            this.startMonitor();
            return true;
        }
        catch (error) {
            if (error instanceof LoginCancelledError || abort.signal.aborted) {
                this.phase = this.phase === "stopped" ? "stopped" : "no-token";
                return false;
            }
            this.phase = "error";
            this.error = `扫码登录失败：${String(error instanceof Error ? error.message : error)}`;
            console.error(`[wechat-groupchat] ${this.error}`);
            // The gateway's QR page lives five minutes. Nobody watches a page
            // that gives up, so a timeout puts a fresh code up instead of
            // parking the plugin in "error" until the operator notices.
            if (this.started && this.phase !== "stopped") {
                this.retryTimer = setTimeout(() => {
                    this.retryTimer = undefined;
                    if (this.started && this.token === undefined) void this.scanLogin();
                }, 2000);
                this.retryTimer.unref?.();
            }
            return false;
        }
        finally {
            if (this.loginAbort === abort) this.loginAbort = undefined;
        }
    }

    publishQr(url) {
        this.qrUrl = url;
        this.qrUpdatedAt = Date.now();
        try {
            this.qrSvg = qrSvg(url);
            const target = path.join(this.storageDir, "login-qr.png");
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, qrPng(url));
            this.qrPath = target;
            this.log(`QR code ready: ${target} (also on /wechat-group/)`);
        }
        catch (error) {
            console.error(`[wechat-groupchat] rendering the QR failed: ${String(error)}`);
        }
    }

    async relogin() {
        const ok = await this.scanLogin({ fresh: true });
        return { ok, message: ok ? "已重新登录" : (this.error || "登录未完成") };
    }

    async logout() {
        await this.stopMonitor();
        this.token = undefined;
        try {
            fs.rmSync(path.join(this.storageDir, "auth", "token.json"), { force: true });
        }
        catch {
            // best effort
        }
        clearSyncBuf(this.storageDir);
        this.phase = "no-token";
        return { ok: true, message: "已退出登录" };
    }

    // ───────────────────────────── status ─────────────────────────────

    getStatus() {
        const conversations = Object.entries(this.store.conversations()).map(([conversationId, record]) => ({
            conversationId,
            kind: record?.kind === "group" ? "group" : "dm",
            sessionId: record?.sessionId ?? "",
            lastInboundAt: record?.lastInboundAt ?? 0,
            lastPreview: record?.lastPreview ?? "",
        }));
        return {
            phase: this.phase,
            error: this.error,
            botId: this.token?.accountId ?? "",
            accountLabel: this.token?.userId ? shortId(this.token.userId) : "",
            baseUrl: this.token?.baseUrl || this.config.baseUrl,
            qrUrl: this.qrUrl,
            qrUpdatedAt: this.qrUpdatedAt,
            qrAvailable: this.qrPath !== "",
            qrPath: this.qrPath,
            storageDir: this.storageDir,
            workspace: this.workspace,
            conversations,
            logs: this.recentLogs(30),
            warnings: this.warnings(),
            config: this.config,
        };
    }

    warnings() {
        const out = [];
        if (this.config.groupChatEnabled && this.config.groupReplyWhen === "mention"
            && idList(this.config.botNames).length === 0 && idList(this.config.groupKeywords).length === 0) {
            out.push("群聊模式是「叫到才回」，但 botNames 和 groupKeywords 都是空的：群里永远不会有人叫得动它。");
        }
        if (this.config.dmAutoReply && idList(this.config.allowedUsers).length === 0) {
            out.push("私聊对所有人自动回复：任何加了机器人的人都能花掉这台机器人的模型额度。");
        }
        if (this.config.dmAutoReply === false && idList(this.config.allowedUsers).length === 0) {
            out.push("私聊是「只在白名单」但白名单空着 —— 现在任何人发私聊都不会得到回复。填上 id，或把开关改回「所有人」。");
        }
        return out;
    }

    updateConfig(next) {
        this.config = next;
        this.workspace = workspaceFor(next, this.storageDir);
    }

    // ───────────────────────────── inbound ─────────────────────────────

    async handleRawMessage(raw) {
        try {
            await this.routeInbound(raw);
        }
        catch (error) {
            console.error(`[wechat-groupchat] handling an inbound message failed: ${String(error)}`);
        }
    }

    async routeInbound(raw) {
        const message = normalizeInbound(raw);
        if (message === undefined) return;
        if (message.id !== "" && this.store.hasSeen(message.id)) return;
        if (message.id !== "") this.store.markSeen(message.id);

        if (message.contextToken) this.contextTokens.set(message.conversationId, message.contextToken);
        // An inbound message reopens the send window: the bot may talk again.
        this.sendWindows.delete(message.conversationId);

        const decision = this.decide(message);
        if (!decision.reply) {
            this.log(`skip ${decision.reason} from ${shortId(message.senderId)} in ${shortId(message.conversationId)}`);
            return;
        }

        const text = message.text.trim();
        if (text === "" && message.itemCount > 0) {
            if (decision.addressed) {
                await this.sendReply(message.conversationId, "这条我暂时看不懂——现在只处理文字（图片、文件、表情还接不住），打字跟我说就行。");
            }
            return;
        }
        if (text === "") return;

        this.log(`recv ${decision.reason} ${shortId(message.senderId)} in ${shortId(message.conversationId)}: ${preview(text)}`);

        if (text.startsWith("/") && this.handleCommand(message, decision)) return;

        const { agent, sessionId } = await this.ensureAgent(message);
        if (!agent || typeof sessionId !== "string" || sessionId === "") {
            this.log(`no agent for ${shortId(message.conversationId)}; telling the sender so`);
            await this.sendReply(message.conversationId, "我这边连不上 DSH 的会话，消息没处理成。稍后再试一次，或者看看宿主日志。");
            return;
        }
        this.pendingTurns.set(sessionId, { conversationId: message.conversationId, at: Date.now() });
        const prompt = this.composePrompt(message);
        const content = [{ type: "text", text: prompt }];
        const userMessage = createUserMessage({ content, source: { kind: "user" } });
        try {
            if (agent.status === "running" && typeof agent.steer === "function") agent.steer(userMessage);
            else agent.followup(userMessage);
            this.log(`delivered to agent ${sessionId}`);
        }
        catch (error) {
            this.pendingTurns.delete(sessionId);
            this.log(`delivering to the agent failed: ${String(error)}`);
            await this.sendReply(message.conversationId, "消息没能送进会话，再发一次试试。");
        }
    }

    /**
     * Turn one WeChat message into the agent prompt.
     *
     * A group message is prefixed with who spoke: the model has no other way to
     * know it is in a room with several people. The longer behavioural hint is
     * given once per conversation, not on every message — repeating it inflates
     * the context and makes the model narrate its own instructions.
     */
    composePrompt(message) {
        const hints = [];
        if (!this.hinted.has(message.conversationId)) {
            this.hinted.add(message.conversationId);
            hints.push(message.isGroup ? GROUP_HINT : DM_HINT);
        }
        const parts = [];
        if (message.isGroup) parts.push(`【微信群聊｜发言人 ${shortId(message.senderId)}】`);
        if (message.quoted) parts.push(`（对方引用了这条消息：${preview(message.quoted, 80)}）`);
        parts.push(message.text.trim());
        if (hints.length > 0) parts.push("", hints.join("\n"));
        return parts.join("\n");
    }

    decide(message) {
        const config = this.config;
        if (!message.isGroup) {
            const allowed = idList(config.allowedUsers);
            if (allowed.length > 0) {
                if (!allowed.includes(message.senderId)) return { reply: false, reason: "dm-sender-not-allowed", addressed: false };
                return { reply: true, reason: "dm", addressed: true };
            }
            if (config.dmAutoReply === false) return { reply: false, reason: "dm-disabled", addressed: false };
            return { reply: true, reason: "dm", addressed: true };
        }
        if (config.groupChatEnabled !== true) return { reply: false, reason: "groups-disabled", addressed: false };
        const groups = idList(config.allowedGroups);
        if (groups.length > 0 && !groups.includes(message.conversationId)) {
            return { reply: false, reason: "group-not-allowed", addressed: false };
        }
        if (config.groupReplyWhen === "all") {
            const last = this.lastGroupReplyAt.get(message.conversationId) ?? 0;
            if (Date.now() - last < config.groupCooldownSeconds * 1000) {
                return { reply: false, reason: "group-cooldown", addressed: false };
            }
            return { reply: true, reason: "group-all", addressed: false };
        }
        const addressed = mentionsBot(message.text, {
            names: idList(config.botNames),
            keywords: idList(config.groupKeywords),
        });
        return addressed
            ? { reply: true, reason: "group-mention", addressed: true }
            : { reply: false, reason: "not-addressed", addressed: false };
    }

    /** Slash commands are local: they must never cost a model turn. */
    handleCommand(message, decision) {
        const command = message.text.trim().split(/\s+/)[0].toLowerCase();
        const allow = !message.isGroup || decision.addressed;
        if (!allow) return false;
        const conversationId = message.conversationId;
        switch (command) {
            case "/new": {
                const previous = this.store.conversation(conversationId)?.sessionId;
                this.store.forgetConversation(conversationId);
                this.hinted.delete(conversationId);
                if (typeof previous === "string") {
                    this.pendingTurns.delete(previous);
                    this.turnText.delete(previous);
                }
                void this.sendReply(conversationId, "已换新会话，接下来这条消息开一轮新的。");
                return true;
            }
            case "/status": {
                void this.sendReply(conversationId, this.statusText(conversationId));
                return true;
            }
            case "/id": {
                void this.sendReply(conversationId,
                    `会话 ${message.isGroup ? "群聊" : "私聊"}\nconversationId: ${conversationId}\n发送者 id: ${message.senderId}\n`
                    + "把要放行/限制的 id 填进设置页的「允许的私聊 / 允许的群」，逗号分隔。");
                return true;
            }
            case "/help": {
                void this.sendReply(conversationId,
                    "我是接在这台机器 DSH 上的微信机器人。\n"
                    + "直接说话就行，我会当真回复。\n"
                    + "命令：/new 换一个干净会话 · /status 看连接和绑定 · /id 看这个聊天的 id · /help 看这页。");
                return true;
            }
            default:
                return false;
        }
    }

    statusText(conversationId) {
        const record = this.store.conversation(conversationId);
        const conversations = Object.values(this.store.conversations());
        const dms = conversations.filter((record) => record?.kind !== "group").length;
        const groups = conversations.filter((record) => record?.kind === "group").length;
        return [
            `连接：${this.phase}`,
            `机器人：${shortId(this.token?.accountId ?? "")}`,
            `绑定：私聊 ${dms} · 群聊 ${groups}`,
            `这个聊天：${record?.sessionId ?? "还没开会话"}`,
            `工作目录：${this.workspace}`,
        ].join("\n");
    }

    // ───────────────────────────── sessions ─────────────────────────────

    async ensureAgent(message) {
        const agents = this.ctx.get("agents");
        if (!agents) {
            this.error = "宿主没有 agents 服务";
            return { agent: undefined, sessionId: undefined };
        }
        const record = this.store.conversation(message.conversationId);
        if (record?.sessionId) {
            const liveAgent = agents.get(record.sessionId);
            if (liveAgent) return { agent: liveAgent, sessionId: record.sessionId };
            try {
                const handle = await agents.resume({ resumeSessionId: record.sessionId, setup: agentSetup });
                await this.attachToWorkspace(record.sessionId);
                return { agent: handle.agent, sessionId: record.sessionId };
            }
            catch (error) {
                this.log(`resuming ${record.sessionId} failed: ${String(error)}; creating a new session`);
            }
        }
        try {
            const sessionId = mintSessionId();
            const preset = this.ctx.get("agentPresets")?.defaultId;
            const handle = await agents.create({
                sessionId,
                meta: { cwd: this.workspace, ...(preset ? { agentPreset: preset } : {}) },
                setup: agentSetup,
            });
            this.store.setConversation(message.conversationId, {
                sessionId,
                kind: message.isGroup ? "group" : "dm",
                createdAt: Date.now(),
                lastInboundAt: Date.now(),
                lastPreview: preview(message.text),
            });
            this.log(`created ${sessionId} for ${message.isGroup ? "group" : "dm"} ${shortId(message.conversationId)}`);
            await this.attachToWorkspace(sessionId);
            return { agent: handle.agent, sessionId };
        }
        catch (error) {
            this.error = `创建会话失败：${String(error)}`;
            this.log(this.error);
            return { agent: undefined, sessionId: undefined };
        }
    }

    /**
     * Account the session to the workspace owning `cwd`, exactly like the GUI's
     * session.create does through `workspace.attachSession`. Without it the
     * session works but shows up in the sidebar's "ungrouped" bucket.
     *
     * Bounded on purpose: grouping is cosmetic, delivering the message is not,
     * so a workspace registry that stalls must not hold up the reply.
     */
    async attachToWorkspace(sessionId) {
        const registry = this.ctx.get("workspaceRegistry");
        if (!registry) return;
        const work = (async () => {
            let workspace = await registry.resolveByPath(this.workspace);
            if (!workspace) workspace = await registry.create(this.workspace);
            await workspace.attachSession(sessionId);
        })();
        try {
            await Promise.race([work, sleep(WORKSPACE_ATTACH_TIMEOUT_MS).then(() => {
                throw new Error(`timed out after ${WORKSPACE_ATTACH_TIMEOUT_MS} ms`);
            })]);
        }
        catch (error) {
            this.log(`attaching ${sessionId} to the workspace skipped: ${String(error)}`);
        }
    }

    // ───────────────────────────── outbound ─────────────────────────────

    /** Fired by the host for every committed session event. */
    handleSessionEvent(sessionId, event) {
        if (!event || typeof event !== "object") return;
        if (event.type === "assistant/message") {
            const text = messageText(event.data?.message?.content);
            if (text !== "") this.turnText.set(sessionId, text);
            return;
        }
        if (event.type === "turn/end") {
            const pending = this.pendingTurns.get(sessionId);
            const text = this.turnText.get(sessionId) ?? "";
            this.turnText.delete(sessionId);
            if (!pending) return;
            this.pendingTurns.delete(sessionId);
            if (text === "") {
                if (this.config.reportErrors) {
                    void this.sendReply(pending.conversationId, "这轮没有生成回复（可能是被中断了）。");
                }
                return;
            }
            this.recordActivity(pending.conversationId, text);
            void this.sendReply(pending.conversationId, text);
        }
    }

    handleAgentError(payload) {
        const sessionId = payload?.agent?.id;
        if (typeof sessionId !== "string") return;
        const pending = this.pendingTurns.get(sessionId);
        if (!pending) return;
        this.pendingTurns.delete(sessionId);
        this.turnText.delete(sessionId);
        if (this.config.reportErrors !== true) return;
        const reason = payload?.error?.message ?? payload?.error ?? "未知错误";
        void this.sendReply(pending.conversationId, `这轮出错了：${preview(String(reason), 200)}`);
    }

    recordActivity(conversationId, text) {
        try {
            this.store.setConversation(conversationId, {
                lastReplyAt: Date.now(),
                lastReplyPreview: preview(text),
                lastInboundAt: this.store.conversation(conversationId)?.lastInboundAt ?? 0,
            });
        }
        catch {
            // the preview is cosmetic
        }
        this.lastGroupReplyAt.set(conversationId, Date.now());
    }

    /**
     * Send one agent reply, flattened for WeChat and split to the gateway size.
     *
     * The send window is per conversation because iLink's continuous-send limit
     * is too: eight messages per ten minutes without an inbound message from
     * that chat, far below the hard limit of ten.
     */
    async sendReply(conversationId, markdown) {
        if (!this.token?.token) {
            this.log(`drop reply to ${shortId(conversationId)}: not logged in`);
            return;
        }
        const flat = sanitizeWeChatText(toWeChatText(String(markdown ?? "")));
        if (flat === "") return;
        const segments = splitText(flat, this.config.maxReplyChars).slice(0, MAX_SEGMENTS);
        for (const [index, segment] of segments.entries()) {
            if (!this.consumeSendSlot(conversationId)) {
                this.log(`reply to ${shortId(conversationId)} paused: send window exhausted`);
                return;
            }
            try {
                await sendTextMessage(conversationId, segment, {
                    baseUrl: this.token.baseUrl || this.config.baseUrl,
                    token: this.token.token,
                    contextToken: this.contextTokens.get(conversationId),
                });
                this.log(`sent ${segment.length} chars to ${shortId(conversationId)}${segments.length > 1 ? ` (${index + 1}/${segments.length})` : ""}`);
            }
            catch (error) {
                console.error(`[wechat-groupchat] sending to ${shortId(conversationId)} failed: ${String(error)}`);
                return;
            }
            if (index < segments.length - 1) await sleep(SEGMENT_GAP_MS);
        }
    }

    consumeSendSlot(conversationId) {
        const now = Date.now();
        const window = this.sendWindows.get(conversationId);
        if (!window || now - window.since > SEND_WINDOW_MS) {
            this.sendWindows.set(conversationId, { count: 1, since: now });
            return true;
        }
        if (window.count >= SEND_WINDOW_MAX) return false;
        window.count += 1;
        return true;
    }

    log(line) {
        const entry = `${new Date().toISOString().slice(11, 19)} ${line}`;
        this.logLines.push(entry);
        if (this.logLines.length > 200) this.logLines.splice(0, this.logLines.length - 200);
        console.log(`[wechat-groupchat] ${line}`);
        // A durable tail matters more than the console here: a desktop host's
        // stdout is not persisted anywhere the operator can read without a
        // terminal attached, and the page is the only place problems surface.
        try {
            const target = path.join(this.storageDir, "plugin.log");
            fs.appendFileSync(target, `${entry}\n`, "utf8");
            const { size } = fs.statSync(target);
            if (size > LOG_FILE_MAX_BYTES) {
                const lines = fs.readFileSync(target, "utf8").split("\n").slice(-300);
                fs.writeFileSync(target, `${lines.join("\n")}\n`, "utf8");
            }
        }
        catch {
            // Logging must never be the reason a message fails.
        }
    }

    /** The tail of the plugin's own log, for the page and for diagnosis. */
    recentLogs(limit = 40) {
        return this.logLines.slice(-limit);
    }
}
