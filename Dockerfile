FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html index.tsx App.tsx LanguageContext.tsx ToastContext.tsx ./
COPY tsconfig.json vite.config.ts constants.ts locales.ts types.ts ./
COPY components ./components
COPY pages ./pages
COPY services ./services
RUN npm run build

FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html/novastory
EXPOSE 80
