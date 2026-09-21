# ⚡ ALPHA Worker — Playwright + Node on Railway
# Uses Microsoft's official Playwright image (all browser deps pre-installed)
FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy source
COPY . .

# Railway injects PORT env var
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
