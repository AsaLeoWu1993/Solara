#!/bin/sh

# 设置默认API地址
DEFAULT_API_BASE_URL="/proxy"

# 设置默认内部代理地址（Nginx -> API容器）
DEFAULT_INTERNAL_API_URL="http://api:8080"

# 设置默认缓存时间 (7天，单位：天)
DEFAULT_CACHE_TTL_DAYS="7"

# 设置默认代理Token（服务端注入）
DEFAULT_PROXY_TOKEN=""

# 使用环境变量或默认值
API_BASE_URL=${SOLARA_API_BASE_URL:-$DEFAULT_API_BASE_URL}
CACHE_TTL_DAYS=${SOLARA_CACHE_TTL:-$DEFAULT_CACHE_TTL_DAYS}
INTERNAL_API_URL=${SOLARA_INTERNAL_API_URL:-$DEFAULT_INTERNAL_API_URL}
PROXY_TOKEN=${SOLARA_PROXY_TOKEN:-$DEFAULT_PROXY_TOKEN}

# 将天数转换为毫秒 (天 * 24小时 * 60分钟 * 60秒 * 1000毫秒)
CACHE_TTL_MS=$((CACHE_TTL_DAYS * 24 * 60 * 60 * 1000))

echo "配置API地址: $API_BASE_URL"
echo "配置缓存时间: $CACHE_TTL_DAYS 天 ($CACHE_TTL_MS ms)"
echo "配置内部API地址: $INTERNAL_API_URL"
if [ -n "$API_TOKEN" ]; then
	echo "已配置客户端API Token"
else
	echo "未配置客户端API Token"
fi
if [ -n "$PROXY_TOKEN" ]; then
	echo "已配置服务端代理Token"
else
	echo "未配置服务端代理Token（将导致上游鉴权失败）"
fi

escape_sed_replacement() {
	printf '%s' "$1" | sed -e 's/[|&]/\\&/g'
}

escape_js_string() {
	printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

JS_SAFE_API_BASE_URL=$(escape_js_string "$API_BASE_URL")
ESCAPED_API_BASE_URL=$(escape_sed_replacement "$JS_SAFE_API_BASE_URL")
ESCAPED_CACHE_TTL_MS=$(escape_sed_replacement "$CACHE_TTL_MS")
ESCAPED_INTERNAL_API_URL=$(escape_sed_replacement "$INTERNAL_API_URL")
ESCAPED_PROXY_TOKEN=$(escape_sed_replacement "$PROXY_TOKEN")

# 替换 index.html 中的占位符
sed -i "s|__SOLARA_API_BASE_URL__|$ESCAPED_API_BASE_URL|g" /usr/share/nginx/html/js/index.js
sed -i "s|__SOLARA_CACHE_TTL__|$ESCAPED_CACHE_TTL_MS|g" /usr/share/nginx/html/js/index.js

# 替换 Nginx 配置占位符
sed -i "s|__SOLARA_INTERNAL_API_URL__|$ESCAPED_INTERNAL_API_URL|g" /etc/nginx/conf.d/default.conf
sed -i "s|__SOLARA_PROXY_TOKEN__|$ESCAPED_PROXY_TOKEN|g" /etc/nginx/conf.d/default.conf

# 启动nginx
exec nginx -g "daemon off;"