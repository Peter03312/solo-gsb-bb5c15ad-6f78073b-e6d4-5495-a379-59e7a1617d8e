# 彩绘玻璃拼片台 —— 单容器镜像
FROM node:20-alpine

# better-sqlite3 需要本地编译工具链
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && mkdir -p /home/node/app/data && chown -R node:node /home/node/app

WORKDIR /home/node/app

COPY --chown=node:node package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

USER node

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/home/node/app/data/glass.db

EXPOSE 3000
VOLUME ["/home/node/app/data"]

# 应用启动时自动建表，数据库文件不存在即初始化
CMD ["node", "src/server.js"]
