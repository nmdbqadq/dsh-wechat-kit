/**
 * The plugin's standalone control page.
 *
 * Served by the Host at `/wechat-group/` and opened as its own tab (the same way
 * the other WeChat channel exposes its QR page). It is not a client-plugin slot,
 * so it may not be embedded in an iframe; it carries its own colours and follows
 * the OS light/dark preference. Everything it shows comes from the JSON status
 * endpoint — the page holds no state of its own.
 */

const STYLE = `
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9;
    --panel: #ffffff;
    --text: #1d2129;
    --muted: #6b7280;
    --line: #e5e7eb;
    --accent: #07c160;
    --warn-bg: #fff7e6;
    --warn-text: #8a5a00;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17181a;
      --panel: #202124;
      --text: #eceff3;
      --muted: #9aa3ad;
      --line: #2f3237;
      --warn-bg: #2c2413;
      --warn-text: #f0c675;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 28px 20px 56px;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.6 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 20px; }
  section {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 16px 18px;
    margin-bottom: 14px;
  }
  h2 { font-size: 14px; margin: 0 0 12px; font-weight: 600; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
  .row > label { min-width: 132px; color: var(--muted); }
  input[type="text"], input[type="number"], select {
    flex: 1 1 260px;
    min-width: 160px;
    padding: 7px 10px;
    border-radius: 8px;
    border: 1px solid var(--line);
    background: var(--bg);
    color: var(--text);
    font: inherit;
  }
  button {
    padding: 7px 16px;
    border-radius: 8px;
    border: 1px solid var(--line);
    background: var(--panel);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button:disabled { opacity: .55; cursor: default; }
  .badge {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 999px;
    border: 1px solid var(--line);
    font-size: 12px;
    color: var(--muted);
  }
  .badge.ok { color: var(--accent); border-color: var(--accent); }
  .qr { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; }
  .qr img { width: 208px; height: 208px; image-rendering: pixelated; border-radius: 10px; background: #fff; }
  .warn {
    background: var(--warn-bg);
    color: var(--warn-text);
    border-radius: 8px;
    padding: 8px 12px;
    margin: 8px 0;
    font-size: 13px;
  }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 500; }
  code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  .logs {
    margin: 0;
    max-height: 220px;
    overflow: auto;
    padding: 10px 12px;
    border-radius: 8px;
    background: var(--bg);
    border: 1px solid var(--line);
    font: 12px/1.5 ui-monospace, Consolas, monospace;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .muted { color: var(--muted); }
  #toast { min-height: 20px; color: var(--accent); font-size: 13px; }
`;

const SCRIPT = `
const $ = (id) => document.getElementById(id);
const state = { status: null };

const LABELS = {
  starting: "启动中", "waiting-scan": "等待扫码", scaned: "已扫码，等待确认",
  connected: "已连接", reconnecting: "重连中", error: "出错", stopped: "已停止",
  "no-token": "未登录",
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function render(status) {
  state.status = status;
  const badge = $("phase");
  badge.textContent = LABELS[status.phase] || status.phase;
  badge.className = "badge" + (status.phase === "connected" ? " ok" : "");
  $("bot").textContent = status.botId ? status.botId : "—";
  $("ws").textContent = status.workspace || "—";
  $("err").textContent = status.error || "";
  $("err").style.display = status.error ? "block" : "none";

  const warnings = $("warnings");
  warnings.innerHTML = (status.warnings || []).map((w) => '<div class="warn">' + esc(w) + '</div>').join("");

  const qr = $("qrbox");
  if (status.qrAvailable && status.phase !== "connected") {
    qr.style.display = "flex";
    const img = $("qrimg");
    if (img.dataset.ts !== String(status.qrUpdatedAt)) {
      img.dataset.ts = String(status.qrUpdatedAt);
      img.src = "/wechat-group/qr.png?ts=" + encodeURIComponent(status.qrUpdatedAt);
    }
  } else {
    qr.style.display = "none";
  }

  const body = $("convs");
  const rows = status.conversations || [];
  body.innerHTML = rows.length === 0
    ? '<tr><td colspan="4" class="muted">还没有任何聊天。给机器人发一条微信消息就会出现。</td></tr>'
    : rows.map((c) => '<tr><td>' + (c.kind === "group" ? "群聊" : "私聊") + '</td>'
        + '<td><code>' + esc(c.conversationId) + '</code></td>'
        + '<td><code>' + esc(c.sessionId || "—") + '</code></td>'
        + '<td>' + esc(c.lastPreview || "—") + '</td></tr>').join("");

  $("logs").textContent = (status.logs || []).join("\\n") || "（还没有日志）";
}

function fillForm(config) {
  if (document.activeElement && document.activeElement.closest("form")) return;
  $("groupChatEnabled").value = config.groupChatEnabled ? "on" : "off";
  $("groupReplyWhen").value = config.groupReplyWhen;
  $("botNames").value = config.botNames;
  $("groupKeywords").value = config.groupKeywords;
  $("dmAutoReply").value = config.dmAutoReply ? "on" : "off";
  $("allowedUsers").value = config.allowedUsers;
  $("allowedGroups").value = config.allowedGroups;
  $("groupCooldownSeconds").value = config.groupCooldownSeconds;
  $("maxReplyChars").value = config.maxReplyChars;
}

async function poll() {
  try {
    const response = await fetch("/wechat-group/api/status", { cache: "no-store" });
    const status = await response.json();
    render(status);
    if (!document.activeElement || !document.activeElement.closest("form")) fillForm(status.config);
  } catch (error) {
    $("err").textContent = "读取状态失败：" + error;
    $("err").style.display = "block";
  }
}

async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const result = await response.json().catch(() => ({}));
  $("toast").textContent = result.message || (response.ok ? "已保存" : "操作失败");
  setTimeout(() => { $("toast").textContent = ""; }, 4000);
  await poll();
}

$("save").addEventListener("click", () => {
  post("/wechat-group/api/config", {
    groupChatEnabled: $("groupChatEnabled").value === "on",
    groupReplyWhen: $("groupReplyWhen").value,
    botNames: $("botNames").value,
    groupKeywords: $("groupKeywords").value,
    dmAutoReply: $("dmAutoReply").value === "on",
    allowedUsers: $("allowedUsers").value,
    allowedGroups: $("allowedGroups").value,
    groupCooldownSeconds: Number($("groupCooldownSeconds").value),
    maxReplyChars: Number($("maxReplyChars").value),
  });
});
$("relogin").addEventListener("click", () => post("/wechat-group/api/relogin"));
$("logout").addEventListener("click", () => post("/wechat-group/api/logout"));

poll();
setInterval(poll, 2000);
`;

export function renderPage() {
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>微信群聊助手 · DeepSeek Harness</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>微信群聊助手</h1>
  <p class="sub">把一台 DSH 接到一个微信机器人上：私聊里跟人实时回话，群里按规则接话。每个聊天各自一个 DSH 会话。</p>

  <section>
    <div class="row"><span id="phase" class="badge">…</span><span class="muted">机器人</span><span id="bot">—</span></div>
    <div class="row"><span class="muted">工作目录</span><code id="ws">—</code></div>
    <div id="err" class="warn" style="display:none"></div>
    <div id="warnings"></div>
    <div id="qrbox" class="qr" style="display:none">
      <img id="qrimg" alt="微信扫码登录" />
      <div>
        <strong>用微信扫这个码</strong>
        <div class="muted">扫完在手机上确认，机器人就登录了。二维码过期会自动刷新。</div>
      </div>
    </div>
    <div class="row">
      <button id="relogin">重新扫码</button>
      <button id="logout">退出登录</button>
      <span id="toast"></span>
    </div>
  </section>

  <section>
    <h2>群聊与私聊规则</h2>
    <form onsubmit="return false">
      <div class="row"><label>参加群聊</label>
        <select id="groupChatEnabled"><option value="on">开</option><option value="off">关</option></select></div>
      <div class="row"><label>群里什么时候回</label>
        <select id="groupReplyWhen">
          <option value="mention">叫到我才回（按名字/关键词）</option>
          <option value="all">每条都回（受冷却限制）</option>
        </select></div>
      <div class="row"><label>机器人名字</label>
        <input id="botNames" type="text" placeholder="机器人,小助手,助手" />
      </div>
      <div class="row"><label>群关键词</label>
        <input id="groupKeywords" type="text" placeholder="可选，逗号分隔" />
      </div>
      <div class="row"><label>群里冷却（秒）</label>
        <input id="groupCooldownSeconds" type="number" min="0" max="3600" step="1" /></div>
      <div class="row"><label>私聊自动回复</label>
        <select id="dmAutoReply"><option value="on">所有人</option><option value="off">只在白名单</option></select></div>
      <div class="row"><label>允许的私聊 id</label>
        <input id="allowedUsers" type="text" placeholder="留空 = 名单不生效" /></div>
      <div class="row"><label>允许的群 id</label>
        <input id="allowedGroups" type="text" placeholder="留空 = 所有群" /></div>
      <div class="row"><label>单条回复字数</label>
        <input id="maxReplyChars" type="number" min="200" max="4000" step="50" /></div>
      <div class="row"><button id="save" class="primary">保存</button>
        <span class="muted">保存后立即生效，不需要重启。</span></div>
    </form>
  </section>

  <section>
    <h2>已接入的聊天</h2>
    <table>
      <thead><tr><th>类型</th><th>聊天 id</th><th>DSH 会话</th><th>最近一句</th></tr></thead>
      <tbody id="convs"></tbody>
    </table>
  </section>

  <section>
    <h2>最近日志</h2>
    <pre id="logs" class="logs"></pre>
  </section>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}


