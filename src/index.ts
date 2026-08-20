import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Config, type Config as ConfigShape } from './config.js'
import { parsePDF } from './parser.js'
import { renderPage } from './renderer.js'
import { analyzeImage } from './vision.js'
import type { ParsedPDF } from './parser.js'

export { Config } from './config.js'
export { parsePDF } from './parser.js'
export { renderPage } from './renderer.js'
export { analyzeImage } from './vision.js'
export type { ParsedPDF, ParsedTable, ParsedSection, ParsedImage } from './parser.js'
export type { Config as PdfToolConfig } from './config.js'

export const name = 'dsh-pdf-tool'
export const inject = ['tools']

export function apply(ctx: Context, config?: object): void {
  const resolved: ConfigShape = Config((config ?? {}) as never) as ConfigShape
  let fromSettings: (() => ConfigShape) | undefined
  const current = (): ConfigShape => fromSettings?.() ?? resolved

  // Register settings namespace for web profile UI (live update)
  ctx.inject(['settings'], (sctx: Context) => {
    const scope = sctx.settings.register('pdf-tool' as never, Config, {
      base: resolved,
      applies: 'live',
    })
    fromSettings = () => scope.get()
  })

  ctx.inject(['tools'], (tctx: Context) => {
    // Tool 1: parse_pdf — extract text, tables, sections, embedded images (no vision)
    tctx.tools.register({
      name: 'parse_pdf',
      description:
        'Parse a PDF file and extract text, tables, sections, and embedded images. ' +
        'Saves the full parsed result as a JSON file. ' +
        'Returns a summary with section titles, image count, and the output JSON file path. ' +
        'Use the read tool on the output JSON file to access full text content of specific sections. ' +
        'Note: vector graphics (charts, diagrams) are NOT extracted as images — use view_pdf_page to analyze those.',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Absolute path to the PDF file to parse' },
          output: { type: 'string', description: 'Directory for output JSON file and extracted images (default: ./output)' },
        },
        required: ['input'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
      },
      async execute(args: { input: string; output?: string }) {
        const inputPath = args.input
        if (!existsSync(inputPath)) {
          throw new Error(`PDF file not found: ${inputPath}`)
        }

        const outputDir = args.output || join(process.cwd(), 'output')
        await mkdir(outputDir, { recursive: true })

        const parsed: ParsedPDF = await parsePDF(inputPath, outputDir)

        // Save full JSON to file for downstream reading
        const pdfName = basename(inputPath, extname(inputPath))
        const jsonPath = join(outputDir, `${pdfName}_parsed.json`)
        await writeFile(jsonPath, JSON.stringify(parsed, null, 2), 'utf8')

        const sectionTitles = parsed.sections.map(s => s.title)
        const textPreview = parsed.text.length > 500
          ? parsed.text.substring(0, 500) + '...'
          : parsed.text

        const lines = [
          `PDF parsed successfully: ${parsed.file}`,
          `Pages: ${parsed.page_count}`,
          `Tables found: ${parsed.tables.length}`,
          `Images extracted: ${parsed.images.length}`,
          `Full output saved to: ${jsonPath}`,
          ``,
          `Sections (${sectionTitles.length}):`,
          ...sectionTitles.map(t => `  - ${t}`),
          ``,
          `Text preview:`,
          textPreview,
          ``,
          `To read the full content of any section, use the read tool on: ${jsonPath}`,
          `To analyze charts/diagrams on a specific page, use the view_pdf_page tool.`,
        ]

        return lines.join('\n')
      },
    })

    // Tool 2: view_pdf_page — render page to image, call multimodal model, return description
    tctx.tools.register({
      name: 'view_pdf_page',
      description:
        'Render a specific PDF page as an image and analyze it with a multimodal vision model. ' +
        'This captures ALL visual content on the page including vector graphics (bar charts, line charts, diagrams) ' +
        'that cannot be extracted as embedded images by parse_pdf. ' +
        'Call this tool multiple times to ask different questions about the same or different pages. ' +
        'The rendered image is cached — repeated calls for the same page skip rendering.',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Absolute path to the PDF file' },
          page: { type: 'number', description: 'Page number to render (1-based)' },
          question: { type: 'string', description: 'Question to ask the vision model about this page (default: describe the page content in detail)' },
          output: { type: 'string', description: 'Directory for rendered image (default: ./output)' },
        },
        required: ['input', 'page'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
      },
      async execute(args: { input: string; page: number; question?: string; output?: string }, exec: { signal: AbortSignal }) {
        const inputPath = args.input
        if (!existsSync(inputPath)) {
          throw new Error(`PDF file not found: ${inputPath}`)
        }

        const cfg = current()
        const outputDir = args.output || join(process.cwd(), 'output')
        await mkdir(outputDir, { recursive: true })

        // Render page to PNG (with cache)
        const rendered = await renderPage(inputPath, args.page, outputDir, cfg.renderScale)

        const question = args.question || cfg.visionPrompt

        // Check if vision model is configured
        if (!cfg.visionModel || !cfg.visionModel.trim()) {
          return [
            `Page ${args.page} rendered to: ${rendered.path}`,
            `Image size: ${rendered.width}x${rendered.height}`,
            `Cached: ${rendered.cached ? 'yes (reused existing)' : 'no (newly rendered)'}`,
            ``,
            `Vision model is not configured. To analyze this image, either:`,
            `1. Configure a vision model in plugin settings`,
            `2. Use the image-viewer tool to view it directly with a multimodal model`,
          ].join('\n')
        }

        // Resolve API key
        const apiKey = await resolveApiKey(tctx, cfg)
        if (!apiKey) {
          return [
            `Page ${args.page} rendered to: ${rendered.path}`,
            `Image size: ${rendered.width}x${rendered.height}`,
            `Cached: ${rendered.cached ? 'yes (reused existing)' : 'no (newly rendered)'}`,
            ``,
            `Vision API key not found. Set visionApiKey in plugin config or environment variable.`,
            `Image is available at: ${rendered.path}`,
          ].join('\n')
        }

        // Call multimodal model
        try {
          const description = await analyzeImage({
            apiKey,
            model: cfg.visionModel,
            baseUrl: cfg.visionBaseUrl,
            image: rendered.path,
            prompt: question,
            maxTokens: cfg.visionMaxTokens,
            signal: exec.signal,
          })

          return [
            `Page ${args.page} analyzed successfully.`,
            `Image: ${rendered.path} (${rendered.width}x${rendered.height}, ${rendered.cached ? 'cached' : 'newly rendered'})`,
            ``,
            `Vision model: ${cfg.visionModel}`,
            `Question: ${question}`,
            ``,
            `Analysis result:`,
            description,
          ].join('\n')
        } catch (err) {
          return [
            `Page ${args.page} rendered to: ${rendered.path}`,
            `Image size: ${rendered.width}x${rendered.height}`,
            `Cached: ${rendered.cached ? 'yes' : 'no'}`,
            ``,
            `Vision analysis failed: ${(err as Error).message}`,
            `Image is available at: ${rendered.path}`,
          ].join('\n')
        }
      },
    })
  })
}

/**
 * Resolve the vision API key: try ctx.credentials first, then env var.
 */
async function resolveApiKey(ctx: Context, cfg: ConfigShape): Promise<string> {
  if (cfg.visionApiKey) {
    try {
      const credentials = (ctx as any).credentials
      if (credentials) {
        const resolved = await credentials.resolve(cfg.visionApiKey)
        if (resolved?.value) return resolved.value
      }
    } catch {
      // credentials not injected or resolve failed — fall through
    }
  }
  if (cfg.visionApiKey) {
    const val = process.env[cfg.visionApiKey]
    if (val) return val
  }
  if (cfg.visionApiKey && !cfg.visionApiKey.endsWith('_API_KEY') && !cfg.visionApiKey.startsWith('PDF_TOOL_')) {
    return cfg.visionApiKey
  }
  return ''
}
