/**
 * 模块职责：账号配置的 schema、类型与校验
 * 依赖方向：仅依赖内核的 schema 工具与类型包
 * 生命周期：模块加载期构造一次 schema，之后只读
 * 注意事项：**该 schema 即为面板中的"添加账号"表单。** 字段标签与说明自此处推导，
 *          故 `title` / `desc` 为最终用户所见文案。
 *
 *          每一项都有默认值：本适配器要调试的是"机器人能不能跑通一条命令"，
 *          逼使用者先填五个字段只会让这件事变得更麻烦。默认值全部可用，
 *          即"新建一个账号、什么都不改、保存"就应当工作。
 */
import { s, SchemaError } from "@yunzai-ng/core"
import type { Infer, SchemaIssue } from "@yunzai-ng/core"

/**
 * 账号配置 schema
 *
 * `uid` 与 `label` 都只是本适配器内部的标识：终端里没有真实的用户，也不存在
 * 一个需要对齐的平台 id。把它们做成可改的，是为了在日志与权限判定里能分辨
 * "这条消息来自终端"。
 *
 * **`uid` 是账号自己的 id，不是发件人的 id。** 发件人固定为 `SENDER_ID`
 * （见 bot.ts），两者必须不同 —— 相同会让内核的 `bot.ignoreSelf` 把每一条
 * 输入都当成机器人自言自语丢掉。主人列表里填的是 `SENDER_ID`。
 */
export const ACCOUNT_SCHEMA = s.object({
  label: s
    .string()
    .default("终端")
    .title("显示名")
    .desc("账号在日志与面板中显示的名字，与 QQ 昵称同义")
    .placeholder("终端")
    .order(1),

  uid: s
    .string()
    .default("console")
    .title("账号 id")
    .desc(
      "本账号在平台上的 id，与 QQ 号同义。注意它**不是**终端里那个人的 id —— " +
        "发件人固定为 `console-user`，主人列表里要填的是后者。留空将被拒绝"
    )
    .placeholder("console")
    .order(2),

  enable: s
    .boolean()
    .default(true)
    .title("接管标准输入")
    .desc(
      "关闭后本账号只做应答侧的演示，不再读取终端输入 —— " +
        "适用于同一个进程里挂了两份该适配器、或只想看机器人往外发什么的情形"
    )
    .order(3),

  echoInput: s
    .boolean()
    .default(true)
    .title("回显输入")
    .desc(
      "把敲下的每一行同时写进历史记录，重启后可用「↑」翻回。" +
        "关闭后历史记录仍在写，只是不再注入 readline 的行缓冲"
    )
    .order(4),

  catimg: s
    .boolean()
    .default(true)
    .title("尝试在终端中画图")
    .desc(
      "开启时会调用外部命令 catimg 把图片画成字符画。未安装该命令时自动降级为打印路径，" +
        "不影响任何其他功能。图片较大时该命令会占满整个终端"
    )
    .group("终端")
    .order(10),

  ansi: s
    .select([
      { value: "auto", label: "自动", description: "标准错误是终端时着色，被重定向时不着色" },
      { value: "always", label: "总是", description: "总是输出 ANSI 颜色码，重定向到文件后可见转义字符" },
      { value: "never", label: "从不", description: "从不输出颜色码" }
    ])
    .default("auto")
    .title("彩色输出")
    .desc("控制回复文本是否带 ANSI 颜色码。判定依据是标准错误而非标准输出：回复走前者")
    .group("终端")
    .order(11),

  historySize: s
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(20)
    .title("启动回读条数")
    .desc(
      "账号连上时把历史记录里最近多少条打进日志，便于看清上次调试到哪儿。" +
        "填 0 表示不读。该值只影响回读，不限制文件的增长"
    )
    .group("历史")
    .order(20),

  historyFile: s
    .file()
    .default("")
    .title("历史记录文件")
    .desc("留空即用本插件数据目录下的 history。换一处可让多个 stdin 账号共用一个记录，或反过来各记一份")
    .group("历史")
    .order(21)
})

/** 账号配置，由 schema 推导而来 */
export type StdinAccount = Infer<typeof ACCOUNT_SCHEMA>

/** 终端着色策略 */
export type AnsiMode = "auto" | "always" | "never"

/**
 * 是否在标准错误上输出颜色码
 *
 * 判定依据刻意是 **stderr 而非 stdout**：本适配器的回复写 stderr，而内核日志写
 * stdout（见 logger/format.ts 的 `supportsColor`）。一个只重定向了 stdout 的用法
 * （`pnpm start > out.log`）在两种判据下结果相反，而正确的那一种是跟随回复自己的去向。
 * @param mode 配置中的着色策略
 * @returns 是否着色
 */
export function useAnsi(mode: AnsiMode): boolean {
  if (mode === "always") return true
  if (mode === "never") return false
  return process.stderr.isTTY === true
}

/**
 * 校验并规范化账号配置
 *
 * schema 本身已覆盖类型与范围，此处只补 schema 无法表达的检查 —— 但 `uid` 的非空
 * 检查仍放在这里而非用 `s.string().min(1)`：面板提交空串时的报错文案要说清"空串会
 * 导致权限判定无从进行"，而不是一句"长度不足"。
 * @param input 面板提交的原始对象
 * @returns 规范化后的配置
 * @throws SchemaError 校验不通过；`issues[].path` 与表单字段名对应
 */
export function validateAccount(input: unknown): StdinAccount {
  const account = ACCOUNT_SCHEMA.parse(input)
  const issues: SchemaIssue[] = []

  const uid = account.uid.trim()
  if (uid === "") {
    issues.push({
      path: "uid",
      message: "不能为空：该值既是终端消息的发件人 id，也是账号自身的 id，权限判定依赖它",
      severity: "error"
    })
  } else if (/\s/.test(uid)) {
    issues.push({
      path: "uid",
      message: `不能含空白字符（当前为「${uid}」）：它会被写进日志与主人列表，含空白将无从比对`,
      severity: "error"
    })
  }

  const label = account.label.trim()
  if (label === "") {
    issues.push({ path: "label", message: "不能为空：账号在日志与面板中都以此为名", severity: "error" })
  }

  if (issues.length > 0) throw new SchemaError(issues)

  return { ...account, uid, label }
}
