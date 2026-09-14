/**
 * 模块职责：`BotDriver` 实现 —— 把终端接成内核的一个账号
 * 依赖方向：依赖 config / console / history / media 与类型包、内核的公开入口
 * 生命周期：一个账号一个实例；`connect()` 与 `disconnect()` 各调用一次
 * 注意事项：**本文件是"进程内适配器"的完整样例，有三处与网络适配器不同，必须做对：**
 *
 *          **一、`connect()` 里绝不能 await 用户输入。** 内核的连接流程是
 *          `await driver.connect()` → 建 Bot 门面 → `handle.attach(facade)`
 *          （见 adapter/accounts.ts 的 `#doConnect`），而 `host.submit()` 在门面
 *          绑定之前一律丢弃事件（见 adapter/host.ts 的"闸门二"）。若 `connect()`
 *          等到第一行输入才返回，那一行必然投递到一个还没有门面的宿主上，被静默丢掉 ——
 *          症状是"第一次敲命令没反应，第二次才正常"。
 *          故 `connect()` 只建 readline 并立即返回，行事件在之后任意时刻投递。
 *
 *          **二、`close` 事件不等于"用户退出"。** 内核 `#teardown()` 的顺序是先
 *          abort signal、再回收登记、最后才 `await driver.disconnect()`。本驱动
 *          `disconnect()` 里会关掉 readline，那会触发 `close` 事件 —— 若把
 *          `close` 一律当作"用户按了 Ctrl+D"，则每次停机、每次热重载都会把账号
 *          报成"输入结束"并排入重连。故用一个 `closing` 标志区分两者。
 *
 *          **三、readline 的拆除要挂在宿主信号上，不只挂在 `disconnect()` 上。**
 *          `AccountManager.detachAdapter()`（插件卸载路径）是同步函数，它 abort
 *          signal 后把 `disconnect()` 挂到 `rt.closing` 上异步收尾。信号一 abort
 *          就拆除监听，可以保证"插件已卸载"之后 stdin 上不再挂着本插件的处理器 ——
 *          否则下次装回来会有两份 `line` 监听，一行输入投两次。
 */
import { createInterface } from "node:readline"
import type { Interface as ReadlineInterface } from "node:readline"
import { join } from "node:path"
import type {
  AdapterHost,
  BotCapability,
  BotDriver,
  ForwardNode,
  GroupInfo,
  MemberInfo,
  MemberListOptions,
  MessageContent,
  MessageRecord,
  SendOptions,
  SendResult,
  SendTarget,
  Segment,
  UserInfo
} from "@yunzai-ng/types"
import { toSegments } from "@yunzai-ng/core"
import { PLATFORM } from "./platform.js"
import type { StdinAccount } from "./config.js"
import { useAnsi } from "./config.js"
import { renderMessage, writeLine } from "./console.js"
import { createHistoryLog } from "./history.js"
import type { HistoryLog } from "./history.js"
import { tailHistory } from "./history.js"

/**
 * 本适配器声明支持的可选能力
 *
 * 只给 `recall`，且它是**装饰性**的：终端里撤回一条已经打在屏幕上的消息无从实现，
 * `recallMessage()` 只打印一行说明。仍要声明它，是因为内核的门面在
 * `recallAfter` 被设置而 `caps` 不含 `recall` 时会打一条"适配器不支持撤回"的警告 ——
 * 而调试场景下这条警告会指向插件作者写错了能力判断，与真实原因无关。
 *
 * **群相关能力一律不给。** 终端里没有群，让 `bot.caps.has("groupMute")` 如实返回
 * false，插件的能力探测才能得到与真实平台一致的结果。
 */
const CAPS: readonly BotCapability[] = ["recall"]

/** 终端账号的昵称兜底 */
const DEFAULT_NICKNAME = "终端"

/**
 * 终端输入的发件人 id
 *
 * 导出是为了让测试能断言"发件人 ≠ `selfId`" —— 那是本适配器唯一一个曾在真机上
 * 让整个功能失效的约定，值得由测试把它钉住，而不是靠注释提醒后来者。
 */
export const SENDER_ID = "console-user"

/**
 * 创建驱动所需的外部依赖
 *
 * 这几项来自插件上下文（`ctx.*`），因为它们是**插件级**的：媒体目录、历史记录文件
 * 的默认位置、静态资源的挂载前缀都不随账号变。账号级的配置走 `account`。
 */
export interface StdinBotDeps {
  /** 适配器 id，用于日志与拼 URL */
  adapterId: string
  /** 本插件的数据目录（历史记录默认落在这里） */
  dataDir: string
  /** 媒体落盘目录 */
  mediaDir: string
  /** 内置服务器可用时的 URL 基址；不可用时 undefined */
  publicBase: string | undefined
}

/**
 * 判别 `process.stdin` 是否可交互
 *
 * **判定写成 `=== true` 而非真值判断**：Windows 上经 Git Bash / MSYS 启动的
 * Node 里 `process.stdin.isTTY` 可能是 `undefined` 而非 `false`，两种写法结果相同，
 * 但真值判断会同时放行 `0`、`""` 一类意外取值，而那些恰恰意味着"不可交互"。
 * @param force 配置或环境变量显式要求接管
 * @returns 是否可交互
 */
export function stdinUsable(force: boolean): boolean {
  if (force) return true
  if (process.env["FORCE_TTY"] !== undefined && process.env["FORCE_TTY"] !== "") return true
  return process.stdin.isTTY === true
}

/**
 * 构造 stdin 不可用时的错误
 *
 * 文案里**必须给出出路**：这条错误会显示在面板的账号状态上，而使用者看到
 * "不是交互式终端"时的第一反应是"那我该怎么办"。两条出路分别对应两种真实用法 ——
 * 容器/守护进程里想要一个能收发的账号（`FORCE_TTY`），以及本来就只想要日志
 *（禁用该账号）。
 * @returns 错误
 */
function unusableError(): Error {
  return new Error(
    "标准输入不可用：当前进程的标准输入不是交互式终端（已重定向、或是以守护进程/服务方式启动）。" +
      "若确认终端可用但仍报此错（如 Git Bash 下启动），设置环境变量 FORCE_TTY=1 强制接管；" +
      "若本就不需要终端对话，请在面板中禁用这个账号"
  )
}

/**
 * 创建一个终端账号驱动
 * @param account 已校验的账号配置
 * @param host 内核提供的宿主能力
 * @param deps 插件级依赖
 * @returns 账号驱动（尚未连接）
 */
export function createStdinBot(account: StdinAccount, host: AdapterHost, deps: StdinBotDeps): BotDriver {
  /** 平台账号 id —— 终端没有真实 id，用配置里的 uid 顶替 */
  const selfId = account.uid
  /**
   * 终端前那个人的 id
   *
   * 与 `selfId` 必须不同，理由见 `submitLine()`。固定值而非配置项：终端里
   * 只可能坐着一个人，"谁在敲键盘"没有第二个答案，做成可配只是徒增一个
   * 填错的入口。主人列表要填的就是这个值。
   */
  const senderId = SENDER_ID
  /** readline 实例；未连接时 undefined */
  let rl: ReadlineInterface | undefined
  /** 是否正在主动关闭（见文件头第 2 点） */
  let closing = false
  /** 是否已连接 */
  let connected = false

  const historyFile = account.historyFile.trim() === "" ? join(deps.dataDir, "history") : account.historyFile.trim()

  /** 终端着色与渲染参数 */
  const renderOpts = {
    logger: host.logger,
    ansi: useAnsi(account.ansi),
    catimg: account.catimg,
    mediaDir: deps.mediaDir,
    publicBase: deps.publicBase
  }

  /** 历史记录句柄 */
  const history: HistoryLog = createHistoryLog(historyFile, host.logger)

  /**
   * 构造一条私聊事件并投递
   *
   * **发件人必须与账号自身是两个 id，这一条不能照抄 TRSS。**
   *
   * 参考实现（TRSS 的 `plugins/adapter/stdin.js`）里 `self_id`、`user_id` 与
   * `sender.user_id` 是同一个值，那在 TRSS 上无害 —— 它通篇没有拿这两个值做
   * 相等判断，防的是 `self_id:user_id:raw_message` 这条 1 秒去重键。
   * 而本内核在 `pipeline/dispatch.ts` 的 `#acceptMessage` 开头就是
   * `if (policy.ignoreSelf && sender.uid === bot.selfId) return false`，
   * 且 `bot.ignoreSelf` 默认为 true。照抄的结果是**每一条终端输入都在进路由
   * 之前被当成"机器人自己发的"丢掉**，症状为"敲什么都没反应"，
   * 且日志里连一条"命令命中"都不会有 —— 排查时极易误判成命令没注册上。
   *
   * 反过来，把两者分开也是更正确的模型：终端前坐着的是"人"，账号是"机器人"，
   * 现实里它们不可能同 id。这样 `ignoreSelf` 的语义才是它字面的意思。
   *
   * **空行也要投。** TRSS 的实现（`stdin.js` 的 `message()`）对任何一行都写历史、
   * 都发事件，不判空 —— 于是终端里敲一下回车，控制台立刻多一行"系统消息:"，
   * 使用者由此确认"输入这条路是通的"。本适配器起初把空行直接 return 掉了，
   * 结果是敲回车毫无反馈，在一个"敲什么都没反应"的排障场景里，这恰恰抹掉了
   * 唯一一个能说明"输入侧正常"的信号。
   *
   * 空行走完整条管线是安全的：内核在前缀与正则两道判定上都不会命中任何命令，
   * 最坏的结果就是不回话。它不会触发任何命令，故不构成误触。
   * @param text 输入行
   */
  const submitLine = (text: string): void => {
    history.append(text)

    const time = Date.now()
    const user: UserInfo = { uid: senderId, name: account.label }
    host.submit({
      kind: "message",
      scene: "private",
      subType: "console",
      messageId: time.toString(36),
      message: [{ type: "text", text }],
      sender: user,
      raw: { source: "stdin", line: text }
    })
  }

  /**
   * 拆除 readline
   *
   * 幂等：宿主信号的 abort 与 `disconnect()` 会各调一次。
   */
  const teardownInput = (): void => {
    const current = rl
    if (current === undefined) return
    rl = undefined
    closing = true
    try {
      current.close()
    } catch {
      // close 在已关闭的接口上抛错，而这条路正是"两条拆除路径都跑了"的常态
    }
  }

  /**
   * 建立 readline 并接管标准输入
   * @throws 标准输入不可用时
   */
  const setupInput = (): void => {
    if (!account.enable) {
      host.logger.info("账号配置中「接管标准输入」处于关闭状态，本账号只回应答侧，不读取终端输入")
      return
    }
    if (!stdinUsable(false)) throw unusableError()

    // output 用 stderr：readline 的提示符与回显必须与日志分离，见 console.ts 文件头
    const iface = createInterface({
      input: process.stdin,
      output: process.stderr,
      // terminal 显式给出：readline 自己会嗅探，但它嗅探的是 `output.isTTY`，
      // 而使用者可能只重定向了 stderr（`2>err.log`）。那种情形下按"非终端"处理，
      // 不注入提示符与控制字符，重定向出来的文件才干净
      terminal: process.stderr.isTTY === true
    })

    iface.on("line", line => {
      /*
       * 收到输入先落一行日志，**空行也落**。
       *
       * 这是终端侧唯一一个"输入侧活着"的可见信号，TRSS 用 `系统消息: <文本>`
       * 做同一件事。少了它，一个"敲命令没反应"的场景里使用者无从分辨是
       * "输入没进来"还是"命令没匹配上" —— 而这两者的排查方向完全不同
       * （前者查终端与适配器，后者查插件与正则）。
       *
       * 用 `mark` 级别而非 `info`：它是给人看的状态行，不是事件记录，
       * 该在常规日志级别下就显示出来。空行时补一个占位词，否则日志里只有
       * 一个光秃秃的前缀，看不出发生过什么。
       */
      host.logger.mark(`系统消息: ${line === "" ? "(空行)" : line}`)

      // 回显：readline 在有提示符时会自己回显，没有提示符时（非终端）不会。
      // 统一在这里补一次，使两种情形下历史记录的观感一致
      if (account.echoInput && process.stderr.isTTY !== true) writeLine(line)
      submitLine(line)
    })

    iface.on("close", () => {
      rl = undefined
      // 只有"不是我们主动关的"才算输入结束（见文件头第 2 点）。
      // 报给内核走完整下线流程：摘 Bot 注册表、发 bot/offline、排入退避重连 ——
      // 重连会重新建一个 readline，即"按了 Ctrl+D 之后还能再按一次回车继续用"
      if (!closing && connected) {
        host.logger.info("标准输入已关闭（Ctrl+D 或输入流结束），账号将按策略重连")
        host.setStatus("offline", { error: "标准输入已关闭" })
      }
    })

    iface.on("SIGINT", () => {
      /*
       * readline 装上 SIGINT 监听之后，Ctrl+C 不再触发进程的默认行为 ——
       * 而内核的优雅停机正是靠 `process.on("SIGINT")` 实现的（见 kernel/app.ts
       * 的 `handleSignals`）。此处**必须自己把它转发回去**，否则 Ctrl+C 会变成
       * "清空当前输入行"，使用者会发现停机快捷键在这里失灵。
       *
       * 转发的做法是重新 emit 到 process 上。readline 只是 `process` 的一个监听器，
       * 它吞掉的是"默认终止进程"这一行为，不是信号本身；手动 emit 后内核那条监听
       * 照常收到。
       */
      process.emit("SIGINT")
    })

    rl = iface
  }

  const driver: BotDriver = {
    platform: PLATFORM,
    adapterId: deps.adapterId,
    caps: new Set(CAPS),

    get selfId(): string {
      return selfId
    },
    get nickname(): string {
      return account.label === "" ? DEFAULT_NICKNAME : account.label
    },
    get online(): boolean {
      return connected
    },

    async connect(): Promise<void> {
      setupInput()
      connected = true

      /*
       * 拆除登记在宿主信号上，而不是只挂在 `disconnect()` 里：插件卸载走的是
       * 同步的 `detachAdapter()`，它 abort 之后才异步调 `disconnect()`。
       * 信号一 abort 就摘掉 stdin 上的监听，可以保证卸载后不再有本插件的处理器
       * 挂在标准输入上 —— 否则下次装回来会有两份 `line` 监听（见文件头第 3 点）。
       */
      if (host.signal.aborted) teardownInput()
      else host.signal.addEventListener("abort", teardownInput, { once: true })

      if (account.enable) {
        host.logger.mark(
          `${this.nickname}(${selfId}) 已连接 —— 在终端直接输入即可与机器人对话` +
            `（历史记录 ${historyFile}）`
        )
      }

      // 回读历史：纯粹给人看，放在最后且不阻塞任何东西
      if (account.historySize > 0) {
        const entries = tailHistory(await history.load(), account.historySize)
        if (entries.length > 0) {
          host.logger.info(`最近 ${entries.length} 条终端输入：`)
          for (const entry of entries) host.logger.info(`  ${new Date(entry.time).toLocaleString()} ${entry.text}`)
        }
      }
    },

    async disconnect(): Promise<void> {
      closing = true
      connected = false
      teardownInput()
    },

    async sendMessage(target: SendTarget, content: MessageContent, opts?: SendOptions): Promise<SendResult> {
      if (target.scene !== "private") {
        // 终端里没有群与频道。抛错而不是静默丢弃：插件的群发逻辑在终端下跑不通，
        // 这件事必须让使用者知道，否则他会以为"群发成功了只是终端没显示"
        throw new Error(
          `stdin 适配器只能向私聊发送消息，当前目标为${target.scene === "group" ? "群" : "频道"}。` +
            `终端里不存在群与频道，请改用私聊目标，或换成真实的平台适配器`
        )
      }

      const segments = toSegments(content)
      // `quote` 在终端里无从表达，直接被丢弃 —— 这是有意的：终端的使用者能看到
      // 上方历史，不需要一个"回复箭头"来定位
      void opts

      const lines = await renderMessage(segments, renderOpts)
      if (lines.length === 0) {
        host.logger.debug("收到的消息没有任何可在终端呈现的内容（例如只有 reply 段）")
      }
      return { ok: true, messageId: Date.now().toString(36), time: Date.now(), raw: { lines: lines.length } }
    },

    async recallMessage(messageId: string): Promise<boolean> {
      // 终端里撤回不了已经打在屏幕上的东西，但要说清"收到了这个请求" ——
      // 否则调试撤回相关的插件时，看到的是一片沉默
      writeLine(`撤回消息: ${messageId}（终端无法真正撤回，仅记录）`)
      return true
    },

    async sendForward(target: SendTarget, nodes: ForwardNode[]): Promise<SendResult> {
      // 终端里没有"合并转发卡片"，直接摊平成一条普通消息发出去 ——
      // 比抛错有用：调试时想看的就是那几条内容本身。
      // 数组类型写作 `Segment[]` 而不是 `MessageContent`：后者含只读数组，
      // 而这里要逐条 push
      const flat: Segment[] = []
      for (const node of nodes) {
        flat.push({ type: "text", text: `--- ${node.name ?? node.uid ?? "未知"} ---` })
        for (const segment of node.message ?? []) flat.push(segment)
      }
      return await this.sendMessage(target, flat)
    },

    async getSelfInfo(): Promise<UserInfo> {
      return { uid: selfId, name: this.nickname }
    },

    async getFriend(uid: string): Promise<UserInfo | undefined> {
      // 终端里只有一个"人"，就是坐在终端前敲键盘的那个（`senderId`），不是账号自己。
      // 对别的 id 返回 undefined —— 编一个不存在的用户出来会让插件的好友判断失去意义
      return uid === senderId ? { uid: senderId, name: this.nickname } : undefined
    },

    async getFriendList(): Promise<UserInfo[]> {
      return [{ uid: senderId, name: this.nickname }]
    },

    async getGroup(): Promise<GroupInfo | undefined> {
      // 没有群可返回。返回 undefined 而非空对象，使插件的
      // `if (group === undefined)` 分支如实触发
      return undefined
    },

    async getGroupList(): Promise<GroupInfo[]> {
      return []
    },

    async getGroupMember(): Promise<MemberInfo | undefined> {
      return undefined
    },

    async getGroupMemberList(_gid: string, _opts?: MemberListOptions): Promise<MemberInfo[]> {
      return []
    },

    async getMessage(): Promise<MessageRecord | undefined> {
      // 终端没有消息存储：上面打过的内容只存在于终端回滚缓冲里，取不回来
      return undefined
    },

    async callApi<T = unknown>(action: string): Promise<T> {
      throw new Error(
        `stdin 适配器没有平台原生 API 可调用（请求的 action 为 ${action}）。` +
          `终端只是一个调试用的收发端点，需要真实平台能力请改用对应适配器`
      )
    }
  }

  return driver
}
