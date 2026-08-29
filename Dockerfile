FROM node:22-alpine AS runtime

ENV NODE_ENV=production
ENV UPLOAD_DIR=/tmp/adh-uploads
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY . .

RUN mkdir -p /tmp/adh-uploads && chown -R node:node /app /tmp/adh-uploads

USER node
EXPOSE 3000

CMD ["node", "server/index.js"]
