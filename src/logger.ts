const PREFIX = "[PenBridge]";

/**
 * 简单日志工具 —— 绝不打印 cookie、token、签名等敏感字段。
 */
export const logger = {
    info(...args: unknown[]) { console.info(PREFIX, ...args); },
    warn(...args: unknown[]) { console.warn(PREFIX, ...args); },
    error(...args: unknown[]) { console.error(PREFIX, ...args); },
};
