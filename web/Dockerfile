# Stage 1: Build React application
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files for layer caching
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci --ignore-scripts

# Copy source files
COPY . ./

# Build the application
RUN npm run build

# Stage 2: Production nginx server
FROM nginx:1.29-alpine

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy custom nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built assets from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost/health || exit 1

CMD ["nginx", "-g", "daemon off;"]
