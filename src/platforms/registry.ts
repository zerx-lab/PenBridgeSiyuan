/**
 * 发布平台注册表 —— 统一管理各平台元信息
 */

export interface PlatformMeta {
    id: string;
    /** i18n 键名 */
    name: string;
    /** 内联 SVG 字符串（16×16 viewBox，fill currentColor） */
    icon: string;
    /** false = 显示"即将支持"，不可配置 */
    available: boolean;
}

/* ── 平台图标（单色内联 SVG，16×16） ── */

const TENCENT_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <path fill="currentColor" d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.2a5.8 5.8 0 1 1 0 11.6A5.8 5.8 0 0 1 8 2.2zM6.2 5v6h1.4V8.6H10V7.4H7.6V6.4H10V5H6.2z"/>
</svg>`;

const HUAWEI_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <path fill="currentColor" d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm0 1.2a5.3 5.3 0 1 1 0 10.6A5.3 5.3 0 0 1 8 2.7zm0 1.6L5 10h6L8 4.3z"/>
</svg>`;

const YUQUE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <path fill="currentColor" d="M4 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm.8 1.8v8.4h6.4V3.8H4.8zm.8 1h4.8v.9H5.6v-.9zm0 1.9h4.8v.9H5.6v-.9zm0 1.9h3.2v.9H5.6v-.9z"/>
</svg>`;

const CNBLOGS_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <path fill="currentColor" d="M3 2h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm1 1.5v9h8v-9H4zm1 1h6v1H5v-1zm0 2h6v1H5v-1zm0 2h4v1H5v-1z"/>
</svg>`;

export const PLATFORMS: PlatformMeta[] = [
    { id: "tencent",  name: "platformTencent",  icon: TENCENT_ICON,  available: true  },
    { id: "huawei",   name: "platformHuawei",   icon: HUAWEI_ICON,   available: false },
    { id: "yuque",    name: "platformYuque",     icon: YUQUE_ICON,    available: false },
    { id: "cnblogs",  name: "platformCnblogs",   icon: CNBLOGS_ICON,  available: false },
];
