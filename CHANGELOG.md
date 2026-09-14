# 更新日志

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## 0.1.0 — 2026-09-14

首个版本。把终端本身当作一个账号接进内核：从标准输入读一行即一封私聊消息，机器人的回复打印
回终端。用于在没有 QQ、没有 NapCat 的环境下跑通整条命令链路。

### 变更

- **不再发 npm**：沿用 adapter-napcat 与 renderer-puppeteer 已有的做法，加 `private`、不加
  `files` —— 发布清单在没有发布动作时不描述任何事实。
- 支持终端着色（`auto` / `always` / `never`）、`catimg` 出图与降级、历史记录回读。
- 历史记录格式与 TRSS-Yunzai 的 `data/stdin/history` 一致（每行 `<base36 时间戳>:<文本>`），
  从旧框架迁移过来的使用者可以把旧文件直接指过来。
