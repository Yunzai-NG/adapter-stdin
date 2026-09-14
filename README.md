# adapter-stdin

Yunzai NG 的标准输入适配器：**把终端本身当作一个账号**。在终端里敲一行就是一条私聊消息，
机器人的回复直接打印回终端。

用于在没有 QQ、没有 NapCat 的环境下调试插件 —— 改完代码敲一条命令，就能看到整条链路
（事件 → 中间件 → 命令匹配 → `e.reply()` → 适配器）是否通了。

本仓库是 [Yunzai NG](https://github.com/Yunzai-NG/yunzai-ng) 的官方可选插件，不随内核分发。

## 安装

推荐经面板的插件市场安装：面板 → 插件市场 → 搜索 `adapter-stdin` → 安装。**装依赖与编译都由
内核代跑**（索引里声明了 `setup.scripts: ["build"]`），故这条路装完即可用 —— 本仓库的
`dist/` 不进 git，不编译就没有入口。

亦可手工克隆至主目录的 `plugins/` 下，那时两步都要自己来：

```powershell
cd <主目录>\plugins
git clone https://github.com/Yunzai-NG/adapter-stdin.git
cd adapter-stdin
pnpm install
pnpm run build
```

随后在面板的插件页重载，或重启内核。

## 使用

首次加载后于 `<主目录>/config/adapter-stdin.yaml` 生成配置文件，亦可在面板的插件页直接编辑。
在其中加一个账号，或直接经面板的账号页添加（适配器选 `stdin`）：

```yaml
accounts:
  - label: 终端
    uid: console
    enable: true
```

`uid` 是账号自己的 id；终端里那个人的 id 固定为 `console-user`，不可配。

随后在运行内核的那个终端里直接输入即可：

```
[stdin] 终端 已就绪，直接输入即可与机器人对话
> 帮助
系统消息: 帮助
发送文本:
帮助
```

直接敲回车（不输入任何内容）也会打出一行 `系统消息: (空行)` —— 那是"输入这条路是通的"
的凭据。排查"敲命令没反应"时，先看有没有这行：有则问题在命令匹配，没有则问题在终端或适配器。

配置项：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `label` | `终端` | 显示名，即这个"账号"的昵称 |
| `uid` | `console` | **该账号自己的 id**，不是发件人的。主人列表里不要填这个 |
| `enable` | `true` | 关掉则只出一个空转账号，不占用标准输入 |
| `echoInput` | `true` | 是否回显输入行 |
| `catimg` | `true` | 是否允许用 `catimg` 在终端里直接画出图片；关闭则只打印图片路径 |
| `ansi` | `auto` | 终端着色。`auto` 按标准错误是否为终端判定 |
| `historySize` | `20` | 启动时回读多少条历史输入 |
| `historyFile` | 空 | 历史记录文件；留空则用本插件数据目录下的 `history` |

历史记录的格式与 TRSS-Yunzai 的 `data/stdin/history` 一致（每行 `<base36 时间戳>:<文本>`），
从旧框架迁移过来的使用者可以把旧文件直接指过来。

### 想用主人权限调试

终端输入的发件人固定是 **`console-user`**，与账号的 `uid`（默认 `console`）**不是同一个值**。
两者必须不同：内核的 `bot.ignoreSelf` 会把"发件人 id 等于机器人自身 id"的消息当成
机器人自言自语丢掉，而那正是本适配器最初照抄 TRSS 时踩的坑 —— 表现是敲什么都没反应。

所以要用 `#重启` 一类主人指令，填的是**发件人**的 id：

```yaml
# config/yunzai.yaml
bot:
  masterQQ:
    - console-user
```

## 已知行为

**日志与回复走不同的流。** 内核日志走标准输出，本适配器的回复与提示走标准错误。想在终端里
看得清楚就把标准输出重定向掉：

```powershell
pnpm start > logs/console.log      # 终端里只剩对话
```

**标准输入被重定向时账号会报错。** 判据是 `process.stdin.isTTY === true`；管道、`< file`、
CI 等场景下它不成立，账号进入 `error` 状态并周期性重连。两条出路，报错文案里都写了：

- `FORCE_TTY=1` 强制启用（仍从标准输入读，只是跳过 TTY 检查）
- 在配置里把该账号的 `enable` 置为 `false`

**`Ctrl+C` 是停机，不是清行。** 终端里的 `Ctrl+C` 被转交给内核的信号处理，走优雅停机。
想退出账号用 `Ctrl+D`（标准输入结束），或直接停掉内核。

**没有群聊。** 终端里不存在群，故本适配器只实现私聊。`bot.caps` 里不含任何群能力，
插件用 `bot.caps.has("groupMute")` 一类判定会如实得到 `false`，不会让插件以为自己在群里。

## 手工验证

单测覆盖的是纯函数（配置校验、历史记录、终端渲染、媒体落盘）；标准输入本身依赖真实终端，
不做自动化测试，按下列步骤手工过一遍：

1. `pnpm start` 起内核，加一个 `stdin` 账号
2. 终端敲一条已装插件的命令 → 确认输入行正常回显、机器人回复打印在标准错误上
3. 敲 `Ctrl+D` → 确认账号离线且**不再重连**
4. 起内核后敲 `Ctrl+C` → 确认走内核的优雅停机，而不是被 readline 吃掉
5. `pnpm start > out.log` 起一次 → 确认账号进入 `error`，报错文案里点名了 `FORCE_TTY`
   与"禁用该账号"
6. `FORCE_TTY=1 pnpm start > out.log` 再起一次 → 确认可以正常工作

## 开发

本插件依赖 `@yunzai-ng/core` 与 `@yunzai-ng/types`，两者声明为 `peerDependencies`
（运行期由宿主内核提供，插件目录内不应再装一份）。**框架发布至 npm 之前**，需先链接本地
框架 checkout：

```powershell
git clone https://github.com/Yunzai-NG/yunzai-ng.git
cd yunzai-ng
pnpm install
pnpm run build          # 必需：本插件的 tsc 读取框架的 dist/*.d.ts

cd ..\adapter-stdin
pnpm install
pnpm run link:framework # 在 node_modules/@yunzai-ng 下建立指向框架的链接
pnpm run verify         # build → typecheck:test → lint → test
```

`link:framework` 按 `YZNG_FRAMEWORK` 环境变量 → `../yunzai-ng` → `../../yunzai-ng` →
`../../code` 的顺序查找框架仓库。目录布局与上述不同时设置该环境变量即可：

```powershell
$env:YZNG_FRAMEWORK = "c:\path\to\yunzai-ng"
```

框架发布之后，`pnpm install` 即可满足依赖，该步骤不再必需。

写适配器插件时容易踩的几个坑（事件提交的两道闸门、`connect()` 不得等待输入、abort 与
`disconnect()` 的先后）见
[插件开发文档](https://github.com/Yunzai-NG/yunzai-ng/blob/main/docs/plugin-development.md#写一个适配器插件)。

## 许可

AGPL-3.0-or-later
