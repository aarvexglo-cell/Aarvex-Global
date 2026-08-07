# lightweight Node.js Dockerfile for claude-curator
FROM node:18-alpine
WORKDIR /usr/src/app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=4000
EXPOSE 4000
CMD ["node", "src/index.js"]
