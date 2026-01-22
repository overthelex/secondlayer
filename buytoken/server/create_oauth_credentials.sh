#!/bin/bash

# SecondLayer OAuth2 Setup Script
# This script helps configure OAuth2 credentials

PROJECT_ID="gen-lang-client-0208700641"
REDIRECT_URI="http://localhost:3001/api/auth/google/callback"
ORIGIN_URI="http://localhost:3001"

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║  SecondLayer OAuth2 Credentials Setup                         ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "Project: $PROJECT_ID"
echo "Redirect URI: $REDIRECT_URI"
echo "Origin URI: $ORIGIN_URI"
echo ""

# Check if APIs are enabled
echo "📋 Step 1: Checking required APIs..."
if gcloud services list --enabled --filter="name:people.googleapis.com" --format="value(name)" | grep -q "people.googleapis.com"; then
  echo "   ✅ People API is enabled"
else
  echo "   ⚠️  People API not enabled. Enabling..."
  gcloud services enable people.googleapis.com
fi

if gcloud services list --enabled --filter="name:cloudidentity.googleapis.com" --format="value(name)" | grep -q "cloudidentity.googleapis.com"; then
  echo "   ✅ Cloud Identity API is enabled"
else
  echo "   ⚠️  Cloud Identity API not enabled. Enabling..."
  gcloud services enable cloudidentity.googleapis.com
fi

echo ""
echo "🌐 Step 2: Opening OAuth Consent Screen..."
echo "   Please configure:"
echo "   - User Type: External"
echo "   - App name: SecondLayer Payment System"
echo "   - Support email: shepherdvovkes@gmail.com"
echo "   - Scopes: userinfo.email, userinfo.profile, openid"
echo "   - Test users: shepherdvovkes@gmail.com"
echo ""
read -p "Press ENTER to open OAuth Consent Screen configuration..."
open "https://console.cloud.google.com/apis/credentials/consent?project=$PROJECT_ID"

echo ""
echo "⏸️  Complete the OAuth Consent Screen setup, then press ENTER to continue..."
read

echo ""
echo "🔑 Step 3: Opening Credentials page to create OAuth Client ID..."
echo "   Please create:"
echo "   - Application type: Web application"
echo "   - Name: SecondLayer Web Client"
echo "   - Authorized JavaScript origins: $ORIGIN_URI"
echo "   - Authorized redirect URIs: $REDIRECT_URI"
echo ""
read -p "Press ENTER to open Credentials page..."
open "https://console.cloud.google.com/apis/credentials?project=$PROJECT_ID"

echo ""
echo "⏸️  After creating the OAuth Client ID:"
echo "   1. Click the download button (JSON icon)"
echo "   2. Or copy the Client ID and Client Secret"
echo ""
read -p "Press ENTER when you have copied the credentials..."

echo ""
echo "📝 Step 4: Update .env file"
echo "   Please provide your OAuth credentials:"
echo ""
read -p "Client ID (xxxxx.apps.googleusercontent.com): " CLIENT_ID
read -p "Client Secret (GOCSPX-xxxxx): " CLIENT_SECRET

if [ -n "$CLIENT_ID" ] && [ -n "$CLIENT_SECRET" ]; then
  ENV_FILE="/Users/vovkes/ZOMCP/SecondLayer/buytoken/server/.env"
  
  # Backup .env
  cp "$ENV_FILE" "$ENV_FILE.backup"
  echo "   ✅ Backed up .env to .env.backup"
  
  # Update credentials
  sed -i '' "s|GOOGLE_CLIENT_ID=.*|GOOGLE_CLIENT_ID=$CLIENT_ID|" "$ENV_FILE"
  sed -i '' "s|GOOGLE_CLIENT_SECRET=.*|GOOGLE_CLIENT_SECRET=$CLIENT_SECRET|" "$ENV_FILE"
  
  echo "   ✅ Updated .env file with OAuth credentials"
  echo ""
  echo "📋 Verify credentials:"
  grep "GOOGLE_" "$ENV_FILE"
else
  echo "   ⚠️  Skipped .env update (no credentials provided)"
fi

echo ""
echo "🔄 Step 5: Restart server"
echo "   Killing existing server and restarting..."
lsof -ti :3001 | xargs kill -9 2>/dev/null
sleep 2
cd /Users/vovkes/ZOMCP/SecondLayer/buytoken/server
npm run start &

sleep 3
echo ""
echo "✅ Server restarted!"
echo ""
echo "🧪 Test OAuth2 flow:"
echo "   open \"http://localhost:3001/api/auth/google\""
echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║  ✅ OAuth2 Setup Complete!                                    ║"
echo "╚════════════════════════════════════════════════════════════════╝"

