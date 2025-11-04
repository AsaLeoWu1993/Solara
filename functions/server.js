const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = 8080;
const API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";

// 重试配置
const RETRY_CONFIG = {
    maxRetries: parseInt(process.env.API_MAX_RETRIES) || 3,
    retryDelay: parseInt(process.env.API_RETRY_DELAY) || 1000,
    audioMaxRetries: parseInt(process.env.AUDIO_MAX_RETRIES) || 2,
    audioRetryDelay: parseInt(process.env.AUDIO_RETRY_DELAY) || 500
};

// 中间件
app.use(cors());
app.use(express.json());

// 允许的Kuwo域名
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;

function isAllowedKuwoHost(hostname) {
    if (!hostname) return false;
    return KUWO_HOST_PATTERN.test(hostname);
}

function normalizeKuwoUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        if (!isAllowedKuwoHost(parsed.hostname)) {
            return null;
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return null;
        }
        parsed.protocol = "http:";
        return parsed;
    } catch {
        return null;
    }
}

// 带重试机制的fetch函数
async function fetchWithRetry(url, options = {}, maxRetries = 3, retryDelay = 1000) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`API请求尝试 ${attempt}/${maxRetries}: ${url}`);

            const response = await fetch(url, options);

            // 检查是否是服务器错误状态码（5xx）
            if (response.status >= 500) {
                const errorText = await response.text();
                console.warn(`API返回错误 ${response.status} (尝试 ${attempt}/${maxRetries}): ${errorText}`);

                if (attempt < maxRetries) {
                    // 指数退避策略
                    const delay = retryDelay * Math.pow(2, attempt - 1);
                    console.log(`等待 ${delay}ms 后重试...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
            }

            // 成功或客户端错误（4xx）直接返回
            console.log(`API请求成功，状态码: ${response.status}`);
            return response;

        } catch (error) {
            lastError = error;
            console.error(`API请求失败 (尝试 ${attempt}/${maxRetries}):`, error.message);

            if (attempt < maxRetries) {
                // 网络错误也使用指数退避
                const delay = retryDelay * Math.pow(2, attempt - 1);
                console.log(`网络错误，等待 ${delay}ms 后重试...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    // 所有重试都失败了
    throw lastError;
}

// 创建CORS头部
function createCorsHeaders(upstreamHeaders) {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
    };

    // 安全的响应头部
    const safeHeaders = [
        'content-type', 'cache-control', 'accept-ranges',
        'content-length', 'content-range', 'etag',
        'last-modified', 'expires'
    ];

    if (upstreamHeaders) {
        for (const [key, value] of Object.entries(upstreamHeaders)) {
            if (safeHeaders.includes(key.toLowerCase())) {
                headers[key] = value;
            }
        }
    }

    return headers;
}

// 处理Kuwo音频代理
async function proxyKuwoAudio(targetUrl, req, res) {
    const url = normalizeKuwoUrl(targetUrl);
    if (!url) {
        return res.status(400).send('Invalid Kuwo URL');
    }

    try {
        const response = await fetchWithRetry(url.toString(), {
            headers: {
                'User-Agent': req.get('User-Agent') || 'Mozilla/5.0',
                'Accept': req.get('Accept') || '*/*',
                'Range': req.get('Range') || ''
            }
        }, RETRY_CONFIG.audioMaxRetries, RETRY_CONFIG.audioRetryDelay);

        if (!response.ok) {
            return res.status(response.status).send('Failed to fetch audio');
        }

        const headers = createCorsHeaders(Object.fromEntries(response.headers.entries()));
        if (!headers['Content-Type']) {
            headers['Content-Type'] = 'audio/mpeg';
        }
        if (req.get('Range')) {
            headers['Accept-Ranges'] = 'bytes';
            headers['Content-Range'] = response.headers.get('Content-Range') || '';
        }

        // 设置响应头
        Object.entries(headers).forEach(([key, value]) => {
            res.set(key, value);
        });

        res.status(response.status);
        response.body.pipe(res);
    } catch (error) {
        console.error('Kuwo proxy error:', error);
        res.status(500).send('Proxy error');
    }
}

// 主要的API代理功能
async function proxyApiRequest(req, res) {
    const apiUrl = new URL(API_BASE_URL);

    // 复制查询参数
    Object.keys(req.query).forEach(key => {
        if (key !== 'target' && key !== 'callback') {
            apiUrl.searchParams.set(key, req.query[key]);
        }
    });

    if (!apiUrl.searchParams.has('types')) {
        return res.status(400).send('Missing types');
    }

    // 根据请求类型设置合适的Accept头
    const types = req.query.types || '';
    let acceptHeader = 'application/json';

    if (types === 'pic') {
        acceptHeader = 'image/*,*/*;q=0.8';
    } else if (types === 'url') {
        acceptHeader = 'audio/*,application/json,*/*;q=0.8';
    }

    try {
        const response = await fetchWithRetry(apiUrl.toString(), {
            headers: {
                'User-Agent': req.get('User-Agent') || 'Mozilla/5.0',
                'Accept': acceptHeader
            }
        }, RETRY_CONFIG.maxRetries, RETRY_CONFIG.retryDelay);

        const headers = createCorsHeaders(Object.fromEntries(response.headers.entries()));

        // 只有当响应没有Content-Type时才设置默认值
        if (!headers['Content-Type']) {
            if (types === 'pic') {
                headers['Content-Type'] = 'image/jpeg';
            } else {
                headers['Content-Type'] = 'application/json; charset=utf-8';
            }
        }

        // 设置响应头
        Object.entries(headers).forEach(([key, value]) => {
            res.set(key, value);
        });

        res.status(response.status);
        response.body.pipe(res);
    } catch (error) {
        console.error('API proxy error:', error);
        res.status(500).send('Proxy error');
    }
}

// 健康检查路由（必须在通配符路由之前）
app.get('/health', (req, res) => {
    try {
        res.status(200).json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            port: PORT
        });
    } catch (error) {
        console.error('Health check error:', error);
        res.status(500).json({ status: 'error', message: 'Health check failed' });
    }
});

// 处理所有GET请求
app.get('*', async (req, res) => {
    const target = req.query.target;

    if (target) {
        return proxyKuwoAudio(target, req, res);
    }

    return proxyApiRequest(req, res);
});

// 处理OPTIONS请求
app.options('*', (req, res) => {
    res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400'
    });
    res.status(204).send();
});

// 添加错误处理
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Solara API Proxy running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Proxy endpoint: http://localhost:${PORT}/`);
    console.log('Server started successfully!');
});

server.on('error', (error) => {
    console.error('Server error:', error);
    process.exit(1);
});