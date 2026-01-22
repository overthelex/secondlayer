# SecondLayer Payment Frontend - Nginx Static Server with SSL Support
FROM nginx:alpine

# Install gettext for envsubst
RUN apk add --no-cache gettext

# Copy static files
COPY index.html /usr/share/nginx/html/
COPY balance.html /usr/share/nginx/html/
COPY billing.html /usr/share/nginx/html/
COPY invoices.html /usr/share/nginx/html/
COPY profile.html /usr/share/nginx/html/
COPY usage.html /usr/share/nginx/html/
COPY css/ /usr/share/nginx/html/css/
COPY assets/ /usr/share/nginx/html/assets/

# Copy nginx configuration templates
COPY nginx.conf /etc/nginx/conf.d/nginx.conf.template
COPY nginx-ssl.conf /etc/nginx/conf.d/nginx-ssl.conf.template

# Copy entrypoint script
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Create certbot webroot directory
RUN mkdir -p /var/www/certbot

# Health check (works for both HTTP and HTTPS)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost/health || exit 1

EXPOSE 80 443

ENTRYPOINT ["/docker-entrypoint.sh"]
