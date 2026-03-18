/**
 * 舷号座位图生成器
 * 用 Puppeteer 渲染 HTML 并截图，返回图片路径
 */
import puppeteer from 'puppeteer'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TMP_DIR = path.join(__dirname, '..', 'tmp')

const SECTIONS = [
  { label: '联队管理层', sub: 'COMMAND · No.000–010', range: [0, 10],   color: '#f59e0b', dim: '#451a03' },
  { label: '杰出贡献者', sub: 'ELITE · No.011–100',   range: [11, 100], color: '#a855f7', dim: '#2e1065' },
  { label: '荣誉舷号',   sub: 'HONOR · No.101+',      range: [101, Infinity], color: '#06b6d4', dim: '#082f49' },
]

function pad(n) { return String(n).padStart(3, '0') }

function buildHtml(assignments, stats) {
  const nums = [...assignments.keys()]
  const maxHull = nums.length ? Math.max(...nums) : 10
  // Honor section ends at maxHull rounded up to next 10
  const honorEnd = Math.max(110, Math.ceil((maxHull + 5) / 10) * 10)

  let sectionsHtml = ''
  for (const sec of SECTIONS) {
    const start = sec.range[0]
    const end = sec.range[1] === Infinity ? honorEnd : sec.range[1]
    if (end < start) continue

    const cells = []
    for (let n = start; n <= end; n++) {
      const member = assignments.get(n)
      if (member) {
        const name = (member.name || '').slice(0, 9)
        cells.push(
          `<div class="cell occ" style="border-color:${sec.color}50;background:${sec.color}18;color:${sec.color}">` +
          `<span class="cn">${pad(n)}</span>` +
          `<span class="nm">${name}</span>` +
          `</div>`
        )
      } else {
        cells.push(
          `<div class="cell emp" style="border-color:${sec.dim};color:${sec.dim}">` +
          `<span class="cn">${pad(n)}</span>` +
          `</div>`
        )
      }
    }

    sectionsHtml += `
      <div class="sec" style="border-color:${sec.color}25">
        <div class="sh" style="border-bottom:1px solid ${sec.color}25">
          <span class="sl" style="color:${sec.color}">${sec.label}</span>
          <span class="ss">${sec.sub}</span>
        </div>
        <div class="grid">${cells.join('')}</div>
      </div>`
  }

  const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0c0e16;color:#e2e8f0;font-family:'Segoe UI',system-ui,sans-serif;padding:16px;width:880px}
.hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;padding:12px 16px;background:#13151f;border-radius:8px;border:1px solid #1e2030}
.ht{font-size:17px;font-weight:700;letter-spacing:.04em}
.sts{display:flex;gap:24px}
.st{text-align:center}.sv{font-size:17px;font-weight:700}.sk{font-size:11px;color:#4b5563;margin-top:1px}
.sec{margin-bottom:12px;border:1px solid;border-radius:8px;overflow:hidden}
.sh{display:flex;align-items:baseline;gap:8px;padding:7px 12px;background:#0f111a}
.sl{font-size:12px;font-weight:600}.ss{font-size:10px;color:#374151}
.grid{display:flex;flex-wrap:wrap;padding:8px;gap:4px;background:#0b0d15}
.cell{width:80px;height:48px;border-radius:5px;border:1px solid;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px}
.cn{font-size:12px;font-weight:600}.nm{font-size:9px;opacity:.9;max-width:74px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.emp{opacity:.3}
.ft{margin-top:8px;font-size:10px;color:#1f2937;text-align:right}
</style></head><body>
<div class="hd">
  <div class="ht">⚓ HORIZN 舷号座位图</div>
  <div class="sts">
    <div class="st"><div class="sv" style="color:#f59e0b">${stats.totalAssigned}</div><div class="sk">已分配</div></div>
    <div class="st"><div class="sv" style="color:#ef4444">${stats.blacklistTotal}</div><div class="sk">黑名单</div></div>
    <div class="st"><div class="sv" style="color:#4b5563">${stats.gapCount}</div><div class="sk">空位</div></div>
  </div>
</div>
${sectionsHtml}
<div class="ft">艾米莉亚 · ${ts}</div>
</body></html>`
}

export async function generateHullSeatmapImage(membersWithNames, stats) {
  fs.mkdirSync(TMP_DIR, { recursive: true })

  const assignments = new Map()
  for (const m of membersWithNames) {
    const n = parseInt(m.hull_number)
    if (!isNaN(n)) assignments.set(n, { name: m.primary_name || m.player_id })
  }

  const html = buildHtml(assignments, stats)

  const browser = await puppeteer.launch({
    args: process.platform === 'linux'
      ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      : [],
    headless: true
  })

  const imgPath = path.join(TMP_DIR, `seatmap_${Date.now()}.png`)
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    await page.setViewport({ width: 900, height: 600 })
    const bodyH = await page.evaluate(() => document.body.scrollHeight)
    await page.setViewport({ width: 900, height: bodyH + 20 })
    await page.screenshot({ path: imgPath })
  } finally {
    await browser.close()
  }

  return imgPath
}
