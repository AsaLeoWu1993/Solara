#!/bin/sh

# 设置默认API地址
DEFAULT_API_BASE_URL="/proxy"

# 设置默认缓存时间 (7天，单位：天)
DEFAULT_CACHE_TTL_DAYS="7"

# 使用环境变量或默认值
API_BASE_URL=${SOLARA_API_BASE_URL:-$DEFAULT_API_BASE_URL}
CACHE_TTL_DAYS=${SOLARA_CACHE_TTL:-$DEFAULT_CACHE_TTL_DAYS}

# 将天数转换为毫秒 (天 * 24小时 * 60分钟 * 60秒 * 1000毫秒)
CACHE_TTL_MS=$((CACHE_TTL_DAYS * 24 * 60 * 60 * 1000))

echo "配置API地址: $API_BASE_URL"
echo "配置缓存时间: $CACHE_TTL_DAYS 天 ($CACHE_TTL_MS ms)"

# 替换 index.html 中的占位符
sed -i "s|__SOLARA_API_BASE_URL__|$API_BASE_URL|g" /usr/share/nginx/html/js/index.js
sed -i "s|__SOLARA_CACHE_TTL__|$CACHE_TTL_MS|g" /usr/share/nginx/html/js/index.js

# 启动nginx
exec nginx -g "daemon off;"