# ⚡ ALPHA Worker — Node 22 + Playwright + Chromium
# Node 22 required: @supabase/realtime-js needs native WebSocket (Node >= 22)

FROM node:22-bookworm-slim

WORKDIR /app

# Install npm dependencies
COPY package*.json ./
RUN npm install

# Install Chromium browser + its OS dependencies
RUN npx playwright install --with-deps chromium

# Copy source
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
