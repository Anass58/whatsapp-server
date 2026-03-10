FROM node:20-slim

# Install ffmpeg and libwebp for media processing (video/audio/stickers)
RUN apt-get update && \
    apt-get install -y ffmpeg libwebp-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
