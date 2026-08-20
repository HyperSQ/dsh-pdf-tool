# dsh-pdf-tool

DeepSeek Harness 插件：两步式 PDF 解析——先提取文本/表格/章节/嵌入图片，再将页面渲染为图片通过多模态模型分析图表内容。

## 为什么需要两步？

PDF 中的图表（柱状图、折线图、饼图等）通常是**矢量图形**，不是嵌入的位图。`parse_pdf` 只能提取嵌入的光栅图（如照片、Logo），无法提取矢量图表。

`view_pdf_page` 将整个页面渲染为图片，捕获所有视觉内容（包括矢量图表），再通过多模态模型分析。

## 工具

### parse_pdf

提取 PDF 的文本、表格、章节、嵌入图片，保存为 JSON 文件。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| input | string | 是 | PDF 文件绝对路径 |
| output | string | 否 | 输出目录（默认 `./output`） |

**输出 JSON 结构**：

```json
{
  "file": "report.pdf",
  "page_count": 13,
  "text": "全文文本...",
  "tables": [{"page": 3, "rows": [["列1", "列2"], ...]}],
  "sections": [{"title": "1 本周市场指数表现", "text": "..."}],
  "images": [{"page": 1, "path": "/abs/path/img_p1_0.png", "width": 1261, "height": 172}]
}
```

### view_pdf_page

将指定页面渲染为图片，调用多模态模型分析。AI 可多次调用，针对不同页面或同一页面提出不同问题。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| input | string | 是 | PDF 文件绝对路径 |
| page | number | 是 | 页码（1-based） |
| question | string | 否 | 要问多模态模型的问题（默认用配置的 `visionPrompt`） |
| output | string | 否 | 输出目录（默认 `./output`） |

**缓存**：渲染图片保存为 `{pdfName}_page_{num}_scale{scale}.png`，文件已存在则跳过渲染。同一页面多次追问不重复渲染。

**未配置视觉模型时**：仍然渲染图片并返回路径，AI 可通过 dsh 自带的 image-viewer 工具直接查看。

## 安装

### 方式一：官方 CLI（推荐）

```bash
dsh plugin --profile <name> add dsh-pdf-tool
```

### 方式二：源码构建

```bash
git clone <repo-url>
cd dsh-pdf-tool
pnpm install
pnpm build
```

构建产物在 `lib/` 目录，包含：
- `index.js` — 打包后的插件（含 pdfjs-dist 和 schemastery）
- `pdf.worker.mjs` — pdfjs worker
- `types/` — TypeScript 类型声明

> `@napi-rs/canvas` 是原生模块（`.node` 二进制），不打包进 `lib/`，由 `pnpm install` 自动下载对应平台预编译二进制。

## 配置

### 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| visionModel | string | `""` | 多模态模型 ID（如 `kimi-k3`），空则禁用视觉分析 |
| visionBaseUrl | string | `""` | OpenAI 兼容 API base URL（不含 `/chat/completions`） |
| visionApiKey | string | `PDF_TOOL_VISION_API_KEY` | API Key（凭证引用名或直接值） |
| visionPrompt | string | `请详细描述...` | 发送给视觉模型的默认提示词 |
| visionMaxTokens | number | `1024` | 每次视觉完成的 max_tokens |
| renderScale | number | `2` | 页面渲染缩放倍数（2 = 2x 分辨率） |

### 方式一：cordis.patch.yml

```yaml
- insert:
    - id: dsh-pdf-tool
      name: dsh-pdf-tool
      config:
        visionModel: "kimi-k3"
        visionBaseUrl: "https://your-api-endpoint.com/v1"
        visionApiKey: "your-api-key"
        visionPrompt: "请详细描述这张图片的内容"
        visionMaxTokens: 1024
        renderScale: 2
```

### 方式二：环境变量

```bash
export PDF_TOOL_VISION_API_KEY="your-api-key"
```

`visionApiKey` 默认值为 `PDF_TOOL_VISION_API_KEY`，作为环境变量名查找。也可以在配置中直接填入 API Key 值。

### 方式三：Web UI

在 Web profile 中通过 settings 界面配置，支持运行时修改无需重启。

## 典型使用流程

```
AI: 调用 parse_pdf(input="report.pdf")
→ 返回: 13页, 18章节, 262图片, JSON路径

AI: 读取 JSON，发现第4页有两融分位点相关内容
AI: 调用 view_pdf_page(input="report.pdf", page=4, question="图2和图3分别展示了什么？")
→ 返回: "图2是两融分位点下穿后收益率柱状图..."

AI: 想看更多细节
AI: 调用 view_pdf_page(input="report.pdf", page=4, question="图2中95%下穿样本的具体收益率是多少？")
→ 返回: "95%下穿去重样本20日平均累计收益率为-1.09%..."

AI: 转向第6页
AI: 调用 view_pdf_page(input="report.pdf", page=6, question="哪个因子超额收益最高？")
→ 返回: "Momentum最高+0.82%..."

AI: 综合所有信息，输出最终总结
```

## 运行时要求

- Node.js 22+
- `@napi-rs/canvas` 原生二进制（pnpm install 自动下载，支持 Windows/Linux/macOS）
- 无 Python 依赖

## 项目结构

```
dsh-pdf-tool/
├── package.json              # 插件声明
├── pnpm-workspace.yaml       # pnpm workspace 配置
├── build.mjs                 # esbuild 构建脚本
├── tsconfig.json             # TypeScript 配置
├── tsconfig.build.json       # 构建用配置（生成 .d.ts）
├── cordis.patch.yml          # 插件注册 patch
├── LICENSE
├── src/
│   ├── index.ts              # 插件入口，注册 parse_pdf + view_pdf_page
│   ├── parser.ts             # PDF 文本/表格/章节/图片提取（pdfjs-dist）
│   ├── renderer.ts           # 页面渲染为 PNG（@napi-rs/canvas + pdfjs）
│   ├── vision.ts             # OpenAI 兼容多模态 API 调用
│   ├── config.ts             # schemastery 配置 schema
│   └── cordis-augment.d.ts   # Context 类型声明合并
└── lib/                      # 构建产物（pnpm build 生成）
    ├── index.js              # 打包后的插件
    ├── index.js.map          # sourcemap
    ├── pdf.worker.mjs        # pdfjs worker
    └── types/                # TypeScript 类型声明
```

## 故障诊断

### `Cannot find module '@napi-rs/canvas'`

`@napi-rs/canvas` 是原生模块，必须通过 `pnpm install` 安装。如果通过 `dsh plugin add` 安装，CLI 会自动处理。源码安装时确保在插件目录运行 `pnpm install`。

### `Canvas error: ... .node file not found`

平台二进制缺失。检查 `node_modules/@napi-rs/canvas-win32-x64-msvc/`（Windows）或对应平台包是否存在。删除 `node_modules` 后重新 `pnpm install`。

### `Vision API 400: temperature`

部分 API 代理要求 `temperature=1`。插件已硬编码 `temperature: 1`，如果仍有问题请检查 API 端点是否兼容 OpenAI 格式。

### `Vision API error {code}: {message}`

API 代理返回了非标准错误格式。检查 `visionBaseUrl` 是否正确（不应包含 `/chat/completions` 后缀），`visionApiKey` 是否有效。

### `Page X out of range`

页码超出 PDF 总页数。先用 `parse_pdf` 获取 `page_count`，页码范围是 1 到 `page_count`。

### `pdfjs worker not loading` / 进程挂起

`lib/pdf.worker.mjs` 文件缺失。重新运行 `pnpm build`，构建脚本会自动复制 worker 文件。

### `API 500 Internal Server Error`（harness headless）

检查工具参数格式是否为标准 JSON Schema（`type: 'object'`, `properties`, `required` 数组）。非标准格式会导致 API 拒绝整个请求。

### 提取的图片不包含图表

这是预期行为。PDF 中的柱状图、折线图是矢量图形，不是嵌入图片。使用 `view_pdf_page` 渲染页面来分析这些图表。

## 开发

```bash
pnpm install          # 安装依赖
pnpm build            # 构建（esbuild 打包 + 复制 worker + tsc 类型声明）
pnpm typecheck        # 类型检查（不生成文件）
```

## License

MIT
