# Simple Dockerfile for the infinite-monkeys app
FROM node:20-alpine

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm ci --production

# Copy app sources
COPY . .

# Ensure data directories exist
RUN mkdir -p data/archive

EXPOSE 3000
ENV PORT=3000

CMD [ "node", "server.js" ]
