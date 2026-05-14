# Pot-App PaddleOCR 文字识别插件

这是一个用于 [Pot](https://pot-app.com/) 的文字识别插件。插件会把 Pot 截图 OCR 传入的图片提交到 PaddleOCR hosted API，等待异步任务完成后下载结果，并返回纯文本给 Pot，适合作为「截图翻译」的 OCR 输入。

## 配置项

安装插件后，在 Pot 的服务设置中配置：

- `Access Token`：PaddleOCR API token，必填。
- `Model`：模型名称，留空时使用 `PaddleOCR-VL-1.5`。
- `返回格式`：
  - `纯文本（推荐）`：清理 Markdown 标记后返回，适合 Pot 截图翻译输入。
  - `Markdown（保留表格/版面）`：保留 PaddleOCR 返回的 Markdown 文本，适合复制表格、标题和列表结构。
- `轮询间隔`：查询任务状态的间隔，默认推荐 `5 秒`。
- `任务超时`：最长等待时间，默认推荐 `120 秒`。
- `方向分类`、`文档矫正`、`图表识别`：对应 PaddleOCR API 的 `optionalPayload`，默认关闭以降低普通截图 OCR 的耗时。

## 工作流程

1. Pot 调用 `recognize(base64, lang, options)`。
2. 插件把 base64 PNG 手动组装成 `multipart/form-data`。
3. `POST https://paddleocr.aistudio-app.com/api/v2/ocr/jobs` 提交任务。
4. 轮询 `GET /jobs/{jobId}`。
5. 任务完成后下载 `resultUrl.jsonUrl`。
6. 解析 JSONL 中的 `layoutParsingResults[*].markdown.text`。
7. 根据 `返回格式` 配置返回纯文本或 Markdown。

## 打包 Pot 插件

将以下文件压缩为 zip：

- `main.js`
- `info.json`
- `icon.png`

然后把 zip 文件重命名为：

```text
plugin.com.pot-app.paddleocr.potext
```

即可在 Pot 的「添加外部插件」中安装。

## 本地验证

```bash
node --check main.js
node --test test/main.test.js
node -e "JSON.parse(require('fs').readFileSync('info.json','utf8')); console.log('info.json ok')"
```

## 参考

- `paddleocr_api.txt`：PaddleOCR API 示例流程。
- Pot 文字识别插件模板：`recognize(base64, lang, options)`。
