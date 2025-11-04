#!/bin/sh

# 设置默认API地址
DEFAULT_API_BASE_URL="/proxy"

# 使用环境变量或默认值
API_BASE_URL=${SOLARA_API_BASE_URL:-$DEFAULT_API_BASE_URL}

echo "配置API地址: $API_BASE_URL"

# 替换 index.html 中的占位符
sed -i "s|__SOLARA_API_BASE_URL__|$API_BASE_URL|g" /usr/share/nginx/html/js/index.js

# 启动nginx
exec nginx -g "daemon off;"