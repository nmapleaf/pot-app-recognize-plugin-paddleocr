const JOB_URL = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";
const DEFAULT_MODEL = "PaddleOCR-VL-1.5";
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_TIMEOUT_SECONDS = 120;

async function recognize(base64, lang, options) {
    const { config = {}, utils = {} } = options || {};
    const fetch = getFetch(utils);
    const accessToken = firstNonEmpty(config.accessToken, config.token, config.apikey);

    if (!accessToken) {
        throw "accessToken not found";
    }

    const model = firstNonEmpty(config.model, DEFAULT_MODEL);
    const optionalPayload = buildOptionalPayload(config);
    const imageBytes = base64ToBytes(base64);
    const multipart = buildMultipartRequest(
        {
            model,
            optionalPayload: JSON.stringify(optionalPayload),
        },
        {
            fieldName: "file",
            fileName: "pot-screenshot.png",
            mime: "image/png",
            bytes: imageBytes,
        }
    );

    const submitData = await fetchOk(fetch, JOB_URL, {
        method: "POST",
        headers: {
            Authorization: `bearer ${accessToken}`,
            "Content-Type": multipart.contentType,
        },
        body: {
            type: "Bytes",
            payload: multipart.bodyBytes,
        },
    }, "submit PaddleOCR job");

    const jobId = pick(submitData, ["data", "jobId"]) || submitData.jobId;
    if (!jobId) {
        throw `PaddleOCR jobId not found: ${safeStringify(submitData)}`;
    }

    const pollIntervalSeconds = parseNumber(config.pollIntervalSeconds, DEFAULT_POLL_INTERVAL_SECONDS, 0, 60);
    const timeoutSeconds = parseNumber(config.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS, 1, 600);
    const resultUrl = await pollJob(fetch, accessToken, jobId, pollIntervalSeconds, timeoutSeconds);
    const jsonl = await downloadText(fetch, resultUrl);
    const returnFormat = firstNonEmpty(config.returnFormat, "plain").toLowerCase();
    const text = returnFormat === "markdown" ? extractMarkdownFromJsonl(jsonl) : extractPlainTextFromJsonl(jsonl);

    if (!text) {
        throw "PaddleOCR result is empty";
    }

    return text;
}

function getFetch(utils) {
    if (utils && typeof utils.tauriFetch === "function") {
        return utils.tauriFetch;
    }
    if (utils && utils.http && typeof utils.http.fetch === "function") {
        return utils.http.fetch;
    }
    throw "tauriFetch not found";
}

function buildOptionalPayload(config) {
    return {
        useDocOrientationClassify: parseBoolean(config.useDocOrientationClassify, false),
        useDocUnwarping: parseBoolean(config.useDocUnwarping, false),
        useChartRecognition: parseBoolean(config.useChartRecognition, false),
    };
}

function parseBoolean(value, defaultValue) {
    if (value === undefined || value === null || value === "") {
        return defaultValue;
    }
    if (typeof value === "boolean") {
        return value;
    }
    const normalized = String(value).trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
        return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
        return false;
    }
    return defaultValue;
}

function parseNumber(value, defaultValue, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return defaultValue;
    }
    return Math.max(min, Math.min(max, parsed));
}

function firstNonEmpty(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null && String(value).trim() !== "") {
            return String(value).trim();
        }
    }
    return "";
}

function base64ToBytes(base64) {
    const clean = String(base64 || "")
        .replace(/^data:[^,]+,/, "")
        .replace(/\s+/g, "");

    if (!clean) {
        throw "image base64 is empty";
    }

    if (typeof atob === "function") {
        const binary = atob(clean);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    if (typeof Buffer !== "undefined") {
        return new Uint8Array(Buffer.from(clean, "base64"));
    }

    throw "base64 decoder not found";
}

function buildMultipartRequest(fields, file, boundary) {
    const multipartBoundary = boundary || `----pot-paddleocr-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const chunks = [];

    for (const key of Object.keys(fields)) {
        appendText(chunks, `--${multipartBoundary}\r\n`);
        appendText(chunks, `Content-Disposition: form-data; name="${escapeMultipartName(key)}"\r\n\r\n`);
        appendText(chunks, `${fields[key]}\r\n`);
    }

    appendText(chunks, `--${multipartBoundary}\r\n`);
    appendText(
        chunks,
        `Content-Disposition: form-data; name="${escapeMultipartName(file.fieldName)}"; filename="${escapeMultipartName(file.fileName)}"\r\n`
    );
    appendText(chunks, `Content-Type: ${file.mime || "application/octet-stream"}\r\n\r\n`);
    appendBytes(chunks, file.bytes);
    appendText(chunks, "\r\n");
    appendText(chunks, `--${multipartBoundary}--\r\n`);

    return {
        contentType: `multipart/form-data; boundary=${multipartBoundary}`,
        bodyBytes: flattenBytes(chunks),
    };
}

function appendText(chunks, value) {
    chunks.push(encodeUtf8(value));
}

function appendBytes(chunks, value) {
    chunks.push(value instanceof Uint8Array ? value : new Uint8Array(value));
}

function encodeUtf8(value) {
    if (typeof TextEncoder !== "undefined") {
        return new TextEncoder().encode(value);
    }
    if (typeof Buffer !== "undefined") {
        return new Uint8Array(Buffer.from(value, "utf8"));
    }
    const encoded = unescape(encodeURIComponent(value));
    const bytes = new Uint8Array(encoded.length);
    for (let i = 0; i < encoded.length; i += 1) {
        bytes[i] = encoded.charCodeAt(i);
    }
    return bytes;
}

function flattenBytes(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
    }
    return Array.from(merged);
}

function escapeMultipartName(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r|\n/g, "_");
}

async function pollJob(fetch, accessToken, jobId, pollIntervalSeconds, timeoutSeconds) {
    const start = Date.now();
    const timeoutMs = timeoutSeconds * 1000;
    const pollIntervalMs = pollIntervalSeconds * 1000;

    while (Date.now() - start <= timeoutMs) {
        const data = await fetchOk(fetch, `${JOB_URL}/${encodeURIComponent(jobId)}`, {
            method: "GET",
            headers: {
                Authorization: `bearer ${accessToken}`,
            },
        }, "poll PaddleOCR job");

        const job = data.data || data;
        const state = job.state;

        if (state === "done") {
            const jsonUrl = pick(job, ["resultUrl", "jsonUrl"]);
            if (!jsonUrl) {
                throw `PaddleOCR jsonUrl not found: ${safeStringify(job)}`;
            }
            return jsonUrl;
        }

        if (state === "failed") {
            throw `PaddleOCR job failed: ${job.errorMsg || safeStringify(job)}`;
        }

        if (state !== "pending" && state !== "running") {
            throw `Unexpected PaddleOCR job state: ${safeStringify(job)}`;
        }

        await sleep(pollIntervalMs);
    }

    throw `PaddleOCR job timeout after ${timeoutSeconds}s`;
}

async function downloadText(fetch, url) {
    const data = await fetchOk(fetch, url, { method: "GET", responseType: 2 }, "download PaddleOCR JSONL");
    if (typeof data === "string") {
        return data;
    }
    return safeStringify(data);
}

async function fetchOk(fetch, url, request, label) {
    const response = await fetch(url, request);
    if (!response || response.ok !== true) {
        const status = response && response.status !== undefined ? response.status : "unknown";
        const data = response && response.data !== undefined ? response.data : response;
        throw `Http Request Error while ${label}\nHttp Status: ${status}\n${safeStringify(data)}`;
    }
    return unwrapResponseData(response.data);
}

function unwrapResponseData(data) {
    if (
        data &&
        typeof data === "object" &&
        Object.prototype.hasOwnProperty.call(data, "result") &&
        !Object.prototype.hasOwnProperty.call(data, "data")
    ) {
        return data.result;
    }
    return data;
}

function extractPlainTextFromJsonl(jsonl) {
    const blocks = [];
    const lines = String(jsonl || "").split(/\r?\n/);

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }

        let parsed;
        try {
            parsed = JSON.parse(line);
        } catch (_error) {
            continue;
        }

        collectTextBlocks(parsed.result || parsed, blocks);
    }

    return normalizeFinalText(blocks.map(markdownToPlainText).filter(Boolean).join("\n"));
}

function extractMarkdownFromJsonl(jsonl) {
    const blocks = [];
    const lines = String(jsonl || "").split(/\r?\n/);

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }

        let parsed;
        try {
            parsed = JSON.parse(line);
        } catch (_error) {
            continue;
        }

        collectTextBlocks(parsed.result || parsed, blocks);
    }

    return blocks
        .map((block) => String(block || "").trim())
        .filter(Boolean)
        .join("\n\n")
        .trim();
}

function collectTextBlocks(result, blocks) {
    const layoutResults = result && result.layoutParsingResults;
    if (Array.isArray(layoutResults)) {
        for (const item of layoutResults) {
            const markdownText = pick(item, ["markdown", "text"]);
            if (markdownText) {
                blocks.push(markdownText);
                continue;
            }
            if (item.text) {
                blocks.push(item.text);
            } else if (item.plainText) {
                blocks.push(item.plainText);
            }
        }
        return;
    }

    if (typeof result === "string") {
        blocks.push(result);
    } else if (result && typeof result.text === "string") {
        blocks.push(result.text);
    }
}

function markdownToPlainText(markdown) {
    const withoutImages = String(markdown || "")
        .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
        .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
        .replace(/<\/?[^>]+>/g, " ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/__([^_]+)__/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/_([^_]+)_/g, "$1");

    const lines = [];
    for (const rawLine of withoutImages.split(/\r?\n/)) {
        let line = rawLine.trim();
        if (!line) {
            continue;
        }
        if (isMarkdownTableSeparator(line)) {
            continue;
        }

        line = line
            .replace(/^#{1,6}\s+/, "")
            .replace(/^>\s*/, "")
            .replace(/^[-*+]\s+/, "")
            .replace(/^\d+[.)]\s+/, "");

        if (line.includes("|")) {
            const cells = line
                .replace(/^\|/, "")
                .replace(/\|$/, "")
                .split("|")
                .map((cell) => cell.trim())
                .filter(Boolean);
            line = cells.join(" ");
        }

        line = line.replace(/\s+/g, " ").trim();
        if (line) {
            lines.push(line);
        }
    }

    return normalizeFinalText(lines.join("\n"));
}

function isMarkdownTableSeparator(line) {
    const trimmed = line.replace(/^\|/, "").replace(/\|$/, "").trim();
    if (!trimmed.includes("|")) {
        return /^:?-{3,}:?$/.test(trimmed);
    }
    return trimmed
        .split("|")
        .map((cell) => cell.trim())
        .every((cell) => /^:?-{3,}:?$/.test(cell));
}

function normalizeFinalText(text) {
    return String(text || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n")
        .trim();
}

function pick(value, path) {
    let current = value;
    for (const key of path) {
        if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, key)) {
            return undefined;
        }
        current = current[key];
    }
    return current;
}

function sleep(ms) {
    if (ms <= 0) {
        return Promise.resolve();
    }
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeStringify(value) {
    if (typeof value === "string") {
        return value;
    }
    try {
        return JSON.stringify(value);
    } catch (_error) {
        return String(value);
    }
}

if (typeof module !== "undefined") {
    module.exports = {
        recognize,
        base64ToBytes,
        buildMultipartRequest,
        extractPlainTextFromJsonl,
        extractMarkdownFromJsonl,
        markdownToPlainText,
        buildOptionalPayload,
    };
}
