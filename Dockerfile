FROM mcr.microsoft.com/playwright:v1.50.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci
RUN npx playwright install chromium

COPY . .

ENV NODE_ENV=production
ENV PORT=10000

EXPOSE 10000
CMD ["node", "src/server.js"]
