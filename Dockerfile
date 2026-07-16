FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY src/ ./src/

RUN mkdir -p /app/data && chown node:node /app/data

USER node

CMD ["node", "src/index.mjs"]
