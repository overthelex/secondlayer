# EULA Deployment - Quick Start

## 🚀 Quick Deployment Commands

### Test Locally (Recommended First Step)

```bash
cd /Users/vovkes/ZOMCP/SecondLayer
./deploy-local.sh
```

Then test at http://localhost:5173

---

### Deploy to Production

```bash
cd /Users/vovkes/ZOMCP/SecondLayer

# Set environment variables (adjust as needed)
export DEPLOY_USER=ubuntu
export DEPLOY_HOST=gate-server
export DEPLOY_PORT=22

# Run deployment
./deploy-eula-update.sh
```

---

## 🎯 What Gets Deployed

### Backend
- ✅ New EULA service and routes
- ✅ Database migration (007_add_eula_acceptance.sql)
- ✅ EULA document loader
- ✅ Acceptance tracking

### Frontend
- ✅ EULA modal component
- ✅ Help & Documentation page
- ✅ EULA context provider
- ✅ Markdown renderer (react-markdown)

---

## ✅ Post-Deployment Checklist

```bash
# Test backend health
curl http://your-server:3000/health

# Test EULA endpoint
curl http://your-server:3000/api/eula

# Test EULA documents
curl http://your-server:3000/api/eula/documents
```

**Then in browser:**
1. Login as new user
2. EULA modal should appear
3. Accept EULA
4. Check "Help & Documentation" menu
5. Verify all documents load

---

## 🔧 Manual Steps (if needed)

### Backend Only
```bash
cd mcp_backend
npm install
npm run build
npm run migrate
pm2 restart secondlayer-http
```

### Frontend Only
```bash
cd frontend
npm install
npm run build
# Copy dist/ to web server
```

---

## 🐛 Quick Troubleshooting

| Issue | Solution |
|-------|----------|
| EULA modal doesn't show | Check backend logs: `pm2 logs secondlayer-http` |
| "Failed to load EULA" | Verify `EULA_manual_license.txt` exists on server |
| 401 on accept endpoint | User needs to be logged in (JWT required) |
| Migration fails | Run `npm run db:setup` or check PostgreSQL connection |
| Build fails | Install dependencies: `npm install` |

---

## 📁 Files Changed

### Backend
```
mcp_backend/
├── src/
│   ├── migrations/007_add_eula_acceptance.sql
│   ├── services/eula-service.ts
│   ├── routes/eula.ts
│   └── http-server.ts (updated)
```

### Frontend
```
frontend/
├── src/
│   ├── components/EULAModal.tsx
│   ├── contexts/EULAContext.tsx
│   ├── pages/help/index.tsx
│   └── App.tsx (updated)
└── package.json (added react-markdown)
```

---

## 🔗 Deployment Scripts

| Script | Purpose |
|--------|---------|
| `./deploy-local.sh` | Test locally before production |
| `./deploy-eula-update.sh` | Full production deployment |

---

## 📚 Full Documentation

For detailed information, see:
- `EULA_DEPLOYMENT.md` - Complete deployment guide
- `mcp_backend/DEPLOYMENT.md` - Backend deployment details

---

## 🎉 Success!

After deployment:
- Users see EULA modal on first login ✓
- Acceptance is tracked in database ✓
- Help page accessible from menu ✓
- All documents available in Ukrainian ✓
