/**
 * Plugin Config schema: multimodal vision model settings for image analysis.
 *
 * When visionModel is empty (default), view_pdf_page still renders the page
 * image but skips the multimodal analysis step.
 *
 * Config can be set via:
 * 1. cordis.patch.yml override (entry config)
 * 2. Web profile settings UI (via ctx.settings.register, live update)
 * @module dsh-pdf-tool/config
 */

import z from "@deepseek-ai/schemastery";

/** Plugin configuration shape. */
export interface Config {
  /** Multimodal model id (e.g. "kimi-k3"). Empty = disabled. */
  visionModel: string;
  /** OpenAI-compatible base URL for the vision model (without /chat/completions). */
  visionBaseUrl: string;
  /** API key for the vision model endpoint. */
  visionApiKey: string;
  /** Prompt sent with each image to the vision model. */
  visionPrompt: string;
  /** max_tokens for each vision completion. */
  visionMaxTokens: number;
  /** Render scale for page rendering (2.0 = 2x resolution). */
  renderScale: number;
}

/** Default prompt for image description. */
export const DEFAULT_VISION_PROMPT =
  "请详细描述这张图片的内容，包括图表类型、数据趋势、关键数值和文字信息。";

/** Schemastery runtime schema — bundled by esbuild, validated by the Loader. */
export const Config = z.object({
  visionModel: z.string().default(""),
  visionBaseUrl: z.string().default(""),
  visionApiKey: z.string().role("credential-ref").default("PDF_TOOL_VISION_API_KEY"),
  visionPrompt: z.string().default(DEFAULT_VISION_PROMPT),
  visionMaxTokens: z.number().min(1).max(32768).step(1).default(1024),
  renderScale: z.number().min(0.5).max(4).step(0.5).default(2),
});
