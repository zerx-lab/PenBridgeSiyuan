/**
 * 腾讯云 COS 图片上传
 * 将 markdown 中的本地 assets 图片和 base64 内联图片上传到腾讯云 COS，返回替换后的 markdown
 */
import { forwardProxy, getFileBlob } from "../api";
import type { TencentClient } from "./client";
import { logger } from "../logger";

// ---- Web Crypto 工具（替代 Node.js crypto，全异步） ----

function bufToHex(buf: ArrayBuffer): string {
    return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

async function hmacSha1Hex(key: string, msg: string): Promise<string> {
    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
        "raw",
        enc.encode(key),
        { name: "HMAC", hash: "SHA-1" },
        false,
        ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(msg));
    return bufToHex(sig);
}

async function sha1Hex(msg: string): Promise<string> {
    const enc = new TextEncoder();
    const hash = await crypto.subtle.digest("SHA-1", enc.encode(msg));
    return bufToHex(hash);
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function getContentType(ext: string): string {
    const e = ext.toLowerCase().replace(/^\./, "");
    const map: Record<string, string> = {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        gif: "image/gif",
        webp: "image/webp",
        bmp: "image/bmp",
        svg: "image/svg+xml",
    };
    return map[e] || "application/octet-stream";
}

// ---- 并发控制 ----

async function runWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let idx = 0;
    let failed = false;

    async function worker(): Promise<void> {
        while (idx < items.length) {
            if (failed) return;
            const i = idx++;
            try {
                results[i] = await fn(items[i]);
            } catch (e) {
                failed = true;
                throw e;
            }
        }
    }

    const workers = Array.from(
        { length: Math.min(concurrency, items.length) },
        () => worker()
    );
    await Promise.all(workers);
    return results;
}

// ---- 单张图片上传到 COS ----

async function cosUpload(
    client: TencentClient,
    ext: string,
    base64Data: string,
    byteLength: number
): Promise<string> {
    // 1. 获取上传信息和临时密钥
    const uploadInfo = await client.getUploadInfo(ext);
    const tmpSecret = await client.getTmpSecret(uploadInfo.objectKey);

    const { TmpSecretId, TmpSecretKey, Token } = tmpSecret.credentials;
    const signTime = `${tmpSecret.startTime};${tmpSecret.expiredTime}`;
    const host = `${uploadInfo.bucket}.cos.${uploadInfo.region}.myqcloud.com`;
    const cosUrl = `https://${host}${uploadInfo.objectKey}`;
    const contentType = getContentType(ext);

    // 2. 生成 PUT 签名（signed headers: content-length;host）
    const putSignKey = await hmacSha1Hex(TmpSecretKey, signTime);
    const putHttpString = `put\n${uploadInfo.objectKey}\n\ncontent-length=${byteLength}&host=${host}\n`;
    const putSha1 = await sha1Hex(putHttpString);
    const putStringToSign = `sha1\n${signTime}\n${putSha1}\n`;
    const putSig = await hmacSha1Hex(putSignKey, putStringToSign);

    const authorization =
        `q-sign-algorithm=sha1&q-ak=${TmpSecretId}` +
        `&q-sign-time=${signTime}&q-key-time=${signTime}` +
        `&q-header-list=content-length;host&q-url-param-list=` +
        `&q-signature=${putSig}`;

    // 3. 通过思源内核 forwardProxy 执行 PUT（payloadEncoding=base64 让内核解码为二进制 body）
    const res = await forwardProxy(
        cosUrl,
        "PUT",
        base64Data,
        [
            { "Authorization": authorization },
            { "x-cos-security-token": Token },
            { "Content-Type": contentType },
            { "Content-Length": String(byteLength) },
            { "Host": host },
        ],
        30000,
        contentType,
        "base64"
    );

    if (!res) throw new Error("COS upload failed: kernel proxy returned no response");
    if (res.status !== 200) {
        throw new Error(`COS 上传失败: HTTP ${res.status}`);
    }

    // 4. 生成访问 URL
    if (!uploadInfo.isPrivateBucket) {
        // 公有读桶：永久有效 URL，无需签名
        return `https://${host}${uploadInfo.objectKey}`;
    }

    // 私有桶：生成带签名的 GET 访问 URL
    const getSignKey = await hmacSha1Hex(TmpSecretKey, signTime);
    const getHttpString = `get\n${uploadInfo.objectKey}\n\nhost=${host}\n`;
    const getSha1 = await sha1Hex(getHttpString);
    const getStringToSign = `sha1\n${signTime}\n${getSha1}\n`;
    const getSig = await hmacSha1Hex(getSignKey, getStringToSign);

    const accessUrl =
        `${cosUrl}?q-sign-algorithm=sha1&q-ak=${TmpSecretId}` +
        `&q-sign-time=${signTime}&q-key-time=${signTime}` +
        `&q-header-list=host&q-url-param-list=` +
        `&q-signature=${getSig}` +
        `&x-cos-security-token=${encodeURIComponent(Token)}`;

    return accessUrl;
}

// ---- 图片任务描述 ----

interface ImageTask {
    original: string;   // 完整 markdown 匹配串（首次出现）
    alt: string;
    ext: string;
    assetPath?: string; // 思源 assets 相对路径，如 assets/xxx.png
    base64Data?: string; // base64 数据（不含 data:image/...;base64, 前缀）
    /** 所有引用此图片源的 (original, alt) 对，包含首次 */
    occurrences: { original: string; alt: string }[];
}

// 思源本地 assets 图片
const ASSETS_PATTERN = /!\[([^\]]*)\]\((assets\/[^"\s)]+)(?:\s+["'][^"']*["'])?\)/g;
// base64 内联图片
const BASE64_PATTERN = /!\[([^\]]*)\]\((data:image\/([a-zA-Z]+);base64,([^)]+))\)/g;

/**
 * 扫描 markdown 中的本地图片并上传到腾讯云 COS，返回替换后的 markdown。
 * - 已在 myqcloud.com / developer.tce.qq.com 的图片不会被两个 pattern 匹配，天然跳过。
 * - 其他外链 http 图片保持原样不处理。
 * @param client  TencentClient 实例（需已配置 Cookie）
 * @param markdown 原始 markdown 内容
 * @param onProgress 进度回调 (done, total)
 */
export async function uploadDocImages(
    client: TencentClient,
    markdown: string,
    onProgress?: (done: number, total: number) => void
): Promise<string> {
    const tasks: ImageTask[] = [];
    const seenSources = new Map<string, ImageTask>();

    // 收集 assets 本地图片（按 assetPath 去重，同路径不同 alt 只上传一次）
    ASSETS_PATTERN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ASSETS_PATTERN.exec(markdown)) !== null) {
        const original = m[0];
        const alt = m[1];
        const assetPath = m[2]; // e.g. "assets/xxx-abcdef.png"
        const ext = assetPath.split(".").pop() || "png";
        const existing = seenSources.get(assetPath);
        if (existing) {
            existing.occurrences.push({ original, alt });
        } else {
            const task: ImageTask = { original, alt, ext, assetPath, occurrences: [{ original, alt }] };
            seenSources.set(assetPath, task);
            tasks.push(task);
        }
    }

    // 收集 base64 内联图片（按 base64 数据内容去重）
    BASE64_PATTERN.lastIndex = 0;
    while ((m = BASE64_PATTERN.exec(markdown)) !== null) {
        const original = m[0];
        const alt = m[1];
        const ext = m[3]; // MIME 子类型，如 "png"、"jpeg"
        const base64Data = m[4];
        const existing = seenSources.get(base64Data);
        if (existing) {
            existing.occurrences.push({ original, alt });
        } else {
            const task: ImageTask = { original, alt, ext, base64Data, occurrences: [{ original, alt }] };
            seenSources.set(base64Data, task);
            tasks.push(task);
        }
    }

    if (tasks.length === 0) return markdown;

    const total = tasks.length;
    let done = 0;
    onProgress?.(0, total);
    logger.info(`开始上传图片，共 ${total} 张`);

    async function processTask(task: ImageTask): Promise<string> {
        const imageId = task.assetPath ?? "inline base64";
        let base64Data: string;
        let byteLength: number;

        try {
            if (task.assetPath) {
                // 从思源内核读取图片文件
                const blob = await getFileBlob(`/data/${task.assetPath}`);
                if (!blob) throw new Error(`读取图片失败: ${task.assetPath}`);
                const buf = await blob.arrayBuffer();
                byteLength = buf.byteLength;
                base64Data = arrayBufferToBase64(buf);
            } else {
                // 已有 base64 数据，去除空白确保签名 content-length 与解码字节数一致
                const clean = task.base64Data!.replace(/\s/g, "");
                base64Data = clean;
                const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
                byteLength = Math.floor((clean.length * 3) / 4) - padding;
            }

            const url = await cosUpload(client, task.ext, base64Data, byteLength);

            done++;
            onProgress?.(done, total);

            return url;
        } catch (e: any) {
            logger.error(`图片上传失败 [${imageId}]:`, e?.message ?? e);
            throw new Error(`图片上传失败 [${imageId}]: ${e?.message ?? e}`);
        }
    }

    // 并发上传，最多同时 3 张
    const urls = await runWithConcurrency(tasks, 3, processTask);
    logger.info(`图片上传完成，共 ${total} 张`);

    // 替换 markdown 中所有匹配的图片引用（同源多引用各自替换为含其 alt 的新 URL）
    let result = markdown;
    for (let i = 0; i < tasks.length; i++) {
        const { occurrences } = tasks[i];
        const newUrl = urls[i];
        for (const { original, alt } of occurrences) {
            result = result.split(original).join(`![${alt}](${newUrl})`);
        }
    }

    return result;
}
