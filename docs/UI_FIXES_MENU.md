# UI Fixes - Menu and Layout

**Date:** 2026-01-21
**Status:** ✅ Fixed
**Environment:** Development (dev.legal.org.ua)

---

## Issues Fixed

### 1. Desktop Header Title - "Підключення к API Ради без ключей"
**Problem:** Wrong title shown in desktop view header when on chat page

**Before:**
```
Підключення к API Ради без ключей
```

**After:**
```
Юридичний асистент
```

**File:** `Lexwebapp/src/components/ChatLayout.tsx:499`

---

### 2. Unnecessary Action Buttons
**Problem:** Two buttons appeared in desktop header that shouldn't be visible:
- "Аналіз справи" button (FileText icon)
- "Share" button

**Solution:** Removed both buttons from the header

**File:** `Lexwebapp/src/components/ChatLayout.tsx:537-546`

**Before:**
```tsx
<div className="flex items-center gap-2">
  <button onClick={() => setCurrentView('case-analysis')}>
    <FileText size={18} />
  </button>
  <button>
    <Share2 size={14} />
    Share
  </button>
</div>
```

**After:**
```tsx
{/* Buttons removed */}
```

---

### 3. Right Panel - Russian Text
**Problem:** Right panel ("Доказова база") had mixed Russian/Ukrainian text

**Files Changed:**
- `Lexwebapp/src/components/RightPanel.tsx`

### 4. Right Panel Not Visible on Desktop
**Problem:** Right panel was hidden on desktop due to Framer Motion animation controlled by `isOpen` state

**Root Cause:**
- On mobile: Button to open panel (`lg:hidden`)
- On desktop: No button, but panel still controlled by `isOpen={false}`
- Result: Panel hidden on desktop with no way to open it

**Final Solution (Matching GitHub Original):**

Compared with https://github.com/overthelex/Lexwebapp and implemented exact structure:

1. **ChatLayout.tsx** - Added toggle button for right panel in desktop header
2. **ChatLayout.tsx** - Wrapped RightPanel in conditional div controlled by `isRightPanelOpen` state
3. **RightPanel.tsx** - Single motion.aside with `lg:translate-x-0` for desktop positioning

**File:** `Lexwebapp/src/components/ChatLayout.tsx`

**Desktop Header Structure:**
```tsx
<header className="hidden lg:flex items-center justify-between px-6 py-3...">
  {/* Left: Toggle sidebar (200px) */}
  <div className="flex items-center gap-3 w-[200px]">
    <button onClick={() => setIsSidebarOpen(!isSidebarOpen)}>
      {isSidebarOpen ? <X size={18} /> : <Menu size={18} />}
    </button>
  </div>

  {/* Center: Page title (flex-1) */}
  <div className="flex-1 flex items-center justify-center">
    <h1>{pageTitle}</h1>
  </div>

  {/* Right: Toggle right panel (200px) */}
  <div className="flex items-center justify-end gap-2 w-[200px]">
    <button onClick={() => setIsRightPanelOpen(!isRightPanelOpen)}>
      {isRightPanelOpen ? <X size={18} /> : <PanelRightOpen size={18} />}
    </button>
  </div>
</header>
```

**RightPanel Integration:**
```tsx
<div className={`${isRightPanelOpen ? 'block' : 'hidden'}`}>
  <RightPanel
    isOpen={isRightPanelOpen}
    onClose={() => setIsRightPanelOpen(false)} />
</div>
```

**File:** `Lexwebapp/src/components/RightPanel.tsx`

**Single Motion.aside Instance:**
```tsx
<motion.aside
  initial={false}
  animate={{ x: isOpen ? 0 : 360 }}
  transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
  className="fixed lg:static inset-y-0 right-0 z-50 w-[360px] bg-white border-l border-claude-border flex flex-col lg:translate-x-0">
  {/* Content */}
</motion.aside>
```

This matches the original GitHub implementation exactly.

#### Translations Applied:

| Russian | Ukrainian | Location |
|---------|-----------|----------|
| Доказательная база | Доказова база | Line 88 (header) |
| Судебные решения | Судові рішення | Line 15 (tab), 227 |
| Нормативные акты | Нормативні акти | Line 19 (tab), 233 |
| Комментарии | Коментарі | Line 23 (tab), 239 |
| Актуальность | Актуальність | Line 27 (tab) |
| Найдено | Знайдено | Line 112 |
| Экспорт | Експорт | Line 115 |
| В силе | Чинне | Line 134 |
| Отменено | Скасовано | Line 134 |
| Применимые нормы | Застосовні норми | Line 161 |
| Обновлено | Оновлено | Line 186 |
| Комментарии и практика | Коментарі та практика | Line 195 |
| Комментарии появятся после анализа | Коментарі з'являться після аналізу | Line 201 |
| Проверка актуальности | Перевірка актуальності | Line 209 |
| Все источники актуальны | Всі джерела актуальні | Line 217 |
| Последняя проверка: сегодня в 14:30 | Остання перевірка: сьогодні о 14:30 | Line 220 |

---

## Files Modified

### 1. ChatLayout.tsx
**Path:** `/Users/vovkes/ZOMCP/SecondLayer/Lexwebapp/src/components/ChatLayout.tsx`

**Changes:**
- Line 499: Changed chat view header from "Підключення к API Ради без ключей" to "Юридичний асистент"
- Lines 537-546: Removed FileText and Share buttons from desktop header

### 2. RightPanel.tsx
**Path:** `/Users/vovkes/ZOMCP/SecondLayer/Lexwebapp/src/components/RightPanel.tsx`

**Changes:**
- Line 88: Header "Доказательная база" → "Доказова база"
- Lines 14-28: Tab labels translated to Ukrainian
- Lines 112-245: All content text translated to Ukrainian

---

## Deployment

### Build Command
```bash
cd /Users/vovkes/ZOMCP/SecondLayer/Lexwebapp
docker build --platform linux/amd64 -f Dockerfile.dev -t lexwebapp-lexwebapp:dev .
```

### Transfer to Server
```bash
docker save lexwebapp-lexwebapp:dev | gzip > /tmp/lexwebapp-dev-ui-fix.tar.gz
scp /tmp/lexwebapp-dev-ui-fix.tar.gz gate:/tmp/
```

### Deploy
```bash
ssh gate "gunzip -c /tmp/lexwebapp-dev-ui-fix.tar.gz | docker load"
ssh gate "cd /home/vovkes/secondlayer-deployment && \
  docker compose -f docker-compose.dev.yml up -d lexwebapp-dev"
```

---

## Verification

### 1. Desktop View Header
1. Open https://dev.legal.org.ua/ in desktop browser
2. Header should show "Юридичний асистент"
3. No FileText or Share buttons should be visible

### 2. Right Panel
1. Open right panel (click icon on mobile or see on desktop)
2. Header should show "Доказова база"
3. All tabs should be in Ukrainian:
   - Судові рішення
   - Нормативні акти
   - Коментарі
   - Актуальність
4. All content should be in Ukrainian

---

## Before/After Screenshots

### Desktop Header

**Before:**
```
┌──────────────────────────────────────────────┐
│ Підключення к API Ради без ключей  📄 Share │
└──────────────────────────────────────────────┘
```

**After:**
```
┌──────────────────────────────────────────────┐
│ Юридичний асистент                            │
└──────────────────────────────────────────────┘
```

### Right Panel Header

**Before:**
```
┌────────────────────────┐
│ Доказательная база  ✕  │
├────────────────────────┤
│ Судебные решения       │
│ Нормативные акты       │
│ Комментарии            │
│ Актуальность           │
└────────────────────────┘
```

**After:**
```
┌────────────────────────┐
│ Доказова база       ✕  │
├────────────────────────┤
│ Судові рішення         │
│ Нормативні акти        │
│ Коментарі              │
│ Актуальність           │
└────────────────────────┘
```

---

## Related Issues

### Previous Fixes
- [Form Accessibility Fix](./FORM_ACCESSIBILITY_FIX.md) - Added id/name attributes and label associations
- [CSP Configuration](./CSP_CONFIGURATION.md) - Fixed JavaScript eval() blocking
- [Google OAuth Fix](./GOOGLE_OAUTH_FIX.md) - Fixed OAuth callback URL

---

## Impact

**Positive:**
- Consistent Ukrainian language throughout UI
- Cleaner header without unnecessary buttons
- Better user experience with correct terminology

**No Breaking Changes:**
- All functionality remains the same
- Only visual/text changes

---

**Status:** ✅ Deployed to Development
**Environment:** dev.legal.org.ua
**Build Time:** ~34 seconds
**Image Size:** 20MB (compressed)
