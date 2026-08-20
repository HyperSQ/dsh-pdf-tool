/**
 * Render a PDF page to a PNG image using @napi-rs/canvas + pdfjs-dist.
 *
 * Captures all visual content on the page including vector graphics
 * (bar charts, line charts, axes, labels) that cannot be extracted as
 * embedded raster images.
 *
 * Caching: rendered images are saved as {pdfName}_page_{num}_scale{scale}.png.
 * If the file already exists, rendering is skipped and the cached file is
 * returned directly.
 * @module dsh-pdf-tool/renderer
 */

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Set up pdfjs worker (same pattern as parser.ts — esbuild deduplicates)
const _moduleDir = fileURLToPath(new URL('.', import.meta.url))
const _workerPath = join(_moduleDir, 'pdf.worker.mjs')
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(_workerPath).href

export interface RenderedPage {
  path: string
  width: number
  height: number
  cached: boolean
}

/**
 * Render a specific PDF page to a PNG file.
 *
 * @param filePath - absolute path to the PDF file
 * @param pageNum - page number (1-based)
 * @param outputDir - directory to save the rendered PNG
 * @param scale - render scale factor (default 2.0)
 * @returns path to the PNG file, dimensions, and whether it was cached
 */
export async function renderPage(
  filePath: string,
  pageNum: number,
  outputDir: string,
  scale: number = 2.0,
): Promise<RenderedPage> {
  const pdfName = basename(filePath, extname(filePath))
  const fname = `${pdfName}_page_${pageNum}_scale${scale}.png`
  const fpath = join(outputDir, fname)

  // Cache hit: file already exists, skip rendering
  if (existsSync(fpath)) {
    // Read PNG dimensions from the file header (bytes 16-23)
    // Avoids re-opening the PDF just to get viewport size
    const pngBuffer = await readFile(fpath)
    const width = pngBuffer.readUInt32BE(16)
    const height = pngBuffer.readUInt32BE(20)
    return {
      path: fpath,
      width,
      height,
      cached: true,
    }
  }

  // Render the page
  await mkdir(outputDir, { recursive: true })

  const buffer = await readFile(filePath)
  const data = new Uint8Array(buffer)
  const doc = await pdfjs.getDocument({ data }).promise

  if (pageNum < 1 || pageNum > doc.numPages) {
    await doc.destroy()
    throw new Error(`Page ${pageNum} out of range (1-${doc.numPages})`)
  }

  const page = await doc.getPage(pageNum)
  const viewport = page.getViewport({ scale })
  const width = Math.floor(viewport.width)
  const height = Math.floor(viewport.height)

  // Create canvas via @napi-rs/canvas (native module, external in esbuild)
  const { createCanvas } = await import('@napi-rs/canvas')
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')

  // Render PDF page to canvas
  const renderTask = page.render({
    canvasContext: ctx,
    viewport,
  })
  await renderTask.promise

  // Save as PNG
  const pngBuffer = canvas.toBuffer('image/png')
  await writeFile(fpath, pngBuffer)

  await page.cleanup()
  await doc.destroy()

  return {
    path: fpath,
    width,
    height,
    cached: false,
  }
}
