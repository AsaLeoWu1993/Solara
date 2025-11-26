const API_BASE_URLS = [
  "https://music-api.gdstudio.xyz/api.php"
];
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "accept-ranges", "content-length", "content-range", "etag", "last-modified", "expires"];
const MAX_RETRIES = 3;
const RETRY_DELAY_BASE = 1000; // 1秒基础延迟
const API_HEALTH_CHECK_TIMEOUT = 5000; // API健康检查超时时间

// API健康状态缓存
let apiHealthCache = new Map<string, { healthy: boolean; lastCheck: number; ttl: number }>();
const API_HEALTH_TTL = 60000; // 1分钟缓存有效期

// 检查API健康状态
async function checkApiHealth(apiUrl: string): Promise<boolean> {
  const cached = apiHealthCache.get(apiUrl);
  const now = Date.now();

  // 如果缓存有效，直接返回缓存结果
  if (cached && (now - cached.lastCheck) < cached.ttl) {
    return cached.healthy;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_HEALTH_CHECK_TIMEOUT);

    const testUrl = `${apiUrl}?types=search&name=test&count=1`;
    const response = await fetch(testUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      }
    });

    clearTimeout(timeoutId);

    const isHealthy = response.ok;
    // 更新缓存
    apiHealthCache.set(apiUrl, {
      healthy: isHealthy,
      lastCheck: now,
      ttl: isHealthy ? API_HEALTH_TTL : API_HEALTH_TTL / 3 // 失败时缓存时间更短
    });

    console.log(`API健康检查 ${apiUrl}: ${isHealthy ? '正常' : '异常'} (${response.status})`);
    return isHealthy;

  } catch (error: any) {
    console.warn(`API健康检查失败 ${apiUrl}:`, error.message);
    apiHealthCache.set(apiUrl, {
      healthy: false,
      lastCheck: now,
      ttl: API_HEALTH_TTL / 3
    });
    return false;
  }
}

// 获取可用的API URL
async function getHealthyApiUrl(): Promise<string> {
  // 并行检查所有API的健康状态
  const healthChecks = API_BASE_URLS.map(async (apiUrl) => {
    const isHealthy = await checkApiHealth(apiUrl);
    return { apiUrl, isHealthy };
  });

  const results = await Promise.all(healthChecks);

  // 首先返回健康的API
  const healthyApis = results.filter(result => result.isHealthy);
  if (healthyApis.length > 0) {
    console.log(`找到 ${healthyApis.length} 个健康的API:`, healthyApis.map(h => h.apiUrl));
    return healthyApis[0].apiUrl;
  }

  // 如果没有健康的API，返回第一个（尽力尝试）
  console.warn('所有API都不健康，使用第一个API进行重试');
  return API_BASE_URLS[0];
}

function createCorsHeaders(init?: Headers): Headers {
  const headers = new Headers();
  if (init) {
    for (const [key, value] of init.entries()) {
      if (SAFE_RESPONSE_HEADERS.includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    }
  }
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  headers.set("Access-Control-Allow-Origin", "*");
  return headers;
}

async function fetchWithRetry(url: string, options: RequestInit): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // 15秒超时

      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      // 5xx服务器错误才重试，4xx客户端错误不重试
      if (response.status < 500) {
        return response;
      }

      // 如果是最后一次尝试，直接返回
      if (attempt === MAX_RETRIES - 1) {
        return response;
      }

      console.warn(`API request failed with ${response.status}, retrying... (${attempt + 1}/${MAX_RETRIES})`);

    } catch (error) {
      lastError = error as Error;

      // 如果是最后一次尝试，抛出错误
      if (attempt === MAX_RETRIES - 1) {
        throw lastError;
      }

      console.warn(`API request failed, retrying... (${attempt + 1}/${MAX_RETRIES}):`, lastError.message);
    }

    // 指数退避延迟: 1s, 2s, 4s
    const delay = RETRY_DELAY_BASE * Math.pow(2, attempt);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  throw lastError || new Error('Max retries exceeded');
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function isAllowedKuwoHost(hostname: string): boolean {
  if (!hostname) return false;
  return KUWO_HOST_PATTERN.test(hostname);
}

function normalizeKuwoUrl(rawUrl: string): URL | null {
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

async function proxyKuwoAudio(targetUrl: string, request: Request): Promise<Response> {
  const normalized = normalizeKuwoUrl(targetUrl);
  if (!normalized) {
    return new Response("Invalid target", { status: 400 });
  }

  const init: RequestInit = {
    method: request.method,
    headers: {
      "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
      "Referer": "https://www.kuwo.cn/",
    },
  };

  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    (init.headers as Record<string, string>)["Range"] = rangeHeader;
  }

  try {
    const upstream = await fetchWithRetry(normalized.toString(), init);
    const headers = createCorsHeaders(upstream.headers);
    if (!headers.has("Cache-Control")) {
      headers.set("Cache-Control", "public, max-age=3600");
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (error) {
    console.error("Kuwo audio proxy failed:", error);
    return new Response("Audio proxy failed", { status: 502 });
  }
}

async function proxyApiRequest(url: URL, request: Request): Promise<Response> {
  if (!url.searchParams.has("types")) {
    return new Response("Missing types", { status: 400 });
  }

  // 尝试每个API源，直到找到可用的
  const apiUrls = await Promise.all(
    API_BASE_URLS.map(async (baseUrl) => {
      const apiUrl = new URL(baseUrl);
      url.searchParams.forEach((value, key) => {
        if (key === "target" || key === "callback") {
          return;
        }
        apiUrl.searchParams.set(key, value);
      });
      return { url: apiUrl.toString(), baseUrl, healthy: await checkApiHealth(baseUrl) };
    })
  );

  // 优先使用健康的API
  apiUrls.sort((a, b) => (b.healthy ? 1 : 0) - (a.healthy ? 1 : 0));

  let lastError: Error | null = null;

  for (const { url: apiUrl, baseUrl, healthy } of apiUrls) {
    try {
      console.log(`尝试使用API: ${baseUrl} (健康状态: ${healthy ? '正常' : '异常'})`);

      const upstream = await fetchWithRetry(apiUrl, {
        headers: {
          "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
          "Accept": "application/json",
        },
      });

      // 如果请求成功，更新API健康状态
      if (upstream.ok) {
        apiHealthCache.set(baseUrl, {
          healthy: true,
          lastCheck: Date.now(),
          ttl: API_HEALTH_TTL
        });
        console.log(`API请求成功: ${baseUrl}`);

        const headers = createCorsHeaders(upstream.headers);
        if (!headers.has("Content-Type")) {
          headers.set("Content-Type", "application/json; charset=utf-8");
        }

        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers,
        });
      } else {
        // API返回错误状态，标记为不健康
        apiHealthCache.set(baseUrl, {
          healthy: false,
          lastCheck: Date.now(),
          ttl: API_HEALTH_TTL / 3
        });
        console.warn(`API返回错误状态 ${upstream.status}: ${baseUrl}`);

        // 如果是最后一个API，也返回响应
        if (apiUrls.indexOf({ url: apiUrl, baseUrl, healthy } as any) === apiUrls.length - 1) {
          const headers = createCorsHeaders(upstream.headers);
          if (!headers.has("Content-Type")) {
            headers.set("Content-Type", "application/json; charset=utf-8");
          }
          return new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers,
          });
        }
      }

    } catch (error: any) {
      lastError = error;
      console.warn(`API请求失败 ${baseUrl}:`, error.message);

      // 标记为不健康
      apiHealthCache.set(baseUrl, {
        healthy: false,
        lastCheck: Date.now(),
        ttl: API_HEALTH_TTL / 3
      });

      // 如果不是最后一个API，继续尝试下一个
      if (apiUrls.findIndex(item => item.baseUrl === baseUrl) < apiUrls.length - 1) {
        continue;
      }
    }
  }

  // 所有API都失败了
  console.error("所有API源都无法访问:", lastError?.message);
  return new Response(
    JSON.stringify({
      error: "All API sources are unavailable",
      message: "音乐服务暂时不可用，请稍后再试",
      details: lastError?.message
    }),
    {
      status: 503,
      headers: { "Content-Type": "application/json" }
    }
  );
}

export async function onRequest({ request }: { request: Request }): Promise<Response> {
  if (request.method === "OPTIONS") {
    return handleOptions();
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("target");

  if (target) {
    return proxyKuwoAudio(target, request);
  }

  return proxyApiRequest(url, request);
}
