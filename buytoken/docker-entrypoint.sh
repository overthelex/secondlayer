#!/bin/sh
set -e

# Substitute environment variables in nginx config
# This allows us to use ${DOMAIN_NAME} in the nginx configuration

if [ -n "$DOMAIN_NAME" ]; then
    echo "Configuring nginx for domain: $DOMAIN_NAME"

    # Use SSL configuration if certificates exist
    if [ -f "/etc/letsencrypt/live/$DOMAIN_NAME/fullchain.pem" ]; then
        echo "SSL certificates found - using HTTPS configuration"
        envsubst '${DOMAIN_NAME}' < /etc/nginx/conf.d/nginx-ssl.conf.template > /etc/nginx/conf.d/default.conf
    else
        echo "No SSL certificates found - using HTTP-only configuration"
        cat > /etc/nginx/conf.d/default.conf <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name _;

    # Allow certbot ACME challenges
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://payment-server:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    location /health {
        access_log off;
        return 200 "healthy\n";
        add_header Content-Type text/plain;
    }
}
EOF
    fi
else
    echo "DOMAIN_NAME not set - using default HTTP configuration"
    cp /etc/nginx/conf.d/nginx.conf.template /etc/nginx/conf.d/default.conf
fi

# Test nginx configuration
nginx -t

# Start nginx
exec nginx -g 'daemon off;'
