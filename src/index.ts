/**
 * 模块职责：插件入口 —— 将标准输入适配器注册至内核
 * 依赖方向：仅依赖 `@yunzai-ng/core` 的公开入口与 `@yunzai-ng/types`
 * 生命周期：`setup` 在插件加载时执行一次，返回后适配器即可被账号引用
 * 注意事项：**本适配器与网络适配器的根本差别是"没有登录"。** NapCat 的账号记录描述的是
 *          "如何连接一个已完成登录的 NapCat"，而终端本身就已经是"登录状态"了 ——
 *          它是一个随时可用的收发端点。故面板上新建一个 stdin 账号、什么都不改、
 *          保存，它就应该工作；`login()` 自然也不必实现。
 *
 *          它的用途是**在没有 QQ 环境的前提下跑通一条完整链路**：命令匹配、权限判定、
 *          消息切分、渲染、定时任务、插件间调用 —— 这些与平台无关的部分，
 *          此前要验证必须先把 NapCat 和 QQ 号都准备好。
 *
 *          **它不是一个可以对外使用的适配器。** 消息只能从终端进、从终端出，
 *          没有第二个用户。放在生产实例上只会得到一个永远不响的账号。
 */
import { ensureDir } from "@yunzai-ng/core"
import { SubsystemUnavailableError } from "@yunzai-ng/core"
import { definePlugin } from "@yunzai-ng/core"
import { join } from "node:path"
import type { AdapterHost, AdapterProvider, BotDriver, PluginDefinition } from "@yunzai-ng/types"
import { ACCOUNT_SCHEMA, validateAccount } from "./config.js"
import type { StdinAccount } from "./config.js"
import { createStdinBot } from "./bot.js"
import { PLATFORM } from "./platform.js"

/** 适配器 id；账号记录中引用该值 */
export const ADAPTER_ID = "stdin"

/** 媒体文件的落盘目录名（位于插件数据目录之下） */
const MEDIA_DIR = "media"

/** 媒体经内置服务器对外暴露时的挂载前缀 */
const MEDIA_ROUTE = "/media"

export { ACCOUNT_SCHEMA, validateAccount, useAnsi } from "./config.js"
export type { StdinAccount, AnsiMode } from "./config.js"
export { stdinUsable } from "./bot.js"
export { PLATFORM } from "./platform.js"

/**
 * 插件定义
 *
 * 显式标注类型而非直接 `export default definePlugin(...)`：返回类型 `PluginDefinition` 声明在
 * `@yunzai-ng/types` 内，就地构建时该包的真实路径可能落在宿主的 `node_modules/.pnpm/` 之下，
 * tsc 生成 .d.ts 时无从以可移植的方式指称它，报 TS2742。标注后 .d.ts 直接写下这个名字。
 * 本插件未声明 configSchema，故配置类型即 `definePlugin` 在这一情形下推出的 `Record<string, never>`。
 */
const plugin: PluginDefinition<Record<string, never>> = definePlugin({
  name: "adapter-stdin",
  version: "0.1.0",
  description: "标准输入适配器：把终端本身当作一个账号，用于没有 QQ 环境时调试命令与插件",
  // 与其他适配器一致：注册越早，"适配器未注册"的时间窗口越短
  priority: 10,

  setup(ctx) {
    /** 媒体目录：随包数据目录，跨重启保留（下次调试还要看上次的图） */
    const mediaDir = join(ctx.dataDir, MEDIA_DIR)

    /*
     * 静态挂载与服务器可用性是两件事，此处刻意分开：
     *
     * `ctx.static()` 把目录挂上（内核的服务器一启动就生效），而 `publicBase` 是否给出
     * 取决于此刻服务器开没开。取 getter 而非快照值 —— 服务器装配比插件加载晚，
     * 快照下来的话先加载插件、后开服务器的顺序会导致 URL 永远为空。
     *
     * **判据不能用 `ctx.app.server.enabled`。** 这一条曾经写错过，代价是一个静默失效的
     * 功能：`ctx.app.server` 转发的是 `hooks.server.info`，而服务器子系统在**插件加载
     * 之后**才替换掉那个 `unavailableServer()` 占位 —— 于是插件加载期读到的 `enabled`
     * 恒为 `false`，`ctx.static()` 一次都没被调用过，`/media/*` 这条路由压根不存在。
     *
     * 它的症状极具迷惑性：媒体文件照常落盘、日志里照常打印出一个**拼得完全正确的 URL**
     * （那个走的是下面 `publicBase()`，getter 每次重读，那时服务器早起来了），
     * 只有真去打开那个地址才会发现 404。加载成功、无警告、无错误，什么都看不出来。
     *
     * 服务器**关闭**时 `ctx.static()` 确实会抛（内核的取舍是"当场报错"优于"注册成功
     * 但永远收不到请求"），而那正是首次运行的默认状态，不能让它把整个插件带走 ——
     * 一个只在"服务器开着"时才装得上的调试适配器，恰恰在最需要它的场景里装不上。
     * 故此处只吞掉**那一类**错误，其余照常抛出。
     */
    try {
      ctx.static(MEDIA_ROUTE, mediaDir)
    } catch (err) {
      if (!(err instanceof SubsystemUnavailableError)) throw err
      ctx.logger.debug("HTTP 服务器未启用，媒体文件只打印本地路径，不提供下载地址")
    }

    const publicBase = (): string | undefined => {
      const server = ctx.app.server
      if (!server.enabled) return undefined
      return `${server.publicUrl.replace(/\/+$/, "")}/plugin/${ctx.name}${MEDIA_ROUTE}`
    }

    const provider: AdapterProvider<StdinAccount> = {
      id: ADAPTER_ID,
      name: "标准输入",
      description: "把终端当作一个账号。消息在终端输入、回复也打印到终端，用于无 QQ 环境下的调试",
      platform: PLATFORM,
      accountSchema: ACCOUNT_SCHEMA.describe(),
      validateAccount,

      createBot(account: StdinAccount, host: AdapterHost): BotDriver {
        return createStdinBot(account, host, {
          adapterId: ADAPTER_ID,
          dataDir: ctx.dataDir,
          mediaDir,
          get publicBase(): string | undefined {
            return publicBase()
          }
        })
      }
    }

    ctx.registerAdapter(provider as unknown as AdapterProvider)

    /*
     * 目录在这里建而不是等第一条落盘消息：`ctx.static()` 挂的是一个不存在的目录时，
     * 内核的静态处理器会返回 404 而不是在启动时报错，于是"图片的 URL 打不开"这件事
     * 要到真的发过一张图之后才会被发现。
     */
    void ensureDir(mediaDir).catch((err: unknown) => {
      ctx.logger.warn(`创建媒体目录 ${mediaDir} 失败：${err instanceof Error ? err.message : String(err)}`)
    })

    ctx.logger.info("标准输入适配器已注册，可在面板的账号页面添加账号（默认配置即可用）")
  }
})

export default plugin
