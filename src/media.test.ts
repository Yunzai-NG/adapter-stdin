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
    expect(resolved.path).toBe(join(dir, "t.bin"))
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
    expect(resolved.path.endsWith("archive.zip")).toBe(true)
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
    expect(resolved.url).toBe("http://127.0.0.1:25365/plugin/adapter-stdin/media/u.png")
  })
})
