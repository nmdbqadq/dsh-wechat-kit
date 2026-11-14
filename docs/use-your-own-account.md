# 用自己的微信号接 DSH（可选路线）

`wechat-groupchat` 走的是 iLink 机器人通道：独立机器人号、纯 HTTP、跨平台。它的代价是「不是你的号」。

想让 DSH 直接用**你自己（或小号）的微信号**收发，只能走桌面客户端自动化。这条路不本仓库维护，用的是开源项目：

```
dsh plugin --profile <profile> add github:thawline/dsh-wechat-bridge
```

- 仓库：<https://github.com/thawline/dsh-wechat-bridge>（MIT，上游 `Yuuyuko-uu/dsh-wechat-bridge`）
- 原理：**读**微信 4.x 的本地 SQLite（只读）收消息；**写**靠 Windows UI Automation + 剪贴板，驱动真实客户端打字
- 平台：仅 Windows；要求微信 4.1.12+ 且已登录
- 风险：非官方接口，**有封号风险，建议用小号**；微信升级后 UIA 控件地址可能漂移导致发送失效

## 实测踩过的坑

这几条是在一台 Windows + 微信 4.1.13.7 的机器上真踩出来的，按顺序排：

### 1. `inject` 少了 `tools`，两个工具挂不上

`lib/host.js` 顶部：

```js
export const inject = ['agents', 'sessions', 'sessionTitle', 'webServer', 'workspaceRegistry', 'timer']
```

但后面用 `ctx.tools.register(...)` 注册 `wechat_bind` / `wechat_block`，宿主会直接报
`cannot get property "tools" without inject`，两个工具静默消失。补一个 `'tools'` 就好。

### 2. OCR 依赖 `winsdk`，而它只有 Python ≤ 3.12 的轮子

桥接的发送路径要用 Windows 自带的 WinRT OCR 定位会话，`winsdk` 是它的依赖。PyPI 上 `winsdk` 最新版只到 `cp312`，Python 3.13/3.14 装不上（源码编译也会失败）。

做法：单独装一个 Python 3.12（官方安装器要管理员权限，用免安装的 embeddable 包更省事），在里面
`pip install wechatauto-replica winsdk`，然后在插件设置里把「解释器」指向那个 `python.exe`。

注意插件会**优先用它自己建的 venv**（如果那个 venv 能 import wechatauto / numpy），所以旧 venv 要改名让位，否则设置里的解释器会被忽略。

### 3. 群聊默认「三路都进」，想只认 @ 得改一行

`bridge/wechat_bridge.py` 里：

```python
called = at_me or is_master(sender, nickname) or chat in CFG.get("活跃群", [])
```

这意味着**主人随便说句话**、或群在「活跃群」名单里，都会被当成在叫它。想让群里只在被 @ / 被叫名字时回话：

```python
if not at_me:
    return
```

### 4. 别拿 `Get-Process` 判断微信死活

沙箱/权限过滤下 `Get-Process Weixin` 会返回空，看起来像「微信崩了」，其实进程好好的。判断客户端在不在，以桥接日志里的 `当前账号 wxid` / `WeChatGUI 初始化成功：hwnd=...` 为准。

### 5. UIA 的「热激活」不一定会崩，先别急着关

桥接为了让微信 4.x 的 UIA 控件树物化，会往 `Weixin.dll` 写一个字节（按版本硬编码的 RVA）。本机 4.1.13.7 实测写完客户端照常活着、UIA 也能用；但官方文档也提醒大版本升级后 RVA 会漂移。真遇到写崩的小版本，设 `WX_BRIDGE_NO_UIA=1` 退回 OCR（慢一点、会短暂抢焦点）。

## 两条路怎么选

| | iLink 机器人（本仓库） | 自己的号（第三方桥接） |
| --- | --- | --- |
| 身份 | 独立机器人号 | 你的微信号 |
| 群聊 | 支持 | 支持 |
| 平台 | 跨平台 | 仅 Windows |
| 依赖 | 只要 Node | 微信桌面版 + Python 3.12 + 视觉模型 |
| 封号风险 | 低（官方通道） | 有 |
| 历史消息 | 拿不到 | 能读本地库 |
