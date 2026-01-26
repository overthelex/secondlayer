# Zakononline API Support Request

## Subject: Missing Access to ECHR and NPA Endpoints

### Token Information:
- Token 1: `YOUR_ZAKONONLINE_TOKEN_1`
- Token 2: `YOUR_ZAKONONLINE_TOKEN_2`

---

## Issue 1: ECHR Practice is Inaccessible

### Access Attempts:

**1.1. Endpoint /api/echr/practice (404):**
```bash
curl -H "X-App-Token: YOUR_ZAKONONLINE_TOKEN_1" \
     -H "Accept: application/json" \
     "https://court.searcher.api.zakononline.com.ua/api/echr/practice?limit=1"
```
**Result:** `{"error":"Endpoint not found: /api/echr/practice?limit=1"}` (HTTP 404)

**1.2. Domain echr.searcher.api (timeout):**
```bash
curl -H "X-App-Token: YOUR_ZAKONONLINE_TOKEN_1" \
     -H "Accept: application/json" \
     "https://echr.searcher.api.zakononline.com.ua/v1/search?limit=1"
```
**Result:** Connection timeout (HTTP 000)

**1.3. Parameter mode=echr (ignored):**
```bash
curl -H "X-App-Token: YOUR_ZAKONONLINE_TOKEN_1" \
     -H "Accept: application/json" \
     "https://court.searcher.api.zakononline.com.ua/v1/search?mode=echr&limit=1"
```
**Result:** Returns regular court decisions instead of ECHR (HTTP 200, but wrong data)

---

## Issue 2: NPA (Regulatory Acts) are Inaccessible

### Access Attempts:

**2.1. Endpoint /api/npa/search (404):**
```bash
curl -H "X-App-Token: YOUR_ZAKONONLINE_TOKEN_1" \
     -H "Accept: application/json" \
     "https://court.searcher.api.zakononline.com.ua/api/npa/search?limit=1"
```
**Result:** `{"error":"Endpoint not found: /api/npa/search?limit=1"}` (HTTP 404)

**2.2. Search with target=title (returns court decisions instead of NPA):**
```bash
curl -H "X-App-Token: YOUR_ZAKONONLINE_TOKEN_1" \
     -H "Accept: application/json" \
     "https://court.searcher.api.zakononline.com.ua/v1/search?target=title&limit=1"
```
**Result:** Returns court decisions instead of NPA (HTTP 200, but wrong data)

**2.3. NPA Search with parameters (400):**
```bash
curl -H "X-App-Token: YOUR_ZAKONONLINE_TOKEN_1" \
     -H "Accept: application/json" \
     "https://court.searcher.api.zakononline.com.ua/v1/search?target=title&mode=sph04&search=Конституція&limit=1"
```
**Result:** Bad Request (HTTP 400)

**2.4. NPA Metadata (works, but no data):**
```bash
curl -H "X-App-Token: YOUR_ZAKONONLINE_TOKEN_1" \
     -H "Accept: application/json" \
     "https://court.searcher.api.zakononline.com.ua/v1/search/meta?target=title"
```
**Result:** `{"begin":0,"pages_num":12942853,"page":0,"total":129428526}` (HTTP 200)
**Issue:** Returns only metadata, but doesn't allow retrieving actual documents

---

## Issue 3: Court Practice (deprecated endpoint)

**3.1. Endpoint /api/court/practice (404):**
```bash
curl -H "X-App-Token: YOUR_ZAKONONLINE_TOKEN_1" \
     -H "Accept: application/json" \
     "https://court.searcher.api.zakononline.com.ua/api/court/practice?limit=1"
```
**Result:** `{"error":"Endpoint not found: /api/court/practice?limit=1"}` (HTTP 404)

---

## What Works (for reference):

**Basic Court Decisions Search:**
```bash
curl -H "X-App-Token: YOUR_ZAKONONLINE_TOKEN_1" \
     -H "Accept: application/json" \
     "https://court.searcher.api.zakononline.com.ua/v1/search?target=text&mode=sph04&limit=1"
```
**Result:** HTTP 200 ✅ (works correctly)

---

## Questions for Support:

1. **ECHR:** How can we access ECHR practice? What is the correct endpoint or parameters?

2. **NPA:** How can we search regulatory acts? Why does `/api/npa/search` return 404?

3. **Do we need separate tokens** for ECHR and NPA access, or do our tokens have limited access?

4. **Documentation:** Is there up-to-date API documentation with all available endpoints and parameters?

---

## Expected Result:

Ability to search and retrieve:
- ECHR decisions
- Ukrainian regulatory acts (NPA)
- Court practice (beyond basic `/v1/search`)

Thank you for your help!
