/**
 * Smoke tests for the parts that decide behaviour without a WeChat account:
 * routing, mention matching, markdown flattening, config coercion, the state
 * store and the QR encoder. Run with `node test/smoke.mjs`.
 *
 * Deliberately dependency-free (node:assert only) — the plugin ships without an
 * install step, so its test cannot need one either.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeInbound, mentionsBot } from "../src/bridge.js";
import { toWeChatText, preview, shortId } from "../src/format.js";
import { normalizeConfig, idList, storageDirFor, workspaceFor } from "../src/config.js";
import { Store } from "../src/store.js";
import { qrPng, qrSvg } from "../src/qr-png.js";
import { MessageType, MessageState } from "../src/ilink/types.js";

const tests = [];
function test(name, fn) {
    tests.push({ name, fn });
}

const dmRaw = {
    message_type: MessageType.USER,
    message_state: MessageState.FINISH,
    from_user_id: "u1@im.wechat",
    group_id: "",
    item_list: [{ type: 1, text_item: { text: "hi" } }],
    context_token: "ct1",
};

test("a 1:1 message is addressed to its sender", () => {
    const message = normalizeInbound(dmRaw);
    assert.equal(message.isGroup, false);
    assert.equal(message.conversationId, "u1@im.wechat");
    assert.equal(message.contextToken, "ct1");
    assert.equal(message.text, "hi");
});

test("a group message is addressed to the group", () => {
    const message = normalizeInbound({ ...dmRaw, from_user_id: "u2@im.wechat", group_id: "g123@chatroom" });
    assert.equal(message.isGroup, true);
    assert.equal(message.conversationId, "g123@chatroom");
    assert.equal(message.senderId, "u2@im.wechat");
});

test("bot echoes and incomplete messages never reach an agent", () => {
    assert.equal(normalizeInbound({ ...dmRaw, message_type: MessageType.BOT }), undefined);
    assert.equal(normalizeInbound({ ...dmRaw, from_user_id: "" }), undefined);
    assert.equal(normalizeInbound({ ...dmRaw, message_state: MessageState.GENERATING }), undefined);
    assert.equal(normalizeInbound(null), undefined);
});

test("voice uses WeChat's own transcription", () => {
    const message = normalizeInbound({
        ...dmRaw,
        item_list: [{ type: 3, voice_item: { text: "语音转出来的字" } }],
    });
    assert.equal(message.text, "语音转出来的字");
});

test("a quoted message surfaces the quote title", () => {
    const message = normalizeInbound({
        ...dmRaw,
        item_list: [{ type: 1, text_item: { text: "回答这句" }, ref_msg: { title: "被引用的一句" } }],
    });
    assert.equal(message.quoted, "被引用的一句");
});

test("mentions match @name, bare name, full-width ＠ and keywords", () => {
    const names = ["小助手", "机器人"];
    assert.equal(mentionsBot("\u2005@小助手 你好", { names }), true);
    assert.equal(mentionsBot("＠小助手 在吗", { names }), true);
    assert.equal(mentionsBot("小助手在吗", { names }), true);
    assert.equal(mentionsBot("帮我查一下", { keywords: ["查一下"] }), true);
    assert.equal(mentionsBot("今天天气不错", { names }), false);
    assert.equal(mentionsBot("我说的是那个人", { names: ["人"] }), false);
    assert.equal(mentionsBot("第一行没问题\n小助手在这", { names }), false);
    assert.equal(mentionsBot("", { names }), false);
});

test("markdown is flattened for WeChat, code kept", () => {
    const flat = toWeChatText([
        "# 标题",
        "",
        "**加粗** 和 `代码`",
        "",
        "```js",
        "const a = 1",
        "```",
        "",
        "- 一",
        "- 二",
        "",
        "[链接](https://x.test)",
        "",
        "| a | b |",
        "| --- | --- |",
        "| 1 | 2 |",
    ].join("\n"));
    assert.ok(!flat.includes("**"), `bold markers left: ${flat}`);
    assert.ok(!flat.includes("`"), `backticks left: ${flat}`);
    assert.ok(!flat.includes("# "), `heading marker left: ${flat}`);
    assert.ok(flat.includes("const a = 1"), "code body lost");
    assert.ok(flat.includes("• 一"), "bullet lost");
    assert.ok(flat.includes("链接 (https://x.test)"), "link lost");
    assert.ok(!flat.includes("--- |"), "table separator left");
});

test("config coercion refuses silently-truthy strings", () => {
    const config = normalizeConfig({
        groupChatEnabled: "false",
        dmAutoReply: "off",
        groupReplyWhen: "ALL",
        maxReplyChars: "100",
        groupCooldownSeconds: "abc",
        botNames: "  小助手 , 机器人  ",
    });
    assert.equal(config.groupChatEnabled, false);
    assert.equal(config.dmAutoReply, false);
    assert.equal(config.groupReplyWhen, "all");
    assert.equal(config.maxReplyChars, 200);
    assert.equal(config.groupCooldownSeconds, 20);
    assert.deepEqual(idList(config.botNames), ["小助手", "机器人"]);
    assert.equal(normalizeConfig({ groupReplyWhen: "bogus" }).groupReplyWhen, "mention");
});

test("storage and workspace default under the home directory", () => {
    const config = normalizeConfig({});
    const dir = storageDirFor(config);
    assert.ok(dir.endsWith(path.join(".dsh", "wechat-groupchat")), dir);
    assert.equal(workspaceFor(config, dir), path.join(dir, "workspace"));
    assert.equal(workspaceFor(normalizeConfig({ workspace: "C:\\tmp\\ws" }), dir), "C:\\tmp\\ws");
});

test("the state store survives a reload", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxgc-"));
    const store = new Store(dir);
    store.setConversation("g1", { sessionId: "session-x", kind: "group" });
    store.markSeen("m1");
    const reloaded = new Store(dir);
    assert.equal(reloaded.conversation("g1").sessionId, "session-x");
    assert.equal(reloaded.hasSeen("m1"), true);
    assert.equal(reloaded.sessionForConversation("session-x"), "g1");
    reloaded.writeConfig({ groupReplyWhen: "all" });
    assert.equal(reloaded.readConfig().groupReplyWhen, "all");
    reloaded.forgetConversation("g1");
    assert.equal(new Store(dir).conversation("g1"), undefined);
});

test("the dedupe list stays bounded", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxgc-"));
    const store = new Store(dir);
    for (let index = 0; index < 700; index += 1) store.markSeen(`m${index}`);
    assert.equal(store.state.seen.length, 500);
    assert.equal(store.hasSeen("m699"), true);
    assert.equal(store.hasSeen("m0"), false);
});

test("the QR encoder produces a square PNG and an SVG", () => {
    const url = "https://example.test/qr?code=abc123";
    const png = qrPng(url);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    assert.equal(width, height);
    assert.ok(width > 100 && width < 2000, `unexpected size ${width}`);
    assert.ok(qrSvg(url).startsWith("<svg"), "svg tag");
});

test("previews and ids stay short", () => {
    assert.equal(preview("a\n\n b   c", 10), "a b c");
    assert.equal(shortId("abcdefghij"), "…efghij");
    assert.equal(shortId(""), "?");
});

let failed = 0;
for (const { name, fn } of tests) {
    try {
        fn();
        console.log(`ok    ${name}`);
    }
    catch (error) {
        failed += 1;
        console.error(`FAIL  ${name}\n      ${String(error?.message ?? error)}`);
    }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
