FROM node:20.19.0 as builder
WORKDIR /app

COPY package.json package-lock.json ./

RUN npm install

COPY angular.json tsconfig.app.json tsconfig.json tsconfig.spec.json .postcssrc.json ./

COPY ./src ./src

RUN npm run build --configuration=production --output-path=/dist

FROM nginx:1.22
ENV API_URL=""
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY docker-entrypoint.d/00-check-certificate.sh /docker-entrypoint.d/00-check-certificate.sh
RUN chmod +x /docker-entrypoint.d/00-check-certificate.sh
COPY docker-entrypoint.d/40-reload-certificates.sh /docker-entrypoint.d/40-reload-certificates.sh
RUN chmod +x /docker-entrypoint.d/40-reload-certificates.sh
COPY --from=builder /app/dist/qabrica-ui /usr/share/nginx/html
