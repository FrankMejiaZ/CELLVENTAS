FROM node:20-alpine

# Actualizar paquetes del sistema Alpine para resolver vulnerabilidades del SO base
RUN apk update && apk upgrade --no-cache

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
RUN mkdir -p /app/data
EXPOSE 8092
ENV PORT=8092
ENV NODE_ENV=production
CMD ["npm", "start"]
