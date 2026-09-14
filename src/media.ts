/**
 * 模块职责：把消息段里的媒体引用落成终端可用的东西（本地路径 / 可下载 URL）
 * 依赖方向：依赖 node:fs、node:path 与类型包；不依赖内核
 * 生命周期：随驱动创建，媒体目录随账号断开保留（下次调试还要看）
 * 注意事项：**缓冲与 base64 必须落盘。** 终端要显示一张图，得先有个文件 ——
 *          `catimg` 只吃路径，而人眼看到的"路径"要能贴进浏览器或图片查看器。
 *          把字节写进媒体目录是最省事的共同落点，代价是一次磁盘写；与"把 base64
 *          打进终端"相比，那点写入量可以忽略。
 *
 *          **URL 只在确有内置服务器时给出。** 终端与内核同机时路径比 URL 有用得多，
 *          而一个拼错的 URL 会让人以为是服务器出了问题。见 {@link mediaUrl}。
 */
import { mkdir, writeFile } from "node:fs/promises"
import { basename, extname, join } from "node:path"
import type { MediaRef } from "@yunzai-ng/types"

/** 由 MIME 推断的扩展名 */
const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "audio/mpeg": ".mp3",
  "audio/amr": ".amr",
  "audio/wav": ".wav",
  "audio/silk": ".silk",
  "video/mp4": ".mp4"
}

/** 无扩展名时按段类型给出的兜底扩展名 */
const FALLBACK_EXT: Record<string, string> = {
  image: ".png",
  record: ".mp3",
  video: ".mp4",
  file: ".bin"
}

/** 落盘所需的环境参数 */
export interface MediaResolveOptions {
  /** 媒体目录绝对路径（已存在或可创建） */
  mediaDir: string
  /** 段类型，仅用于推断兜底扩展名 */
  segmentType: string
  /** 内置服务器可用时的 URL 基址；不可用时 undefined */
  publicBase: string | undefined
}

/**
 * 媒体在终端里的表示
 *
 * 三个字段都可能为空串：一个既没有路径也取不到 URL 的媒体（例如只有平台侧 id 的
 * 引用）在终端里就是一句话都说不出的东西，调用方据此决定要不要提示"无法显示"。
 */
export interface ResolvedMedia {
  /** 本地绝对路径；取不到时为空串 */
  path: string
  /** 可下载地址；未启用内置服务器或取不到时为空串 */
  url: string
  /** 描述文本，用于终端输出（如"图片 12.3 KB"） */
  describe: string
}

/**
 * 由 MIME 或段类型推断扩展名
 * @param mime MIME 类型
 * @param segmentType 段类型
 * @returns 带点的扩展名
 */
function pickExt(mime: string | undefined, segmentType: string): string {
  if (mime !== undefined) {
    const hit = MIME_EXT[mime.toLowerCase()]
    if (hit !== undefined) return hit
  }
  return FALLBACK_EXT[segmentType] ?? ".bin"
}

/**
 * 取文件名，保留原扩展名
 *
 * 给定的名字优先于按 MIME 推断 —— 文件段的白名单常常依赖扩展名，把它换成 `.bin`
 * 会让"发一个 zip 给机器人"这类调试变得没法做。
 * @param name 建议文件名
 * @param mime MIME 类型
 * @param segmentType 段类型
 * @returns 文件名（不含路径分隔符）
 */
function pickName(name: string | undefined, mime: string | undefined, segmentType: string): string {
  if (name !== undefined && name !== "") {
    // 只取 basename：调用方给的名字可能带路径，而它最终落在本插件的媒体目录里
    const safe = basename(name).replace(/[/\\]/g, "_")
    if (extname(safe) !== "") return safe
    return `${safe}${pickExt(mime, segmentType)}`
  }
  return `media-${Date.now().toString(36)}${pickExt(mime, segmentType)}`
}

/**
 * 拼出媒体的下载地址
 *
 * 只在 `publicBase` 存在时给出。终端使用者在本机，路径已经足够；一个"看起来能用
 * 但其实连不上"的 URL 比没有 URL 更误导 —— 后者会让人直接去看路径，前者会让人
 * 去查服务器。
 * @param file 媒体文件名
 * @param publicBase URL 基址
 * @returns 完整地址；无基址时为空串
 */
export function mediaUrl(file: string, publicBase: string | undefined): string {
  if (publicBase === undefined || publicBase === "") return ""
  return `${publicBase.replace(/\/+$/, "")}/${encodeURIComponent(file)}`
}

/**
 * 把媒体引用解析成终端可用的形式
 *
 * 按 `id > url > path > buffer > base64` 的代价顺序处理，与内核 `MediaRef` 的注释一致：
 * `id` 零传输但终端用不上（只回显 id），`url` 不必下载（本机终端拿到 URL 反而更方便），
 * `path` 直接可用，后两者必须落盘。
 * @param ref 媒体引用
 * @param opts 环境参数
 * @returns 解析结果
 */
export async function resolveMedia(ref: MediaRef, opts: MediaResolveOptions): Promise<ResolvedMedia> {
  switch (ref.kind) {
    case "path":
      return {
        path: ref.path,
        url: mediaUrl(basename(ref.path), opts.publicBase),
        describe: `本地文件 ${basename(ref.path)}`
      }

    case "url":
      // 刻意不下载：终端里能看到并点开的 URL，比一个被悄悄存到某处的副本有用
      return { path: "", url: ref.url, describe: "远端资源" }

    case "id":
      // 平台侧的资源标识在终端里无从解析。原样显示，让使用者知道"这里有东西但看不到"
      return { path: "", url: "", describe: `平台资源 ${ref.id === "" ? "（id 为空）" : ref.id}` }

    case "buffer":
    case "base64": {
      const data = ref.kind === "buffer" ? Buffer.from(ref.data) : Buffer.from(ref.base64, "base64")
      const name = pickName(ref.kind === "buffer" ? ref.name : undefined, ref.mime, opts.segmentType)
      const file = join(opts.mediaDir, name)
      await mkdir(opts.mediaDir, { recursive: true })
      await writeFile(file, data)
      return {
        path: file,
        url: mediaUrl(name, opts.publicBase),
        describe: `已写入 ${(data.byteLength / 1024).toFixed(1)} KB`
      }
    }
  }
}
