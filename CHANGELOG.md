# Changelog

## 0.1.0 — 2026-11-14

首个版本。

### wechat-groupchat

- 扫码登录 iLink 机器人（二维码由插件本地编码成 PNG / SVG），token 落盘，重启自动恢复
- 每个微信聊天一间 DSH 会话：私聊任意发送者、每个群各自独立
- 群聊策略：`mention`（默认，正文出现名字/关键词才回）/ `all`（每条都回，带冷却）
- 一回合一条回复：订阅 `session/event`，`turn/end` 时取最后一条 assistant 文本发出
- 长回复按 markdown 边界切段（代码块、表格不被切坏）；单会话 10 分钟 8 条的发送配额
- 本地命令 `/new` `/status` `/id` `/help`，不产生模型调用
- 控制页 `/wechat-group/`：状态、二维码、规则表单、会话列表、最近日志
- 热重载安全：控制面挂在 `globalThis`，新实例释放旧路由再接管
- 「把会话挂进工作区」有 8 秒上限，工作区服务卡住不挡消息投递
- 26 项测试：路由、群聊策略、mention 匹配、markdown 扁平化、配置强制转换、状态持久化、去重、二维码编码、回合流程

### dafeiyu-preset

- 一条 `@deepseek-ai/dsh-agent-preset` 预设（id `dafeiyu`）：persona 前缀 + 收窄的工具集（联网搜索、出图、文件读写、时间）
