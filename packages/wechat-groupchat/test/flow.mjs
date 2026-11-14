/**
 * Turn-flow tests: the path a WeChat message takes from arrival to answer.
 *
 * The real WeChat account and the real Host are both replaced here — what is
 * under test is the routing decision and the sequence of calls this plugin makes
 * on the Host's services. These are the facts a live account cannot easily pin
 * down (a group message that must stay unanswered, a cooldown, the fact that the
 * reply is sent once per turn rather than per assistant message).
 *
 * Run with `node test/flow.mjs`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WeChatBridge } from "../src/bridge.js";
import { Store } from "../src/store.js";
import { defaultConfig } from "../src/config.js";
import { MessageType, MessageState } from "../src/ilink/types.js";

/** A Host stub with only the services this bridge touches. */
function fakeHost({ attachHangs = false } = {}) {
    const calls = { create: [], resume: [], followup: [], steer: [], attach: [] };
    const agents = {
        get: () => undefined,
        async create(request) {
            calls.create.push(request);
            return {
                agent: {
                    status: "idle",
                    followup(message) { calls.followup.push(message); },
                    steer(message) { calls.steer.push(message); },
                },
            };
        },
        async resume(request) {
            calls.resume.push(request);
            return { agent: { status: "idle", followup() {}, steer() {} } };
        },
    };
    const ctx = {
        get(service) {
            if (service === "agents") return agents;
            if (service === "agentPresets") return { defaultId: "standard", async mount() {} };
            if (service === "agentDefaultModel") return { currentSelection: () => ({ provider: "deepseek-account", model: "deepseek-flash" }) };
            if (service === "workspaceRegistry") {
                return {
                    async resolveByPath() { return null; },
                    async create() {
                        return {
                            async attachSession(sessionId) {
                                calls.attach.push(sessionId);
                                if (attachHangs) await new Promise(() => {});
                            },
                        };
                    },
                };
            }
            return undefined;
        },
        on() {},
    };
    return { ctx, calls };
}

function makeBridge({ config = {}, attachHangs = false } = {}) {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "wxgc-flow-"));
    const { ctx, calls } = fakeHost({ attachHangs });
    const store = new Store(storageDir);
    const bridge = new WeChatBridge(ctx, { ...defaultConfig(), ...config }, store, storageDir);
    bridge.token = { token: "test-token", baseUrl: "https://example.test/" };
    /** Replies captured instead of being sent to iLink. */
    const replies = [];
    bridge.sendReply = async (conversationId, text) => { replies.push({ conversationId, text }); };
    /** Keep the log out of the console noise. */
    bridge.log = () => {};
    return { bridge, store, calls, replies, storageDir };
}

const dm = (text, extra = {}) => ({
    message_type: MessageType.USER,
    message_state: MessageState.FINISH,
    from_user_id: "u1@im.wechat",
    group_id: "",
    item_list: [{ type: 1, text_item: { text } }],
    message_id: undefined,
    ...extra,
});
const group = (text, extra = {}) => dm(text, { from_user_id: "u2@im.wechat", group_id: "g1@chatroom", ...extra });

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("a direct message becomes one agent turn in its own session", async () => {
    const { bridge, calls, replies, storageDir } = makeBridge();
    await bridge.handleRawMessage(dm("你好"));
    assert.equal(calls.create.length, 1);
    assert.equal(calls.create[0].meta.cwd, path.join(storageDir, "workspace"));
    assert.equal(calls.create[0].meta.agentPreset, "standard");
    assert.equal(calls.followup.length, 1);
    const text = calls.followup[0].content.map((block) => block.text).join("\n");
    assert.ok(text.includes("你好"), text);
    assert.deepEqual(replies, [], "no reply until the turn ends");
});

test("the same conversation reuses its session; a different one does not", async () => {
    const { bridge, calls } = makeBridge();
    await bridge.handleRawMessage(dm("第一句"));
    // The live agent is gone after the first call (stub returns undefined from
    // `get`), so the second delivery resumes the recorded session instead.
    await bridge.handleRawMessage(dm("第二句"));
    assert.equal(calls.create.length, 1);
    assert.equal(calls.resume.length, 1);
    assert.equal(calls.resume[0].resumeSessionId, calls.create[0].sessionId);

    await bridge.handleRawMessage(dm("别人来了", { from_user_id: "u9@im.wechat" }));
    assert.equal(calls.create.length, 2, "a new sender gets a new session");
});

test("one answer is sent per turn, from the last assistant message", async () => {
    const { bridge, calls, replies } = makeBridge();
    await bridge.handleRawMessage(dm("在吗"));
    const sessionId = calls.create[0].sessionId;
    bridge.handleSessionEvent(sessionId, { type: "assistant/message", data: { message: { content: [{ type: "text", text: "先查一下" }] } } });
    bridge.handleSessionEvent(sessionId, { type: "assistant/message", data: { message: { content: [{ type: "text", text: "在的。" }] } } });
    bridge.handleSessionEvent(sessionId, { type: "turn/end", data: {} });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].text, "在的。");
    assert.equal(replies[0].conversationId, "u1@im.wechat");
});

test("a session nobody talked to from WeChat never sends", async () => {
    const { bridge, replies } = makeBridge();
    bridge.handleSessionEvent("session-other", { type: "assistant/message", data: { message: { content: [{ type: "text", text: "GUI 里的话" }] } } });
    bridge.handleSessionEvent("session-other", { type: "turn/end", data: {} });
    assert.deepEqual(replies, []);
});

test("a group message not addressed to the bot is ignored", async () => {
    const { bridge, calls, replies } = makeBridge();
    await bridge.handleRawMessage(group("今天吃什么"));
    assert.equal(calls.create.length, 0);
    assert.deepEqual(replies, []);
});

test("a group message that names the bot gets answered in the group", async () => {
    const { bridge, calls } = makeBridge();
    await bridge.handleRawMessage(group("小助手 今天吃什么"));
    assert.equal(calls.create.length, 1);
    const text = calls.followup[0].content.map((block) => block.text).join("\n");
    assert.ok(text.includes("微信群聊"), text);
    assert.ok(text.includes("u2@im.wechat".slice(-6)), "the sender is identified");
    const record = bridge.store.conversation("g1@chatroom");
    assert.equal(record.kind, "group");
});

test("group chats can be switched off entirely", async () => {
    const { bridge, calls } = makeBridge({ config: { groupChatEnabled: false } });
    await bridge.handleRawMessage(group("小助手 在吗"));
    assert.equal(calls.create.length, 0);
});

test("`all` mode answers everything, but respects the cooldown", async () => {
    const { bridge, calls } = makeBridge({ config: { groupReplyWhen: "all", groupCooldownSeconds: 60 } });
    await bridge.handleRawMessage(group("第一句"));
    assert.equal(calls.create.length, 1);
    await bridge.handleRawMessage(group("第二句"));
    assert.equal(calls.create.length, 1, "the second message is inside the cooldown");
});

test("an allowlist restricts direct messages", async () => {
    const { bridge, calls } = makeBridge({ config: { allowedUsers: "someone-else" } });
    await bridge.handleRawMessage(dm("你好"));
    assert.equal(calls.create.length, 0);
});

test("duplicate deliveries of one message are handled once", async () => {
    const { bridge, calls } = makeBridge();
    const raw = dm("重复吗", { message_id: 424242 });
    await bridge.handleRawMessage(raw);
    await bridge.handleRawMessage(raw);
    assert.equal(calls.create.length, 1);
    assert.equal(calls.followup.length, 1);
});

test("/new unbinds the conversation without touching other chats", async () => {
    const { bridge, calls, replies } = makeBridge();
    await bridge.handleRawMessage(dm("先聊一句"));
    await bridge.handleRawMessage(dm("另一个人", { from_user_id: "u9@im.wechat" }));
    assert.equal(calls.create.length, 2);
    await bridge.handleRawMessage(dm("/new"));
    assert.equal(bridge.store.conversation("u1@im.wechat"), undefined);
    assert.ok(bridge.store.conversation("u9@im.wechat"), "the other chat keeps its session");
    assert.ok(replies.some((reply) => reply.text.includes("新会话")));
    await bridge.handleRawMessage(dm("再来一句"));
    assert.equal(calls.create.length, 3, "the next message opens a fresh session");
});

test("text-only is the promise: media gets a notice, not a turn", async () => {
    const { bridge, calls, replies } = makeBridge();
    await bridge.handleRawMessage({
        message_type: MessageType.USER,
        message_state: MessageState.FINISH,
        from_user_id: "u1@im.wechat",
        group_id: "",
        item_list: [{ type: 2, image_item: { media: { encrypt_query_param: "x" } } }],
    });
    assert.equal(calls.create.length, 0);
    assert.equal(replies.length, 1);
    assert.ok(replies[0].text.includes("只处理文字"), replies[0].text);
});

test("a stalled workspace registry never holds up delivery", async () => {
    const { bridge, calls } = makeBridge({ attachHangs: true });
    const startedAt = Date.now();
    await bridge.handleRawMessage(dm("别卡住"));
    const elapsed = Date.now() - startedAt;
    assert.equal(calls.followup.length, 1, "the message still reached the agent");
    assert.ok(elapsed < 12000, `delivery waited ${elapsed} ms on the workspace registry`);
});

let failed = 0;
for (const { name, fn } of tests) {
    try {
        await fn();
        console.log(`ok    ${name}`);
    }
    catch (error) {
        failed += 1;
        console.error(`FAIL  ${name}\n      ${String(error?.message ?? error)}`);
    }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
