/**
 * 模块职责：终端输入的历史记录（追加写、启动回读）
 * 依赖方向：依赖 node:fs 与类型包；不依赖内核
 * 生命周期：随账号创建、随账号断开归档
 * 注意事项：**格式与 TRSS-Yunzai 的 `data/stdin/history` 一致**（每行 `<base36 时间戳>:<文本>`），
 *          以便从旧框架迁移过来的使用者能把旧文件直接指过来用。为此也保留了它一个不
 *          甚优雅的性质：文本里的换行会把一行拆成两行，回读时后半截认不出时间戳前缀 ——
 *          回读的容错逻辑见 {@link parseHistory}。
 *
 *          **写入失败只记日志，不向上抛。** 记录历史是旁路：磁盘满了、路径只读、
 *          目录被删了，都不该让"发一条消息给机器人"这件事失败。
 */
import { appendFile, readFile } from "node:fs/promises"
import type { Logger } from "@yunzai-ng/types"

/**
 * 一行历史记录的形状
 *
 * 时间戳部分限定为 base36 字符集且必须非空；正文可以含冒号（`时间: 12:30` 这类
 * 回复内容极常见），故正文不设限、"从第一个冒号处切开"由 `[^:]+` 保证。
 */
const HISTORY_LINE_RE = /^([0-9a-z]+):(.*)$/

/**
 * 历史记录的一行
 *
 * 时间戳存 base36 而非十进制，与 TRSS 保持一致：同为毫秒时间戳，十进制 13 位、
 * base36 只有 8 位，一个高频调试的会话里这个差别体现在文件大小上。
 */
export interface HistoryEntry {
  /** 记录时刻（毫秒时间戳） */
  time: number
  /** 该行的文本 */
  text: string
}

/**
 * 把一条记录格式化为一行
 * @param text 文本
 * @param time 记录时刻，缺省取当前时间
 * @returns 不含换行的行文本
 */
export function formatHistoryLine(text: string, time: number = Date.now()): string {
  // 文本里的换行必须就地替换：否则一条多行输入会被拆成若干行，回读时除首行外
  // 全部因认不出时间戳前缀而被丢弃。替换成可见的 ⏎ 而不是空格，是为了回读时
  // 还能看出"这里原本断过行"
  return `${time.toString(36)}:${text.replace(/\r?\n/g, "⏎")}`
}

/**
 * 解析历史记录的全文
 *
 * **认不出的行静默跳过，不抛错。** 该文件是使用者可以直接编辑的 —— 手工补一行注释、
 * 编辑器在末尾留一个空行、旧版本留下的别的格式，都是正常情形；为此让整个账号连不上
 * 是不成比例的。
 *
 * 时间戳部分用**正则整体校验**而不是 `parseInt(x, 36)`：后者遇非法字符即停并把
 * 已读到的部分当作结果（`parseInt("zz!!", 36)` 得到 1295），于是 `"这行是注释"` 一类的
 * 中文行会被解析成一个荒唐的时间戳而混进历史记录里。
 * @param content 文件全文
 * @returns 按文件中出现顺序排列的记录
 */
export function parseHistory(content: string): HistoryEntry[] {
  const out: HistoryEntry[] = []
  for (const raw of content.split("\n")) {
    const line = raw.trim()
    if (line === "") continue
    const match = HISTORY_LINE_RE.exec(line)
    if (match === null) continue
    const time = Number.parseInt(match[1] ?? "", 36)
    if (Number.isNaN(time)) continue
    out.push({ time, text: match[2] ?? "" })
  }
  return out
}

/**
 * 取最近若干条记录
 *
 * 返回**按时间升序**（最早的在前），与 `parseHistory` 的返回顺序相反 ——
 * 调用方要的是"最近发生了什么"，读日志的人自然是从上往下看。
 * @param entries 全部记录
 * @param count 取多少条；`<= 0` 时为空数组
 * @returns 最近 count 条，升序
 */
export function tailHistory(entries: readonly HistoryEntry[], count: number): HistoryEntry[] {
  if (count <= 0) return []
  return entries.slice(-count)
}

/** 历史记录的读写句柄 */
export interface HistoryLog {
  /** 记录文件绝对路径 */
  readonly file: string

  /**
   * 追加一条记录
   *
   * 不 await、不抛错：调用点在消息投递的关键路径上。
   * @param text 文本
   */
  append(text: string): void

  /**
   * 读取全部记录
   * @returns 记录数组；文件不存在或读不出时为空数组
   */
  load(): Promise<HistoryEntry[]>
}

/**
 * 创建历史记录句柄
 * @param file 记录文件绝对路径
 * @param logger 日志器，用于记录读写失败
 * @returns 句柄
 */
export function createHistoryLog(file: string, logger: Logger): HistoryLog {
  return {
    file,

    append(text: string): void {
      if (text === "") return
      const line = `${formatHistoryLine(text)}\n`
      // 不 await：写入耗时不计入事件处理，写失败也不该影响任何事
      void appendFile(file, line, "utf8").catch((err: unknown) => {
        logger.debug(`写入历史记录 ${file} 失败：${err instanceof Error ? err.message : String(err)}`)
      })
    },

    async load(): Promise<HistoryEntry[]> {
      try {
        return parseHistory(await readFile(file, "utf8"))
      } catch (err) {
        // 文件不存在是首次运行的常态，不是错误
        const code = (err as NodeJS.ErrnoException).code
        if (code !== "ENOENT") {
          logger.warn(`读取历史记录 ${file} 失败：${err instanceof Error ? err.message : String(err)}`)
        }
        return []
      }
    }
  }
}
