FROM node:20-alpine

# 安装 curl（用于健康检查）
RUN apk add --no-cache curl

WORKDIR /app

# 复制 package.json 和 package-lock.json（如果存在）
COPY package.json* ./

# 安装依赖（根据 package.json 中的完整依赖列表）
RUN npm install && npm cache clean --force

# 复制源代码
COPY server.js ./

# 暴露端口
EXPOSE 8080

# 设置健康检查（检查 /health 端点）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8080/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

# 启动API服务
CMD ["node", "server.js"]