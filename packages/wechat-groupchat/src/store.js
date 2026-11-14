/**
 * Small JSON store for the plugin's own durable state.
 *
 * The DSH session log is the source of truth for conversations; this file only
 * remembers *which* session a WeChat conversation is bound to, plus the recent
 * inbound ids used for dedupe. Losing it costs a fresh session per
 * conversation, never data the model needs to answer.
 */
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDir, writePrivateFile } from "./ilink/secure-fs.js";

const MAX_SEEN = 500;

function emptyState() {
    return { version: 1, conversations: {}, seen: [] };
}

function readJson(filePath) {
    try {
        if (!fs.existsSync(filePath)) return undefined;
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return parsed && typeof parsed === "object" ? parsed : undefined;
    }
    catch {
        // A truncated or hand-edited file must not take the plugin down.
        return undefined;
    }
}

function writeJson(filePath, value) {
    ensurePrivateDir(path.dirname(filePath));
    writePrivateFile(filePath, JSON.stringify(value, null, 2));
}

export class Store {
    constructor(storageDir) {
        this.storageDir = storageDir;
        this.configPath = path.join(storageDir, "config.json");
        this.statePath = path.join(storageDir, "bridge-state.json");
        const state = readJson(this.statePath) ?? emptyState();
        this.state = {
            version: 1,
            conversations: isPlainObject(state.conversations) ? state.conversations : {},
            seen: Array.isArray(state.seen) ? state.seen.filter((id) => typeof id === "string").slice(-MAX_SEEN) : [],
        };
        this.seenIndex = new Set(this.state.seen);
    }

    // ─── Config ───

    /** The runtime config layer (page edits). Empty object when absent. */
    readConfig() {
        return readJson(this.configPath) ?? {};
    }

    writeConfig(patch) {
        const merged = { ...this.readConfig(), ...patch };
        const clean = {};
        for (const [key, value] of Object.entries(merged)) {
            if (value !== undefined) clean[key] = value;
        }
        writeJson(this.configPath, clean);
        return clean;
    }

    // ─── Conversations ───

    conversation(conversationId) {
        return this.state.conversations[conversationId];
    }

    conversations() {
        return this.state.conversations;
    }

    setConversation(conversationId, patch) {
        const previous = this.state.conversations[conversationId] ?? {};
        this.state.conversations[conversationId] = { ...previous, ...patch };
        this.save();
        return this.state.conversations[conversationId];
    }

    /** Drop a binding so the next message opens a fresh DSH session. */
    forgetConversation(conversationId) {
        if (this.state.conversations[conversationId] === undefined) return false;
        delete this.state.conversations[conversationId];
        this.save();
        return true;
    }

    sessionForConversation(sessionId) {
        for (const [conversationId, record] of Object.entries(this.state.conversations)) {
            if (record?.sessionId === sessionId) return conversationId;
        }
        return undefined;
    }

    // ─── Inbound dedupe ───

    /** True when this id was already handled (and therefore must be skipped). */
    hasSeen(id) {
        return this.seenIndex.has(id);
    }

    markSeen(id) {
        if (typeof id !== "string" || id === "" || this.seenIndex.has(id)) return;
        this.seenIndex.add(id);
        this.state.seen.push(id);
        while (this.state.seen.length > MAX_SEEN) {
            const dropped = this.state.seen.shift();
            this.seenIndex.delete(dropped);
        }
        this.save();
    }

    save() {
        try {
            writeJson(this.statePath, this.state);
        }
        catch (error) {
            console.error(`[wechat-groupchat] saving state failed: ${String(error)}`);
        }
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
