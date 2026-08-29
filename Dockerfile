FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY . .

RUN mkdir -p /app/data/uploads && chown -R node:node /app

USER node
EXPOSE 3000

CMD ["node", "server/index.js"]
