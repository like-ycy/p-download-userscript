// ==UserScript==
// @name         Pornhub 单个与当前页批量下载
// @namespace    local.pornhub.download-manager
// @version      2026.11.20.4
// @description  主页跳转、列表单个/当前页批量下载、播放页分辨率与地址；串行任务队列。
// @match        https://*.pornhub.com/*
// @match        https://pornhub.com/*
// @match        https://*.pornhubpremium.com/*
// @match        https://pornhubpremium.com/*
// @grant        GM_download
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      pornhub.com
// @connect      pornhubpremium.com
// @connect      phncdn.com
// @connect      phprcdn.com
// @run-at       document-idle
// @noframes
// @license      MIT
// ==/UserScript==

// 基于原脚本的 mediaDefinitions → get_media 解析思路重新实现。
// 原脚本：Pornhub video download with one click，MIT；
// 作者：liuwanlin、heckles、MatthewXY、人民的勤务员。
// https://github.com/ChinaGodMan/UserScripts

(() => {
    'use strict';

    const ROOT_ID = 'ph-download-manager';
    if (document.getElementById(ROOT_ID)) return;
    const SITE_HOSTS = ['pornhub.com', 'pornhubpremium.com'];
    const MEDIA_HOSTS = [...SITE_HOSTS, 'phncdn.com', 'phprcdn.com'];
    const LIST_SELECTORS = [
        '#mostRecentVideosSection', '#pornstarsVideoSection',
        '#uploadedVideosSection', '#videosUploadedSection',
        '#videoCollection', '#videosTab ul.videos',
    ];
    const REQUEST_TIMEOUT = 60000;
    const MEDIA_IDLE_TIMEOUT = 90000;
    const TEMP_DIRECTORY = 'ph-download-manager';
    const jobs = [];
    let running = false;
    let context;
    let pageURL = '';
    let scanTimer;
    let detailVersion = 0;
    let detailKey = '';
    let selection = '1080';
    let pickerVideos = [];
    const selectedKeys = new Set();
    const pickerRows = new Map();

    function allowedHost(host, domains) {
        return domains.some(domain => host === domain || host.endsWith(`.${domain}`));
    }

    function safeURL(value, base, domains = MEDIA_HOSTS) {
        const url = new URL(value, base);
        if (url.protocol !== 'https:' || url.port || url.username || url.password ||
            !allowedHost(url.hostname, domains)) {
            throw new Error('媒体地址不属于支持的 HTTPS 域名');
        }
        return url;
    }

    function videoIdentity(value, base = location.href, sameOrigin = true) {
        try {
            const url = safeURL(value, base, SITE_HOSTS);
            const key = url.searchParams.get('viewkey');
            if ((sameOrigin && url.origin !== location.origin) || url.pathname !== '/view_video.php' ||
                !key || !/^[a-zA-Z0-9]+$/.test(key)) return null;
            return { key, url: `${url.origin}/view_video.php?viewkey=${encodeURIComponent(key)}` };
        } catch {
            return null;
        }
    }

    function pageContext() {
        const video = videoIdentity(location.href);
        if (video) return { kind: 'video', video };
        const match = location.pathname.match(/^\/(model|pornstar|users|channels)\/([^/]+)(\/.*)?$/);
        if (!match) return { kind: 'none' };
        const base = `/${match[1]}/${match[2]}`;
        const tail = (match[3] || '').replace(/\/$/, '');
        if (!tail) return { kind: 'home', base };
        if (/^\/videos(?:\/(?:public|upload|uploads))?$/.test(tail)) {
            return { kind: 'list', base };
        }
        return { kind: 'none' };
    }

    function listRoots() {
        // 仅已识别的作者视频区域；不扫描全页链接，避免混入导航推荐和广告。
        for (const selector of LIST_SELECTORS) {
            const roots = [...document.querySelectorAll(selector)];
            if (roots.some(root => root.querySelector('a[href*="view_video.php"]'))) return roots;
        }
        return [];
    }

    function collectVideos() {
        const videos = new Map();
        for (const root of listRoots()) {
            for (const card of root.querySelectorAll('li[data-video-vkey], li.pcVideoListItem, li.videoblock')) {
                if (card.closest('[data-ad], .adContainer, .adsbytrafficjunky')) continue;
                const link = card.querySelector('.title a[href*="view_video.php"]') ||
                    card.querySelector('a[href*="view_video.php"]');
                const identity = link && videoIdentity(link.href);
                if (!identity) continue;
                if (card.dataset.videoVkey && card.dataset.videoVkey !== identity.key) continue;
                // 优先读取可见文本，以保留浏览器整页翻译后的标题。
                const visibleTitle = link.textContent.replace(/\s+/g, ' ').trim();
                const title = link.getAttribute('title') || visibleTitle || identity.key;
                const displayTitle = visibleTitle || title;
                const duration = card.querySelector('.duration')?.textContent.trim() || '';
                if (!videos.has(identity.key)) videos.set(identity.key, { ...identity, title, displayTitle, duration });
            }
        }
        return [...videos.values()];
    }

    function jsonObjectAt(source, start) {
        // 只读取 JSON 字面量，不执行网站脚本（禁止 eval / Function）。
        if (source[start] !== '{') throw new Error('播放器数据格式不受支持');
        let depth = 0;
        let quoted = false;
        let escaped = false;
        for (let i = start; i < source.length; i++) {
            const char = source[i];
            if (quoted) {
                if (escaped) escaped = false;
                else if (char === '\\') escaped = true;
                else if (char === '"') quoted = false;
            } else if (char === '"') quoted = true;
            else if (char === '{') depth++;
            else if (char === '}' && --depth === 0) return JSON.parse(source.slice(start, i + 1));
        }
        throw new Error('播放器数据不完整');
    }

    function playerData(doc) {
        const candidates = [];
        for (const script of doc.scripts) {
            const source = script.textContent;
            const pattern = /\bvar\s+flashvars_\d+\s*=\s*(?=\{)/g;
            let match;
            while ((match = pattern.exec(source))) {
                try {
                    const data = jsonObjectAt(source, pattern.lastIndex);
                    if (Array.isArray(data.mediaDefinitions)) candidates.push(data);
                } catch {
                    // 非 JSON 不尝试执行；统一在没有有效候选时报告错误。
                }
            }
        }
        if (candidates.length !== 1) {
            const error = new Error(candidates.length ? '检测到多个播放器，无法确认当前视频' :
                '未找到可读的播放器数据；请打开视频检查登录、验证或视频是否可播放');
            if (!candidates.length) error.code = 'PLAYER_DATA_MISSING';
            throw error;
        }
        return candidates[0];
    }

    async function requestText(value, referer) {
        const url = safeURL(value, referer);
        if (url.origin === location.origin) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
            try {
                const response = await fetch(url.href, {
                    credentials: 'include', cache: 'no-store', signal: controller.signal,
                    referrer: referer,
                });
                if (!response.ok) throw new Error(`请求失败：HTTP ${response.status}`);
                safeURL(response.url, referer);
                return { text: await response.text(), url: response.url };
            } catch (error) {
                if (error.name === 'AbortError') throw new Error('解析请求超时，请稍后重试');
                throw error;
            } finally {
                clearTimeout(timer);
            }
        }
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url: url.href, timeout: REQUEST_TIMEOUT,
                headers: { Referer: referer },
                onload: response => {
                    try {
                        if (response.status < 200 || response.status >= 300) {
                            throw new Error(`媒体接口失败：HTTP ${response.status}`);
                        }
                        safeURL(response.finalUrl || url.href, referer);
                        resolve({ text: response.responseText, url: response.finalUrl || url.href });
                    } catch (error) { reject(error); }
                },
                onerror: () => reject(new Error('媒体接口连接失败，请检查网络或油猴域名授权')),
                ontimeout: () => reject(new Error('媒体接口请求超时')),
                onabort: () => reject(new Error('媒体接口请求已取消')),
            });
        });
    }

    function normalizeMedia(definitions, base) {
        const sources = new Map();
        for (const item of definitions) {
            if (!item || item.remote || typeof item.videoUrl !== 'string' || !item.videoUrl) continue;
            const quality = String(item.quality ?? item.height ?? '').match(/^(\d{2,4})(?:p)?$/i);
            if (!quality) continue;
            const url = safeURL(item.videoUrl, base);
            const format = String(item.format || '').toLowerCase();
            if (format !== 'mp4' || /\.m3u8(?:$|[/?])/i.test(url.pathname)) continue;
            const height = Number(quality[1]);
            if (!sources.has(height)) sources.set(height, { height, url: url.href });
        }
        return [...sources.values()].sort((a, b) => a.height - b.height);
    }

    async function resolveVideo(video) {
        // 每个队列项启动时重新解析，避免排队时签名过期或跨网络复用地址。
        const response = await requestText(video.url, video.url);
        if (videoIdentity(response.url, video.url, false)?.key !== video.key) {
            throw new Error('视频页面被重定向，请先打开视频完成站点验证');
        }
        const doc = new DOMParser().parseFromString(response.text, 'text/html');
        const data = playerData(doc);
        const definitions = [...data.mediaDefinitions];
        const visited = new Set();
        const remoteErrors = [];
        // 远程端点可返回多分辨率；最多读取一层，避免循环和意外递归请求。
        for (const definition of data.mediaDefinitions) {
            if (!definition.remote || !definition.videoUrl || visited.has(definition.videoUrl)) continue;
            visited.add(definition.videoUrl);
            try {
                const remote = await requestText(definition.videoUrl, response.url);
                const rows = JSON.parse(remote.text);
                if (!Array.isArray(rows)) throw new Error('媒体接口没有返回视频列表');
                definitions.push(...rows);
            } catch (error) { remoteErrors.push(error.message); }
        }
        // 部分接口失败也不把不完整的分辨率列表伪装为完整结果。
        if (remoteErrors.length) throw new Error(remoteErrors.join('；'));
        const sources = normalizeMedia(definitions, response.url);
        if (!sources.length) {
            const hls = definitions.some(item => item.format === 'hls' || /\.m3u8/i.test(item.videoUrl || ''));
            throw new Error(hls ? '此视频仅提供 HLS 播放流，当前脚本不能将其直接下载为 MP4' :
                '此视频没有可下载的 MP4 地址');
        }
        const title = data.video_title || doc.querySelector('meta[property="og:title"]')?.content ||
            doc.title.replace(/\s*[-|]\s*Pornhub(?:\.com)?\s*$/i, '') || video.title || video.key;
        return { title, sources, referer: response.url };
    }

    function chooseSource(sources, quality) {
        if (quality === 'lowest') return sources[0];
        if (quality === 'highest') return sources[sources.length - 1];
        // 全部下载入口统一规则：最高不超过目标画质，不向上升级。
        return sources.filter(source => source.height <= Number(quality))
            .reduce((best, source) => !best || source.height > best.height ? source : best, undefined);
    }

    function filename(title, key, height) {
        const clean = String(title).normalize('NFC').replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_')
            .replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '');
        // 同时限制多字节标题长度，给文件系统的 255 字节文件名上限留余量。
        let short = '';
        const encoder = new TextEncoder();
        for (const char of clean) {
            if (encoder.encode(short + char).length > 160) break;
            short += char;
        }
        return `${short || 'video'} [${key}] ${height}p.mp4`;
    }

    function downloadError(error) {
        const code = typeof error === 'string' ? error : error?.error || error?.name || 'unknown';
        const detail = [error?.details?.message, typeof error?.details === 'string' ? error.details : '',
            error?.message, error?.statusText].filter(value => typeof value === 'string' && value.trim())
            .join('；').replace(/https?:\/\/\S+/g, '[媒体地址]').slice(0, 300);
        const messages = {
            not_enabled: '请在 Tampermonkey 设置中启用下载功能（下载模式：浏览器 API）',
            not_whitelisted: '请在 Tampermonkey 下载扩展名白名单中允许 mp4',
            not_permitted: '请允许 Tampermonkey 的下载权限和媒体域名访问',
            not_supported: '当前脚本管理器不支持下载，请使用 Tampermonkey 的浏览器 API 下载模式',
            not_succeeded: '本地文件保存失败；请检查 Chrome 下载记录、磁盘空间和下载权限',
        };
        const message = messages[code] || `本地文件保存失败（${code}）`;
        return detail ? `${message}：${detail}` : message;
    }

    function saveFile(job, source, file) {
        return new Promise((resolve, reject) => {
            if (typeof GM_download !== 'function') {
                reject(new Error('未找到 GM_download，请在油猴中安装并运行此脚本'));
                return;
            }
            let settled = false;
            const finish = error => {
                if (settled) return;
                settled = true;
                if (error) reject(error);
                else resolve();
            };
            try {
                GM_download({
                    // 媒体已由页面取得；扩展仅保存本地 File，不重新请求签名 CDN 地址。
                    // OPFS 的 .tmp 文件没有 MIME；显式指定，避免 Chrome 将扩展名改为 .txt。
                    url: file.slice(0, file.size, 'video/mp4'), name: filename(job.title, job.key, source.height),
                    mode: 'browser', saveAs: false,
                    onload: () => finish(),
                    onerror: error => finish(new Error(downloadError(error))),
                    ontimeout: () => finish(new Error('下载超时，请重试')),
                    onprogress: event => {
                        if (settled) return;
                        const loaded = Number(event.loaded) || 0;
                        const total = Number(event.total) || 0;
                        job.note = `保存文件 · ${total > 0 ? `${Math.min(100, loaded / total * 100).toFixed(1)}%` :
                            `${(loaded / 1024 / 1024).toFixed(1)} MB`}`;
                        renderJobs();
                    },
                });
            } catch (error) { finish(error); }
        });
    }

    async function temporaryDirectory() {
        if (!navigator.storage?.getDirectory || !navigator.locks?.request) {
            throw new Error('当前浏览器不支持临时磁盘下载，请使用新版 Chrome');
        }
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle(TEMP_DIRECTORY, { create: true });
    }

    async function removeAbandonedFiles(directory) {
        // 同源其他标签页正在使用的临时文件有锁；刷新/关闭后锁自动释放。
        for await (const [name, handle] of directory.entries()) {
            if (handle.kind !== 'file' || !/^transfer-[\da-f-]+\.tmp$/.test(name)) continue;
            await navigator.locks.request(`${TEMP_DIRECTORY}:${name}`, { ifAvailable: true }, async lock => {
                if (lock) await directory.removeEntry(name).catch(() => {});
            });
        }
    }

    async function writeMedia(job, source, handle) {
        const controller = new AbortController();
        let timer;
        let reader;
        let writer;
        let closed = false;
        let received = 0;
        const header = new Uint8Array(12);
        let headerLength = 0;
        const armTimeout = () => {
            clearTimeout(timer);
            timer = setTimeout(() => controller.abort(), MEDIA_IDLE_TIMEOUT);
        };
        try {
            armTimeout();
            const response = await fetch(safeURL(source.url, job.url).href, {
                signal: controller.signal, credentials: 'omit', cache: 'no-store',
                referrer: job.referer || job.url,
            });
            if (response.status !== 200) {
                throw new Error(`媒体请求失败：HTTP ${response.status}；请重试以刷新地址`);
            }
            safeURL(response.url, job.url);
            const type = response.headers.get('content-type') || '';
            if (/text\/|json|mpegurl/i.test(type)) throw new Error('服务器返回了网页或播放清单，并非 MP4 文件');
            if (!response.body) throw new Error('服务器没有返回视频数据');
            const total = Number(response.headers.get('content-length')) || 0;
            const space = await navigator.storage.estimate();
            if (total > 0 && space.quota && total > space.quota - (space.usage || 0)) {
                throw new Error('浏览器临时磁盘空间不足，请释放磁盘或站点存储后重试');
            }
            reader = response.body.getReader();
            writer = await handle.createWritable();
            let lastRender = 0;
            while (true) {
                armTimeout();
                const { done, value } = await reader.read();
                clearTimeout(timer);
                if (done) break;
                if (headerLength < header.length) {
                    const part = value.subarray(0, header.length - headerLength);
                    header.set(part, headerLength);
                    headerLength += part.length;
                    if (headerLength >= 8 && String.fromCharCode(...header.subarray(4, 8)) !== 'ftyp') {
                        throw new Error('服务器返回的数据不是有效的 MP4 文件');
                    }
                }
                await writer.write(value);
                received += value.byteLength;
                if (Date.now() - lastRender > 250) {
                    job.note = `读取媒体 · ${total > 0 ? `${Math.min(100, received / total * 100).toFixed(1)}%` :
                        `${(received / 1024 / 1024).toFixed(1)} MB`}`;
                    renderJobs();
                    lastRender = Date.now();
                }
            }
            if (headerLength < 12 || (total > 0 && received !== total)) {
                throw new Error('视频数据不完整，请重试；未保存为已完成文件');
            }
            await writer.close();
            closed = true;
            return await handle.getFile();
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('媒体连接超过 90 秒没有数据，请重试');
            if (error.name === 'QuotaExceededError') throw new Error('浏览器临时磁盘空间不足，请释放空间后重试');
            if (error instanceof TypeError) throw new Error('页面读取媒体失败，请检查网络或 CDN 跨域限制后重试');
            throw error;
        } finally {
            clearTimeout(timer);
            controller.abort();
            if (reader) await reader.cancel().catch(() => {});
            if (writer && !closed) await writer.abort().catch(() => {});
        }
    }

    async function downloadFile(job, source) {
        const directory = await temporaryDirectory();
        await removeAbandonedFiles(directory);
        const name = `transfer-${crypto.randomUUID()}.tmp`;
        await navigator.locks.request(`${TEMP_DIRECTORY}:${name}`, async () => {
            try {
                const handle = await directory.getFileHandle(name, { create: true });
                const file = await writeMedia(job, source, handle);
                job.note = '媒体读取完成，正在保存文件…';
                renderJobs();
                await saveFile(job, source, file);
            } finally {
                try { await directory.removeEntry(name); }
                catch (error) {
                    if (error.name !== 'NotFoundError') {
                        notice.textContent = '浏览器未能清理临时文件，下次下载时会再次尝试清理。';
                    }
                }
            }
        });
    }

    async function runQueue() {
        if (running) return;
        running = true;
        try {
            let job;
            while ((job = jobs.find(item => item.state === 'queued'))) {
                job.state = 'resolving';
                job.note = '';
                renderJobs();
                try {
                    const result = await resolveVideo(job);
                    job.title = result.title;
                    job.referer = result.referer;
                    const source = chooseSource(result.sources, job.quality);
                    if (!source) {
                        job.state = 'skipped';
                        job.note = `无 ${job.quality}p 或更低画质（可用：${result.sources.map(x => `${x.height}p`).join('、')}）`;
                    } else {
                        job.height = source.height;
                        job.state = 'downloading';
                        renderJobs();
                        await downloadFile(job, source);
                        job.state = 'done';
                        job.note = '';
                    }
                } catch (error) {
                    job.state = 'failed';
                    job.note = error.message || '未知错误';
                }
                renderJobs();
            }
        } finally {
            running = false;
            renderJobs();
        }
    }

    function enqueue(videos, quality) {
        let added = 0;
        for (const video of videos) {
            if (jobs.some(job => job.key === video.key && job.quality === quality &&
                ['queued', 'resolving', 'downloading'].includes(job.state))) continue;
            jobs.push({ key: video.key, url: video.url, title: video.title || video.key, displayTitle: video.displayTitle,
                quality, state: 'queued', note: '' });
            added++;
        }
        notice.textContent = added ? `已加入 ${added} 个任务；逐个下载，请保持此页打开。` : '任务已在队列中。';
        renderJobs();
        void runQueue();
    }

    const css = `
        :host { display:block; color:#eee; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color-scheme:dark; }
        * { box-sizing:border-box; } [hidden] { display:none !important; }
        .panel { clear:both; margin:16px 0; padding:16px; border:1px solid #555; border-radius:10px; background:#181818; }
        h2 { margin:0 0 10px; color:#ffab40; font-size:18px; } p { margin:8px 0; }
        .row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
        button,select,a.action { font:inherit; padding:7px 11px; border:1px solid #666; border-radius:6px; background:#303030; color:#fff; }
        button,a.action { cursor:pointer; } button:hover,a.action:hover { border-color:#ffab40; }
        button:disabled { cursor:default; opacity:.5; } button.primary,a.action { background:#ff9900; border-color:#ff9900; color:#111; }
        button:focus-visible,select:focus-visible,input:focus-visible,a:focus-visible { outline:3px solid #73cfff; outline-offset:3px; }
        a { color:#ffb64d; text-decoration:none; } .muted { color:#bbb; font-size:12px; }
        .panel:not([data-page="home"]),dialog { color-scheme:light; color:#172b3a; background:#fff; border:1px solid #deebf3; border-radius:16px; box-shadow:0 8px 28px #001b3b12; padding:20px; }
        .panel:not([data-page="home"]) h2,dialog h2 { color:#172b3a; font-size:17px; margin:0; }
        .panel:not([data-page="home"]) .muted,dialog .muted { color:#688093; }
        .panel:not([data-page="home"]) button,dialog button { border:0; border-radius:9px; background:#eef3f7; color:#26465d; padding:8px 12px; }
        .panel:not([data-page="home"]) button.primary,dialog button.primary { background:#008ac5; color:#fff; font-weight:600; }
        .panel:not([data-page="home"]) button.primary:hover:enabled,dialog button.primary:hover:enabled { background:#0078ab; }
        .panel:not([data-page="home"]) a,dialog a { color:#008ac5; }
        .panel:not([data-page="home"]) select,dialog select { background:#fff; color:#26465d; border:1px solid #d6e3ec; border-radius:9px; padding:7px 10px; }
        .panel:not([data-page="home"]) .controls { margin-top:16px; gap:18px; }
        label { display:inline-flex; align-items:center; gap:8px; cursor:pointer; }
        input[type="checkbox"] { width:16px; height:16px; accent-color:#008ac5; margin:0; cursor:pointer; flex:none; }
        .error { color:#b32e36; } .success { color:#228350; }
        .task-area { border-top:1px solid #e6eef4; margin-top:18px; padding-top:12px; }
        summary { cursor:pointer; color:#688093; font-size:12px; padding:4px 0 10px; }
        .jobs { max-height:260px; overflow:auto; margin-top:8px; }
        .job { display:grid; grid-template-columns:minmax(100px,1fr) minmax(120px,1fr); gap:16px; border-top:1px solid #e6eef4; padding:10px 0; font-size:12px; overflow-wrap:anywhere; }
        .job a { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
        dialog { width:min(900px,calc(100vw - 32px)); max-height:85vh; padding:0; overflow:hidden; box-shadow:0 20px 80px #001b3b40; }
        dialog::backdrop { background:#0f213b66; backdrop-filter:blur(3px); }
        .dialog-head { padding:20px 24px 14px; display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
        dialog .close { background:transparent; color:#758796; font-size:25px; line-height:1; padding:0 6px; }
        .picker-toolbar { padding:12px 24px; background:#f5f9fc; border-block:1px solid #e6eef4; gap:16px; }
        .picker-toolbar .primary { margin-left:auto; }
        .table-scroll { max-height:calc(85vh - 210px); min-height:90px; overflow:auto; }
        table { width:100%; border-collapse:collapse; table-layout:fixed; }
        th,td { text-align:left; border-bottom:1px solid #e6eef4; padding:13px 8px; font-size:13px; overflow-wrap:anywhere; }
        th { color:#688093; font-weight:500; background:#fff; position:sticky; top:0; z-index:1; }
        th:first-child,td:first-child { width:52px; text-align:center; padding-left:20px; }
        th.duration,td.duration { width:76px; color:#688093; font-variant-numeric:tabular-nums; }
        th:last-child,td:last-child { width:100px; text-align:right; padding-right:24px; }
        td button { white-space:nowrap; font-size:12px; padding:7px 11px; }
        .video-name { display:block; font-weight:600; line-height:1.6; color:#172b3a; }
        tr[data-selected="true"] { background:#edf8fd; }
        tr:hover { background:#f5f9fc; }
        .video-status { display:block; font-size:12px; margin-top:4px; color:#688093; }
        .video-status.error { color:#b32e36; } .video-status.success { color:#228350; }
        .dialog-foot { margin:0; padding:11px 24px; border-top:1px solid #e6eef4; }
        .detail-heading { justify-content:space-between; margin-top:16px; }
        .sources { margin-top:8px; }
        .source { display:grid; grid-template-columns:85px minmax(100px,1fr) auto auto; gap:10px; align-items:center; padding:12px 0; border-top:1px solid #e6eef4; }
        .source strong { color:#26465d; font-size:14px; }
        .source small { display:block; font-size:11px; font-weight:400; color:#688093; }
        input.address { min-width:0; width:100%; padding:8px; border:1px solid #e1e9f0; border-radius:7px; background:#f7fafc; color:#688093; font:12px ui-monospace,monospace; }
        .inline-status { min-height:18px; font-size:12px; margin:5px 0 0; }
        @media(max-width:600px) {
            .dialog-head,.picker-toolbar { padding:16px; }.picker-toolbar .primary { margin-left:0; }
            .table-scroll { max-height:calc(85vh - 265px); } th.duration,td.duration { display:none; }
            th:last-child,td:last-child { width:82px; padding-right:12px; } th:first-child,td:first-child { width:40px; padding-left:10px; }
            .source { grid-template-columns:70px minmax(0,1fr) auto; }.source input { grid-column:1/-1; grid-row:2; }
        }
    `;

    function element(tag, text, className) {
        const node = document.createElement(tag);
        if (text) node.textContent = text;
        if (className) node.className = className;
        return node;
    }

    function button(text, handler, primary = false) {
        const node = element('button', text, primary ? 'primary' : '');
        node.type = 'button';
        node.addEventListener('click', handler);
        return node;
    }

    function link(text, url, className) {
        const node = element('a', text, className);
        node.href = url;
        return node;
    }

    function qualityName(value) {
        return ({ lowest: '最低可用', highest: '最高可用', 1440: '2K · 1440p', 2160: '4K · 2160p' })[value] || `${value}p`;
    }

    function qualityPicker() {
        const select = element('select');
        select.setAttribute('aria-label', '下载画质');
        for (const value of ['240', '360', '480', '720', '1080', '1440', '2160', 'lowest', 'highest']) {
            const option = element('option', qualityName(value));
            option.value = value;
            select.append(option);
        }
        select.value = selection;
        select.addEventListener('change', () => {
            selection = select.value;
            qualitySelect.value = pickerQuality.value = selection;
            updatePickerSelection();
        });
        return select;
    }

    const host = element('div');
    host.id = ROOT_ID;
    host.setAttribute('translate', 'no');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.append(element('style', css));
    const panel = element('section', '', 'panel');
    const heading = element('h2', '视频下载');
    const intro = element('p', '', 'muted');
    const controls = element('div', '', 'row controls');
    const qualityLabel = element('label', '下载画质');
    const qualitySelect = qualityPicker();
    qualityLabel.append(qualitySelect);
    const batchButton = button('选择下载', () => void openPicker(), true);
    const homeLink = link('进入视频页下载', '#', 'action');
    controls.append(qualityLabel, batchButton, homeLink);
    const notice = element('p', '', 'muted');
    notice.setAttribute('role', 'status');
    const detailArea = element('div');
    const taskArea = element('details', '', 'task-area');
    const summary = element('summary');
    const queueControls = element('div', '', 'row');
    const stopButton = button('停止后续任务', () => {
        for (const job of jobs) if (job.state === 'queued') job.state = 'cancelled';
        notice.textContent = '后续任务已停止；当前任务会继续完成。';
        renderJobs();
    });
    const retryButton = button('重试失败项', () => restartJobs('failed'));
    const resumeButton = button('继续已停止项', () => restartJobs('cancelled'));
    const clearButton = button('清除记录', () => {
        for (let i = jobs.length - 1; i >= 0; i--) {
            if (!['queued', 'resolving', 'downloading'].includes(jobs[i].state)) jobs.splice(i, 1);
        }
        renderJobs();
    });
    queueControls.append(stopButton, retryButton, resumeButton, clearButton);
    const jobList = element('div', '', 'jobs');
    taskArea.append(summary, queueControls, jobList);
    panel.append(heading, intro, controls, notice, detailArea, taskArea);

    const dialog = element('dialog');
    dialog.setAttribute('aria-label', '选择要下载的视频');
    const dialogHead = element('header', '', 'dialog-head');
    const dialogTitleBlock = element('div');
    dialogTitleBlock.append(element('h2', '选择下载'));
    const pickerCaption = element('p', '', 'muted');
    dialogTitleBlock.append(pickerCaption);
    const closeButton = button('×', () => dialog.close());
    closeButton.className = 'close';
    closeButton.setAttribute('aria-label', '关闭视频列表');
    dialogHead.append(dialogTitleBlock, closeButton);
    const pickerToolbar = element('div', '', 'row picker-toolbar');
    const selectAllLabel = element('label', '');
    const selectAll = element('input');
    selectAll.type = 'checkbox';
    selectAllLabel.append(selectAll, document.createTextNode('全选'));
    selectAll.addEventListener('change', () => {
        selectedKeys.clear();
        if (selectAll.checked) for (const video of pickerVideos) selectedKeys.add(video.key);
        updatePickerSelection();
    });
    const pickerQualityLabel = element('label', '画质');
    const pickerQuality = qualityPicker();
    pickerQualityLabel.append(pickerQuality);
    const selectionCount = element('span', '', 'muted');
    const downloadSelected = button('下载已选', () => {
        enqueue(pickerVideos.filter(video => selectedKeys.has(video.key)), selection);
    }, true);
    pickerToolbar.append(selectAllLabel, pickerQualityLabel, selectionCount, downloadSelected);
    const tableScroll = element('div', '', 'table-scroll');
    const table = element('table');
    const thead = element('thead');
    const columnRow = element('tr');
    for (const [title, className] of [['', ''], ['视频', ''], ['时长', 'duration'], ['操作', '']]) {
        const th = element('th', title, className);
        th.scope = 'col';
        if (!title) th.setAttribute('aria-label', '选择');
        columnRow.append(th);
    }
    thead.append(columnRow);
    const pickerBody = element('tbody');
    table.append(thead, pickerBody);
    tableScroll.append(table);
    const pickerFooter = element('p', '所选画质不可用时自动降低；仅下载当前页，关闭此窗口不影响队列。', 'muted dialog-foot');
    dialog.append(dialogHead, pickerToolbar, tableScroll, pickerFooter);
    shadow.append(panel, dialog);

    function restartJobs(state) {
        for (const job of jobs) {
            if (job.state !== state) continue;
            const duplicate = jobs.some(other => other !== job && other.key === job.key &&
                other.quality === job.quality && ['queued', 'resolving', 'downloading'].includes(other.state));
            if (!duplicate) { job.state = 'queued'; job.note = ''; job.height = undefined; }
        }
        renderJobs();
        void runQueue();
    }

    function jobQuality(job) {
        if (!job.height) return qualityName(job.quality);
        const lowered = /^\d+$/.test(job.quality) && job.height < Number(job.quality);
        return lowered ? `${job.quality}p → ${job.height}p` : `${job.height}p`;
    }

    function renderJobs() {
        const labels = { queued: '排队中', resolving: '获取最新地址', downloading: '下载中',
            done: '已完成', failed: '失败', skipped: '已跳过', cancelled: '已停止' };
        const counts = {};
        for (const job of jobs) counts[job.state] = (counts[job.state] || 0) + 1;
        taskArea.hidden = !jobs.length;
        summary.textContent = `下载任务 · ${Object.entries(counts).map(([state, count]) => `${labels[state]} ${count}`).join(' · ')}`;
        stopButton.disabled = !counts.queued;
        retryButton.disabled = !counts.failed;
        resumeButton.disabled = !counts.cancelled;
        const fragment = document.createDocumentFragment();
        for (const job of jobs) {
            const row = element('div', '', 'job');
            const videoLink = link(job.displayTitle || job.title, job.url);
            videoLink.target = '_blank';
            videoLink.rel = 'noopener noreferrer';
            videoLink.title = job.title;
            row.append(videoLink, element('span', `${jobQuality(job)} · ${labels[job.state]}${job.note ? ` · ${job.note}` : ''}`,
                job.state === 'failed' ? 'error' : job.state === 'done' ? 'success' : ''));
            fragment.append(row);
        }
        jobList.replaceChildren(fragment);
        for (const [key, row] of pickerRows) {
            const active = jobs.find(job => job.key === key && ['queued', 'resolving', 'downloading'].includes(job.state));
            const job = active || [...jobs].reverse().find(item => item.key === key);
            row.download.disabled = Boolean(active);
            row.download.textContent = active ? '处理中' : '下载';
            row.status.textContent = job ? `${jobQuality(job)} · ${labels[job.state]}${job.note ? ` · ${job.note}` : ''}` : '';
            row.status.className = `video-status${job?.state === 'failed' ? ' error' : job?.state === 'done' ? ' success' : ''}`;
        }
    }

    function updatePickerSelection() {
        for (const [key, row] of pickerRows) {
            row.checkbox.checked = selectedKeys.has(key);
            row.node.dataset.selected = String(row.checkbox.checked);
        }
        selectionCount.textContent = `已选 ${selectedKeys.size} / ${pickerVideos.length}`;
        selectAll.checked = pickerVideos.length > 0 && selectedKeys.size === pickerVideos.length;
        selectAll.indeterminate = selectedKeys.size > 0 && selectedKeys.size < pickerVideos.length;
        downloadSelected.textContent = `下载已选（${selectedKeys.size}）`;
        downloadSelected.disabled = !selectedKeys.size;
    }

    function showPicker(videos) {
        pickerVideos = videos;
        selectedKeys.clear();
        pickerRows.clear();
        pickerBody.replaceChildren();
        pickerCaption.textContent = `当前页 ${videos.length} 个视频 · 可单个下载，也可勾选多个`;
        for (const video of videos) {
            const node = element('tr');
            const checkCell = element('td');
            const checkbox = element('input');
            checkbox.type = 'checkbox';
            checkbox.setAttribute('aria-label', `选择 ${video.displayTitle || video.title}`);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) selectedKeys.add(video.key);
                else selectedKeys.delete(video.key);
                updatePickerSelection();
            });
            checkCell.append(checkbox);
            const titleCell = element('td');
            const title = link(video.displayTitle || video.title, video.url, 'video-name');
            title.target = '_blank';
            title.rel = 'noopener noreferrer';
            title.title = video.title;
            const status = element('small', '', 'video-status');
            titleCell.append(title, status);
            const actions = element('td');
            const download = button('下载', () => enqueue([video], selection), true);
            download.setAttribute('aria-label', `下载 ${video.displayTitle || video.title}`);
            actions.append(download);
            node.append(checkCell, titleCell, element('td', video.duration || '—', 'duration'), actions);
            pickerBody.append(node);
            pickerRows.set(video.key, { node, checkbox, download, status });
        }
        pickerQuality.value = selection;
        updatePickerSelection();
        renderJobs();
        if (!dialog.open) dialog.showModal();
    }

    function openPicker() {
        if (context.kind !== 'list') return;
        const videos = collectVideos();
        if (!videos.length) { notice.textContent = '当前页尚未加载视频，请稍后重试。'; return; }
        notice.textContent = '';
        showPicker(videos);
    }

    async function copyFresh(video, height, trigger, input, status) {
        trigger.disabled = true;
        trigger.textContent = '更新中…';
        status.textContent = '';
        try {
            const result = await resolveVideo(video);
            // 地址行对应明确画质，复制不能悄悄变成另一个画质。
            const source = result.sources.find(item => item.height === height);
            if (!source) throw new Error(`该视频已不提供 ${height}p，请刷新地址`);
            GM_setClipboard(source.url, 'text');
            input.value = source.url;
            trigger.textContent = '已复制';
        } catch (error) {
            trigger.textContent = '重新复制';
            status.textContent = error.message;
        } finally { trigger.disabled = false; }
    }

    async function loadDetail(video, attempt = 0) {
        const version = ++detailVersion;
        const current = () => version === detailVersion && context.kind === 'video' && context.video.key === video.key;
        detailArea.replaceChildren(element('p', '正在获取可用画质和下载地址…', 'muted'));
        try {
            const result = await resolveVideo(video);
            if (!current()) return;
            const tools = element('div', '', 'row detail-heading');
            tools.append(element('span', `${result.sources.length} 个画质 · MP4`, 'muted'),
                button('刷新地址', () => void loadDetail(video)));
            const sources = element('div', '', 'sources');
            const status = element('p', '', 'inline-status error');
            status.setAttribute('role', 'status');
            for (const source of [...result.sources].reverse()) {
                const row = element('div', '', 'source');
                const quality = element('strong', `${source.height}p`);
                quality.append(element('small', 'MP4 视频'));
                const input = element('input', '', 'address');
                input.readOnly = true;
                input.value = source.url;
                input.setAttribute('aria-label', `${source.height}p MP4 地址`);
                input.addEventListener('click', () => input.select());
                const copy = button('复制', () => void copyFresh(video, source.height, copy, input, status));
                row.append(quality, input, copy, button('下载', () => {
                    enqueue([{ ...video, title: result.title }], String(source.height));
                    taskArea.open = true;
                }, true));
                sources.append(row);
            }
            detailArea.replaceChildren(tools, sources, status);
        } catch (error) {
            if (!current()) return;
            if (error.code === 'PLAYER_DATA_MISSING' && attempt < 2) {
                detailArea.replaceChildren(element('p', '播放器数据尚未就绪，正在等待并重试…', 'muted'));
                setTimeout(() => { if (current()) void loadDetail(video, attempt + 1); }, 1200 * (attempt + 1));
                return;
            }
            detailArea.replaceChildren(element('p', error.message, 'error'),
                button('重新获取', () => void loadDetail(video)));
        }
    }

    function scanPage() {
        const next = pageContext();
        const changed = pageURL !== location.href || JSON.stringify(context) !== JSON.stringify(next);
        context = next;
        pageURL = location.href;
        if (changed) {
            if (dialog.open) dialog.close();
            detailVersion++;
            detailKey = '';
            detailArea.replaceChildren();
        }
        if (context.kind === 'none') {
            host.hidden = !jobs.length;
            return;
        }
        host.hidden = false;
        panel.dataset.page = context.kind;
        let anchor;
        if (context.kind === 'video') {
            anchor = document.querySelector('.playerWrapper, #player');
            if (anchor && host.previousElementSibling !== anchor) anchor.after(host);
        } else if (context.kind === 'list') {
            anchor = listRoots()[0];
            if (anchor && host.nextElementSibling !== anchor) anchor.before(host);
        } else {
            anchor = document.querySelector('#modelMostRecentVideosSection, #pornstarsVideoSection, #profileContent');
            if (anchor && host.nextElementSibling !== anchor) anchor.before(host);
        }
        if (!host.isConnected) (document.querySelector('main, #content') || document.body).prepend(host);
        const isList = context.kind === 'list';
        qualityLabel.hidden = batchButton.hidden = !isList;
        homeLink.hidden = context.kind !== 'home';
        controls.hidden = context.kind === 'video';
        detailArea.hidden = context.kind !== 'video';
        heading.textContent = context.kind === 'home' ? '下载此作者的视频' : '视频下载';
        if (context.kind === 'home') {
            homeLink.href = `${location.origin}${context.base}/videos`;
            intro.textContent = '主页只展示部分视频，且没有分页。请进入视频页，再选择单个视频或下载当前页。';
        } else if (isList) {
            const videos = collectVideos();
            batchButton.disabled = !videos.length;
            intro.textContent = videos.length ?
                `当前页 ${videos.length} 个视频 · 所选画质不可用时自动降低 · 下载期间请保持此页打开` :
                '尚未识别到作者的视频列表，请等待页面加载。';
        } else {
            intro.textContent = '下载或复制时自动更新地址。地址可能绑定当前网络，并会过期。';
            if (detailKey !== context.video.key) {
                detailKey = context.video.key;
                void loadDetail(context.video);
            }
        }
        renderJobs();
    }

    function scheduleScan() {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(scanPage, 250);
    }

    scanPage();
    new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', scheduleScan);
    window.addEventListener('beforeunload', event => {
        if (!running && !jobs.some(job => job.state === 'queued')) return;
        event.preventDefault();
        event.returnValue = '';
    });
})();
