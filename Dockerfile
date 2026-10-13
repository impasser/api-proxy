FROM node:20-alpine

WORKDIR /app

# 先複製依賴設定檔，利用 Docker Cache 加快後續構建速度
COPY package*.json ./

# 只安裝生產依賴
RUN npm install --omit=dev

# 複製伺服器原始碼
COPY server.js ./

# 暴露服務端口 (預設 8080)
EXPOSE 8080

ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "server.js"]
