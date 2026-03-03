#!/bin/sh

# 设置默认API地址
DEFAULT_API_BASE_URL="/proxy"

# 当 API_BASE_URL 为相对路径时，Nginx 使用该默认上游拼接
DEFAULT_PROXY_UPSTREAM_BASE="http://api:8080"

# 设置默认缓存时间 (7天，单位：天)
DEFAULT_CACHE_TTL_DAYS="7"

# 设置默认代理Token（服务端注入）
DEFAULT_PROXY_TOKEN=""

# 设置默认客户端Token（仅在前端直连外部API时需要）
DEFAULT_CLIENT_API_TOKEN=""

# 使用环境变量或默认值
API_BASE_URL=${SOLARA_API_BASE_URL:-$DEFAULT_API_BASE_URL}
CACHE_TTL_DAYS=${SOLARA_CACHE_TTL:-$DEFAULT_CACHE_TTL_DAYS}
PROXY_TOKEN=${SOLARA_PROXY_TOKEN:-$DEFAULT_PROXY_TOKEN}
CLIENT_API_TOKEN=${SOLARA_API_TOKEN:-$DEFAULT_CLIENT_API_TOKEN}

extract_url_host() {
	printf '%s' "$1" | sed -e 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##' -e 's#/.*$##' -e 's#:[0-9][0-9]*$##'
}

is_internal_host() {
	host=$(extract_url_host "$1")
	case "$host" in
		"" ) return 0 ;;
		localhost|127.*|0.0.0.0|::1|host.docker.internal) return 0 ;;
		*.*) return 1 ;;
		*) return 0 ;;
	esac
}

case "$API_BASE_URL" in
	http://*|https://*)
		NGINX_PROXY_PASS="$API_BASE_URL"
		if is_internal_host "$API_BASE_URL"; then
			CLIENT_API_BASE_URL="/proxy"
		else
			CLIENT_API_BASE_URL="$API_BASE_URL"
		fi
		;;
	/*)
		NGINX_PROXY_PASS="${DEFAULT_PROXY_UPSTREAM_BASE}${API_BASE_URL}"
		CLIENT_API_BASE_URL="$API_BASE_URL"
		;;
	*)
		NGINX_PROXY_PASS="$API_BASE_URL"
		CLIENT_API_BASE_URL="$API_BASE_URL"
		;;
esac

# 外部地址直连时，如未单独提供客户端Token，则回退使用服务端代理Token
if [ "$CLIENT_API_BASE_URL" != "/proxy" ] && [ -z "$CLIENT_API_TOKEN" ] && [ -n "$PROXY_TOKEN" ]; then
	CLIENT_API_TOKEN="$PROXY_TOKEN"
fi

# 将天数转换为毫秒 (天 * 24小时 * 60分钟 * 60秒 * 1000毫秒)
CACHE_TTL_MS=$((CACHE_TTL_DAYS * 24 * 60 * 60 * 1000))

echo "配置API地址: $API_BASE_URL"
echo "前端API地址: $CLIENT_API_BASE_URL"
echo "Nginx代理上游: $NGINX_PROXY_PASS"
echo "配置缓存时间: $CACHE_TTL_DAYS 天 ($CACHE_TTL_MS ms)"
if [ -n "$CLIENT_API_TOKEN" ]; then
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

JS_SAFE_API_BASE_URL=$(escape_js_string "$CLIENT_API_BASE_URL")
ESCAPED_API_BASE_URL=$(escape_sed_replacement "$JS_SAFE_API_BASE_URL")
ESCAPED_NGINX_PROXY_PASS=$(escape_sed_replacement "$NGINX_PROXY_PASS")
ESCAPED_CACHE_TTL_MS=$(escape_sed_replacement "$CACHE_TTL_MS")
ESCAPED_PROXY_TOKEN=$(escape_sed_replacement "$PROXY_TOKEN")
ESCAPED_CLIENT_API_TOKEN=$(escape_sed_replacement "$CLIENT_API_TOKEN")

# 替换前端脚本中的占位符
sed -i "s|__SOLARA_API_BASE_URL__|$ESCAPED_API_BASE_URL|g" /usr/share/nginx/html/js/index.js
sed -i "s|__SOLARA_CACHE_TTL__|$ESCAPED_CACHE_TTL_MS|g" /usr/share/nginx/html/js/index.js
sed -i "s|__SOLARA_BUILD_API_TOKEN__|$ESCAPED_CLIENT_API_TOKEN|g" /usr/share/nginx/html/js/index.js

# 替换 Nginx 配置占位符
sed -i "s|__SOLARA_API_BASE_URL__|$ESCAPED_NGINX_PROXY_PASS|g" /etc/nginx/conf.d/default.conf
sed -i "s|__SOLARA_PROXY_TOKEN__|$ESCAPED_PROXY_TOKEN|g" /etc/nginx/conf.d/default.conf

# 启动nginx
exec nginx -g "daemon off;"