/**
 * 舷号座位图生成器
 * 调用抽奖模拟器后端 API 获取 PNG，保存到本地临时文件
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TMP_DIR = path.join(__dirname, '..', 'tmp')

export async function generateHullSeatmapImage() {
  const apiUrl = process.env.SEATMAP_API_URL
  if (!apiUrl) throw new Error('未配置 SEATMAP_API_URL')

  const token = process.env.HORIZN_BOT_TOKEN
  const url = token ? `${apiUrl}?token=${encodeURIComponent(token)}` : apiUrl

  const resp = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`座位图 API 返回 ${resp.status}: ${body.slice(0, 200)}`)
  }

  const contentType = resp.headers.get('content-type') || ''
  if (!contentType.includes('image')) {
    const body = await resp.text().catch(() => '')
    throw new Error(`座位图 API 返回非图片内容: ${body.slice(0, 200)}`)
  }

  fs.mkdirSync(TMP_DIR, { recursive: true })
  const imgPath = path.join(TMP_DIR, `seatmap_${Date.now()}.png`)
  const buffer = await resp.arrayBuffer()
  fs.writeFileSync(imgPath, Buffer.from(buffer))

  console.log(`[SeatMap] 图片已保存: ${imgPath} (${buffer.byteLength} bytes)`)
  return imgPath
}
