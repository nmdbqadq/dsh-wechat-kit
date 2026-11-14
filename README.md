# dsh-wechat-kit

给 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 用的两个微信小程序包：

| 包 | 一句话 |
| --- | --- |
| [`wechat-groupchat`](packages/wechat-groupchat) | 接腾讯 iLink 机器人：私聊里跟人实时回话，群里按规则接话，**每个微信聊天各自一个 DSH 会话** |
| [`dafeiyu-preset`](packages/dafeiyu-preset) | 一条 Agent 预设（角色卡）：话少、爱接梗、只在被叫到时回话的群聊人格 |

两个包互不依赖，可以只装一个。

## 为什么是 iLink 机器人，不是「自己的号」

用自己的微信号接 DSH，得靠桌面客户端自动化（读本地库 + UIA 模拟打字），只在 Windows 能跑、要登录桌面版、有封号风险，微信升级还可能直接失效。

iLink 机器人是腾讯给「机器人号」的通道：扫码登录、纯 HTTP 长轮询、跨平台、不碰客户端内存。代价是它是个独立的机器人号，不是你的号，也不能继承你好友的聊天记录。

要走「自己的号」那条路，见 [docs/use-your-own-account.md](docs/use-your-own-account.md)。

## 安装

要求：DSH `0.2.x`、Node ≥ 20。两个包都是普通 JS，**不需要编译、不需要 Python**。

```bash
# clone 下来，用本地目录安装
git clone https://github.com/<你>/dsh-wechat-kit.git
dsh plugin --profile <profile> add ./dsh-wechat-kit/packages/wechat-groupchat
dsh plugin --profile <profile> add ./dsh-wechat-kit/packages/dafeiyu-preset
```

也可以只装其中一个。装完重启 DSH。

## 快速开始（wechat-groupchat）

1. 打开 `http://127.0.0.1:<DSH 端口>/wechat-group/`
2. 用微信扫码 → 手机上确认 → 页面状态变「已连接」
3. 在微信里找到这个新机器人，随便说句话；想拉进群就拉
4. 群里默认「叫到才回」（正文出现 `机器人 / 小助手 / 助手 / bot / AI`，或你在设置页改的名字）

控制页能改：群聊开关、群里什么时候回、机器人名字、群关键词、允许的私聊/群、冷却时间、单条字数。保存即生效，不用重启。

## 主要设计

- **一个聊天一间会话**：私聊、每个群各自独立，A 群的上下文不会漏进 B 群，私聊历史也不会漏进群。
- **群消息带发言人**：协议只给不透明 id，消息前缀会带上发言人 id 尾巴 + 「这是群聊」的提示，模型才知道自己在跟一屋子人说话。
- **一轮一条回复**：订阅 `session/event`，这一轮 `turn/end` 时取最后一条 assistant 文本发回微信，过程中的工具调用不会变成刷屏。
- **发送配额**：iLink 同一个聊天连发 10 条要等你回一句才解锁，插件在 8 条处自己停手；长回复按 markdown 边界切段，不会把代码块和表格切坏。
- **热重载安全**：控制面挂在 `globalThis`，新实例先释放旧路由再接管，不会出现「页面显示的是死掉的实例」。

## 已知限制

- 只处理**文字**（含微信已转成文字的语音）；图片、文件会回一句「暂时看不懂」。
- 一个机器人 token 同一时间只能有一个客户端长轮询：别和其它微信插件共用同一个机器人号。
- 群成员昵称拿不到，只能看到 id 尾巴，所以它不会 @ 人。
- 发送走 `to_user_id = group_id` 并回显 `context_token`，这是 iLink 的群回复方式。

细节见 [`packages/wechat-groupchat/docs/DETAIL.md`](packages/wechat-groupchat/docs/DETAIL.md)。

## 开发

```bash
cd packages/wechat-groupchat
npm test        # 26 项：路由/群聊策略/markdown/配置/存储/去重/二维码/回合流程
```

测试不需要微信账号，也不需要 DSH：`test/flow.mjs` 用假 Host 跑完整的「消息 → 一次回合 → 一条回复」调用序列。

## 许可

MIT。用的、改的、再发的都随意，不用署名。

`packages/wechat-groupchat/src/ilink/` 下的 iLink 客户端 vendored 自 [dsh-wechat](https://github.com/pan17/dsh-wechat) / [wechat-opencode](https://github.com/pan17/wechat-opencode)（MIT），二维码编码器是 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)（MIT），出处见 `THIRD_PARTY_NOTICES.md`。

本项目与腾讯、DeepSeek 均无隶属关系，用的是非官方通道，使用风险自负。
