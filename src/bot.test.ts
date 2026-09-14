/**
 * 模块职责：`BotDriver` 的事件构造与联系人视图 —— 发件人身份与空行投递
 * 依赖方向：测试文件，依赖 bot.ts 与类型包
 * 生命周期：每个用例一个驱动实例，用例结束即丢弃
 * 注意事项：**本文件守的是"终端输入不会被内核当成机器人自言自语丢掉"。**
 *
 *          这一条曾经真的错过，代价是一整天的排查：本适配器照抄了 TRSS 参考实现的
 *          身份模型（`self_id` 与 `sender.user_id` 同值），而内核
 *          `pipeline/dispatch.ts` 的 `#acceptMessage` 开头就是
 *          `if (policy.ignoreSelf && sender.uid === bot.selfId) return false`，
 *          `bot.ignoreSelf` 默认为 true。于是每一条输入都在进路由之前被静默丢弃：
 *          终端上敲什么都没反应，日志里连一条"命令命中"都没有。
 *
 *          TRSS 那边同样的写法无害 —— 它通篇不拿这两个值做相等判断。
 *          **照抄一个在源框架里不成立的前提，是这次移植最贵的一课。**
 *
 *          之所以此前 7 个用例全没抓到：它们都在测 `index.ts` 的 `setup()`，
 *          没有一个碰过事件构造。本文件补上这一段。
 *
 *          **本文件用 `enable: false` 造账号。** `connect()` 接管标准输入需要真实
 *          TTY，而测试环境里没有；关掉之后 `connect()` 只做登记不碰 readline，
 *          其余公开方法照常可测。这也顺带覆盖了"关闭接管"这条配置分支。
 */
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { fakeLogger } from "@yunzai-ng/core/testing"
import type { AdapterHost, BotDriver, MessageContent, SendTarget } from "@yunzai-ng/types"
import { createStdinBot, SENDER_ID, stdinUsable } from "./bot.js"
import { validateAccount } from "./config.js"

/**
 * 用例里使用的账号 id
 *
 * 与 `SENDER_ID` 的关系才是断言的对象 —— 具体取值不重要，**两者不等**才重要。
 * 取配置默认值，顺带保证"默认配置下两者就不等"。
 */
const ACCOUNT_ID = "console"

/**
 * 造一个驱动
 *
 * `submit` 收到的内容不在这里断言 —— 事件是由 `readline` 的 `line` 事件触发的，
 * 而那条路径需要真实 TTY。发件人身份改由驱动公开的 `selfId` 与 `SENDER_ID`
 * 比对来断言（见下方用例）：那正是内核 `#acceptMessage` 拿来判等的两个值。
 * @returns 驱动实例
 */
function makeDriver(): BotDriver {
  const logger = fakeLogger()
  const host = {
    logger,
    submit: () => {},
    setStatus: () => {},
    onDispose: () => () => {},
    signal: new AbortController().signal
  } as unknown as AdapterHost
  const account = validateAccount({ uid: ACCOUNT_ID, enable: false, catimg: false, echoInput: false })
  return createStdinBot(account, host, {
    adapterId: "stdin",
    dataDir: join(tmpdir(), "yzng-stdin-bot"),
    mediaDir: join(tmpdir(), "yzng-stdin-bot", "media"),
    publicBase: undefined
  })
}

describe("发件人身份", () => {
  it("发件人 id 与账号 id 不同 —— 否则内核的 ignoreSelf 会吞掉每一条输入", () => {
    /*
     * 本文件存在的理由。若这条断言红了，终端里敲什么都不会有反应，
     * 且日志里不会留下任何痕迹（事件在进路由之前就没了）。
     */
    expect(SENDER_ID).not.toBe(ACCOUNT_ID)
  })

  it("发件人 id 非空且不含空白 —— 它会被拿去与主人列表比对", () => {
    expect(SENDER_ID.trim()).toBe(SENDER_ID)
    expect(SENDER_ID).not.toBe("")
    expect(/\s/.test(SENDER_ID)).toBe(false)
  })

  it("驱动暴露的 selfId 是账号 id，不是发件人 id", () => {
    // 这两个值就是内核判等的那一对；相等则 ignoreSelf 那道门永远为真
    expect(makeDriver().selfId).toBe(ACCOUNT_ID)
    expect(makeDriver().selfId).not.toBe(SENDER_ID)
  })
})

describe("标准输入可用性判定", () => {
  it("强制开启时无条件为真", () => {
    // FORCE_TTY 是容器/守护进程场景下唯一的出路
    expect(stdinUsable(true)).toBe(true)
  })

  it("FORCE_TTY 环境变量同样生效", () => {
    const saved = process.env["FORCE_TTY"]
    process.env["FORCE_TTY"] = "1"
    try {
      expect(stdinUsable(false)).toBe(true)
    } finally {
      if (saved === undefined) delete process.env["FORCE_TTY"]
      else process.env["FORCE_TTY"] = saved
    }
  })
})

describe("消息发送", () => {
  it("私聊目标可发送，返回 messageId", async () => {
    const target: SendTarget = { scene: "private", uid: SENDER_ID }
    const result = await makeDriver().sendMessage(target, "hello" as MessageContent)
    expect(typeof result.messageId).toBe("string")
    expect(result.messageId.length).toBeGreaterThan(0)
  })

  it("群聊目标被拒绝 —— 终端里没有群", async () => {
    // 假装支持群会让调试时看到与真实平台不一致的行为，宁可当场报错
    const target: SendTarget = { scene: "group", gid: "123" }
    await expect(makeDriver().sendMessage(target, "hi" as MessageContent)).rejects.toThrow()
  })
})

describe("联系人视图", () => {
  it("唯一的人就是终端前的使用者，不是账号自己", async () => {
    /*
     * 与发件人身份同源的一处：`getFriend` / `getFriendList` 报的应当是
     * "谁能跟机器人说话"，即终端前那个人。报成账号自己会让插件的
     * "给自己发消息"判断（如私聊推送去重）拿到一个错误的对象。
     */
    const driver = makeDriver()
    expect((await driver.getFriendList()).map(u => u.uid)).toEqual([SENDER_ID])
    expect(await driver.getFriend(SENDER_ID)).toBeDefined()
    expect(await driver.getFriend(ACCOUNT_ID)).toBeUndefined()
  })

  it("没有群可返回 —— 让插件的 undefined 分支如实触发", async () => {
    const driver = makeDriver()
    expect(await driver.getGroup("123")).toBeUndefined()
    expect(await driver.getGroupList()).toEqual([])
  })
})
