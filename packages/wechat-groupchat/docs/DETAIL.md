# 微信群聊助手

把一台 DSH 接到一个微信机器人上。它在私聊里跟人实时回话，在群里按规则接话，并且**每个微信聊天各自一个 DSH 会话**——私聊里聊过的事不会漏到群里，群里 A 的上下文也不会被 B 的提问顶掉。

## 它做什么

| 能力 | 说明 |
| --- | --- |
| 私聊回复 | 任何人给机器人发消息都会得到回复；每个发送者一个独立会话 |
| 群聊接话 | 默认「叫到才回」：消息首行出现机器人名字（或用关键词）我才说话。也可以切成「每条都回」并带冷却 |
| 实时性 | 收消息走长轮询（约 35 秒一次的空转，收到即处理），回复在那一轮 `turn/end` 之后立刻发出，不再等第二个触发 |
| 引用与语音 | 对方引用原消息时会带一句引用提示；微信已经把语音转成文字的，按文字处理 |
| 本地命令 | `/new` 换干净会话 · `/status` 看连接与绑定 · `/id` 看这个聊天的 id · `/help` 一个命令都不花模型额度 |
| 群聊边界 | 群里的会话看不到你私聊里的任何东西；群里的历史也不会喂给私聊 |

## 怎么用

1. 装好插件后打开 **`http://127.0.0.1:<端口>/wechat-group/`**（跟当前 DSH Web 同一个端口），页面里会出现二维码。
2. 用微信扫码、在手机上确认。确认后页面上状态变成「已连接」，机器人就上线了，会一直在后台长轮询。
3. 让机器人**先给你自己发一条消息**（在微信里找到这个机器人，随便说句话），这条私聊就是它的第一个会话。
4. 想让它进群：把这个机器人拉进群。群里的消息默认只回「叫到它」的那种——首行写它的名字（默认是「机器人 / 小助手 / 助手 / bot / AI」里的任意一个），或者在设置页把 `机器人名字` 改成你们群里对它的叫法。
5. 群里想让它主动接话、每条都聊：设置页把「群里什么时候回」改成「每条都回」，并给一个冷却秒数（默认 20 秒），免得刷屏。

设置页保存后立刻生效，不用重启。**换代码才需要重启 DSH。**

## 配置

改设置页最方便；想固定进版本，就写进 profile 的 `cordis.patch.yml` 的 `dsh-wechat-groupchat` 那一行（页面里保存的值优先于 patch）。

| 键 | 默认 | 意思 |
| --- | --- | --- |
| `dmAutoReply` | `true` | 私聊对所有人自动回复。关掉后只有 `allowedUsers` 里的人能触发 |
| `allowedUsers` | 空 | 逗号分隔的微信用户 id 白名单；留空 = 不启用白名单 |
| `groupChatEnabled` | `true` | 是否参加群聊。关掉后群消息完全不处理 |
| `groupReplyWhen` | `mention` | `mention` = 叫到才回；`all` = 每条都回 |
| `botNames` | `机器人,小助手,助手,bot,AI` | 群里叫它什么。iLink 不给 @ 列表，所以按首行文本匹配 |
| `groupKeywords` | 空 | 额外的触发词，首行出现即算叫到 |
| `allowedGroups` | 空 | 只在这些群 id 里回；留空 = 所有群 |
| `groupCooldownSeconds` | `20` | `all` 模式下两条主动回复之间的最小间隔 |
| `maxReplyChars` | `1400` | 单条消息字数上限，超出会拆成连续几条 |
| `storageDir` | `~/.dsh/wechat-groupchat` | 放 token、游标、状态文件的地方（只能写在 patch 里） |
| `workspace` | `<storageDir>/workspace` | 所有会话的工作目录 |
| `reportErrors` | `true` | 一轮出错或没产出时回一句提示，而不是静默 |

## 已知边界

- **机器人必须自己登录一个号**。一个微信机器人 token 同一时间只能有一个客户端在长轮询：如果你已经用 `dsh-wechat` 或 `dsh-im` 的微信渠道登录了某个机器人，本插件要登录**另一个**，否则两边会互相抢消息。
- **群聊看不到成员昵称**。协议只给 `from_user_id` 这种不透明 id，模型看到的是 id 尾巴；它没法在群里点名 @ 某人，也不会知道谁是谁。
- **不接管审批卡/提问卡**。这两类交互仍只在 DSH 界面里处理；微信侧只会因为「这轮没产出」而收到一句提示。
- **iLink 的发送限制照旧**：一个会话里机器人连发 10 条要等你回一条才解锁，本插件在 8 条处就自己停手并记日志；24 小时没互动也不能主动推消息。所以它只在**你发消息之后**回话。
- **只处理文字**（含微信已经转成文字的语音）。图片、文件、表情目前会回一句「暂时看不懂」，不会下载入库。
- **群里默认不接命令**。`/new`、`/status` 这类命令只在私聊里生效；群里要先叫到它。

## 文件放哪

- token：`<storageDir>/auth/token.json`（0o600 / Windows 靠用户目录 ACL）
- 长轮询游标：`<storageDir>/sync-buf.json`
- 聊天 → 会话绑定：`<storageDir>/bridge-state.json`（删掉等于让每个聊天重开新会话，聊天记录本身还在 DSH 里）
- 设置页保存的值：`<storageDir>/config.json`
- 登录二维码：`<storageDir>/login-qr.png`

## 验证状态

已经实际验证过的：

- 打包安装后插件激活、长轮询连上 iLink 网关（真实机器人账号，`connected`）。
- 扫码登录流程：二维码由插件自己编码成 PNG/SVG，扫完在手机上确认后 token 落盘，重启或热重启后自动恢复连接。
- **私聊的一次完整往返**：真机发一条 `.` 进来，会话建出来、agent 跑完、回复发回微信（记录到的回复是「我在，怎么啦？发个点是想让我猜吗。 有事直接说，闲着也能聊。」）。
- 插件的热重启（禁用再启用 bundle）：新版代码接管 `wechat-group` 下全部路由，旧实例的路由被顶掉，不需要重启整个 DSH。
- 控制页在 `/wechat-group/` 正常渲染，设置保存即时生效（写入 `config.json`）。
- 26 项本地测试：路由判定、群聊提及匹配、markdown 扁平化、配置强制转换、状态持久化、去重、二维码编码，以及「一条微信消息 → 一次 agent 回合 → 一轮结束后发一条回复」的完整调用序列。

还没有验证过的（需要在真机上过一遍）：

- **群聊**：把机器人拉进一个群后，`group_id` 是否如协议所描述地出现在消息里、回复是否真的投递到群里。插件侧的路由与策略由测试覆盖，但微信那一端没试过。
- 图片、文件、表情：明确不支持（会回一句提示），也没有下载入库的代码路径。

---

实际踩到并已修掉的两点，留作参考：

1. **热重启会撞路由**：`webserver.register` 对重复的 (kind, path) 直接抛错，旧代插件留下的注册不会自己消失，新代就注册不上，页面会一直显示死掉的那个实例。现在控制面挂在 `globalThis` 的同一个对象上，新实例先释放旧路由、再接管自己的路径。
2. **「把会话挂到工作区」不能挡在投递前面**：这一步是纯装饰（侧边栏分组），但工作区服务卡住时它会拖住整条消息。现在它有 8 秒上限，超时就跳过。

## English

Connects one WeChat (iLink) bot to DSH. It replies in direct messages, answers in group chats according to a policy (`mention` by default, `all` with a cooldown), keeps one DSH session per WeChat conversation, and exposes a standalone control page at `/wechat-group/` for the login QR, the rules and the bindings. Text only; group members are addressed by opaque id tails; the bot must have its own WeChat bot account, because one bot token cannot be long-polled by two clients.
