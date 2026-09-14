/**
 * 模块职责：插件入口的测试 —— `setup()` 在两种服务器状态下的行为
 * 依赖方向：测试文件，依赖内核的公开测试替身（`@yunzai-ng/core/testing`）
 * 生命周期：每个用例一套全新的上下文
 * 注意事项：**本文件守的是"服务器关闭时插件仍能装上"。** 这一条曾经真的错过：
 *          `ctx.static()` 在 `server.enable` 为 false 时是抛错的（内核刻意不建服务器实例，
 *          把那几个方法留成会抛的占位，理由是"注册成功却永远收不到请求"比当场报错难查），
 *          而无条件调用它会让本插件在**首次运行的默认配置**下整个加载失败 ——
 *          一个只在"服务器开着"时才装得上的调试适配器，恰恰在最需要它的场景里装不上。
 *
 *          这类缺陷单元测试抓不到，是端到端起一次内核才暴露出来的（见 README 的手工验证）。
 *          补上本用例是为了让它以后只错一次。
 *
 *          **此处不测 `createStdinBot()` 的细节**，那是 bot.ts 的事，且它需要真实标准输入。
 */
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createPluginContext, createServiceRegistry, createEventBus, DisposalRegistry } from "@yunzai-ng/core"
import { SubsystemUnavailableError } from "@yunzai-ng/core"
import { fakeLogger, fakeHttp, recordingHooks } from "@yunzai-ng/core/testing"
import type { AppView, ConfigHandle, KvNamespace, PluginContext, ServerInfo } from "@yunzai-ng/types"
import plugin, { ADAPTER_ID } from "./index.js"

/** 假插件根目录（只做路径计算，不必真的存在） */
const ROOT = join(tmpdir(), "yzng-stdin-plugin")

/** 假数据目录 */
const DATA = join(tmpdir(), "yzng-stdin-data")

/**
 * 媒体目录的挂载前缀
 *
 * 直接写字符串而不是从 `index.ts` 导入：它是本插件与外部（README 里给使用者看的
 * URL、面板上贴的地址）之间的契约，改动它就是改契约。导入常量的话断言会跟着一起变，
 * 测不出"路径被人改了"这件事。`index.ts` 也确实没有导出它——不必为一个测试放宽公开面。
 */
const MEDIA_PATH = "/media"

/**
 * 装配一份上下文并跑一次 `setup()`
 * @param server 服务器信息，用于模拟开 / 关两种状态
 * @returns 录制到的注册结果与清理句柄
 */
function runSetup(server: ServerInfo): {
  recorded: ReturnType<typeof recordingHooks>["recorded"]
  staticCalls: string[]
} {
  const logger = fakeLogger()
  const { hooks, recorded } = recordingHooks()
  const registry = new DisposalRegistry("adapter-stdin")

  /*
   * `ctx.static()` 的调用痕迹
   *
   * 需要它是因为"录制到的挂载为空"这件事有两种成因 —— 插件压根没调，或者调了但抛了。
   * 只断言"为空"分不清这两者，而本文件要守的恰恰是前者（用加载期的 `enabled` 提前跳过）。
   */
  const staticCalls: string[] = []
  const realStatic = hooks.server.static

  /*
   * 服务器关闭时要让 `static` 真的抛错，照内核 `unavailableServer()` 的样子。
   *
   * 录制型替身一律不抛，直接拿它测"关闭"等于测了个空：`setup()` 那时无论怎么写都能过，
   * 本文件也就白写了。内核之所以在关闭时刻意留一个会抛的占位，理由是
   * "注册成功却永远收不到请求"比当场报错难查得多 —— 替身若把这份严厉抹平，
   * 测出来的行为就与真机不一致。
   *
   * **抛的必须是 `SubsystemUnavailableError`**，不能是裸 `Error`：插件只吞这一类，
   * 其余错误照常抛出。替身抛错类型不对的话，"该吞的吞了、该抛的没被吞"这两件事
   * 就分不开。
   *
   * 顺序要紧：先记痕、再决定抛不抛。反过来写的话后一个赋值会把记录器整个盖掉。
   */
  const failing = !server.enabled
  hooks.server = {
    ...hooks.server,
    static: (scope, urlPath, dir) => {
      staticCalls.push(urlPath)
      if (failing) throw new SubsystemUnavailableError("HTTP 服务器", "服务器子系统未初始化")
      return realStatic(scope, urlPath, dir)
    }
  }
  if (failing) {
    const fail = (): never => {
      throw new SubsystemUnavailableError("HTTP 服务器", "服务器子系统未初始化")
    }
    hooks.server = { ...hooks.server, route: fail, websocket: fail, panel: fail }
  }

  const { ctx } = createPluginContext({
    name: "adapter-stdin",
    version: "0.1.0",
    root: ROOT,
    dataDir: DATA,
    logger,
    kv: {} as unknown as KvNamespace,
    config: {} as unknown as ConfigHandle<unknown>,
    // 只覆写 server：其余成员本用例用不到，也不必在本文件里重复替身
    app: { version: "0.0.0-test", startedAt: 0, server, usage: () => ({}) } as unknown as AppView,
    http: fakeHttp(),
    services: createServiceRegistry(),
    events: createEventBus({ logger }),
    hooks,
    registry,
    signal: new AbortController().signal
  })

  /*
   * `createPluginContext()` 的返回类型固定是 `PluginContext<unknown>`（宿主对插件的
   * 配置类型一无所知），而本插件的 `setup` 声明的是 `Record<string, never>` ——
   * 它没有 configSchema，配置只能是空对象。两者只差 `config.get()` 的返回类型，
   * 断言即是最贴切的表达；真正的不匹配（比如插件声明了 configSchema 而替身给不出）
   * 会在别处当场暴露，不会靠这里蒙混过去。
   */
  plugin.setup(ctx as PluginContext<Record<string, never>>)
  return { recorded, staticCalls }
}

/** 服务器可用 */
const SERVER_ON: ServerInfo = {
  enabled: true,
  host: "127.0.0.1",
  port: 25365,
  publicUrl: "http://127.0.0.1:25365"
}

/** 服务器关闭——首次运行的默认状态 */
const SERVER_OFF: ServerInfo = { enabled: false, host: "", port: 0, publicUrl: "" }

describe("插件元信息", () => {
  it("适配器 id 与包名一致", () => {
    // 账号记录里存的是这个 id；改名会让已有账号全部指不到适配器
    expect(ADAPTER_ID).toBe("stdin")
    expect(plugin.name).toBe("adapter-stdin")
  })

  it("比其他插件先加载", () => {
    // 适配器注册越晚，"账号找不到适配器"的时间窗口越长
    expect(plugin.priority).toBe(10)
  })
})

describe("服务器开启时", () => {
  it("注册适配器并挂上媒体目录", () => {
    const { recorded } = runSetup(SERVER_ON)
    expect(recorded.adapters.map(a => a.id)).toEqual(["stdin"])
    expect(recorded.statics.map(m => m.urlPath)).toEqual([MEDIA_PATH])
  })

  it("媒体挂载指向插件数据目录下的子目录", () => {
    const { recorded } = runSetup(SERVER_ON)
    expect(recorded.statics[0]?.dir).toBe(join(DATA, "media"))
  })
})

describe("服务器关闭时", () => {
  it("插件照常装上，不因 static 挂不上而整体失败", () => {
    /*
     * 本文件存在的理由。见文件头：`ctx.static()` 在服务器关闭时抛错，
     * 而无条件调用它会让插件在默认配置下装不上。
     */
    expect(() => runSetup(SERVER_OFF)).not.toThrow()
  })

  it("适配器仍然注册成功——这才是本插件的本职", () => {
    // 调试用的适配器不该依赖 HTTP 服务器；服务器只影响媒体能否通过 URL 下载
    const { recorded } = runSetup(SERVER_OFF)
    expect(recorded.adapters.map(a => a.id)).toEqual(["stdin"])
  })

  it("不挂静态目录", () => {
    const { recorded } = runSetup(SERVER_OFF)
    expect(recorded.statics).toHaveLength(0)
  })
})

describe("服务器尚未装配时", () => {
  it("静态目录仍然被挂上 —— 此时 enabled 为 false 但服务器随后就会起来", () => {
    /*
     * 本用例守的是一个曾静默失效的功能，现象是"图片 URL 打不开（404）"。
     *
     * 内核里 `ctx.app.server` 转发的是 `hooks.server.info`，而服务器子系统在
     * **插件加载之后**才替换掉 `unavailableServer()` 那个占位。于是插件加载期读到的
     * `enabled` 恒为 `false`，哪怕配置里 `server.enable` 是 true。
     *
     * 原先的写法据此跳过挂载，结果 `/media/*` 这条路由从来没注册过。症状极具迷惑性：
     * 文件照常落盘、日志照常打印出一个拼得完全正确的 URL，只有真去打开才会 404。
     *
     * 故这里断言的是**挂载动作发生了**，而不是"enabled 为真时才挂"。替身此刻抛错，
     * 正说明它模拟的是"占位尚未被替换"这一状态 —— 与真机加载期一模一样。
     */
    const { recorded, staticCalls } = runSetup(SERVER_OFF)
    // 替身抛错 → 挂载没成，故录制到的静态目录为空
    expect(recorded.statics).toHaveLength(0)
    // 但"为空"单看分不清"没调"与"调了但抛了"，故断言调用痕迹确实存在
    expect(staticCalls).toEqual([MEDIA_PATH])
  })
})
