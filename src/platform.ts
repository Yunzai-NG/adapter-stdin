/**
 * 模块职责：本适配器的平台标识
 * 依赖方向：叶子模块
 * 生命周期：纯常量
 * 注意事项：单独一个文件而不是写在 `index.ts` 里 —— `bot.ts` 与 `codec` 一类的
 *          模块都要用它，而从 `index.ts` 反向导入会把插件入口拖进依赖图，
 *          入口一被执行（`definePlugin` 被调用）就会在测试环境里产生副作用。
 */
export const PLATFORM = "stdin"
