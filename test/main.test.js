const test = require("node:test");
const assert = require("node:assert/strict");

const plugin = require("../main.js");

test("base64ToBytes decodes screenshot bytes", () => {
    assert.deepEqual(Array.from(plugin.base64ToBytes("SGVsbG8=")), [72, 101, 108, 108, 111]);
});

test("buildMultipartRequest includes fields and PNG bytes", () => {
    const request = plugin.buildMultipartRequest(
        {
            model: "PaddleOCR-VL-1.5",
            optionalPayload: JSON.stringify({ useDocOrientationClassify: false }),
        },
        {
            fieldName: "file",
            fileName: "pot-screenshot.png",
            mime: "image/png",
            bytes: plugin.base64ToBytes("iVBORw0KGgo="),
        },
        "test-boundary"
    );

    const asText = Buffer.from(request.bodyBytes).toString("latin1");
    assert.equal(request.contentType, "multipart/form-data; boundary=test-boundary");
    assert.match(asText, /name="model"/);
    assert.match(asText, /PaddleOCR-VL-1\.5/);
    assert.match(asText, /name="file"; filename="pot-screenshot\.png"/);
    assert.match(asText, /Content-Type: image\/png/);
    assert.ok(request.bodyBytes.length > "iVBORw0KGgo=".length);
});

test("markdownToPlainText normalizes OCR markdown for translation input", () => {
    const markdown = [
        "# Title",
        "",
        "| A | B |",
        "|---|---|",
        "| hello | world |",
        "- bullet **bold**",
        "![figure](images/0.jpg)",
        "[link text](https://example.com)",
        "`code`",
    ].join("\n");

    assert.equal(
        plugin.markdownToPlainText(markdown),
        ["Title", "A B", "hello world", "bullet bold", "link text", "code"].join("\n")
    );
});

test("extractPlainTextFromJsonl extracts markdown text from multiple pages", () => {
    const jsonl = [
        JSON.stringify({
            result: {
                layoutParsingResults: [
                    { markdown: { text: "# Page 1\nHello **Pot**" } },
                    { markdown: { text: "Second block" } },
                ],
            },
        }),
        "",
        "{not json",
        JSON.stringify({
            result: {
                layoutParsingResults: [{ markdown: { text: "| A | B |\n|---|---|\n| 1 | 2 |" } }],
            },
        }),
    ].join("\n");

    assert.equal(plugin.extractPlainTextFromJsonl(jsonl), "Page 1\nHello Pot\nSecond block\nA B\n1 2");
});

test("extractMarkdownFromJsonl preserves OCR markdown structure", () => {
    const jsonl = [
        JSON.stringify({
            result: {
                layoutParsingResults: [
                    { markdown: { text: "# Page 1\n\n| A | B |\n|---|---|\n| hello | world |" } },
                    { markdown: { text: "- item **bold**" } },
                ],
            },
        }),
        JSON.stringify({
            result: {
                layoutParsingResults: [{ markdown: { text: "## Page 2\nMore text" } }],
            },
        }),
    ].join("\n");

    assert.equal(
        plugin.extractMarkdownFromJsonl(jsonl),
        [
            "# Page 1\n\n| A | B |\n|---|---|\n| hello | world |",
            "- item **bold**",
            "## Page 2\nMore text",
        ].join("\n\n")
    );
});

test("recognize submits a job, polls result, downloads JSONL, and returns plain text", async () => {
    const calls = [];
    const fetch = async (url, request) => {
        calls.push({ url, request });
        if (url.endsWith("/jobs") && request.method === "POST") {
            return { ok: true, data: { data: { jobId: "job-123" } } };
        }
        if (url.endsWith("/jobs/job-123")) {
            return {
                ok: true,
                data: {
                    data: {
                        state: "done",
                        extractProgress: { extractedPages: 1 },
                        resultUrl: { jsonUrl: "https://result.example/out.jsonl" },
                    },
                },
            };
        }
        if (url === "https://result.example/out.jsonl") {
            return {
                ok: true,
                data: JSON.stringify({
                    result: {
                        layoutParsingResults: [{ markdown: { text: "# OCR\nhello **world**" } }],
                    },
                }),
            };
        }
        throw new Error(`unexpected url ${url}`);
    };

    const text = await plugin.recognize("iVBORw0KGgo=", "auto", {
        config: {
            accessToken: "token",
            model: "PaddleOCR-VL-1.5",
            pollIntervalSeconds: "0",
            timeoutSeconds: "10",
        },
        utils: { tauriFetch: fetch },
    });

    assert.equal(text, "OCR\nhello world");
    assert.equal(calls.length, 3);
    assert.equal(calls[0].request.method, "POST");
    assert.equal(calls[0].request.headers.Authorization, "bearer token");
    assert.match(calls[0].request.headers["Content-Type"], /^multipart\/form-data; boundary=/);
    assert.equal(calls[0].request.body.type, "Bytes");
    assert.ok(Array.isArray(calls[0].request.body.payload));
    assert.equal(calls[2].request.responseType, 2);
});

test("recognize returns markdown when returnFormat is markdown", async () => {
    const fetch = async (url, request) => {
        if (url.endsWith("/jobs") && request.method === "POST") {
            return { ok: true, data: { data: { jobId: "job-123" } } };
        }
        if (url.endsWith("/jobs/job-123")) {
            return {
                ok: true,
                data: {
                    data: {
                        state: "done",
                        resultUrl: { jsonUrl: "https://result.example/out.jsonl" },
                    },
                },
            };
        }
        if (url === "https://result.example/out.jsonl") {
            return {
                ok: true,
                data: JSON.stringify({
                    result: {
                        layoutParsingResults: [
                            { markdown: { text: "# OCR\n\n| A | B |\n|---|---|\n| hello | **world** |" } },
                        ],
                    },
                }),
            };
        }
        throw new Error(`unexpected url ${url}`);
    };

    const text = await plugin.recognize("iVBORw0KGgo=", "auto", {
        config: {
            accessToken: "token",
            returnFormat: "markdown",
            pollIntervalSeconds: "0",
            timeoutSeconds: "10",
        },
        utils: { tauriFetch: fetch },
    });

    assert.equal(text, "# OCR\n\n| A | B |\n|---|---|\n| hello | **world** |");
});
