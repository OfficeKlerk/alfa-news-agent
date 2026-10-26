FROM node:24.13.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY server/ server/
RUN npm run build && npm prune --omit=dev
COPY frontend/ frontend/
COPY data/ data/
ENV HOST=0.0.0.0 PORT=8000
RUN mkdir -p /app/var && chown node:node /app/var
USER node
EXPOSE 8000
CMD ["node", "dist/index.js"]
