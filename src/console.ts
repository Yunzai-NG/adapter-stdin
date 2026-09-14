/**
 * 模块职责：把消息段渲染到终端（标准错误）
 * 依赖方向：依赖 node:child_process、node:util 与本包的 media
 * 生命周期：`catimg` 的可用性判定在进程内缓存一次
 * 注意事项：**全部输出走标准错误。** 内核日志走标准输出（见 logger/format.ts），
 *          两者分开是使用者能 `pnpm start > out.log` 只留日志的前提；
 *          本文件若往 stdout 写一个字，那份日志就会被机器人的回复污染。
 *
 *          **`catimg` 的判定结果缓存。** TRSS 的写法是在 `ENOENT` 之后把
 *          `catimg` 方法自替换成空函数；此处等价地缓存在模块变量里 ——
 *          不缓存的话，一个未安装 catimg 的环境里每条图片消息都要 spawn 一个
 *          注定失败的子进程，而它的报错还只出现在 stderr 上。
 */
import { spawn } from "node:child_process"
import { inspect } from "node:util"
import type { Logger, MediaRef, Segment } from "@yunzai-ng/types"
import { resolveMedia } from "./media.js"

/** 输出前缀，与内核日志区分 */
const PREFIX = "[stdin]"

/** `catimg` 是否可用；undefined 表示尚未判定 */
let catimgAvailable: boolean | undefined

/** 渲染所需的环境参数 */
export interface ConsoleRenderOptions {
  /** 日志器 */
  logger: Logger
  /** 是否输出 ANSI 颜色码 */
  ansi: boolean
  /** 是否尝试用 catimg 画图 */
  catimg: boolean
  /** 媒体目录绝对路径 */
  mediaDir: string
  /** 内置服务器可用时的 URL 基址 */
  publicBase: string | undefined
}

/** 渲染后的每一段都产生的中间结果，供测试断言文案 */
export interface RenderedLine {
  /** 输出到终端的文本（不含前缀） */
  text: string
  /** 该行的类别，便于调用方与测试分辨 */
  kind: Segment["type"] | "raw"
}

/**
 * 给文本着色
 * @param text 文本
 * @param code ANSI 颜色码
 * @param ansi 是否启用着色
 * @returns 着色后的文本
 */
function paint(text: string, code: string, ansi: boolean): string {
  return ansi ? `[${code}m${text}[0m` : text
}

/**
 * 写入一行到标准错误
 * @param text 文本
 */
export function writeLine(text: string): void {
  process.stderr.write(`${PREFIX} ${text}\n`)
}

/**
 * 探测 `catimg` 是否可用
 *
 * 结果缓存：见文件头第 2 点。
 * @param logger 日志器
 * @returns 是否可用
 */
export function hasCatimg(logger: Logger): Promise<boolean> {
  if (catimgAvailable !== undefined) return Promise.resolve(catimgAvailable)
  return new Promise<boolean>(resolve => {
    const child = spawn("catimg", ["-h"], { stdio: "ignore" })
    child.on("error", () => {
      catimgAvailable = false
      logger.debug("未找到 catimg 命令，图片将只打印路径")
      resolve(false)
    })
    // 能起来就算有，退出码不管：不同版本对 `-h` 的返回码不一致
    child.on("close", () => {
      catimgAvailable = true
      resolve(true)
    })
  })
}

/**
 * 在终端里画一张图
 * @param path 图片绝对路径
 * @param logger 日志器
 * @returns 是否画出来了
 */
export async function drawImage(path: string, logger: Logger): Promise<boolean> {
  if (path === "") return false
  if (!(await hasCatimg(logger))) return false
  return new Promise<boolean>(resolve => {
    // stdio 沿用父进程：字符画要直接打在终端上，不能被抓进 Buffer 再转一道
    spawn("catimg", ["-l0", path], { stdio: "inherit" })
      .on("error", () => resolve(false))
      .on("close", () => resolve(true))
  })
}

/**
 * 描述一个媒体引用，用于终端输出
 * @param ref 媒体引用
 * @param opts 渲染参数
 * @param label 段类型的显示名
 * @returns 输出行
 */
async function describeMedia(ref: MediaRef, opts: ConsoleRenderOptions, label: string): Promise<RenderedLine> {
  const resolved = await resolveMedia(ref, {
    mediaDir: opts.mediaDir,
    segmentType: label,
    publicBase: opts.publicBase
  })

  const parts: string[] = [`发送${label}`]
  if (resolved.path !== "") parts.push(`路径: ${paint(resolved.path, "36", opts.ansi)}`)
  if (resolved.url !== "") parts.push(`地址: ${paint(resolved.url, "32", opts.ansi)}`)
  if (resolved.path === "" && resolved.url === "") parts.push(`（无法显示：${resolved.describe}）`)
  else parts.push(`(${resolved.describe})`)

  return { text: parts.join(" "), kind: label === "图片" ? "image" : "file" }
}

/**
 * 渲染一个消息段
 *
 * 每个段类型对应 TRSS `stdin.js` 的 `switch (i.type)` 分支。差异之处有二：
 * `at` 段渲染成 `@名字` 而不是静默跳过 —— 终端里看不到"被 @ 了"这件事，
 * 调试群聊相关的逻辑时会以为插件没触发；`forward` 段递归展开，
 * 否则一条合并转发在终端里只剩一个空壳。
 * @param segment 消息段
 * @param opts 渲染参数
 * @returns 输出行数组
 */
export async function renderSegment(segment: Segment, opts: ConsoleRenderOptions): Promise<RenderedLine[]> {
  switch (segment.type) {
    case "text": {
      const text = segment.text.trim()
      if (text === "") return []
      // 多行文本加一行抬头：不加的话它与机器人自己的其他输出混在一起，
      // 分不清哪几行是"发出去的内容"
      if (segment.text.includes("\n")) return [{ text: `发送文本:\n${segment.text}`, kind: "text" }]
      return [{ text, kind: "text" }]
    }

    case "image":
      return [await describeMedia(segment.file, opts, "图片")]

    case "record":
      return [await describeMedia(segment.file, opts, "语音")]

    case "video":
      return [await describeMedia(segment.file, opts, "视频")]

    case "file":
      return [await describeMedia(segment.file, opts, "文件")]

    case "at":
      return [{ text: `@${segment.name ?? segment.uid}`, kind: "at" }]

    case "atAll":
      return [{ text: "@全体成员", kind: "atAll" }]

    case "reply":
      // 终端里没有"引用某条消息"的视觉表达，且被引用的那条本来就打在屏幕上方
      return []

    case "face":
      return [{ text: `[表情 ${segment.id}]`, kind: "face" }]

    case "forward": {
      const nodes = segment.nodes ?? []
      if (nodes.length === 0) return [{ text: "发送合并转发（无节点内容）", kind: "forward" }]
      const lines: RenderedLine[] = [{ text: `发送合并转发（${nodes.length} 条）:`, kind: "forward" }]
      for (const node of nodes) {
        const who = node.name ?? node.uid ?? "未知"
        lines.push({ text: `  ┌ ${who}`, kind: "forward" })
        for (const inner of node.message ?? []) {
          // 缩进两格，与上面的头一行对齐；嵌套转发不再递归，避免刷屏
          for (const line of await renderSegment(inner, opts)) {
            lines.push({ text: `  │ ${line.text.replace(/\n/g, "\n  │ ")}`, kind: line.kind })
          }
        }
      }
      return lines
    }

    case "music":
      return [{ text: `发送音乐分享: ${segment.title ?? segment.id ?? "（无标题）"}`, kind: "music" }]

    case "share":
      return [{ text: `发送链接分享: ${segment.title} ${segment.url}`, kind: "share" }]

    case "location":
      return [{ text: `发送位置: ${segment.title ?? ""} (${segment.lat}, ${segment.lon})`, kind: "location" }]

    case "json":
    case "xml":
      return [{ text: `发送卡片（${segment.type}）: ${segment.data}`, kind: segment.type }]

    case "poke":
      return [{ text: `发送戳一戳: ${segment.uid ?? "（无目标）"}`, kind: "poke" }]

    case "dice":
      return [{ text: `发送骰子: ${segment.result ?? "（随机）"}`, kind: "dice" }]

    case "rps":
      return [{ text: `发送猜拳: ${segment.result ?? "（随机）"}`, kind: "rps" }]

    case "contact":
      return [{ text: `发送推荐${segment.scene === "group" ? "群" : "好友"}: ${segment.id}`, kind: "contact" }]

    case "markdown":
      return [{ text: `发送 Markdown:\n${segment.content}`, kind: "markdown" }]

    case "keyboard":
      return [{ text: `发送按钮键盘（${segment.rows.length} 行）`, kind: "keyboard" }]

    case "raw":
      // 平台私有段：终端不认识它，原样打印结构，让使用者判断该怎么处理
      return [{ text: `发送平台私有段 ${segment.platformType}: ${inspect(segment.data)}`, kind: "raw" }]

    default: {
      /*
       * 走到这里说明内核加了新的段类型而本适配器尚未跟上。取联合类型的穷尽检查：
       * `segment` 在此处为 `never`，故这段代码只是在类型层面"证明"分支已穷尽，
       * 运行期兜底打印结构而不抛错 —— 一条未知段不该让整条回复发不出去。
       */
      const unknown: never = segment
      return [{ text: `发送未知段: ${inspect(unknown)}`, kind: "raw" }]
    }
  }
}

/**
 * 渲染一整条消息
 *
 * 逐段渲染后按顺序写出，并在每行前加段类型标签 —— 终端里图片与文字混排时，
 * 没有标签就分不清"这一段是插件发的文本"还是"图片的路径说明"。
 * @param segments 消息段
 * @param opts 渲染参数
 * @returns 写出后的文本行
 */
export async function renderMessage(
  segments: readonly Segment[],
  opts: ConsoleRenderOptions
): Promise<RenderedLine[]> {
  const out: RenderedLine[] = []
  for (const segment of segments) {
    const lines = await renderSegment(segment, opts)
    for (const line of lines) {
      writeLine(line.text)
      out.push(line)
    }
  }
  return out
}
