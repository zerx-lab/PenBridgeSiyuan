/**
 * GitHub dock 通用工具。
 */
import { getFrontend } from "siyuan";

/** 在系统默认浏览器打开外部链接；桌面端用 Electron shell，否则用 window.open。 */
export function openInBrowser(url: string): void {
    const fe = getFrontend();
    if (
        (fe === "desktop" || fe === "desktop-window") &&
        typeof (window as any).require === "function"
    ) {
        try {
            const { shell } = (window as any).require("electron");
            shell.openExternal(url);
            return;
        } catch {
            /* 回退到 window.open */
        }
    }
    window.open(url, "_blank", "noopener,noreferrer");
}

/** 复制文本到剪贴板；优先 navigator.clipboard，失败回退 execCommand。 */
export async function copyToClipboard(text: string): Promise<boolean> {
    try {
        if (navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        /* 回退 */
    }
    try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    }
}

/** 把 ISO 时间转成简短相对时间（如 "3天前"）。 */
export function relativeTime(iso: string): string {
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return iso;
    const diff = Date.now() - t;
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return "刚刚";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}分钟前`;
    const hour = Math.floor(min / 60);
    if (hour < 24) return `${hour}小时前`;
    const day = Math.floor(hour / 24);
    if (day < 30) return `${day}天前`;
    const month = Math.floor(day / 30);
    if (month < 12) return `${month}个月前`;
    return `${Math.floor(month / 12)}年前`;
}

/** 判断 label 背景色应配深色还是浅色文字（YIQ 亮度）。 */
export function labelTextColor(hex: string): string {
    const h = hex.replace(/^#/, "");
    if (h.length !== 6) return "#24292f";
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 140 ? "#24292f" : "#ffffff";
}
