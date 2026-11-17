# The world server, for any host that runs containers. The client is a static page and is not in this image.
#   docker build -t calder-territory . && docker run -p 8080:8080 calder-territory
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY shared ./shared
COPY server ./server
USER node
EXPOSE 8080
CMD ["node", "server/src/node/main.js"]
