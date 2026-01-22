#!/bin/bash

# SecondLayer Payment System - Database Migration Script
# Run this after first deployment or when schema changes

set -e

echo "🗄️  Running database migrations..."

# Run migrations inside the payment-server container
docker-compose exec payment-server npm run migrate

echo "✅ Database migrations complete!"
