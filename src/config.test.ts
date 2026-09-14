/**
 * 模块职责：账号配置校验的测试 —— 固定默认值与两条跨字段检查的报错文案
 * 依赖方向：测试文件，依赖 config.ts 与内核的 SchemaError
 * 生命周期：纯函数，无状态
 * 注意事项：**"空对象也能得到一份可用配置"是本适配器最重要的断言。** 它想调试的
 *          是"机器人能不能跑通一条命令"，若新建账号还要先填五个字段，这件事的
 *          门槛就被抬到了不该有的高度。该断言一旦失败，说明默认值出了问题。
 *
 *          其余断言针对报错文案：`path` 必须指到具体字段，否则面板无从把错误
 *          标到对应输入框上。
 */
import { describe, expect, it } from "vitest"
import { SchemaError } from "@yunzai-ng/core"
import { ACCOUNT_SCHEMA, useAnsi, validateAccount } from "./config.js"

describe("账号配置", () => {
  it("空对象也能得到一份可直接使用的配置", () => {
    const account = validateAccount({})
    expect(account.uid).toBe("console")
    expect(account.label).toBe("终端")
    expect(account.enable).toBe(true)
    expect(account.echoInput).toBe(true)
    expect(account.catimg).toBe(true)
    expect(account.ansi).toBe("auto")
    expect(account.historySize).toBe(20)
    expect(account.historyFile).toBe("")
  })

  it("uid 为空串被拦下，且错误指向 uid 字段", () => {
    try {
      validateAccount({ uid: "   " })
      expect.unreachable("应当抛出")
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaError)
      const issues = (err as SchemaError).issues
      expect(issues[0]?.path).toBe("uid")
      // 报错要说清"为什么不能为空"，而不只是"不能为空"
      expect(issues[0]?.message).toContain("权限判定")
    }
  })

  it("uid 的说明不提发件人 —— 两者已不是一回事", () => {
    /*
     * 这条守的是一个曾把使用者引到沟里的文案：字段说明原先写着
     * "把该值填进内核配置的 policy.masters"，而 `policy.masters` 这项配置
     * 根本不存在（实际路径是 `bot.masterQQ`），且 `uid` 已不再充当发件人。
     * 使用者照着填会填到错的地方，还以为是权限没生效。
     */
    const desc = ACCOUNT_SCHEMA.field("uid")?.describe().description ?? ""
    expect(desc).not.toContain("policy.masters")
    expect(desc).toContain("console-user")
  })

  it("uid 含空白字符被拦下", () => {
    // 它会被写进日志与主人列表，含空白将无从比对
    try {
      validateAccount({ uid: "my console" })
      expect.unreachable("应当抛出")
    } catch (err) {
      const issues = (err as SchemaError).issues
      expect(issues[0]?.path).toBe("uid")
      expect(issues[0]?.message).toContain("空白")
    }
  })

  it("label 为空串被拦下", () => {
    try {
      validateAccount({ label: "  " })
      expect.unreachable("应当抛出")
    } catch (err) {
      const issues = (err as SchemaError).issues
      expect(issues.some(i => i.path === "label")).toBe(true)
    }
  })

  it("两端的空白被剔除", () => {
    // 自面板粘贴时极易带入尾随空格，而 uid 会被拿去与主人列表比对
    const account = validateAccount({ uid: "  console  ", label: "  终端  " })
    expect(account.uid).toBe("console")
    expect(account.label).toBe("终端")
  })

  it("越界取值由 schema 拦截", () => {
    expect(() => validateAccount({ historySize: -1 })).toThrow(SchemaError)
    expect(() => validateAccount({ historySize: 100_000 })).toThrow(SchemaError)
    expect(() => validateAccount({ ansi: "rainbow" })).toThrow(SchemaError)
  })

  it("布尔字段接受手势写法的真值", () => {
    /*
     * 这不是本适配器的行为而是内核 schema 的：`#validateBoolean` 显式认
     * `"true"/"1"/"yes"/"on"/"是"` 与它们的反面，因为配置文件是给人手工编辑的，
     * 写 `enable: yes` 是 YAML 里极自然的写法。此处断言它，是为了说明
     * **不该**给这些字段加 `s.literal(true)` 一类的收紧 —— 那会把手工编辑
     * 配置文件的路径堵死
     */
    expect(validateAccount({ enable: "yes" }).enable).toBe(true)
    expect(validateAccount({ enable: "no" }).enable).toBe(false)
    expect(validateAccount({ enable: "是" }).enable).toBe(true)
    // 认不出的字符串仍然被拦下
    expect(() => validateAccount({ enable: "maybe" })).toThrow(SchemaError)
  })

  it("historySize 允许为 0（表示不回读）", () => {
    expect(validateAccount({ historySize: 0 }).historySize).toBe(0)
  })

  it("schema 描述里每个字段都有中文标签", () => {
    // 该描述即面板表单，缺 title 会在页面上显示成英文键名
    const descriptor = ACCOUNT_SCHEMA.describe()
    const properties = descriptor.properties ?? {}
    expect(Object.keys(properties).length).toBeGreaterThan(0)
    for (const [key, field] of Object.entries(properties)) {
      expect(field.title, `字段 ${key} 缺 title`).toBeTruthy()
      expect(field.description, `字段 ${key} 缺 description`).toBeTruthy()
    }
  })
})

describe("着色判定", () => {
  it("always / never 不受终端影响", () => {
    expect(useAnsi("always")).toBe(true)
    expect(useAnsi("never")).toBe(false)
  })

  it("auto 跟随标准错误是否终端", () => {
    // 依据刻意是 stderr：回复走 stderr，日志走 stdout。转发了 stdout 的用法
    // 在两种判据下结果相反，而正确的那一种是跟随回复自己的去向
    const original = process.stderr.isTTY
    try {
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true })
      expect(useAnsi("auto")).toBe(true)
      Object.defineProperty(process.stderr, "isTTY", { value: undefined, configurable: true })
      expect(useAnsi("auto")).toBe(false)
    } finally {
      Object.defineProperty(process.stderr, "isTTY", { value: original, configurable: true })
    }
  })
})
