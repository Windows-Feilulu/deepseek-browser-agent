# syntax=docker/dockerfile:1.4
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y \
    libnss3 libatk-bridge2.0-0 libdrm-dev libxkbcommon-dev libgbm-dev \
    libasound-dev libxshmfence-dev libxrandr-dev libxcomposite-dev \
    libxdamage-dev libxfixes-dev libx11-xcb-dev libxtst-dev libpango-1.0-0 \
    libcairo2 libglib2.0-0 libgtk-3-0 libxslt1.1 libxss1 libxcb1 libxcb-shm0 \
    libxcb-shape0 libxcb-xfixes0 libxcb-randr0 libxcb-util1 libxcb-keysyms1 \
    libxcb-icccm4 libxcb-render0 libxcb-render-util0 libxcb-xkb1 libxcb-xv0 \
    libxcb-glx0 libxcb-present0 libxcb-dri3-0 libxcb-sync1 libxshmfence1 \
    libgl1-mesa-glx libgl1-mesa-dri libgles2-mesa libegl1-mesa libva2 \
    libvdpau1 libexpat1 libfontconfig1 libfreetype6 libjpeg62-turbo \
    libpng16-16 libwebp7 libavif15 libopus0 libvpx7 libevent-2.1-7 libffi8 \
    libgssapi-krb5-2 libicu72 libssl3 libcurl4 libarchive13 libbz2-1.0 \
    liblzma5 libsqlite3-0 libudev1 libxkbcommon-x11-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1. 先复制 package 文件（变化频率低）
COPY package*.json ./

# 2. 安装 Node 依赖，但跳过 postinstall（因为此时 src/ 还不存在）
RUN npm install --ignore-scripts

# 3. 安装 Playwright 浏览器，使用缓存挂载（关键！）
RUN --mount=type=cache,target=/root/.cache/ms-playwright \
    npx playwright install chromium

# 4. 复制全部源代码（包括 src/）
COPY . .

# 5. 手动执行 postinstall（如果存在）
RUN if [ -f src/postinstall.js ]; then node src/postinstall.js; fi

# 6. 准备数据目录
RUN mkdir -p /root/.deepseek-agent/session

VOLUME ["/root/.deepseek-agent"]
ENTRYPOINT ["node", "src/index.js"]