# lifeos 应用镜像 / lifeos application image.
# 纯 JS（pg + dotenv + MCP sdk + zod），无原生编译，slim 即可。
FROM node:20-slim

WORKDIR /app

# 先装依赖（利用层缓存）/ install deps first for layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# 再拷源码 / then the source.
COPY src ./src
COPY sql ./sql
COPY config ./config
COPY fixtures ./fixtures

# Obsidian 富镜像默认写到挂载卷 /vault / vault mount target.
ENV LIFEOS_OBSIDIAN_VAULT=/vault

ENTRYPOINT ["node", "src/cli.js"]
CMD ["stats"]
