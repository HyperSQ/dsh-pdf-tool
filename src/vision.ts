/**
 * OpenAI-compatible vision request: POST `{baseUrl}/chat/completions` with
 * an `image_url` part (base64 data URL) and a text prompt.
 *
 * Adapted from dsh-image-pathify's vision.ts. Makes a direct HTTP call
 * to any OpenAI-compatible multimodal endpoint.
 * @module dsh-pdf-tool/vision
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";

/** Filename extension → image MIME subtype. */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  jpg: "jpeg",
  jpeg: "jpeg",
  png: "png",
  gif: "gif",
  webp: "webp",
  bmp: "bmp",
};

/** One vision completion request. */
export interface VisionRequest {
  apiKey: string;
  model: string;
  baseUrl: string;
  /** Absolute local path to the image file. */
  image: string;
  prompt: string;
  maxTokens: number;
  signal?: AbortSignal;
}

/** Convert a local image file to a base64 data URL. */
async function imageToDataUrl(path: string, signal?: AbortSignal): Promise<string> {
  const data = await readFile(path, { signal });
  const ext = extname(path).toLowerCase().replace(".", "");
  const subtype = MIME_BY_EXT[ext] ?? "jpeg";
  return `data:image/${subtype};base64,${Buffer.from(data).toString("base64")}`;
}

/** Build the full chat/completions URL from a base URL. */
function completionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) {
    throw new Error("Vision API base URL is empty. Configure it in plugin settings.");
  }
  return `${trimmed.replace(/\/?$/, "/")}chat/completions`;
}

/** Extract text content from an OpenAI-compatible response. */
function extractContent(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Vision API returned a non-object body");
  }
  // Handle proxy error format: { code: 400, message: "..." }
  const proxyCode = (payload as { code?: number }).code;
  if (proxyCode && proxyCode !== 200) {
    const msg = (payload as { message?: string }).message;
    throw new Error(`Vision API error ${proxyCode}: ${msg || "unknown"}`);
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices[0] === undefined) {
    throw new Error("Vision API returned no choices");
  }
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  const content = message?.content;
  if (typeof content === "string" && content.length > 0) return content;
  throw new Error("Vision API returned an empty message");
}

/**
 * Call the configured vision model and return its text description.
 * @throws if apiKey or model is empty
 */
export async function analyzeImage(request: VisionRequest): Promise<string> {
  const apiKey = request.apiKey.trim();
  const model = request.model.trim();
  if (apiKey.length === 0 || model.length === 0) {
    throw new Error("Vision API is not configured. Set visionModel and visionApiKey in plugin settings.");
  }

  const dataUrl = await imageToDataUrl(request.image, request.signal);
  request.signal?.throwIfAborted();

  const body = JSON.stringify({
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUrl } },
          { type: "text", text: request.prompt },
        ],
      },
    ],
    stream: false,
    max_tokens: request.maxTokens,
    temperature: 1,
  });

  const response = await fetch(completionsUrl(request.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body,
    signal: request.signal,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Vision API ${response.status}: ${text.slice(0, 300)}`);
  }

  try {
    return extractContent(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) return text;
    throw error;
  }
}
