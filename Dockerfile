# ==========================================
# Dockerfile para Backend (CELLVENTAS API)
# ==========================================
FROM node:20-alpine

# Definir directorio de trabajo dentro del contenedor
WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias de producción
RUN npm install --only=production

# Copiar código fuente del backend
COPY server.js db.js ./

# Crear el directorio de datos si es necesario
RUN mkdir -p /app/data

# Exponer el puerto del backend (8092 por defecto)
EXPOSE 8092

# Variables de entorno por defecto
ENV PORT=8092
ENV NODE_ENV=production

# Comando de inicio del backend
CMD ["node", "server.js"]
