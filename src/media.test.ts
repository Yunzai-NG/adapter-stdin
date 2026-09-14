/**
 * 模块职责：媒体解析的测试 —— 落盘、命名、URL 拼接与"服务器不可用时不编造 URL"
 * 依赖方向：测试文件，依赖 media.ts
 * 生命周期：每个用例用独立的临时目录
 * 注意事项：**"没有内置服务器时 URL 为空串"是要守住的行为。** 一个看起来能用、
 *          点开却连不上的 URL 比没有 URL 更误导 —— 前者会让人去查服务器配置，
 *          后者会让人直接去看那个已经打印在旁边的本地路径。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mediaUrl, resolveMedia } from "./media.js"

describe("媒体 URL 拼接", () => {
  it("基址末尾的斜杠不会产生双斜杠", () => {
    expect(mediaUrl("a.png", "http://127.0.0.1:25365/plugin/adapter-stdin/media/")).toBe(
      "http://127.0.0.1:25365/plugin/adapter-stdin/media/a.png"
    )
  })

  it("文件名被 URL 编码", () => {
    // 落盘的文件名来自使用者给的名字，可能含空格与中文
    expect(mediaUrl("我的 图.png", "http://x/media")).toBe("http://x/media/%E6%88%91%E7%9A%84%20%E5%9B%BE.png")
  })

  it("无基址时返回空串而不是编一个相对路径", () => {
    expect(mediaUrl("a.png", undefined)).toBe("")
    expect(mediaUrl("a.png", "")).toBe("")
  })
})

describe("媒体解析", () => {
  let dir = ""

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "stdin-media-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("本地路径直接采用，不复制文件", async () => {
    const resolved = await resolveMedia({ kind: "path", path: join(dir, "x.png") }, {
      mediaDir: dir,
      segmentType: "image",
      publicBase: undefined
    })
    expect(resolved.path).toBe(join(dir, "x.png"))
    expect(resolved.describe).toContain("x.png")
  })

  it("远端地址不下载，只回显", async () => {
    // 终端里能看到并点开的 URL，比一个被悄悄存到某处的副本有用
    const resolved = await resolveMedia({ kind: "url", url: "https://example.com/a.png" }, {
      mediaDir: dir,
      segmentType: "image",
      publicBase: undefined
    })
    expect(resolved.url).toBe("https://example.com/a.png")
    expect(resolved.path).toBe("")
  })

  it("平台资源 id 说得清自己看不到", async () => {
    const resolved = await resolveMedia({ kind: "id", id: "abc123" }, {
      mediaDir: dir,
      segmentType: "image",
      publicBase: undefined
    })
    expect(resolved.path).toBe("")
    expect(resolved.url).toBe("")
    expect(resolved.describe).toContain("abc123")
  })

  it("平台资源 id 为空时也给出可读的说明", async () => {
    const resolved = await resolveMedia({ kind: "id", id: "" }, {
      mediaDir: dir,
      segmentType: "image",
      publicBase: undefined
    })
    expect(resolved.describe).toContain("id 为空")
  })

  it("buffer 落盘且内容一致", async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5])
    const resolved = await resolveMedia({ kind: "buffer", data, name: "t.bin" }, {
      mediaDir: dir,
      segmentType: "file",
      publicBase: undefined
    })
    expect(resolved.path.startsWith(join(dir, "t-"))).toBe(true)
    expect(resolved.path.endsWith(".bin")).toBe(true)
    expect(new Uint8Array(await readFile(resolved.path))).toEqual(data)
  })

  it("base64 落盘且按 MIME 推断扩展名", async () => {
    const payload = Buffer.from("hello").toString("base64")
    const resolved = await resolveMedia({ kind: "base64", base64: payload, mime: "image/png" }, {
      mediaDir: dir,
      segmentType: "image",
      publicBase: undefined
    })
    expect(resolved.path.endsWith(".png")).toBe(true)
    expect(await readFile(resolved.path, "utf8")).toBe("hello")
  })

  it("给定的文件名保留其扩展名，不被 MIME 覆盖", async () => {
    // 文件段的白名单常常依赖扩展名，换成 .bin 会让"发个 zip 给机器人"没法调试
    const resolved = await resolveMedia(
      { kind: "buffer", data: new Uint8Array([0]), name: "archive.zip", mime: "application/octet-stream" },
      { mediaDir: dir, segmentType: "file", publicBase: undefined }
    )
    expect(resolved.path.endsWith(".zip")).toBe(true)
    expect(resolved.path).toContain("archive-")
  })

  it("名字里带路径分隔符时只取文件名", async () => {
    // 名字可能来自使用者消息，全是路径的话会写到自己目录外面去
    const resolved = await resolveMedia(
      { kind: "buffer", data: new Uint8Array([0]), name: "../../escape.png" },
      { mediaDir: dir, segmentType: "image", publicBase: undefined }
    )
    expect(resolved.path.startsWith(dir)).toBe(true)
    expect(resolved.path).not.toContain("..")
  })

  it("媒体目录不存在时自动创建", async () => {
    const nested = join(dir, "a", "b")
    const resolved = await resolveMedia({ kind: "buffer", data: new Uint8Array([9]) }, {
      mediaDir: nested,
      segmentType: "image",
      publicBase: undefined
    })
    expect(await readFile(resolved.path)).toBeTruthy()
  })

  it("给出基址时同时产出可下载 URL", async () => {
    const resolved = await resolveMedia({ kind: "buffer", data: new Uint8Array([9]), name: "u.png" }, {
      mediaDir: dir,
      segmentType: "image",
      publicBase: "http://127.0.0.1:25365/plugin/adapter-stdin/media"
    })
    expect(resolved.url.startsWith("http://127.0.0.1:25365/plugin/adapter-stdin/media/u-")).toBe(true)
  })
})

/**
 * 同名媒体不得相互覆盖
 *
 * **缺陷现场：`pickName` 原先是"调用方给了名字就直接用"。** 而 `MediaRef.name` 的语义是
 * 「**建议**文件名」而非"必须叫这个名"（类型定义里原文就是"建议"）。渲染器每次出图给的都是
 * 同一个名字（`<插件名>-0.jpeg`），于是后一张静默覆盖前一张 —— 终端里那句
 * 「发送图片 路径: …/yenai-state-0.jpeg」永远是同一个文件，看起来像"图片保存的是固定的
 * 那一张"，实则是每次写到了同一个位置。实机上正是这么报上来的。
 *
 * 故这里连发两张**同名**图，断言落地成两个**不同**的文件，且两张的内容都还在。
 */
describe("同名媒体不覆盖", () => {
  let dir = ""

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "stdin-media-dup-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("**两张同名的图落成两个文件，先发的那张还在**", async () => {
    const opts = { mediaDir: dir, segmentType: "image", publicBase: undefined }
    const first = await resolveMedia(
      { kind: "buffer", data: new Uint8Array([1, 1, 1]), name: "yenai-state-0.jpeg", mime: "image/jpeg" },
      opts
    )
    // 时间戳是秒以下的分辨率，隔一拍才保证不同
    await new Promise(resolve => setTimeout(resolve, 5))
    const second = await resolveMedia(
      { kind: "buffer", data: new Uint8Array([2, 2, 2]), name: "yenai-state-0.jpeg", mime: "image/jpeg" },
      opts
    )

    expect(second.path, "第二张覆盖了第一张 —— 这正是那个缺陷").not.toBe(first.path)
    expect(new Uint8Array(await readFile(first.path))).toEqual(new Uint8Array([1, 1, 1]))
    expect(new Uint8Array(await readFile(second.path))).toEqual(new Uint8Array([2, 2, 2]))
  })

  it("文件名里看得出原名，也带时间戳与内容摘要", async () => {
    // 照 TRSS-Yunzai 的 stdin：`mt11wv18.cadfa939.png` —— 时间戳保证不重名，
    // 摘要让同一张图在目录里看得出是一份
    const resolved = await resolveMedia(
      { kind: "buffer", data: new Uint8Array([7, 7]), name: "状态图.jpeg", mime: "image/jpeg" },
      { mediaDir: dir, segmentType: "image", publicBase: undefined }
    )
    const file = resolved.path.slice(dir.length + 1)
    // <原名>-<36 进制时间戳>.<8 位摘要><扩展名>
    expect(file).toMatch(/^状态图-[0-9a-z]+\.[0-9a-f]{8}\.jpeg$/)
  })

  it("没给名字时也带时间戳，不叫 `media-…` 那种共用名", async () => {
    const resolved = await resolveMedia(
      { kind: "base64", base64: Buffer.from("x").toString("base64"), mime: "image/png" },
      { mediaDir: dir, segmentType: "image", publicBase: undefined }
    )
    expect(resolved.path.slice(dir.length + 1)).toMatch(/^[0-9a-z]+\.[0-9a-f]{8}\.png$/)
  })

  it("内容完全相同 → 摘要相同，只有时间戳在区分", async () => {
    const opts = { mediaDir: dir, segmentType: "image", publicBase: undefined }
    const a = await resolveMedia({ kind: "buffer", data: new Uint8Array([5, 5]), name: "a.png" }, opts)
    const b = await resolveMedia({ kind: "buffer", data: new Uint8Array([5, 5]), name: "b.png" }, opts)
    const digest = (p: string): string => p.slice(p.lastIndexOf(".") - 8, p.lastIndexOf("."))

    expect(digest(a.path)).toBe(digest(b.path))
  })
})
