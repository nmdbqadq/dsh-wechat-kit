/**
 * Plugin configuration: defaults, coercion, and where the plugin keeps files.
 *
 * Two layers feed the live config, in this order:
 *
 *   1. `defaultConfig()` — the values below.
 *   2. The Host row's `config` in `cordis.patch.yml` (survives upgrades).
 *   3. `<storageDir>/config.json` — everything edited in the plugin page, so a
 *      runtime change sticks without touching the patch layer.
 *
 * Later layers win. Booleans accept the strings a YAML or an HTML form can
 * produce (`"false"`, `"off"`, `""`), because a silently-truthy `"false"` is
 * the classic way a switch appears on when the user turned it off.
 */
import os from "node:os";
import path from "node:path";

export const GROUP_REPLY_WHEN = new Set(["mention", "all"]);

/** The iLink gateway the official bot accounts live on. */
export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com/";

export function defaultConfig() {
    return {
        // ─── Connection ───
        /** Gateway origin. Only change it if Tencent moves the bot service. */
        baseUrl: DEFAULT_BASE_URL,
        /** Optional iLink bot type passed to the QR endpoint (empty = server default). */
        botType: "",
        /** Start the monitor as soon as the plugin activates (token already saved). */
        autoStart: true,

        // ─── Where sessions run ───
        /** Empty = `~/.dsh/wechat-groupchat`. Holds the token, cursor and state. */
        storageDir: "",
        /** Empty = `<storageDir>/workspace`. Working directory of every session. */
        workspace: "",

        // ─── Direct messages ───
        /**
         * Reply to anyone who messages the bot. Off = only `allowedUsers`.
         * On is what "跟人实时回复" means, and it also means any stranger who
         * finds the bot can spend the deployment's model tokens.
         */
        dmAutoReply: true,
        /** Comma/space separated WeChat user ids. Empty = no restriction. */
        allowedUsers: "",

        // ─── Group chats ───
        /** Answer in groups at all. Off leaves group traffic completely ignored. */
        groupChatEnabled: true,
        /** `mention` = only when addressed by name; `all` = every message. */
        groupReplyWhen: "mention",
        /**
         * Names the bot answers to inside a group. iLink does not deliver the
         * @-list, so this is matched against the first line of the message.
         */
        botNames: "机器人,小助手,助手,bot,AI",
        /** Extra triggers, matched case-insensitively anywhere in the first line. */
        groupKeywords: "",
        /** Comma/space separated group ids to answer in. Empty = any group. */
        allowedGroups: "",
        /**
         * Minimum seconds between two proactive replies to the same group in
         * `all` mode. Keeps a chatty group from turning the bot into a flood.
         */
        groupCooldownSeconds: 20,

        // ─── Replies ───
        /** Replies longer than this are split into sequential messages. */
        maxReplyChars: 1400,
        /** Answer with a short notice when a turn fails instead of staying silent. */
        reportErrors: true,
    };
}

function text(value, fallback) {
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return fallback;
}

function bool(value, fallback) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "" ) return fallback;
        if (["1", "true", "yes", "on", "是", "开"].includes(normalized)) return true;
        if (["0", "false", "no", "off", "否", "关"].includes(normalized)) return false;
    }
    return fallback;
}

function positiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? "").trim(), 10);
    if (!Number.isFinite(parsed)) return fallback;
    const rounded = Math.trunc(parsed);
    if (rounded < min) return min;
    if (rounded > max) return max;
    return rounded;
}

/** Coerce any raw object (patch row, JSON file, HTTP body) into a full config. */
export function normalizeConfig(raw = {}) {
    const base = defaultConfig();
    const source = raw && typeof raw === "object" ? raw : {};
    const when = text(source.groupReplyWhen, base.groupReplyWhen).toLowerCase();
    return {
        baseUrl: text(source.baseUrl, base.baseUrl) || base.baseUrl,
        botType: text(source.botType, base.botType),
        autoStart: bool(source.autoStart, base.autoStart),
        storageDir: text(source.storageDir, base.storageDir),
        workspace: text(source.workspace, base.workspace),
        dmAutoReply: bool(source.dmAutoReply, base.dmAutoReply),
        allowedUsers: text(source.allowedUsers, base.allowedUsers),
        groupChatEnabled: bool(source.groupChatEnabled, base.groupChatEnabled),
        groupReplyWhen: GROUP_REPLY_WHEN.has(when) ? when : base.groupReplyWhen,
        botNames: text(source.botNames, base.botNames),
        groupKeywords: text(source.groupKeywords, base.groupKeywords),
        allowedGroups: text(source.allowedGroups, base.allowedGroups),
        groupCooldownSeconds: positiveInt(source.groupCooldownSeconds, base.groupCooldownSeconds, { min: 0, max: 3600 }),
        maxReplyChars: positiveInt(source.maxReplyChars, base.maxReplyChars, { min: 200, max: 4000 }),
        reportErrors: bool(source.reportErrors, base.reportErrors),
    };
}

/** Split a comma/space/newline separated id list, dropping empties and duplicates. */
export function idList(value) {
    const seen = new Set();
    const out = [];
    for (const part of String(value ?? "").split(/[,，\s]+/)) {
        const item = part.trim();
        if (item === "" || seen.has(item)) continue;
        seen.add(item);
        out.push(item);
    }
    return out;
}

export function storageDirFor(config) {
    const configured = text(config?.storageDir, "");
    if (configured) return path.resolve(configured);
    return path.join(os.homedir(), ".dsh", "wechat-groupchat");
}

export function workspaceFor(config, storageDir) {
    const configured = text(config?.workspace, "");
    return configured ? path.resolve(configured) : path.join(storageDir, "workspace");
}
