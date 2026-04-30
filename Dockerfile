# 使用官方的 Node.js 20 輕量級映像檔
FROM node:20-slim

# 設定工作目錄
WORKDIR /app

# 複製 backend 和 frontend 資料夾到容器中
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# 進入 backend 資料夾並安裝依賴
WORKDIR /app/backend
RUN npm install --production

# Cloud Run 會提供 PORT 環境變數（預設 8080）
ENV PORT=8080
EXPOSE 8080

# 啟動伺服器
CMD ["node", "app.js"]
