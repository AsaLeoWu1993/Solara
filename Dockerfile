# 使用轻量级nginx作为基础镜像
FROM nginx:alpine

# 设置维护者信息
LABEL maintainer="Solara Music Player"
LABEL description="现代化网页音乐播放器，整合多种音乐聚合接口"

# 设置工作目录
WORKDIR /usr/share/nginx/html

# 安装 curl（用于健康检查）
RUN apk add --no-cache curl

# 复制静态文件到nginx默认目录
COPY index.html ./ 
COPY css/ ./css/
COPY js/ ./js/
COPY favicon.png ./
COPY favicon.svg ./

# 复制自定义nginx配置
COPY nginx.conf /etc/nginx/conf.d/default.conf

# 创建必要的目录并设置权限
RUN chown -R nginx:nginx /usr/share/nginx/html && \
    chmod -R 755 /usr/share/nginx/html

# 暴露端口
EXPOSE 80

# 设置健康检查（改用 curl）
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost/ || exit 1

# 启动nginx
CMD ["nginx", "-g", "daemon off;"]