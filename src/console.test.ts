/**
 * 模块职责：终端渲染的测试 —— 各段类型的输出文案与"看不见的东西要说出来"
 * 依赖方向：测试文件，依赖 console.ts
 * 生命周期：`catimg` 探测结果被模块级缓存，故本文件不测真实画图（见文末说明）
 * 注意事项：断言的**重点是"该说的说了"而不是"文案一字不差"** —— 用 `toContain`
 *          而非 `toBe`，使调整措辞不必改测试。唯一例外是 `at` 段与空段：
 *          那两处的行为（渲染出 `@名字`、跳过空文本）是刻意的设计决定，
 *          必须有断言守着，否则一次"简化"就会把它们改掉。
 *
 *          **不测 `drawImage`。** 它要么 spawn 一个真实的外部命令（在 CI 上没有），
 *          要么就得断言一个假的 spawn 替身被调用过 —— 后者只证明了"我写的代码
 *          和我写的一样"，测不出任何真实缺陷。
 */
import { describe, expect, it } from "vitest"
import type { Logger, Segment } from "@yunzai-ng/types"
import { renderSegment } from "./console.js"

/** 静默日志器，避免噪声混进测试输出 */
const logger: Logger = {
  level: "silent",
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  mark: () => undefined,
  child: () => logger,
  isLevelEnabled: () => false
}

/** 渲染参数，catimg 关闭以免测试试图 spawn 外部命令 */
const opts = {
  logger,
  ansi: false,
  catimg: false,
  mediaDir: "/nonexistent-media-dir",
  publicBase: undefined
}

/**
 * 渲染单个段并把输出拼成一段文本
 * @param segment 消息段
 * @returns 拼接后的输出
 */
async function render(segment: Segment): Promise<string> {
  const lines = await renderSegment(segment, opts)
  return lines.map(l => l.text).join("\n")
}

describe("文本段", () => {
  it("单行文本原样输出，不加抬头", async () => {
    expect(await render({ type: "text", text: "你好" })).toBe("你好")
  })

  it("多行文本加抬头，便于分辨哪几行是发出去的内容", async () => {
    const out = await render({ type: "text", text: "第一行\n第二行" })
    expect(out).toContain("发送文本:")
    expect(out).toContain("第一行\n第二行")
  })

  it("空白文本不产生输出行", async () => {
    // 插件里 `[cond && "x", y]` 这类拼装很容易留下空白段，
    // 若每个都打一行空行，终端会被刷得看不出内容
    expect(await render({ type: "text", text: "   " })).toBe("")
  })
})

describe("at 段必须可见", () => {
  it("渲染成 @名字", async () => {
    /*
     * 这是刻意与 TRSS 不同的一处：TRSS 的 stdin 适配器遇到 at 段直接跳过。
     * 终端里看不到"被 @ 了"这件事，调试群聊相关的逻辑时会以为插件根本没触发。
     */
    expect(await render({ type: "at", uid: "123456", name: "某人" })).toBe("@某人")
  })

  it("没有名字时退回到 uid", async () => {
    expect(await render({ type: "at", uid: "123456" })).toBe("@123456")
  })

  it("atAll 渲染成 @全体成员", async () => {
    expect(await render({ type: "atAll" })).toBe("@全体成员")
  })
})

describe("reply 段被静默跳过", () => {
  it("不产生任何输出", async () => {
    // 终端里没有"引用某条消息"的视觉表达，而被引用的那条本来就打在屏幕上方
    expect(await renderSegment({ type: "reply", messageId: "abc" }, opts)).toEqual([])
  })
})

describe("媒体段的降级", () => {
  it("图片在无 catimg 时打印路径而不是抛错", async () => {
    const out = await render({ type: "image", file: { kind: "path", path: "/tmp/pic.png" } })
    expect(out).toContain("发送图片")
    expect(out).toContain("/tmp/pic.png")
  })

  it("取不到路径也取不到 URL 时明说无法显示", async () => {
    // 一个只有平台侧 id 的引用在终端里就是一句话都说不出的东西。
    // 沉默会让人以为插件没发出来
    const out = await render({ type: "image", file: { kind: "id", id: "xyz" } })
    expect(out).toContain("无法显示")
    expect(out).toContain("xyz")
  })

  it("语音/视频/文件各有自己的标签", async () => {
    expect(await render({ type: "record", file: { kind: "path", path: "/tmp/a.silk" } })).toContain("发送语音")
    expect(await render({ type: "video", file: { kind: "path", path: "/tmp/a.mp4" } })).toContain("发送视频")
    expect(await render({ type: "file", file: { kind: "path", path: "/tmp/a.zip" } })).toContain("发送文件")
  })
})

describe("合并转发被摊平", () => {
  it("逐节点、逐段展开", async () => {
    // 不展开的话，一条合并转发在终端里只剩一个空壳，调试时看不到内容
    const out = await render({
      type: "forward",
      nodes: [
        { name: "甲", message: [{ type: "text", text: "甲说的话" }] },
        { uid: "222", message: [{ type: "text", text: "乙说的话" }] }
      ]
    })
    expect(out).toContain("2 条")
    expect(out).toContain("甲")
    expect(out).toContain("甲说的话")
    expect(out).toContain("222")
    expect(out).toContain("乙说的话")
  })

  it("节点为空时给出可读说明", async () => {
    expect(await render({ type: "forward" })).toContain("无节点内容")
  })
})

describe("其余段类型都有可读输出", () => {
  it("表情、戳一戳、卡片、位置等都不是静默的", async () => {
    // 静默会让"插件发了东西但终端没显示"与"插件压根没发"变得无从区分
    expect(await render({ type: "face", id: 12 })).toContain("12")
    expect(await render({ type: "poke", uid: "999" })).toContain("999")
    expect(await render({ type: "json", data: '{"a":1}' })).toContain("json")
    expect(await render({ type: "xml", data: "<msg/>" })).toContain("xml")
    expect(await render({ type: "location", lat: 1, lon: 2, title: "某地" })).toContain("某地")
    expect(await render({ type: "music", platform: "qq", id: "1", title: "歌" })).toContain("歌")
    expect(await render({ type: "dice", result: 3 })).toContain("3")
    expect(await render({ type: "rps", result: 2 })).toContain("2")
    expect(await render({ type: "contact", scene: "group", id: "555" })).toContain("555")
    expect(await render({ type: "markdown", content: "# 标题" })).toContain("标题")
    expect(await render({ type: "keyboard", rows: [] })).toContain("按钮")
    expect(await render({ type: "raw", platform: "x", platformType: "custom", data: { k: 1 } })).toContain("custom")
  })
})

describe("着色开关", () => {
  it("关闭时不产生任何转义字符", async () => {
    // 使用者把 stderr 重定向到文件时，满屏的 \u001b[36m 会让日志没法看
    const plain = await render({ type: "image", file: { kind: "path", path: "/tmp/p.png" } })
    expect(plain).not.toContain("\u001b[")
  })

  it("开启时给路径与地址着色", async () => {
    const colored = await renderSegment(
      { type: "image", file: { kind: "path", path: "/tmp/p.png" } },
      { ...opts, ansi: true }
    )
    expect(colored[0]?.text).toContain("\u001b[")
  })
})
