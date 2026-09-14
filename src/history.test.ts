/**
 * 模块职责：历史记录的测试 —— 格式兼容、容错解析、尾部截取
 * 依赖方向：测试文件，依赖 history.ts
 * 生命周期：纯函数
 * 注意事项：**格式与 TRSS-Yunzai 的 `data/stdin/history` 一致**，故第一条断言同时
 *          也是"从旧框架迁移过来的记录文件仍可读"的断言。改格式会让迁移过来的人
 *          看到一堆认不出的行被静默丢弃，而他们不会知道为什么。
 */
import { describe, expect, it } from "vitest"
import { formatHistoryLine, parseHistory, tailHistory } from "./history.js"

describe("历史记录格式", () => {
  it("写成 base36 时间戳加冒号的形式", () => {
    // 固定时间戳而非 Date.now()：断言要能复现出确切的字符串
    const time = Date.UTC(2024, 0, 1)
    expect(formatHistoryLine("你好", time)).toBe(`${time.toString(36)}:你好`)
  })

  it("文本里的换行被就地替换，不产生第二行", () => {
    // 一条多行输入若原样写入会被拆成若干行，回读时除首行外全部认不出时间戳前缀
    const line = formatHistoryLine("第一行\n第二行\r\n第三行", 1)
    expect(line.split("\n")).toHaveLength(1)
    expect(line).toContain("⏎")
  })

  it("解析回自己写出的行", () => {
    const time = Date.UTC(2024, 5, 15, 12, 0, 0)
    const entries = parseHistory(formatHistoryLine("hello", time))
    expect(entries).toEqual([{ time, text: "hello" }])
  })
})

describe("历史记录解析的容错", () => {
  it("跳过空行与注释行而不抛错", () => {
    // 该文件使用者可以直接编辑：手工补一行注释、编辑器在末尾留空行都是常态
    const content = ["# 这是我自己加的注释", "", formatHistoryLine("有效行", 1000), "   ", "没有冒号的行"].join("\n")
    const entries = parseHistory(content)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.text).toBe("有效行")
  })

  it("时间戳部分不是合法 base36 时跳过该行", () => {
    const entries = parseHistory("zz!!:文本\nfoo bar:文本")
    expect(entries).toHaveLength(0)
  })

  it("文本本身含冒号时从第一个冒号处分割", () => {
    // 机器人回复里带冒号极常见，误把后面的冒号当分隔符会截断内容
    const entries = parseHistory(formatHistoryLine("时间: 12:30", 42))
    expect(entries[0]?.text).toBe("时间: 12:30")
  })

  it("空内容解析为空数组", () => {
    expect(parseHistory("")).toEqual([])
  })

  it("尾部缺少换行时最后一行仍可解析", () => {
    const entries = parseHistory(`abc:第一行\n${formatHistoryLine("最后一行", 7)}`)
    expect(entries).toHaveLength(2)
    expect(entries[1]?.text).toBe("最后一行")
  })
})

describe("历史记录截取", () => {
  const entries = [
    { time: 1, text: "一" },
    { time: 2, text: "二" },
    { time: 3, text: "三" }
  ]

  it("取最近若干条且保持升序", () => {
    // 升序而非"最近的排最前"：读日志的人是从上往下看的
    expect(tailHistory(entries, 2).map(e => e.text)).toEqual(["二", "三"])
  })

  it("条数超过总数时全部返回", () => {
    expect(tailHistory(entries, 99)).toHaveLength(3)
  })

  it("条数为 0 或负数时返回空数组", () => {
    expect(tailHistory(entries, 0)).toEqual([])
    expect(tailHistory(entries, -1)).toEqual([])
  })
})
