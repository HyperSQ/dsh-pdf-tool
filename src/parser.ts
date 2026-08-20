import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { deflateSync } from 'node:zlib'

// Set up pdfjs worker for Node.js
// After esbuild bundling, pdf.worker.mjs sits next to index.js in lib/
// Convert to file:// URL for Windows compatibility (pdfjs uses dynamic import)
const _moduleDir = fileURLToPath(new URL('.', import.meta.url))
const _workerPath = join(_moduleDir, 'pdf.worker.mjs')
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(_workerPath).href

export interface ParsedTable {
  page: number
  rows: string[][]
}

export interface ParsedSection {
  title: string
  text: string
}

export interface ParsedImage {
  page: number
  path: string
  width: number
  height: number
}

export interface ParsedPDF {
  file: string
  page_count: number
  text: string
  tables: ParsedTable[]
  sections: ParsedSection[]
  images: ParsedImage[]
}

interface PositionedText {
  str: string
  x: number
  y: number
  width: number
  height: number
}

/**
 * Parse a PDF file and extract text, tables, sections, and images.
 * @param filePath - absolute path to the PDF file
 * @param outputDir - directory to save extracted images (defaults to ./output)
 */
export async function parsePDF(filePath: string, outputDir?: string): Promise<ParsedPDF> {
  const buffer = await readFile(filePath)
  const data = new Uint8Array(buffer)
  const imgDir = outputDir || join(process.cwd(), 'output')
  await mkdir(imgDir, { recursive: true })

  const loadingTask = pdfjs.getDocument({ data })
  const doc = await loadingTask.promise

  const allText: string[] = []
  const allTables: ParsedTable[] = []
  const allImages: ParsedImage[] = []

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()

    // Extract positioned text items
    const items: PositionedText[] = (content.items as any[])
      .filter(item => 'str' in item && item.str !== '')
      .map(item => ({
        str: item.str,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width || 0,
        height: item.height || 0,
      }))

    // Build page text
    const lines = groupIntoLines(items)
    const pageText = lines.map(line => joinLineItems(line)).join('\n')
    allText.push(pageText)

    // Detect tables
    const tables = detectTables(lines, i)
    allTables.push(...tables)

    // Extract images
    const images = await extractImages(page, i, imgDir)
    allImages.push(...images)

    page.cleanup()
  }

  const numPages = doc.numPages
  await doc.destroy()

  const fullText = allText.join('\n')
  const sections = splitSections(fullText)

  return {
    file: basename(filePath),
    page_count: numPages,
    text: fullText,
    tables: allTables,
    sections,
    images: allImages,
  }
}

/**
 * Group text items into lines by Y position.
 * Items within 2px vertically are considered the same line.
 */
function groupIntoLines(items: PositionedText[]): PositionedText[][] {
  if (items.length === 0) return []

  // Sort by Y (descending, top to bottom in PDF coords) then X (ascending)
  const sorted = [...items].sort((a, b) => {
    if (Math.abs(a.y - b.y) > 2) return b.y - a.y
    return a.x - b.x
  })

  const lines: PositionedText[][] = []
  let currentLine: PositionedText[] = [sorted[0]]
  let currentY = sorted[0].y

  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i]
    if (Math.abs(item.y - currentY) > 2) {
      lines.push(currentLine)
      currentLine = [item]
      currentY = item.y
    } else {
      currentLine.push(item)
    }
  }
  lines.push(currentLine)

  return lines
}

/**
 * Join items in a line into a string.
 * Adds spaces between items when there's a horizontal gap.
 */
function joinLineItems(items: PositionedText[]): string {
  if (items.length <= 1) return items.map(i => i.str).join('')

  const parts: string[] = [items[0].str]
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1]
    const curr = items[i]
    const gap = curr.x - (prev.x + prev.width)
    if (gap > 5) {
      parts.push(' ')
    }
    parts.push(curr.str)
  }
  return parts.join('')
}

/**
 * Detect tables from text lines using position heuristics.
 * A table is a group of consecutive lines where each line has 2+ items
 * with significant horizontal gaps (indicating columns).
 */
function detectTables(lines: PositionedText[][], pageNum: number): ParsedTable[] {
  const tables: ParsedTable[] = []
  const GAP_THRESHOLD = 30 // Min gap (PDF units) to count as column separator

  // Identify which lines are potential table rows
  const isTableRow = lines.map(line => {
    if (line.length < 2) return false
    let gaps = 0
    for (let i = 1; i < line.length; i++) {
      const gap = line[i].x - (line[i - 1].x + line[i - 1].width)
      if (gap > GAP_THRESHOLD) gaps++
    }
    return gaps >= 1
  })

  // Group consecutive table rows into tables
  let i = 0
  while (i < lines.length) {
    if (!isTableRow[i]) {
      i++
      continue
    }

    let end = i
    while (end < lines.length && isTableRow[end]) {
      end++
    }

    const tableLines = lines.slice(i, end)
    if (tableLines.length >= 2) {
      // Determine column boundaries from all rows
      const columnXs = new Set<number>()
      for (const line of tableLines) {
        for (const item of line) {
          columnXs.add(Math.round(item.x / 10) * 10)
        }
      }
      const sortedColumns = [...columnXs].sort((a, b) => a - b)

      // Build rows by assigning items to nearest column
      const rows = tableLines.map(line => {
        const row: string[] = new Array(sortedColumns.length).fill('')
        for (const item of line) {
          let closestIdx = 0
          let closestDist = Infinity
          for (let j = 0; j < sortedColumns.length; j++) {
            const dist = Math.abs(item.x - sortedColumns[j])
            if (dist < closestDist) {
              closestDist = dist
              closestIdx = j
            }
          }
          row[closestIdx] = row[closestIdx] ? row[closestIdx] + ' ' + item.str : item.str
        }
        // Trim trailing empty cells
        while (row.length > 0 && row[row.length - 1] === '') {
          row.pop()
        }
        return row
      })

      tables.push({ page: pageNum, rows })
    }

    i = end
  }

  return tables
}

/**
 * Split text into sections by detecting heading patterns.
 */
function splitSections(text: string): ParsedSection[] {
  const tocDotRe = /\.{3,}.*$/

  const patterns: RegExp[] = [
    // Chinese numbered: 一、 二、 etc.
    /^(一、|二、|三、|四、|五、|六、|七、|八、|九、|十、)\s*(.+)/,
    // Arabic numbered: 1  1.1  2.3 etc. (number + space + title text)
    /^(\d+\.?\d*)\s+(\S[^\n]{1,78})/,
    // Named sections (Chinese / English)
    /^(摘要|引言|方法论|研究方法|实证结果|实证分析|结论|参考文献|附录|目录|Abstract|Introduction|Methodology|Results|Conclusion)$/,
  ]

  const sections: ParsedSection[] = []
  const lines = text.split('\n')
  let currentTitle: string | null = null
  let currentLines: string[] = []

  for (const line of lines) {
    const stripped = line.trim()
    if (!stripped) {
      if (currentTitle !== null) {
        currentLines.push(line)
      }
      continue
    }

    let matched = false
    for (const pat of patterns) {
      const m = stripped.match(pat)
      if (m) {
        const cleanTitle = stripped.replace(tocDotRe, '').trim()
        // Skip if title is just a number, too short, a citation (contains 《), or a year-prefixed sentence
        if (cleanTitle.length < 3 || cleanTitle.replace(/[.\s]/g, '').match(/^\d+$/) || cleanTitle.includes('《') || /^(19|20)\d{2}\s/.test(cleanTitle)) {
          continue
        }
        if (currentTitle !== null) {
          sections.push({ title: currentTitle, text: currentLines.join('\n').trim() })
        }
        currentTitle = cleanTitle
        currentLines = []
        matched = true
        break
      }
    }

    if (!matched && currentTitle !== null) {
      currentLines.push(line)
    }
  }

  if (currentTitle !== null) {
    sections.push({ title: currentTitle, text: currentLines.join('\n').trim() })
  }

  return sections
}

/**
 * Extract images from a PDF page and save them as files.
 * Uses the operator list to find image XObjects.
 */
async function extractImages(page: any, pageNum: number, outputDir: string): Promise<ParsedImage[]> {
  const images: ParsedImage[] = []
  try {
    const ops = await page.getOperatorList()
    const OPS = pdfjs.OPS
    const fnArray = ops.fnArray
    const argsArray = ops.argsArray

    let imgIdx = 0
    for (let j = 0; j < fnArray.length; j++) {
      if (fnArray[j] === OPS.paintImageXObject || fnArray[j] === OPS.paintInlineImageXObject) {
        const imgName = argsArray[j][0]
        try {
          const imgObj = await new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('image load timeout')), 5000)
            page.objs.get(imgName, (val: any) => {
              clearTimeout(timer)
              resolve(val)
            }, (err: any) => {
              clearTimeout(timer)
              reject(err)
            })
          })
          if (imgObj && imgObj.data && imgObj.width && imgObj.height) {
            // Convert raw RGBA/RGB data to PNG using a minimal encoder
            const w = imgObj.width
            const h = imgObj.height
            const fname = `img_p${pageNum}_${imgIdx}.png`
            const fpath = join(outputDir, fname)
            await writePng(fpath, imgObj.data, w, h, imgObj.kind)
            images.push({ page: pageNum, path: fpath, width: w, height: h })
            imgIdx++
          }
        } catch {
          // Skip images that can't be extracted
        }
      }
    }
  } catch {
    // Skip image extraction if operator list fails
  }
  return images
}

/**
 * Minimal PNG encoder for raw image data from pdfjs.
 * Handles RGB (3 channels) and RGBA (4 channels) data.
 */
async function writePng(path: string, data: Uint8Array, width: number, height: number, kind: number): Promise<void> {
  // pdfjs ImageKind: 1 = GRAY_1BPP, 2 = RGB_24BPP, 3 = RGBA_32BPP
  const channels = kind === 2 ? 3 : 4
  const png = encodePng(data, width, height, channels)
  await writeFile(path, png)
}

/**
 * Encode raw pixel data as a PNG file (uncompressed/stored).
 * Simple but reliable — no native dependencies.
 */
function encodePng(rawData: Uint8Array, width: number, height: number, channels: number): Buffer {
  const rowSize = width * channels
  const rawSize = (rowSize + 1) * height

  // Build raw data with filter byte (0 = None) per row
  const raw = new Uint8Array(rawSize)
  let offset = 0
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0 // filter: None
    const srcStart = y * rowSize
    raw.set(rawData.subarray(srcStart, srcStart + rowSize), offset)
    offset += rowSize
  }

  // Compress with zlib (Node built-in)
  const compressed = deflateSync(Buffer.from(raw))

  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

  // IHDR chunk
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = channels === 4 ? 6 : 2 // color type: 6=RGBA, 2=RGB
  ihdr[10] = 0 // compression: deflate
  ihdr[11] = 0 // filter method: standard
  ihdr[12] = 0 // interlace: none

  const ihdrChunk = makeChunk('IHDR', ihdr)
  const idatChunk = makeChunk('IDAT', compressed)
  const iendChunk = makeChunk('IEND', Buffer.alloc(0))

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk])
}

/** Build a PNG chunk: length + type + data + CRC. */
function makeChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcData = Buffer.concat([typeBuf, data])
  const crc = crc32(crcData)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc >>> 0, 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

/** CRC32 lookup table for PNG. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

/** Compute CRC32 for PNG chunks. */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
