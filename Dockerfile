FROM node:22-alpine

# ssh client for Flint access (LTE failover metering + kill switch)
RUN apk add --no-cache openssh-client

WORKDIR /app

COPY package.json ./
COPY src/ ./src/

RUN mkdir -p /app/data && chown node:node /app/data

USER node

CMD ["node", "src/index.mjs"]
