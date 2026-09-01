FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
RUN mkdir -p /app/data
EXPOSE 8092
ENV PORT=8092
ENV NODE_ENV=production
CMD ["npm", "start"]
