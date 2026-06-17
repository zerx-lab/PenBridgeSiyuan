/**
 * 浏览器窗口登录：仅在思源桌面端（Electron）可用。
 * 使用独立 session 分区打开腾讯云登录页，轮询 cookie 判断登录成功。
 */
import { getFrontend } from "siyuan";

export function canUseBrowserLogin(): boolean {
    const fe = getFrontend();
    return (
        (fe === "desktop" || fe === "desktop-window") &&
        typeof (window as any).require === "function"
    );
}

/** 最大等待时间（ms） */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** 轮询间隔（ms） */
const POLL_INTERVAL_MS = 1000;
/** 登录页 URL */
const LOGIN_URL = "https://cloud.tencent.com/developer";
/** session 分区标识 */
const PARTITION = "persist:penbridge-tencent-login";

/**
 * 打开独立浏览器窗口让用户完成腾讯云登录，
 * 登录成功后返回过滤了 skey 的 cookie 字符串。
 * 每次登录前清空会话分区，避免旧的失效 cookie 被提取。
 */
export async function loginViaBrowserWindow(): Promise<string> {
    const remote = (window as any).require("@electron/remote") as any;

    const loginSession = remote.session.fromPartition(PARTITION);

    // 清空上次登录残留的 cookies、缓存与各类存储，保证干净环境
    try {
        await loginSession.clearStorageData();
        await loginSession.clearCache();
    } catch {
        // 清理失败不阻断登录流程
    }

    return new Promise<string>((resolve, reject) => {
        const win = new remote.BrowserWindow({
            width: 900,
            height: 700,
            title: "登录腾讯云",
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                session: loginSession,
            },
        });

        win.loadURL(LOGIN_URL);

        let resolved = false;

        const timeoutHandle = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            clearInterval(pollHandle);
            if (!win.isDestroyed()) {
                win.close();
            }
            reject(new Error("login timeout"));
        }, LOGIN_TIMEOUT_MS);

        const pollHandle = setInterval(async () => {
            if (resolved || win.isDestroyed()) {
                clearInterval(pollHandle);
                return;
            }
            try {
                const [cookies1, cookies2] = await Promise.all([
                    loginSession.cookies.get({ domain: ".cloud.tencent.com" }),
                    loginSession.cookies.get({ domain: "cloud.tencent.com" }),
                ]);

                // 合并去重（key: name@domain）
                const seen = new Map<string, any>();
                for (const c of [...cookies1, ...cookies2]) {
                    const key = `${c.name}@${c.domain}`;
                    if (!seen.has(key)) seen.set(key, c);
                }
                const all = Array.from(seen.values());

                const names = new Set(all.map((c: any) => c.name));
                const hasSession = names.has("qcommunity_session");
                const hasUin = names.has("uin") || names.has("login_uin");

                if (hasSession && hasUin) {
                    resolved = true;
                    clearInterval(pollHandle);
                    clearTimeout(timeoutHandle);

                    // 过滤 skey，拼接 cookie 字符串
                    const cookieStr = all
                        .filter((c: any) => c.name !== "skey")
                        .map((c: any) => `${c.name}=${c.value}`)
                        .join("; ");

                    if (!win.isDestroyed()) {
                        win.close();
                    }
                    resolve(cookieStr);
                }
            } catch {
                // 窗口可能已销毁，忽略竞态错误
            }
        }, POLL_INTERVAL_MS);

        win.on("closed", () => {
            clearInterval(pollHandle);
            clearTimeout(timeoutHandle);
            if (!resolved) {
                resolved = true;
                reject(new Error("login cancelled"));
            }
        });
    });
}
