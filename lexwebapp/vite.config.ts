import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { marked } from 'marked'

/**
 * Vite plugin that regenerates sitemap.xml at build time
 * by extracting article IDs/dates from articles.ts via regex.
 */
function sitemapPlugin(): Plugin {
  return {
    name: 'generate-sitemap',
    buildStart() {
      try {
        // Dynamic import won't work here for .ts, so we inline the minimal logic
        const root = path.resolve(__dirname)
        const articlesPath = path.resolve(root, 'src/pages/BlogPage/articles.ts')
        const src = fs.readFileSync(articlesPath, 'utf-8')

        const BASE_URL = 'https://legal.org.ua'

        // Extract article ids and dates
        const ids: string[] = []
        const dates: string[] = []
        let m: RegExpExecArray | null
        const idRe = /id:\s*'([^']+)'/g
        const dateRe = /publishedAt:\s*'([^']+)'/g
        while ((m = idRe.exec(src)) !== null) ids.push(m[1])
        while ((m = dateRe.exec(src)) !== null) dates.push(m[1])
        const count = Math.min(ids.length, dates.length)

        interface Entry { loc: string; changefreq: string; priority: string; lastmod?: string }

        const staticPages: Entry[] = [
          { loc: '/', changefreq: 'daily', priority: '1.0' },
          { loc: '/product', changefreq: 'weekly', priority: '0.95' },
          { loc: '/about', changefreq: 'monthly', priority: '0.85' },
          { loc: '/about/team', changefreq: 'monthly', priority: '0.8' },
          { loc: '/blog', changefreq: 'weekly', priority: '0.9' },
          { loc: '/lex-news', changefreq: 'weekly', priority: '0.7' },
          { loc: '/investor', changefreq: 'monthly', priority: '0.6' },
          { loc: '/uk_investor', changefreq: 'monthly', priority: '0.6' },
          { loc: '/uk_investor_simplified', changefreq: 'monthly', priority: '0.6' },
          { loc: '/pitch-deck.html', changefreq: 'monthly', priority: '0.6' },
          { loc: '/developer/docs', changefreq: 'weekly', priority: '0.9' },
        ]

        const blogArticles: Entry[] = []
        for (let i = 0; i < count; i++) {
          blogArticles.push({ loc: `/blog/${ids[i]}`, changefreq: 'monthly', priority: '0.8', lastmod: dates[i] })
          blogArticles.push({ loc: `/blog/uk/${ids[i]}`, changefreq: 'monthly', priority: '0.7', lastmod: dates[i] })
          blogArticles.push({ loc: `/blog/ru/${ids[i]}`, changefreq: 'monthly', priority: '0.7', lastmod: dates[i] })
        }

        const legalSlugs = ['offer', 'terms', 'privacy', 'dpa', 'ai-usage', 'ai-transparency', 'refund-policy', 'attorney-offer', 'developer-offer', 'marketplace-rules']
        const legalLangs = ['en', 'ua']
        const legalPages: Entry[] = []
        for (const slug of legalSlugs) {
          for (const lang of legalLangs) {
            legalPages.push({ loc: `/${lang}/${slug}`, changefreq: 'monthly', priority: '0.5' })
          }
        }

        const dataSourcePages: Entry[] = [
          '/data-sources',
          '/us/data-sources', '/uk/data-sources', '/de/data-sources',
          '/fr/data-sources', '/nl/data-sources', '/ee/data-sources',
          '/ua/data-sources', '/eu/comparison',
        ].map(loc => ({ loc, changefreq: 'monthly', priority: '0.6' }))

        const allEntries = [...staticPages, ...blogArticles, ...legalPages, ...dataSourcePages]

        const urls = allEntries.map(e => {
          const parts = [
            `    <loc>${BASE_URL}${e.loc}</loc>`,
            e.lastmod ? `    <lastmod>${e.lastmod}</lastmod>` : null,
            `    <changefreq>${e.changefreq}</changefreq>`,
            `    <priority>${e.priority}</priority>`,
          ].filter(Boolean)
          return `  <url>\n${parts.join('\n')}\n  </url>`
        }).join('\n')

        const xml = [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
          urls,
          '</urlset>',
          '',
        ].join('\n')

        const outputPath = path.resolve(root, 'public/sitemap.xml')
        fs.writeFileSync(outputPath, xml)
        console.log(`[sitemap] Generated sitemap.xml with ${allEntries.length} URLs (${blogArticles.length} blog articles)`)
      } catch (err) {
        console.error('[sitemap] Failed to generate sitemap:', err)
      }
    },
  }
}

/**
 * Vite plugin that generates a static HTML shell for /developer/docs
 * so crawlers can index meta tags and content without executing JavaScript.
 * The React SPA still boots and takes over for interactive users.
 */
function prerenderDocsPlugin(): Plugin {
  return {
    name: 'prerender-developer-docs',
    closeBundle() {
      try {
        const root = path.resolve(__dirname)
        const distDir = path.resolve(root, 'dist')
        const indexHtml = fs.readFileSync(path.resolve(distDir, 'index.html'), 'utf-8')

        // Extract tool groups from source to build semantic HTML
        const toolsSrc = fs.readFileSync(
          path.resolve(root, 'src/pages/DeveloperDocsPage/index.tsx'), 'utf-8'
        )

        // Extract tool names and descriptions via regex
        const toolEntries: { name: string; desc: string }[] = []
        const toolRe = /name:\s*'([^']+)',\s*description:\s*'([^']+)'/g
        let tm: RegExpExecArray | null
        while ((tm = toolRe.exec(toolsSrc)) !== null) {
          toolEntries.push({ name: tm[1], desc: tm[2] })
        }

        // Extract group titles
        const groupTitles: string[] = []
        const groupRe = /title:\s*'([^']+)'/g
        let gm: RegExpExecArray | null
        while ((gm = groupRe.exec(toolsSrc)) !== null) {
          groupTitles.push(gm[1])
        }

        const toolCount = toolEntries.length
        const title = `LEX AI API — документація MCP сервера | ${toolCount} юридичних інструментів`
        const description = `Підключіть Claude Desktop, Cursor, VS Code або ChatGPT до MCP сервера LEX AI (mcp.legal.org.ua). ${toolCount} інструментів: 136M+ судових рішень ЄДРСР, законодавство, державні реєстри, відкриті дані, due diligence. REST API, MCP Streamable HTTP та SSE.`
        const ogDescription = `Підключіть Claude, Cursor або ChatGPT до ${toolCount} інструментів юридичного аналізу через MCP. Судова практика, законодавство, реєстри України.`
        const canonical = 'https://legal.org.ua/developer/docs'

        // Build semantic HTML for crawlers
        const toolsHtml = toolEntries.map(t =>
          `<li><code>${t.name}</code> — ${t.desc}</li>`
        ).join('\n          ')

        const categoriesHtml = groupTitles.map(g => `<li>${g}</li>`).join('\n          ')

        const semanticContent = `
    <div id="developer-docs-seo" style="max-width:820px;margin:40px auto;font-family:system-ui,sans-serif;padding:0 24px">
      <h1>LEX AI Platform API — документація MCP сервера</h1>
      <p>${description}</p>

      <h2>Підключення MCP клієнта</h2>
      <p>MCP Streamable HTTP: <code>https://mcp.legal.org.ua/api/v2/mcp</code> (куратований набір, 28 інструментів)</p>
      <p>MCP SSE (legacy): <code>https://mcp.legal.org.ua/sse</code></p>
      <p>MCP, повний набір: <code>https://mcp.legal.org.ua/api/v1/mcp</code> (${toolCount} інструментів)</p>
      <p>REST API: <code>https://platform.legal.org.ua/api/tools/:toolName</code> (${toolCount} інструментів)</p>
      <p>Підтримувані клієнти: Claude Desktop, Claude Code, Cursor, VS Code, ChatGPT, Continue.dev</p>
      <pre><code>{
  "mcpServers": {
    "secondlayer": {
      "type": "http",
      "url": "https://mcp.legal.org.ua/api/v2/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_TOKEN"
      }
    }
  }
}</code></pre>

      <h2>Категорії інструментів</h2>
      <ul>
        ${categoriesHtml}
      </ul>

      <h2>Всі інструменти (${toolEntries.length})</h2>
      <ul>
        ${toolsHtml}
      </ul>

      <h2>Автентифікація</h2>
      <p>Всі запити потребують Bearer Token. Згенеруйте API ключ у розділі Профіль → API токени.</p>

      <h2>Правові документи</h2>
      <ul>
        <li><a href="/ua/developer-offer">Оферта розробника</a></li>
        <li><a href="/ua/privacy">Політика конфіденційності</a></li>
        <li><a href="/ua/dpa">DPA (обробка даних)</a></li>
      </ul>
    </div>`

        const jsonLd = JSON.stringify({
          "@context": "https://schema.org",
          "@type": "WebAPI",
          "name": "LEX AI MCP Server",
          "description": `MCP сервер для юридичного аналізу: ${toolCount} інструментів — судова практика (136M+ документів ЄДРСР), законодавство, державні реєстри, відкриті дані, due diligence. Підключається через Streamable HTTP або SSE до Claude Desktop, Cursor, VS Code, ChatGPT.`,
          "url": "https://mcp.legal.org.ua/api/v2/mcp",
          "documentation": canonical,
          "provider": { "@type": "Organization", "name": "SecondLayer", "url": "https://legal.org.ua" },
          "termsOfService": "https://legal.org.ua/ua/developer-offer"
        })

        // Replace head meta tags in the index.html shell
        let html = indexHtml
          .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
          .replace(
            /<meta name="description" content="[^"]*"\s*\/?>/,
            `<meta name="description" content="${description}" />`
          )
          .replace(
            /<meta property="og:title" content="[^"]*"\s*\/?>/,
            `<meta property="og:title" content="${title}" />`
          )
          .replace(
            /<meta property="og:description" content="[^"]*"\s*\/?>/,
            `<meta property="og:description" content="${ogDescription}" />`
          )
          .replace(
            /<meta property="og:url" content="[^"]*"\s*\/?>/,
            `<meta property="og:url" content="${canonical}" />`
          )
          .replace(
            /<meta name="twitter:title" content="[^"]*"\s*\/?>/,
            `<meta name="twitter:title" content="${title}" />`
          )
          .replace(
            /<meta name="twitter:description" content="[^"]*"\s*\/?>/,
            `<meta name="twitter:description" content="${ogDescription}" />`
          )
          .replace(
            /<link rel="canonical" href="[^"]*"\s*\/?>/,
            `<link rel="canonical" href="${canonical}" />`
          )

        // Add WebAPI JSON-LD before closing </head>
        html = html.replace(
          '</head>',
          `<script type="application/ld+json">${jsonLd}</script>\n  </head>`
        )

        // Add semantic content before <div id="root"> so crawlers see it
        // React will render into #root and the SPA takes over
        html = html.replace(
          '<div id="root"></div>',
          `${semanticContent}\n    <div id="root"></div>\n    <script>document.getElementById('developer-docs-seo')?.remove()</script>`
        )

        // Write to dist/developer/docs/index.html
        const outDir = path.resolve(distDir, 'developer', 'docs')
        fs.mkdirSync(outDir, { recursive: true })
        fs.writeFileSync(path.resolve(outDir, 'index.html'), html)
        console.log(`[prerender] Generated developer/docs/index.html (${toolEntries.length} tools)`)
      } catch (err) {
        console.error('[prerender] Failed to generate developer/docs page:', err)
      }
    },
  }
}

/**
 * Vite plugin that generates static HTML for /blog and /blog/:slug
 * so crawlers can index blog content without executing JavaScript.
 */
function prerenderBlogPlugin(): Plugin {
  return {
    name: 'prerender-blog',
    closeBundle() {
      try {
        const root = path.resolve(__dirname)
        const distDir = path.resolve(root, 'dist')
        const indexHtml = fs.readFileSync(path.resolve(distDir, 'index.html'), 'utf-8')

        const BASE_URL = 'https://legal.org.ua'

        const LANG_META: Record<string, { ogLocale: string, htmlLang: string, backLabel: string }> = {
          uk: { ogLocale: 'uk_UA', htmlLang: 'uk', backLabel: '← Всі статті' },
          en: { ogLocale: 'en_US', htmlLang: 'en', backLabel: '← All articles' },
          ru: { ogLocale: 'ru_RU', htmlLang: 'ru', backLabel: '← Все статьи' },
        }

        interface ParsedArticle {
          id: string
          title: string
          punchline: string
          category: string
          tags: string[]
          readTime: string
          publishedAt: string
          content: string
        }

        // --- Parse articles from a TS source file via regex ---
        function parseArticlesFile(filePath: string, isTranslation: boolean): ParsedArticle[] | Record<string, Partial<ParsedArticle>> {
          const src = fs.readFileSync(filePath, 'utf-8')

          if (isTranslation) {
            // Translation files: { 'slug': { title, punchline, content, readTime } }
            const map: Record<string, Partial<ParsedArticle>> = {}
            // Match each slug entry
            const slugPattern = /['"]([a-z0-9-]+)['"]\s*:\s*\{/g
            let match
            while ((match = slugPattern.exec(src)) !== null) {
              const slug = match[1]
              const startIdx = match.index + match[0].length
              // Find the content boundaries for this slug
              const remaining = src.slice(startIdx)
              const titleMatch = remaining.match(/title:\s*'((?:[^'\\]|\\.)*)'/)
              const punchlineMatch = remaining.match(/punchline:\s*'((?:[^'\\]|\\.)*)'/)
              const readTimeMatch = remaining.match(/readTime:\s*'((?:[^'\\]|\\.)*)'/)
              const contentMatch = remaining.match(/content:\s*`((?:\\[\s\S]|[^`])*)`/)

              if (titleMatch) {
                map[slug] = {
                  title: titleMatch[1].replace(/\\'/g, "'"),
                  punchline: punchlineMatch ? punchlineMatch[1].replace(/\\'/g, "'") : '',
                  readTime: readTimeMatch ? readTimeMatch[1] : '',
                  content: contentMatch
                    ? contentMatch[1].replace(/\\`/g, '`').replace(/\\\$/g, '$').replace(/\\\\/g, '\\')
                    : '',
                }
              }
            }
            return map
          }

          // Main articles file
          const articles: ParsedArticle[] = []
          const articleBlocks = src.split(/\n  \{[\s]*\n/).slice(1)
          for (const block of articleBlocks) {
            const get = (key: string) => {
              const m = block.match(new RegExp(`${key}:\\s*'([^']*)'`))
              return m ? m[1] : ''
            }
            const id = get('id')
            const title = get('title')
            const punchline = get('punchline')
            const category = get('category')
            const readTime = get('readTime')
            const publishedAt = get('publishedAt')

            const tagsMatch = block.match(/tags:\s*\[([^\]]*)\]/)
            const tags = tagsMatch
              ? tagsMatch[1].match(/'([^']+)'/g)?.map(t => t.replace(/'/g, '')) || []
              : []

            const contentMatch = block.match(/content:\s*`((?:\\[\s\S]|[^`])*)`/)
            const content = contentMatch
              ? contentMatch[1]
                  .replace(/\\`/g, '`')
                  .replace(/\\\$/g, '$')
                  .replace(/\\\\/g, '\\')
              : ''

            if (id && title) {
              articles.push({ id, title, punchline, category, tags, readTime, publishedAt, content })
            }
          }
          return articles
        }

        // Parse all language versions
        const articles = parseArticlesFile(
          path.resolve(root, 'src/pages/BlogPage/articles.ts'), false
        ) as ParsedArticle[]

        const enMap = parseArticlesFile(
          path.resolve(root, 'src/pages/BlogPage/articles-en.ts'), true
        ) as Record<string, Partial<ParsedArticle>>

        const ruMap = parseArticlesFile(
          path.resolve(root, 'src/pages/BlogPage/articles-ru.ts'), true
        ) as Record<string, Partial<ParsedArticle>>

        if (articles.length === 0) {
          console.warn('[prerender-blog] No articles parsed, skipping')
          return
        }

        const translationMaps: Record<string, Record<string, Partial<ParsedArticle>>> = {
          en: enMap,
          ru: ruMap,
        }

        // Helper to replace meta tags in the HTML shell
        function replaceMeta(html: string, opts: {
          title: string, description: string, ogTitle: string, ogDescription: string,
          ogUrl: string, ogImage?: string, canonical: string, ogLocale?: string, htmlLang?: string
        }): string {
          let result = html
            .replace(/<title>[^<]*<\/title>/, `<title>${opts.title}</title>`)
            .replace(/<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${opts.description.replace(/"/g, '&quot;')}" />`)
            .replace(/<meta property="og:title" content="[^"]*"\s*\/?>/, `<meta property="og:title" content="${opts.ogTitle.replace(/"/g, '&quot;')}" />`)
            .replace(/<meta property="og:description" content="[^"]*"\s*\/?>/, `<meta property="og:description" content="${opts.ogDescription.replace(/"/g, '&quot;')}" />`)
            .replace(/<meta property="og:url" content="[^"]*"\s*\/?>/, `<meta property="og:url" content="${opts.ogUrl}" />`)
            .replace(/<meta name="twitter:title" content="[^"]*"\s*\/?>/, `<meta name="twitter:title" content="${opts.ogTitle.replace(/"/g, '&quot;')}" />`)
            .replace(/<meta name="twitter:description" content="[^"]*"\s*\/?>/, `<meta name="twitter:description" content="${opts.ogDescription.replace(/"/g, '&quot;')}" />`)
            .replace(/<link rel="canonical" href="[^"]*"\s*\/?>/, `<link rel="canonical" href="${opts.canonical}" />`)
            .replace(/<meta property="og:image" content="[^"]*"\s*\/?>/, `<meta property="og:image" content="${opts.ogImage || `${BASE_URL}/og-image.png`}" />`)
            .replace(/<meta name="twitter:image" content="[^"]*"\s*\/?>/, `<meta name="twitter:image" content="${opts.ogImage || `${BASE_URL}/og-image.png`}" />`)
          if (opts.ogLocale) {
            result = result.replace(/<meta property="og:locale" content="[^"]*"\s*\/?>/, `<meta property="og:locale" content="${opts.ogLocale}" />`)
          }
          if (opts.htmlLang) {
            result = result.replace(/<html lang="[^"]*"/, `<html lang="${opts.htmlLang}"`)
          }
          return result
        }

        // Helper to generate hreflang link tags for a given article slug
        function hreflangTags(slug: string): string {
          const enUrl = `${BASE_URL}/blog/${slug}`
          const ukUrl = `${BASE_URL}/blog/uk/${slug}`
          const ruUrl = `${BASE_URL}/blog/ru/${slug}`
          return [
            `<link rel="alternate" hreflang="en" href="${enUrl}" />`,
            `<link rel="alternate" hreflang="uk" href="${ukUrl}" />`,
            `<link rel="alternate" hreflang="ru" href="${ruUrl}" />`,
            `<link rel="alternate" hreflang="x-default" href="${enUrl}" />`,
          ].join('\n    ')
        }

        // --- Generate /blog/index.html (+ /blog/en/ and /blog/ru/) ---
        const blogDir = path.resolve(distDir, 'blog')
        fs.mkdirSync(blogDir, { recursive: true })

        const blogListMeta: Record<string, { title: string, desc: string, heading: string }> = {
          uk: {
            title: 'LEX Blog — AI Legal Tech Articles',
            desc: 'Статті про AI в юриспруденції, юридичні технології, аналіз судових рішень, fine-tuning LLM на судовій практиці та цифрову трансформацію правничої практики.',
            heading: 'LEX AI Blog',
          },
          en: {
            title: 'LEX Blog — AI Legal Tech Articles',
            desc: 'Articles on AI in law, legal technology, court decision analysis, fine-tuning LLMs on case law, and digital transformation of legal practice.',
            heading: 'LEX AI Blog',
          },
          ru: {
            title: 'LEX Blog — AI Legal Tech Articles',
            desc: 'Статьи об AI в юриспруденции, юридических технологиях, анализе судебных решений, fine-tuning LLM на судебной практике и цифровой трансформации правовой практики.',
            heading: 'LEX AI Blog',
          },
        }

        const sortedArticles = [...articles].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))

        for (const lang of ['uk', 'en', 'ru'] as const) {
          const meta = blogListMeta[lang]
          const langMeta = LANG_META[lang]
          const langPrefix = lang === 'en' ? '' : `${lang}/`
          const blogUrl = `${BASE_URL}/blog${lang === 'en' ? '' : `/${lang}`}`

          const listArticles = sortedArticles.map(a => {
            let title = a.title
            let punchline = a.punchline
            let readTime = a.readTime
            if (lang !== 'uk') {
              const tr = translationMaps[lang]?.[a.id]
              if (tr?.title) {
                title = tr.title
                punchline = tr.punchline || punchline
                readTime = tr.readTime || readTime
              }
            }
            return { ...a, title, punchline, readTime }
          })

          const articleListHtml = listArticles.map(a => `
        <article>
          <h2><a href="/blog/${langPrefix}${a.id}">${a.title}</a></h2>
          <p>${a.punchline}</p>
          <div>
            <span>${a.category === 'tech' ? 'TECH' : a.category === 'academic' ? 'ACADEMIC' : 'LEGAL'}</span>
            <time datetime="${a.publishedAt}">${a.publishedAt}</time>
            <span>${a.readTime}</span>
          </div>
          <div>${a.tags.map(t => `<span>#${t}</span>`).join(' ')}</div>
        </article>`).join('\n')

          const blogListJsonLd = JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Blog",
            "name": meta.heading,
            "description": meta.desc,
            "url": blogUrl,
            "inLanguage": langMeta.htmlLang,
            "publisher": { "@type": "Organization", "name": "SecondLayer", "url": BASE_URL },
            "blogPost": listArticles.slice(0, 20).map(a => ({
              "@type": "BlogPosting",
              "headline": a.title,
              "description": a.punchline,
              "url": `${BASE_URL}/blog/${langPrefix}${a.id}`,
              "datePublished": a.publishedAt,
              "keywords": a.tags.join(', '),
            }))
          })

          const blogHreflang = [
            `<link rel="alternate" hreflang="en" href="${BASE_URL}/blog" />`,
            `<link rel="alternate" hreflang="uk" href="${BASE_URL}/blog/uk" />`,
            `<link rel="alternate" hreflang="ru" href="${BASE_URL}/blog/ru" />`,
            `<link rel="alternate" hreflang="x-default" href="${BASE_URL}/blog" />`,
          ].join('\n    ')

          let blogListPage = replaceMeta(indexHtml, {
            title: meta.title,
            description: meta.desc,
            ogTitle: meta.title,
            ogDescription: meta.desc,
            ogUrl: blogUrl,
            canonical: blogUrl,
            ogLocale: langMeta.ogLocale,
            htmlLang: langMeta.htmlLang,
          })
          blogListPage = blogListPage.replace('</head>', `    ${blogHreflang}\n  <script type="application/ld+json">${blogListJsonLd}</script>\n  </head>`)
          blogListPage = blogListPage.replace(
            '<div id="root"></div>',
            `<div id="blog-seo" style="max-width:820px;margin:40px auto;font-family:system-ui,sans-serif;padding:0 24px">
      <h1>${meta.heading}</h1>
      <p>${meta.desc}</p>
      ${articleListHtml}
    </div>
    <div id="root"></div>
    <script>document.getElementById('blog-seo')?.remove()</script>`
          )

          const listDir = lang === 'en' ? blogDir : path.resolve(blogDir, lang)
          fs.mkdirSync(listDir, { recursive: true })
          fs.writeFileSync(path.resolve(listDir, 'index.html'), blogListPage)
        }

        // --- Generate /blog/:slug/index.html for each article (all languages) ---
        let articleCount = 0
        const languages = ['uk', 'en', 'ru'] as const

        for (const article of articles) {
          for (const lang of languages) {
            // Resolve translated content
            let title = article.title
            let punchline = article.punchline
            let content = article.content
            let readTime = article.readTime

            if (lang !== 'uk') {
              const translation = translationMaps[lang]?.[article.id]
              if (!translation?.title) continue // skip if no translation exists
              title = translation.title || title
              punchline = translation.punchline || punchline
              content = translation.content || content
              readTime = translation.readTime || readTime
            }

            const langMeta = LANG_META[lang]
            const slugPath = lang === 'en' ? article.id : `${lang}/${article.id}`
            const articleUrl = `${BASE_URL}/blog/${slugPath}`
            const ogImage = `${BASE_URL}/blog-banners/${article.id}.png`
            const truncatedPunchline = punchline.length > 200
              ? punchline.slice(0, 197) + '...'
              : punchline

            let articlePage = replaceMeta(indexHtml, {
              title: `${title} | LEX Blog`,
              description: truncatedPunchline,
              ogTitle: title,
              ogDescription: truncatedPunchline,
              ogUrl: articleUrl,
              ogImage,
              canonical: articleUrl,
              ogLocale: langMeta.ogLocale,
              htmlLang: langMeta.htmlLang,
            })

            articlePage = articlePage.replace(
              '<meta property="og:type" content="website" />',
              '<meta property="og:type" content="article" />'
            )

            // Add hreflang tags
            articlePage = articlePage.replace('</head>', `    ${hreflangTags(article.id)}\n  </head>`)

            const articleJsonLd = JSON.stringify({
              "@context": "https://schema.org",
              "@type": "BlogPosting",
              "headline": title,
              "description": punchline,
              "url": articleUrl,
              "image": ogImage,
              "datePublished": article.publishedAt,
              "keywords": article.tags.join(', '),
              "articleSection": article.category === 'tech' ? 'Technology' : article.category === 'academic' ? 'Academic' : 'Legal',
              "inLanguage": langMeta.htmlLang,
              "publisher": { "@type": "Organization", "name": "SecondLayer", "url": BASE_URL },
              "mainEntityOfPage": { "@type": "WebPage", "@id": articleUrl }
            })

            articlePage = articlePage.replace('</head>', `<script type="application/ld+json">${articleJsonLd}</script>\n  </head>`)

            let contentHtml = ''
            try {
              contentHtml = marked.parse(content) as string
            } catch {
              contentHtml = `<pre>${content.replace(/</g, '&lt;')}</pre>`
            }

            const semanticArticle = `<article id="blog-article-seo" style="max-width:820px;margin:40px auto;font-family:system-ui,sans-serif;padding:0 24px">
      <header>
        <span>${article.category === 'tech' ? 'TECH' : article.category === 'academic' ? 'ACADEMIC' : 'LEGAL'}</span>
        <time datetime="${article.publishedAt}">${article.publishedAt}</time>
        <span>${readTime}</span>
      </header>
      <h1>${title}</h1>
      <p><em>${punchline}</em></p>
      ${contentHtml}
      <footer>
        <div>${article.tags.map(t => `<span>#${t}</span>`).join(' ')}</div>
        <nav><a href="/blog">${langMeta.backLabel}</a></nav>
      </footer>
    </article>`

            articlePage = articlePage.replace(
              '<div id="root"></div>',
              `${semanticArticle}\n    <div id="root"></div>\n    <script>document.getElementById('blog-article-seo')?.remove()</script>`
            )

            const articleDir = path.resolve(blogDir, slugPath)
            fs.mkdirSync(articleDir, { recursive: true })
            fs.writeFileSync(path.resolve(articleDir, 'index.html'), articlePage)
            articleCount++
          }
        }

        console.log(`[prerender-blog] Generated blog/index.html + ${articleCount} article pages (uk/en/ru)`)
      } catch (err) {
        console.error('[prerender-blog] Failed to generate blog pages:', err)
      }
    },
  }
}

/**
 * Vite plugin that generates static HTML for /investor, /uk_investor, /lex-news
 * so crawlers (Google, WebFetch, LLM) can index team, product, and company
 * information without executing JavaScript. Required by Google for Startups
 * qualification (LEXAI-864).
 */
function prerenderInvestorAndNewsPlugin(): Plugin {
  return {
    name: 'prerender-investor-news',
    closeBundle() {
      try {
        const root = path.resolve(__dirname)
        const distDir = path.resolve(root, 'dist')
        const indexHtml = fs.readFileSync(path.resolve(distDir, 'index.html'), 'utf-8')
        const BASE_URL = 'https://legal.org.ua'

        // Shared meta-replacement helper (same shape as prerenderBlogPlugin)
        function replaceMeta(html: string, opts: {
          title: string; description: string; ogUrl: string; canonical: string;
          ogLocale?: string; ogImage?: string;
        }): string {
          const esc = (s: string) => s.replace(/"/g, '&quot;')
          return html
            .replace(/<title>[^<]*<\/title>/, `<title>${opts.title}</title>`)
            .replace(/<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${esc(opts.description)}" />`)
            .replace(/<meta property="og:title" content="[^"]*"\s*\/?>/, `<meta property="og:title" content="${esc(opts.title)}" />`)
            .replace(/<meta property="og:description" content="[^"]*"\s*\/?>/, `<meta property="og:description" content="${esc(opts.description)}" />`)
            .replace(/<meta property="og:url" content="[^"]*"\s*\/?>/, `<meta property="og:url" content="${opts.ogUrl}" />`)
            .replace(/<meta property="og:locale" content="[^"]*"\s*\/?>/, `<meta property="og:locale" content="${opts.ogLocale || 'en_US'}" />`)
            .replace(/<meta property="og:image" content="[^"]*"\s*\/?>/, `<meta property="og:image" content="${opts.ogImage || `${BASE_URL}/og-image.png`}" />`)
            .replace(/<meta name="twitter:title" content="[^"]*"\s*\/?>/, `<meta name="twitter:title" content="${esc(opts.title)}" />`)
            .replace(/<meta name="twitter:description" content="[^"]*"\s*\/?>/, `<meta name="twitter:description" content="${esc(opts.description)}" />`)
            .replace(/<meta name="twitter:image" content="[^"]*"\s*\/?>/, `<meta name="twitter:image" content="${opts.ogImage || `${BASE_URL}/og-image.png`}" />`)
            .replace(/<link rel="canonical" href="[^"]*"\s*\/?>/, `<link rel="canonical" href="${opts.canonical}" />`)
        }

        function writePage(route: string, html: string) {
          const outDir = route === '/' ? distDir : path.resolve(distDir, route.replace(/^\//, ''))
          fs.mkdirSync(outDir, { recursive: true })
          fs.writeFileSync(path.resolve(outDir, 'index.html'), html)
        }

        function injectSeoBlock(html: string, seoBlockHtml: string, seoId: string): string {
          return html.replace(
            '<div id="root"></div>',
            `${seoBlockHtml}\n    <div id="root"></div>\n    <script>document.getElementById('${seoId}')?.remove()</script>`
          )
        }

        // Shared team/company JSON-LD (used on investor pages)
        const organizationJsonLd = {
          '@context': 'https://schema.org',
          '@type': 'Organization',
          name: 'SecondLayer',
          legalName: 'LEX AI LLC',
          alternateName: 'LEX',
          url: BASE_URL,
          logo: `${BASE_URL}/icon-192x192.png`,
          description: 'AI-powered legal technology company building tools for law firms and corporate counsel. Semantic search across 110M+ Ukrainian court decisions, AI-queryable registry data, MCP integration for Claude/GPT.',
          foundingDate: '2024',
          founders: [
            {
              '@type': 'Person',
              name: 'Volodymyr Ovcharov',
              jobTitle: 'Co-founder & CTO',
              alumniOf: 'Kyiv Polytechnic Institute (KPI), Faculty of Applied Mathematics',
              description: 'Former researcher at V.M. Glushkov Institute of Cybernetics, NAS of Ukraine. 15+ years building scalable data processing, NLP, and AI infrastructure.',
              sameAs: ['https://www.linkedin.com/in/overthelex/'],
            },
            {
              '@type': 'Person',
              name: 'Igor Kyrychenko',
              jobTitle: 'Co-founder & CEO',
              description: 'PhD in Law. Deep expertise in Ukrainian and international law, court practice, and legal analytics.',
              sameAs: ['https://www.linkedin.com/in/igor-kyrychenko/'],
            },
          ],
          contactPoint: {
            '@type': 'ContactPoint',
            email: 'info@legal.org.ua',
            contactType: 'Business',
          },
        }

        // ---------------------------------------------------------------
        // /investor — Ukrainian investor letter (SEO block)
        // ---------------------------------------------------------------
        const investorTitle = 'Відкритий лист інвестору — LEX AI платформа для юридичної аналітики'
        const investorDesc = 'Відкритий лист інвестору від LEX AI (SecondLayer): команда (CTO 15+ років, CEO PhD у праві), 119M+ записів відкритих даних, семантичний пошук по 110M+ судових рішень, MCP-протокол для Claude/GPT, порівняння з Harvey AI та ZakonOnline, TAM $500M.'
        const investorSeo = `
    <main id="investor-seo" lang="uk" style="max-width:900px;margin:40px auto;font-family:system-ui,sans-serif;padding:0 24px;color:#e4e4e7;background:#0a0a0b">
      <h1>Відкритий лист інвестору — LEX AI</h1>
      <p>LEX — AI-платформа для юридичної аналітики, побудована на відкритих даних України. MCP-інтеграція з Claude, GPT, Cursor. Live production на <a href="${BASE_URL}">legal.org.ua</a>.</p>

      <h2>1. Засновники</h2>
      <section>
        <h3>Володимир Овчаров — Co-founder &amp; CTO</h3>
        <p>Випускник КПІ, Факультет прикладної математики. Працював в Інституті кібернетики імені В.М. Глушкова НАН України. 15+ років досвіду розробки масштабованих платформ для роботи з даними, NLP та AI-інфраструктури.</p>
        <p><a href="https://www.linkedin.com/in/overthelex/">LinkedIn профіль</a></p>
      </section>
      <section>
        <h3>Ігор Кириченко — Co-founder &amp; CEO</h3>
        <p>PhD з юриспруденції. Глибока експертиза в українському та міжнародному праві, судовій практиці та правовій аналітиці. Поєднання академічного юридичного бекграунду з розумінням потреб практикуючих юристів.</p>
      </section>
      <p><strong>Унікальна комбінація:</strong> технічна експертиза (AI, інфраструктура, масштабування) + юридична наука (PhD) = продукт, побудований людьми, які розуміють обидва боки.</p>

      <h2>2. Продукт</h2>
      <p>LEX — AI-powered платформа, що об'єднує пошук судових рішень, аналіз законодавства, моніторинг змін та MCP-інтеграцію з LLM-клієнтами (Claude, GPT). Прямих AI-конкурентів в Україні немає.</p>
      <ul>
        <li>Семантичний пошук по 110M+ судовим рішенням ЄДРСР через Qdrant + embeddings</li>
        <li>Аналітика ефективності суддів — унікальний функціонал (12 000+ профілів із метриками)</li>
        <li>100+ MCP-інструментів для Claude Desktop, Cursor, VS Code, ChatGPT</li>
        <li>REST API + SSE streaming для B2B інтеграцій</li>
        <li>Моніторинг змін у законодавстві (200 000+ актів з РАДА)</li>
        <li>Перевірка цитувань AI (HallucinationGuard + CitationValidator у продакшені)</li>
        <li>End-to-end encrypted консультації + маркетплейс адвокатів (ЄРАУ verify + Monobank escrow)</li>
      </ul>

      <h2>3. Дані на продакшені (119M+ записів)</h2>
      <ul>
        <li><strong>ЄДРСР</strong> — 8.8M метаданих + 53M RTF-файлів повних текстів (1.4TB)</li>
        <li><strong>NAIS реєстри</strong> — 41.8M записів (боржники 10M, виконавчі провадження 29M, нотаріуси, експерти, банкрутства, НПА тощо)</li>
        <li><strong>Податкові реєстри</strong> — 1.83M записів</li>
        <li><strong>OpenReyestr</strong> — 4.5M юросіб, ФОП, бенефіціарів</li>
        <li><strong>Санкції</strong> — 1.3M (OpenSanctions, РНБО)</li>
        <li><strong>Prozorro</strong> — 706K+ публічних закупівель</li>
        <li><strong>Векторні ембедінги</strong> — 2M+ через Qdrant, text-embedding-3-small 1536d</li>
        <li><strong>Парламент</strong> — 450 депутатів, 10K+ законопроектів, історія голосувань</li>
      </ul>

      <h2>4. Підписки та unit economics</h2>
      <table>
        <thead><tr><th>Тариф</th><th>Ціна</th><th>Для кого</th></tr></thead>
        <tbody>
          <tr><td>Individual</td><td>$29/міс</td><td>Solo-адвокат</td></tr>
          <tr><td>Professional</td><td>$49/міс</td><td>Активний юрист</td></tr>
          <tr><td>Firm</td><td>$99–299/міс</td><td>Юрфірма 2–20 осіб</td></tr>
          <tr><td>Enterprise</td><td>Custom</td><td>Корп. юрвідділи</td></tr>
          <tr><td>API/MCP</td><td>Pay-per-query</td><td>B2B розробники</td></tr>
        </tbody>
      </table>
      <p>Середня собівартість запиту $0.02, середня ціна $0.05, середня маржа ~60%. Юрист робить 50–200 запитів на день.</p>

      <h2>5. Конкуренти</h2>
      <table>
        <thead><tr><th>Компанія</th><th>Країна</th><th>Оцінка / Дохід</th><th>Фокус</th></tr></thead>
        <tbody>
          <tr><td>Harvey AI</td><td>США</td><td>$1.5B+</td><td>AI для юрфірм</td></tr>
          <tr><td>Clio</td><td>Канада</td><td>$3B+</td><td>Practice management + AI</td></tr>
          <tr><td>LexisNexis (RELX)</td><td>США/UK</td><td>$14B+ revenue</td><td>Правові бази даних</td></tr>
          <tr><td><strong>LEX (legal.org.ua)</strong></td><td>Україна</td><td>Seed</td><td>AI legal + MCP</td></tr>
        </tbody>
      </table>
      <p>В Україні єдиний гравець з AI-аналізом, семантичним пошуком, MCP-протоколом та перевіркою цитувань. ActiveLex, ZakonOnline, ЛІГА:ЗАКОН — класичні keyword-пошуковики без AI.</p>

      <h2>6. Ринок</h2>
      <ul>
        <li>TAM (глобальний legal AI 2026): <strong>$500M+</strong></li>
        <li>SAM (legal IT Україна + CEE): <strong>$50M</strong></li>
        <li>SOM (перші 2 роки, Україна): <strong>$2–5M</strong></li>
        <li>60 000+ адвокатів НААУ, 5 000+ юрфірм, 10 000+ корпюрвідділів</li>
      </ul>

      <h2>7. Трекшен</h2>
      <ul>
        <li>Live production з Q4 2025 на <a href="${BASE_URL}">legal.org.ua</a></li>
        <li>50+ зареєстрованих користувачів (органічно, без платного acquisition)</li>
        <li>3 Letters of Intent від середніх юрфірм на Professional/Firm плани</li>
        <li>100+ MCP-інструментів в продакшені через Claude Desktop</li>
        <li>Backed by AWS Activate</li>
      </ul>

      <h2>8. Technology Moat</h2>
      <ul>
        <li><strong>Data moat:</strong> 119M+ записів + 53M RTF-файлів. Повторення зайняло б місяці скрапінгу.</li>
        <li><strong>MCP-протокол:</strong> перша та єдина legal-платформа в Україні з нативною MCP-інтеграцією для LLM.</li>
        <li><strong>AI pipeline:</strong> семантичний пошук, citation verification, pattern detection, класифікація — production-hardened на 119M+ records.</li>
        <li><strong>Domain expertise у коді:</strong> PhD-юрист як co-founder → правова логіка закладена архітектурно, не bolted-on.</li>
      </ul>

      <h2>Контакти</h2>
      <p>Email: <a href="mailto:info@legal.org.ua">info@legal.org.ua</a> · Сайт: <a href="${BASE_URL}">legal.org.ua</a> · Developer API: <a href="${BASE_URL}/developer/docs">legal.org.ua/developer/docs</a></p>
      <p>Додаткові матеріали: <a href="${BASE_URL}/uk_investor">English investor memo</a> · <a href="${BASE_URL}/pitch-deck.html">Pitch deck</a> · <a href="${BASE_URL}/blog">Technical blog (39 articles)</a></p>
    </main>`
        let investorPage = replaceMeta(indexHtml, {
          title: investorTitle,
          description: investorDesc,
          ogUrl: `${BASE_URL}/investor`,
          canonical: `${BASE_URL}/investor`,
          ogLocale: 'uk_UA',
        })
        investorPage = investorPage.replace('</head>',
          `<script type="application/ld+json">${JSON.stringify(organizationJsonLd)}</script>\n  </head>`)
        investorPage = injectSeoBlock(investorPage, investorSeo, 'investor-seo')
        writePage('/investor', investorPage)

        // ---------------------------------------------------------------
        // /uk_investor — English investment memorandum (SEO block)
        // ---------------------------------------------------------------
        const ukTitle = 'LEX AI — Investment Memorandum | AI legal platform for Ukraine'
        const ukDesc = 'LEX AI (SecondLayer) investment memorandum: founding team (CTO with 15+ years, CEO with PhD in Law), 119M+ open-data records, semantic search across 110M+ court decisions, MCP protocol for Claude/GPT, competitive moat vs Harvey AI and LexisNexis.'
        const ukSeo = `
    <main id="uk-investor-seo" lang="en" style="max-width:900px;margin:40px auto;font-family:system-ui,sans-serif;padding:0 24px;color:#e4e4e7;background:#0a0a0b">
      <h1>LEX AI — Investment Memorandum</h1>
      <p>LEX is an AI-powered legal analytics platform for Ukraine — built on 119M+ open-data records, with MCP-native integration for Claude, GPT, and Cursor. Live in production at <a href="${BASE_URL}">legal.org.ua</a>.</p>

      <h2>1. Founding Team</h2>
      <section>
        <h3>Volodymyr Ovcharov — Co-founder &amp; CTO</h3>
        <p>BSc Applied Mathematics, National Technical University "KPI" (Kyiv Polytechnic Institute). Former researcher at the V.M. Glushkov Institute of Cybernetics, National Academy of Sciences of Ukraine. 15+ years building scalable data-processing, NLP, and AI-infrastructure platforms.</p>
        <p><a href="https://www.linkedin.com/in/overthelex/">LinkedIn profile</a></p>
      </section>
      <section>
        <h3>Igor Kyrychenko — Co-founder &amp; CEO</h3>
        <p>PhD in Law. Deep expertise in Ukrainian and international law, court practice, and legal analytics. Bridges academic legal rigour with the practical requirements of working lawyers.</p>
      </section>
      <p><strong>Complementary team:</strong> technical expertise (AI, infrastructure, scaling) + legal science (PhD) = a product architected by people who understand both technology and law.</p>

      <h2>2. Why Now</h2>
      <ul>
        <li><strong>LLM inflection point</strong> — GPT-4o, Claude 3.5 and Bedrock reached production-grade quality for legal reasoning.</li>
        <li><strong>Ukrainian open-data wave</strong> — 11 NAIS registries + EDRSR + Prozorro + tax registries, 119M+ records opened since 2020.</li>
        <li><strong>EU AI Act (effective 2026)</strong> — creates tailwinds for transparent, auditable, citation-verified legal AI.</li>
        <li><strong>Productivity crisis</strong> — Ukrainian lawyers spend 60–70% of billable time on research with 2000s-era keyword tools.</li>
      </ul>

      <h2>3. Product</h2>
      <p>LEX combines court-decision search, legislation analysis, change monitoring, and MCP integration with LLM clients (Claude, GPT). No direct AI competitors in Ukraine.</p>
      <ul>
        <li>Semantic vector search across 110M+ EDRSR court decisions (Qdrant + OpenAI embeddings)</li>
        <li>Judge performance analytics — 12,000+ profiles with appeal-reversal rate, deadline violations, court specialisation</li>
        <li>100+ MCP tools for Claude Desktop, Cursor, VS Code, ChatGPT</li>
        <li>REST API + SSE streaming for B2B integrations</li>
        <li>Legislation change monitoring (200,000+ acts from Verkhovna Rada)</li>
        <li>AI citation verification (HallucinationGuard + CitationValidator in production)</li>
        <li>E2E-encrypted consultations + attorney marketplace (ЄРАУ verification + Monobank escrow)</li>
      </ul>

      <h2>4. Production Data Assets — 119M+ records</h2>
      <ul>
        <li><strong>EDRSR</strong> — 8.8M metadata + 53M RTF full-text files (1.4TB)</li>
        <li><strong>NAIS state registries</strong> — 41.8M records (debtors 10M, enforcement proceedings 29M, notaries, experts, bankruptcies, regulatory acts)</li>
        <li><strong>Tax registries</strong> — 1.83M records (as of Feb 2022, last pre-invasion dump)</li>
        <li><strong>OpenReyestr (business registry)</strong> — 4.5M entities, sole proprietors, NGOs, beneficiaries</li>
        <li><strong>Sanctions</strong> — 1.3M (OpenSanctions global, RNBO national)</li>
        <li><strong>Prozorro public procurement</strong> — 706K+ tenders</li>
        <li><strong>Vector embeddings</strong> — 2M+ in Qdrant, text-embedding-3-small (1536d)</li>
        <li><strong>Parliament</strong> — 450 deputies, 10K+ bills, complete voting records</li>
      </ul>

      <h2>5. Business Model &amp; Unit Economics</h2>
      <table>
        <thead><tr><th>Plan</th><th>Price</th><th>Target</th></tr></thead>
        <tbody>
          <tr><td>Individual</td><td>£23/mo</td><td>Solo attorneys</td></tr>
          <tr><td>Professional</td><td>£39/mo</td><td>Active practitioners</td></tr>
          <tr><td>Firm</td><td>£79–239/mo</td><td>Law firms (2–20 seats)</td></tr>
          <tr><td>Enterprise</td><td>Custom</td><td>Corporate legal departments</td></tr>
          <tr><td>API / MCP</td><td>Pay-per-query</td><td>B2B developers</td></tr>
        </tbody>
      </table>
      <p>Average query cost £0.016, average client price £0.040, average gross margin ~60%. Attorneys make 50–200 queries/day.</p>

      <h2>6. Competitive Landscape</h2>
      <table>
        <thead><tr><th>Company</th><th>Country</th><th>Valuation / Revenue</th><th>Focus</th></tr></thead>
        <tbody>
          <tr><td>Harvey AI</td><td>USA</td><td>£1.2B+ valuation</td><td>AI for law firms</td></tr>
          <tr><td>Clio</td><td>Canada</td><td>£2.4B+ valuation</td><td>Practice management + AI</td></tr>
          <tr><td>LexisNexis (RELX)</td><td>USA / UK</td><td>£11B+ revenue</td><td>Legal analytics, databases</td></tr>
          <tr><td><strong>LEX (legal.org.ua)</strong></td><td>Ukraine</td><td>Seed stage</td><td>AI legal + MCP</td></tr>
        </tbody>
      </table>

      <h2>7. Market Sizing</h2>
      <ul>
        <li>TAM (global legal AI 2026): <strong>£400M+</strong></li>
        <li>SAM (legal IT Ukraine + CEE): <strong>£40M</strong></li>
        <li>SOM (first 2 years, Ukraine): <strong>£1.6–4M</strong></li>
        <li>60,000+ attorneys (UNBA), 5,000+ law firms, 10,000+ corporate legal departments</li>
      </ul>

      <h2>8. Traction</h2>
      <ul>
        <li>Live production since Q4 2025 at <a href="${BASE_URL}">legal.org.ua</a></li>
        <li>50+ registered users (organic, no paid acquisition)</li>
        <li>3 Letters of Intent from mid-size law firms for Professional / Firm plans</li>
        <li>100+ MCP tools deployed — production-grade via Claude Desktop and API</li>
        <li>Backed by AWS Activate</li>
      </ul>

      <h2>9. Technology Moat</h2>
      <ul>
        <li><strong>Data moat:</strong> 119M+ records + 53M RTF files. Replicating would require months of crawling, parsing, indexing.</li>
        <li><strong>MCP protocol:</strong> first and only legal platform in Ukraine with native MCP integration. Network effect as LLM clients adopt MCP.</li>
        <li><strong>AI pipeline:</strong> semantic search, citation verification, pattern detection — production-hardened across 119M+ records.</li>
        <li><strong>Domain expertise in code:</strong> PhD lawyer as co-founder — legal taxonomy, court hierarchy, procedural rules encoded as first-class domain models.</li>
      </ul>

      <h2>Contact</h2>
      <p>Email: <a href="mailto:info@legal.org.ua">info@legal.org.ua</a> · Website: <a href="${BASE_URL}">legal.org.ua</a> · Developer API: <a href="${BASE_URL}/developer/docs">legal.org.ua/developer/docs</a></p>
      <p>Related materials: <a href="${BASE_URL}/investor">Ukrainian investor letter</a> · <a href="${BASE_URL}/pitch-deck.html">Pitch deck</a> · <a href="${BASE_URL}/blog">Technical blog (39 articles)</a></p>
    </main>`
        let ukPage = replaceMeta(indexHtml, {
          title: ukTitle,
          description: ukDesc,
          ogUrl: `${BASE_URL}/uk_investor`,
          canonical: `${BASE_URL}/uk_investor`,
          ogLocale: 'en_GB',
        })
        ukPage = ukPage.replace('</head>',
          `<script type="application/ld+json">${JSON.stringify(organizationJsonLd)}</script>\n  </head>`)
        ukPage = injectSeoBlock(ukPage, ukSeo, 'uk-investor-seo')
        writePage('/uk_investor', ukPage)

        // ---------------------------------------------------------------
        // /lex-news — dynamic list of product news + per-article shells
        // ---------------------------------------------------------------
        const newsArticlesPath = path.resolve(root, 'src/pages/LexNewsPage/articles.ts')
        interface NewsItem { id: string; title: string; summary: string; category: string; publishedAt: string; readTime: string; tags: string[]; content: string; lang: string }
        const newsItems: NewsItem[] = []
        if (fs.existsSync(newsArticlesPath)) {
          const src = fs.readFileSync(newsArticlesPath, 'utf-8')
          const blocks = src.split(/\n  \{[\s]*\n/).slice(1)
          for (const block of blocks) {
            const get = (k: string) => {
              const m = block.match(new RegExp(`${k}:\\s*'([^']*)'`))
              return m ? m[1] : ''
            }
            const tagsMatch = block.match(/tags:\s*\[([^\]]*)\]/)
            const tags = tagsMatch ? (tagsMatch[1].match(/'([^']+)'/g)?.map(t => t.replace(/'/g, '')) || []) : []
            const contentMatch = block.match(/content:\s*`((?:\\[\s\S]|[^`])*)`/)
            const content = contentMatch ? contentMatch[1].replace(/\\`/g, '`').replace(/\\\$/g, '$').replace(/\\\\/g, '\\') : ''
            const id = get('id')
            const title = get('title')
            if (id && title) {
              newsItems.push({
                id, title,
                summary: get('summary'),
                category: get('category'),
                publishedAt: get('publishedAt'),
                readTime: get('readTime'),
                lang: get('lang'),
                tags, content,
              })
            }
          }
        }

        const newsListTitle = 'LEX News — Product updates and market expansion'
        const newsListDesc = 'Product news, partnerships, and market-expansion updates from LEX AI — new features, open-data integrations, international rollout (Spain, Georgia, UK), MCP tooling releases.'
        const newsListHtml = newsItems
          .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
          .map(n => `
      <article>
        <h2><a href="/lex-news#${n.id}">${n.title}</a></h2>
        <p>${n.summary}</p>
        <p><time datetime="${n.publishedAt}">${n.publishedAt}</time> · ${n.category} · ${n.readTime}</p>
        <div>${n.tags.map(t => `<span>#${t}</span>`).join(' ')}</div>
      </article>`).join('\n')

        const newsListBodyHtml = `
    <main id="lex-news-seo" style="max-width:900px;margin:40px auto;font-family:system-ui,sans-serif;padding:0 24px;color:#e4e4e7;background:#0a0a0b">
      <h1>LEX News</h1>
      <p>${newsListDesc}</p>
      ${newsListHtml}
    </main>`

        let newsPage = replaceMeta(indexHtml, {
          title: newsListTitle,
          description: newsListDesc,
          ogUrl: `${BASE_URL}/lex-news`,
          canonical: `${BASE_URL}/lex-news`,
        })
        newsPage = injectSeoBlock(newsPage, newsListBodyHtml, 'lex-news-seo')
        writePage('/lex-news', newsPage)

        console.log(`[prerender-investor-news] Generated /investor, /uk_investor, /lex-news (${newsItems.length} news items)`)
      } catch (err) {
        console.error('[prerender-investor-news] Failed:', err)
      }
    },
  }
}

/**
 * Vite plugin that generates static HTML shells for the public marketing pages
 * /about, /about/team, /product so crawlers (Google, Bing, social media bots)
 * can index real meta tags and content without executing JavaScript. The React
 * SPA still hydrates and takes over for interactive users; the visible SEO
 * block is removed on hydration to avoid double-rendering.
 */
function prerenderAboutAndProductPlugin(): Plugin {
  return {
    name: 'prerender-about-product',
    closeBundle() {
      try {
        const root = path.resolve(__dirname)
        const distDir = path.resolve(root, 'dist')
        const indexHtml = fs.readFileSync(path.resolve(distDir, 'index.html'), 'utf-8')
        const BASE_URL = 'https://legal.org.ua'

        function replaceMeta(html: string, opts: {
          title: string; description: string; ogUrl: string; canonical: string;
          ogLocale?: string; ogImage?: string;
        }): string {
          const esc = (s: string) => s.replace(/"/g, '&quot;')
          return html
            .replace(/<title>[^<]*<\/title>/, `<title>${opts.title}</title>`)
            .replace(/<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${esc(opts.description)}" />`)
            .replace(/<meta property="og:title" content="[^"]*"\s*\/?>/, `<meta property="og:title" content="${esc(opts.title)}" />`)
            .replace(/<meta property="og:description" content="[^"]*"\s*\/?>/, `<meta property="og:description" content="${esc(opts.description)}" />`)
            .replace(/<meta property="og:url" content="[^"]*"\s*\/?>/, `<meta property="og:url" content="${opts.ogUrl}" />`)
            .replace(/<meta property="og:locale" content="[^"]*"\s*\/?>/, `<meta property="og:locale" content="${opts.ogLocale || 'en_US'}" />`)
            .replace(/<meta property="og:image" content="[^"]*"\s*\/?>/, `<meta property="og:image" content="${opts.ogImage || `${BASE_URL}/og-image.png`}" />`)
            .replace(/<meta name="twitter:title" content="[^"]*"\s*\/?>/, `<meta name="twitter:title" content="${esc(opts.title)}" />`)
            .replace(/<meta name="twitter:description" content="[^"]*"\s*\/?>/, `<meta name="twitter:description" content="${esc(opts.description)}" />`)
            .replace(/<meta name="twitter:image" content="[^"]*"\s*\/?>/, `<meta name="twitter:image" content="${opts.ogImage || `${BASE_URL}/og-image.png`}" />`)
            .replace(/<link rel="canonical" href="[^"]*"\s*\/?>/, `<link rel="canonical" href="${opts.canonical}" />`)
        }

        function writePage(route: string, html: string) {
          const outDir = route === '/' ? distDir : path.resolve(distDir, route.replace(/^\//, ''))
          fs.mkdirSync(outDir, { recursive: true })
          fs.writeFileSync(path.resolve(outDir, 'index.html'), html)
        }

        function injectSeoBlock(html: string, seoBlockHtml: string, seoId: string): string {
          return html.replace(
            '<div id="root"></div>',
            `${seoBlockHtml}\n    <div id="root"></div>\n    <script>document.getElementById('${seoId}')?.remove()</script>`
          )
        }

        function injectHreflang(html: string, route: string): string {
          const links = [
            `<link rel="alternate" hreflang="en" href="${BASE_URL}${route}?lang=en" />`,
            `<link rel="alternate" hreflang="uk" href="${BASE_URL}${route}?lang=uk" />`,
            `<link rel="alternate" hreflang="x-default" href="${BASE_URL}${route}" />`,
          ].join('\n    ')
          return html.replace('</head>', `${links}\n  </head>`)
        }

        function injectJsonLd(html: string, jsonLd: object | object[]): string {
          const arr = Array.isArray(jsonLd) ? jsonLd : [jsonLd]
          const tags = arr
            .map(j => `<script type="application/ld+json">${JSON.stringify(j)}</script>`)
            .join('\n    ')
          return html.replace('</head>', `${tags}\n  </head>`)
        }

        const organizationJsonLd = {
          '@context': 'https://schema.org',
          '@type': 'Organization',
          name: 'SecondLayer',
          legalName: 'LEX AI LLC',
          alternateName: 'LEX',
          url: BASE_URL,
          logo: `${BASE_URL}/icon-192x192.png`,
          description: 'AI-powered legal technology company building tools for law firms and corporate counsel. Semantic search across 110M+ Ukrainian court decisions, AI-queryable registry data, MCP integration for Claude/GPT.',
          foundingDate: '2024',
          founders: [
            {
              '@type': 'Person',
              name: 'Volodymyr Ovcharov',
              jobTitle: 'Co-founder & CTO',
              alumniOf: 'Kyiv Polytechnic Institute (KPI), Faculty of Applied Mathematics',
              sameAs: ['https://www.linkedin.com/in/volodymir-ovcharov/'],
            },
            {
              '@type': 'Person',
              name: 'Igor Kyrychenko',
              jobTitle: 'Co-founder & CEO',
              description: 'PhD in Law',
              sameAs: ['https://www.linkedin.com/in/ihor-kyrychenko-90503890/'],
            },
          ],
          contactPoint: {
            '@type': 'ContactPoint',
            email: 'info@legal.org.ua',
            contactType: 'Business',
          },
        }

        // ---------------------------------------------------------------
        // /about — Business Description
        // ---------------------------------------------------------------
        const aboutTitle = 'About — LEX | AI legal intelligence for Ukraine and beyond'
        const aboutDesc = 'LEX is the AI platform built by SecondLayer that turns 120M+ Ukrainian court decisions, full legislation, parliament records and 41M+ open-data registry records into structured, citation-backed answers in seconds.'
        const aboutSeo = `
    <main id="about-seo" lang="en" style="max-width:900px;margin:40px auto;font-family:system-ui,sans-serif;padding:0 24px;color:#e4e4e7;background:#0a0a0b">
      <h1>About SecondLayer / LEX</h1>
      <p>LEX is the AI platform built and operated by SecondLayer, a Ukrainian legal-tech company. We turn the entire Ukrainian legal corpus — 120 million court decisions, the full legislative code with amendment history, parliament voting records, and 41 million open-data registry records — into structured, citation-backed answers that arrive in seconds instead of days.</p>

      <h2>The problem we solve</h2>
      <p>Ukrainian legal practice runs on tools designed in the 2000s. The two largest incumbents (LIGA:ZAKON and ZakonOnline) are keyword databases with no semantic search, no AI, no analytics, no API. A practising lawyer who needs to research case law for a single matter spends 2–3 full business days digging through court records by hand. Generic LLM chatbots fill some of that gap but hallucinate, do not understand Ukrainian legal specifics, and cannot cite sources reliably.</p>

      <h2>Who we serve</h2>
      <ul>
        <li><strong>Law firms and solo practitioners</strong> — semantic search, judge analytics, case-strategy generation, document drafting.</li>
        <li><strong>In-house and corporate counsel</strong> — compliance research, contract analysis, regulatory monitoring.</li>
        <li><strong>Compliance and legal-ops teams</strong> — reproducible, auditable AI-assisted analysis with source citations.</li>
        <li><strong>Legal-tech and fintech platforms</strong> — embedded AI legal layer via API and MCP (Model Context Protocol).</li>
        <li><strong>Government and public-sector</strong> — court analytics, beneficial-ownership investigation, sanctions screening.</li>
        <li><strong>Academic and research institutions</strong> — bulk access to Ukrainian case law and legislation for empirical legal research.</li>
      </ul>

      <h2>Market context</h2>
      <p>Ukraine has 60,000+ practising lawyers, ~6,000 licensed attorneys, ~5,000 law firms, and 10,000+ corporate legal departments. The global legal-AI market is $500M+ and growing 28% YoY. Our serviceable market in Ukraine and CEE is conservatively $50M. We are the first and only platform in Ukraine to combine AI-native semantic search with the full national legal corpus and live state-registry integration.</p>

      <h2>How we are different</h2>
      <p>We are not a generic chatbot wrapper. Every recommendation drills down to the underlying court decision or legislative article. A built-in HallucinationGuard validates every citation against the source before it reaches the user. Authority weighting (instance, citation graph, motivation density, overrule status) ranks results so the lawyer immediately sees which positions are load-bearing and which are noise.</p>

      <h2>Where we operate</h2>
      <p>Headquartered in Kyiv, Ukraine. Live production deployment on AWS (eu-central-1, Frankfurt), with active expansion into European jurisdictions (UK, Spain, Germany, Netherlands, France, Estonia — country-specific data-source pages already shipped).</p>

      <p><a href="${BASE_URL}/about/team">Meet the team →</a> · <a href="${BASE_URL}/product">See the product →</a></p>
    </main>`
        const aboutJsonLd = {
          '@context': 'https://schema.org',
          '@type': 'AboutPage',
          name: aboutTitle,
          description: aboutDesc,
          url: `${BASE_URL}/about`,
          mainEntity: organizationJsonLd,
        }
        let aboutPage = replaceMeta(indexHtml, {
          title: aboutTitle,
          description: aboutDesc,
          ogUrl: `${BASE_URL}/about`,
          canonical: `${BASE_URL}/about`,
        })
        aboutPage = injectHreflang(aboutPage, '/about')
        aboutPage = injectJsonLd(aboutPage, [organizationJsonLd, aboutJsonLd])
        aboutPage = injectSeoBlock(aboutPage, aboutSeo, 'about-seo')
        writePage('/about', aboutPage)

        // ---------------------------------------------------------------
        // /about/team — Founders & Team
        // ---------------------------------------------------------------
        const teamTitle = 'Team — LEX | Founders & Engineering'
        const teamDesc = 'The team behind LEX: Volodymyr Ovcharov (Co-founder & CTO, 15+ years in data platforms and AI/ML) and Igor Kyrychenko (Co-founder & CEO, PhD in Law).'
        const teamSeo = `
    <main id="team-seo" lang="en" style="max-width:900px;margin:40px auto;font-family:system-ui,sans-serif;padding:0 24px;color:#e4e4e7;background:#0a0a0b">
      <h1>The team behind LEX</h1>
      <p>A Ukrainian-founded company combining 15+ years of large-scale data-platform engineering with deep Ukrainian legal-domain expertise. The platform is built end-to-end in-house: data-ingestion pipelines, AI orchestration, frontend, and infrastructure.</p>

      <section>
        <h2>Volodymyr Ovcharov — Co-founder &amp; CTO</h2>
        <img src="${BASE_URL}/team/volodymyr.jpg" alt="Volodymyr Ovcharov, Co-founder and CTO of SecondLayer" width="200" height="200" />
        <p>15+ years building scalable data platforms, AI/ML systems, and OSINT infrastructure. As CTO of SecondLayer, designed and shipped the platform that processes 120M+ court records via 118 AI tools using LLM orchestration, vector search, and autonomous agents.</p>
        <p><strong>Selected expertise:</strong> production RAG pipelines (Qdrant, Voyage AI, OpenAI embeddings); multi-provider LLM orchestration (OpenAI GPT-4o, Anthropic Claude Opus/Sonnet, AWS Bedrock); autonomous agentic systems with intent classification and query planning; OSINT engineering across 20+ registries; Ukrainian-language NLP; E2EE (X25519 + AES-256-GCM); WebAuthn/FIDO2; Diia digital-identity integration; blue-green CI/CD on self-hosted runners.</p>
        <p><strong>Education:</strong> BSc Applied Mathematics, Igor Sikorsky Kyiv Polytechnic Institute (KPI). Researcher, V.M. Glushkov Institute of Cybernetics, National Academy of Sciences of Ukraine.</p>
        <p><a href="https://linkedin.com/in/volodymir-ovcharov">LinkedIn</a> · <a href="mailto:volodymyr@legal.org.ua">volodymyr@legal.org.ua</a></p>
      </section>

      <section>
        <h2>Igor Kyrychenko — Co-founder &amp; CEO</h2>
        <img src="${BASE_URL}/team/igor.jpg" alt="Igor Kyrychenko, Co-founder and CEO of SecondLayer" width="200" height="200" />
        <p>PhD in Law, with deep expertise in Ukrainian and international legal practice. Director of the operating Ukrainian entity and COO of SecondLayer. Responsible for product direction, legal-domain modelling (the taxonomy of 118 MCP tools, the workflow templates for litigation, and the doctrinal weighting used in retrieval), business development, and partnerships with law firms, bar associations, and the government sector.</p>
        <p><strong>Selected expertise:</strong> Ukrainian civil, commercial, and criminal procedure; Supreme Court doctrinal analysis; legal-domain ontology design; legal-tech go-to-market in Ukraine; partnerships with the Ukrainian Bar Association and Diia (Ministry of Digital Transformation).</p>
        <p><a href="https://www.linkedin.com/in/ihor-kyrychenko-90503890/">LinkedIn</a> · <a href="mailto:igor@legal.org.ua">igor@legal.org.ua</a> · <a href="tel:+380677206353">+380 67 720 63 53</a></p>
      </section>

      <h2>The wider team</h2>
      <p>In-house engineers and contributors across backend (TypeScript / Node.js), frontend (React 19), data engineering (PostgreSQL, Qdrant, Redis), DevOps (AWS, Docker, blue-green CI/CD), and legal review by practising Ukrainian lawyers. We actively collaborate with independent open-source contributors.</p>

      <p><a href="${BASE_URL}/about">← About SecondLayer</a> · <a href="${BASE_URL}/product">See the product →</a></p>
    </main>`
        const teamJsonLd = {
          '@context': 'https://schema.org',
          '@type': 'AboutPage',
          name: teamTitle,
          description: teamDesc,
          url: `${BASE_URL}/about/team`,
          about: [
            {
              '@type': 'Person',
              name: 'Volodymyr Ovcharov',
              jobTitle: 'Co-founder & CTO',
              image: `${BASE_URL}/team/volodymyr.jpg`,
              alumniOf: 'Igor Sikorsky Kyiv Polytechnic Institute (KPI)',
              email: 'volodymyr@legal.org.ua',
              sameAs: ['https://linkedin.com/in/volodymir-ovcharov'],
              worksFor: { '@type': 'Organization', name: 'SecondLayer', url: BASE_URL },
            },
            {
              '@type': 'Person',
              name: 'Igor Kyrychenko',
              jobTitle: 'Co-founder & CEO',
              image: `${BASE_URL}/team/igor.jpg`,
              email: 'igor@legal.org.ua',
              telephone: '+380677206353',
              description: 'PhD in Law',
              sameAs: ['https://www.linkedin.com/in/ihor-kyrychenko-90503890/'],
              worksFor: { '@type': 'Organization', name: 'SecondLayer', url: BASE_URL },
            },
          ],
        }
        let teamPage = replaceMeta(indexHtml, {
          title: teamTitle,
          description: teamDesc,
          ogUrl: `${BASE_URL}/about/team`,
          canonical: `${BASE_URL}/about/team`,
          ogImage: `${BASE_URL}/team/volodymyr.jpg`,
        })
        teamPage = injectHreflang(teamPage, '/about/team')
        teamPage = injectJsonLd(teamPage, [organizationJsonLd, teamJsonLd])
        teamPage = injectSeoBlock(teamPage, teamSeo, 'team-seo')
        writePage('/about/team', teamPage)

        // ---------------------------------------------------------------
        // /product — Product / Service Details
        // ---------------------------------------------------------------
        const productTitle = 'Product — LEX | AI legal platform for Ukraine'
        const productDesc = 'LEX bundles five products around the Ukrainian legal corpus: AI research & drafting, state-registry OSINT, parliament analytics, attorney marketplace, and MCP Connect for any LLM client. Live in production on AWS.'
        const productHeroImage = `${BASE_URL}/product-screenshots/01-hero-workflow-plan.png`
        const productSeo = `
    <main id="product-seo" lang="en" style="max-width:900px;margin:40px auto;font-family:system-ui,sans-serif;padding:0 24px;color:#e4e4e7;background:#0a0a0b">
      <h1>LEX — AI legal platform for Ukraine</h1>
      <p>A single AI platform, five products, one legal corpus. LEX is a production AI platform that turns the entire Ukrainian legal corpus into citation-backed answers.</p>
      <img src="${productHeroImage}" alt="LEX AI legal research platform — auto-generated workflow plan from a single sentence" width="900" height="500" />

      <h2>1. AI Legal Research &amp; Drafting (live)</h2>
      <p>A web app where the lawyer asks a natural-language question and receives a structured, citation-backed answer in seconds.</p>
      <ul>
        <li>Semantic search across 120M+ court decisions (entire ЄДРСР, since 2006).</li>
        <li>Article-level legislation retrieval with full amendment history and word-level diff.</li>
        <li>AI-generated litigation strategies. Real client case: 11-year-old enforcement matter (UAH 11.9M) — 473 documents analysed, 9 defence strategies in 15 minutes.</li>
        <li>Judge analytics — 12,000+ judge profiles with overturn rate, decision volume, peer ranking. No other Ukrainian platform offers this.</li>
        <li>Citation graph and Shepardization — track whether a precedent is still good law.</li>
        <li>Legislative monitoring with word-level diffs and customer notifications.</li>
      </ul>

      <h2>2. State Registry &amp; OSINT (live)</h2>
      <p>Built into LEX and exposed via API. Live, fuzzy lookup across the Ukrainian state-registry stack.</p>
      <ul>
        <li>Business entities — full ЄДРПОУ corporate registry with beneficial-ownership chains.</li>
        <li>Debtors and enforcement proceedings — official Ministry-of-Justice data.</li>
        <li>Notaries, judges, attorneys — official registries indexed and searchable.</li>
        <li>Open-data lookups — invalidated passports (3.1M), public-procurement spending (12.6M+), vehicle registrations (19.5M), NGOs (1.08M), financial reports (504K), VAT payers (264K), corruption / sanctions / wanted-persons / lustration / terrorist-list registries.</li>
      </ul>

      <h2>3. Parliament &amp; Voting Analytics (live)</h2>
      <p>Bills, deputies, and voting records of the Verkhovna Rada — live and queryable. Deputy profiles with voting history and party-loyalty metrics. Bill tracking with notifications when watched bills change status.</p>

      <h2>4. Marketplace for Legal Consultations (beta)</h2>
      <p>A two-sided marketplace connecting clients with verified Ukrainian attorneys. E2EE messaging (X25519 + AES-256-GCM), Monobank payments (UAH and USD), escrow, and audit trails. Anchored in the official ЄРАУ (Unified Registry of Ukrainian Attorneys).</p>

      <h2>5. MCP Connect — AI tools for any LLM client (live)</h2>
      <p>LEX is the first and only Ukrainian legal platform with native MCP (Model Context Protocol) support. All 118 of our legal tools plug directly into Claude Desktop, ChatGPT, Cursor, and any MCP-compatible client. Free for individual developers; metered for enterprise.</p>

      <h2>Security and compliance</h2>
      <ul>
        <li>GDPR-compliant — full export, deletion, and legal-hold pipelines.</li>
        <li>DPA available for enterprise customers.</li>
        <li>E2EE for documents and consultations (X25519 + AES-256-GCM).</li>
        <li>WebAuthn / FIDO2 / multi-factor authentication.</li>
        <li>Diia digital-ID auth — first legal-tech platform in Ukraine to support the national digital identity.</li>
        <li>Independent security audit completed in March 2026 — 10 OWASP findings remediated, 7-layer defence-in-depth architecture.</li>
      </ul>

      <h2>Infrastructure</h2>
      <p>AWS (eu-central-1, Frankfurt), backed by AWS Activate. TypeScript / Node.js 20, React 19, PostgreSQL 15 with PgBouncer, Redis 7, Qdrant, Docker, Nginx. AI providers: OpenAI GPT-4o, Anthropic Claude (via Amazon Bedrock), Voyage AI embeddings. Blue-green CI/CD with self-healing test agents on a self-hosted runner.</p>

      <h2>Pricing</h2>
      <ul>
        <li>Individual lawyer — $29 / month</li>
        <li>Law firm — from $99 / month</li>
        <li>Pay-per-query API — $0.05 / query</li>
        <li>Enterprise / on-prem / VPC — custom</li>
      </ul>
      <p>Free tier — 50 credits on signup, no credit card required.</p>

      <p><a href="${BASE_URL}">Try LEX →</a> · <a href="${BASE_URL}/about">About SecondLayer</a> · <a href="${BASE_URL}/about/team">Meet the team</a> · <a href="${BASE_URL}/developer/docs">Developer API</a></p>
    </main>`
        const productJsonLd = {
          '@context': 'https://schema.org',
          '@type': 'SoftwareApplication',
          name: 'LEX — AI legal platform',
          applicationCategory: 'LegalService',
          operatingSystem: 'Web, iOS, Android',
          description: productDesc,
          url: `${BASE_URL}/product`,
          image: productHeroImage,
          screenshot: [
            `${BASE_URL}/product-screenshots/01-hero-workflow-plan.png`,
            `${BASE_URL}/product-screenshots/03-structured-legal-analysis.png`,
            `${BASE_URL}/product-screenshots/09-judge-profile.png`,
            `${BASE_URL}/product-screenshots/14-chatgpt-mcp-connected.png`,
          ],
          offers: [
            { '@type': 'Offer', name: 'Individual lawyer', price: '29.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
            { '@type': 'Offer', name: 'Law firm', price: '99.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
            { '@type': 'Offer', name: 'Pay-per-query API', price: '0.05', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
          ],
          publisher: organizationJsonLd,
        }
        let productPage = replaceMeta(indexHtml, {
          title: productTitle,
          description: productDesc,
          ogUrl: `${BASE_URL}/product`,
          canonical: `${BASE_URL}/product`,
          ogImage: productHeroImage,
        })
        productPage = injectHreflang(productPage, '/product')
        productPage = injectJsonLd(productPage, [organizationJsonLd, productJsonLd])
        productPage = injectSeoBlock(productPage, productSeo, 'product-seo')
        writePage('/product', productPage)

        console.log('[prerender-about-product] Generated /about, /about/team, /product')
      } catch (err) {
        console.error('[prerender-about-product] Failed:', err)
      }
    },
  }
}

function prerenderCISOAcademyPlugin(): Plugin {
  return {
    name: 'prerender-ciso-academy',
    closeBundle() {
      try {
        const root = path.resolve(__dirname)
        const distDir = path.resolve(root, 'dist')
        const indexHtml = fs.readFileSync(path.resolve(distDir, 'index.html'), 'utf-8')
        const BASE_URL = 'https://legal.org.ua'

        function replaceMeta(html: string, opts: {
          title: string; description: string; ogUrl: string; canonical: string;
          ogLocale?: string; ogImage?: string;
        }): string {
          const esc = (s: string) => s.replace(/"/g, '&quot;')
          return html
            .replace(/<title>[^<]*<\/title>/, `<title>${opts.title}</title>`)
            .replace(/<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${esc(opts.description)}" />`)
            .replace(/<meta property="og:title" content="[^"]*"\s*\/?>/, `<meta property="og:title" content="${esc(opts.title)}" />`)
            .replace(/<meta property="og:description" content="[^"]*"\s*\/?>/, `<meta property="og:description" content="${esc(opts.description)}" />`)
            .replace(/<meta property="og:url" content="[^"]*"\s*\/?>/, `<meta property="og:url" content="${opts.ogUrl}" />`)
            .replace(/<meta property="og:locale" content="[^"]*"\s*\/?>/, `<meta property="og:locale" content="${opts.ogLocale || 'en_US'}" />`)
            .replace(/<meta property="og:image" content="[^"]*"\s*\/?>/, `<meta property="og:image" content="${opts.ogImage || `${BASE_URL}/og-image.png`}" />`)
            .replace(/<meta name="twitter:title" content="[^"]*"\s*\/?>/, `<meta name="twitter:title" content="${esc(opts.title)}" />`)
            .replace(/<meta name="twitter:description" content="[^"]*"\s*\/?>/, `<meta name="twitter:description" content="${esc(opts.description)}" />`)
            .replace(/<meta name="twitter:image" content="[^"]*"\s*\/?>/, `<meta name="twitter:image" content="${opts.ogImage || `${BASE_URL}/og-image.png`}" />`)
            .replace(/<link rel="canonical" href="[^"]*"\s*\/?>/, `<link rel="canonical" href="${opts.canonical}" />`)
        }

        function writePage(route: string, html: string) {
          const outDir = path.resolve(distDir, route.replace(/^\//, ''))
          fs.mkdirSync(outDir, { recursive: true })
          fs.writeFileSync(path.resolve(outDir, 'index.html'), html)
        }

        function injectHreflang(html: string, route: string): string {
          const links = [
            `<link rel="alternate" hreflang="en" href="${BASE_URL}${route}?lang=en" />`,
            `<link rel="alternate" hreflang="uk" href="${BASE_URL}${route}?lang=uk" />`,
            `<link rel="alternate" hreflang="x-default" href="${BASE_URL}${route}" />`,
          ].join('\n    ')
          return html.replace('</head>', `${links}\n  </head>`)
        }

        function injectJsonLd(html: string, jsonLd: object | object[]): string {
          const arr = Array.isArray(jsonLd) ? jsonLd : [jsonLd]
          const tags = arr
            .map(j => `<script type="application/ld+json">${JSON.stringify(j)}</script>`)
            .join('\n    ')
          return html.replace('</head>', `${tags}\n  </head>`)
        }

        function injectSeoBlock(html: string, seoBlockHtml: string, seoId: string): string {
          return html.replace(
            '<div id="root"></div>',
            `${seoBlockHtml}\n    <div id="root"></div>\n    <script>document.getElementById('${seoId}')?.remove()</script>`
          )
        }

        const title = 'CISO Academy — QA to AppSec in 12 months | legal.org.ua'
        const description = 'A 12-month practical training plan for transitioning from QA Automation to Application Security. From networking and cryptography to OWASP, cloud security, and your first AppSec role.'

        const seoHtml = `
    <main id="cisoacademy-seo" lang="en" style="max-width:900px;margin:40px auto;font-family:system-ui,sans-serif;padding:0 24px">
      <h1>CISO Academy — QA Automation to AppSec in 12 Months</h1>
      <p>A month-by-month training plan built around practice. Each topic produces a concrete artifact: a dissected CVE, a written exploit, a vulnerability found in a training application. Designed for QA Automation engineers with API testing experience transitioning to Application Security.</p>

      <h2>Phase 1: Foundation (Months 1–3)</h2>
      <h3>Month 1: Network Literacy and Protocols</h3>
      <p>OSI model, TCP/IP, HTTP/1.1 &amp; HTTP/2 at the byte level, TLS handshake and certificates, DNS attacks (rebinding, cache poisoning, exfiltration). Practice: Wireshark traffic analysis, curl, Burp Suite, MITM proxy in Python.</p>
      <h3>Month 2: Operating Systems and Linux Internals</h3>
      <p>Processes, UID/GID, SUID/SGID, file system internals, bash, systemd, iptables/nftables, tcpdump. Windows basics: AD, NTLM, Kerberos. Practice: privilege escalation via SUID on a vulnerable VM.</p>
      <h3>Month 3: Cryptography Without the Math</h3>
      <p>AES, RSA, ECC, hash functions, HMAC, key derivation (PBKDF2, Argon2, bcrypt), JWT deep dive. Common mistakes: ECB mode, nonce reuse, hardcoded secrets. Practice: cryptopals.com first set.</p>

      <h2>Phase 2: Web Vulnerabilities as Craft (Months 4–7)</h2>
      <h3>Month 4: OWASP Top 10</h3>
      <p>SQL/NoSQL/command injection, XSS (reflected, stored, DOM-based), CSRF, SSRF, XXE, IDOR, insecure deserialization. Practice: PortSwigger Web Security Academy labs.</p>
      <h3>Month 5: Advanced Web Exploitation</h3>
      <p>Race conditions, HTTP request smuggling (CL.TE, TE.CL), prototype pollution, web cache poisoning, OAuth 2.0/OIDC attacks. Practice: PortSwigger Practitioner level.</p>
      <h3>Month 6: API Security</h3>
      <p>OWASP API Security Top 10, BOLA/IDOR, GraphQL security, gRPC, rate limiting. Practice: OWASP crAPI and VAmPI exploitation.</p>
      <h3>Month 7: Authentication &amp; Authorization</h3>
      <p>SAML, OAuth, OIDC attacks, session management, MFA bypasses, WebAuthn, RBAC vs ABAC vs ReBAC. Practice: Keycloak local setup and exploitation.</p>

      <h2>Phase 3: Defensive AppSec (Months 8–11)</h2>
      <h3>Month 8: Secure SDLC &amp; Threat Modeling</h3>
      <p>STRIDE, PASTA, data flow diagrams, integrating security into development. Practice: full threat model for a SaaS architecture.</p>
      <h3>Month 9: SAST, DAST, SCA Toolkit</h3>
      <p>Semgrep, CodeQL, Snyk, Trivy, OWASP ZAP, gitleaks, trufflehog. Practice: full security pipeline in GitHub Actions.</p>
      <h3>Month 10: Secure Code Review</h3>
      <p>Reading code in Python, JS/TS, Go, Java for vulnerabilities. Studying real CVE fixes. Practice: dissect 10 public CVEs to the changed line.</p>
      <h3>Month 11: Cloud Security</h3>
      <p>AWS/GCP/Azure IAM, VPC, secrets management, Kubernetes security, CloudTrail, GuardDuty. Practice: flaws.cloud and flaws2.cloud CTFs.</p>

      <h2>Phase 4: Professional Development (Month 12+)</h2>
      <h3>Month 12: Portfolio &amp; Positioning</h3>
      <p>GitHub portfolio, PortSwigger Practitioner certification, HackerOne/Bugcrowd profile, LinkedIn repositioning. Target: 3+ CVE analyses, 1 security tool, 1+ bug bounty report.</p>
      <h3>Month 13: Certifications</h3>
      <p>BSCP ($90), TCM PNPT, OffSec OSCP. Target positions: Security Automation Engineer, AppSec Engineer, DevSecOps.</p>

      <h2>Essential Reading</h2>
      <ul>
        <li><a href="https://portswigger.net/daily-swig">PortSwigger Daily Swig</a> — daily security news</li>
        <li><a href="https://tldrsec.com/">tl;dr sec (Clint Gibler)</a> — best weekly AppSec newsletter</li>
        <li><a href="https://googleprojectzero.blogspot.com/">Project Zero blog</a> — deep technical analyses from Google</li>
        <li><a href="https://blog.orange.tw/">Orange Tsai</a> — world-class web security research</li>
        <li><a href="https://portswigger.net/research/james-kettle">James Kettle</a> — HTTP request smuggling research</li>
      </ul>

      <p><a href="${BASE_URL}/career">Career at LEX →</a> · <a href="${BASE_URL}/product">See the product →</a></p>
    </main>`

        const jsonLd = {
          '@context': 'https://schema.org',
          '@type': 'Course',
          name: 'CISO Academy — QA to AppSec in 12 months',
          description,
          provider: {
            '@type': 'Organization',
            name: 'SecondLayer',
            url: BASE_URL,
          },
          url: `${BASE_URL}/cisoacademy`,
          educationalLevel: 'Intermediate',
          timeRequired: 'P12M',
          teaches: 'Application Security, OWASP, Cloud Security, Threat Modeling, Secure Code Review',
        }

        let page = replaceMeta(indexHtml, {
          title,
          description,
          ogUrl: `${BASE_URL}/cisoacademy`,
          canonical: `${BASE_URL}/cisoacademy`,
        })
        page = injectHreflang(page, '/cisoacademy')
        page = injectJsonLd(page, jsonLd)
        page = injectSeoBlock(page, seoHtml, 'cisoacademy-seo')
        writePage('/cisoacademy', page)

        console.log('[prerender-ciso-academy] Generated /cisoacademy')
      } catch (err) {
        console.error('[prerender-ciso-academy] Failed:', err)
      }
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const isDocker = !!process.env.DOCKER_ENV
  const certsDir = path.resolve(__dirname, 'certs')
  const certFile = path.join(certsDir, 'local.legal.org.ua+2.pem')
  const keyFile = path.join(certsDir, 'local.legal.org.ua+2-key.pem')
  const hasLocalCerts = !isDocker && fs.existsSync(certFile) && fs.existsSync(keyFile)

  return {
    plugins: [react(), sitemapPlugin(), prerenderDocsPlugin(), prerenderBlogPlugin(), prerenderInvestorAndNewsPlugin(), prerenderAboutAndProductPlugin(), prerenderCISOAcademyPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    define: {
      'import.meta.env.VITE_BUILD_TIME': JSON.stringify(new Date().toISOString()),
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(
        process.env.APP_VERSION ||
        (() => { try { return execSync('git tag -l "v*" --sort=-version:refname 2>/dev/null').toString().trim().split('\n')[0]; } catch { return ''; } })() ||
        (() => { try { const v = fs.readFileSync(path.resolve(__dirname, '..', 'VERSION'), 'utf8'); const m = v.match(/BACKEND_VERSION=(.+)/); return m ? m[1] : v.trim(); } catch { return 'dev'; } })()
      ),
      'import.meta.env.VITE_APP_FRONTEND_VERSION': JSON.stringify(
        process.env.APP_FRONTEND_VERSION ||
        (() => { try { return execSync('git tag -l "fe-v*" --sort=-version:refname 2>/dev/null').toString().trim().split('\n')[0]; } catch { return ''; } })() ||
        (() => { try { const v = fs.readFileSync(path.resolve(__dirname, '..', 'VERSION'), 'utf8'); const m = v.match(/FRONTEND_VERSION=(.+)/); return m ? m[1] : ''; } catch { return ''; } })()
      ),
    },
    build: {
      outDir: mode === 'staging' ? 'dist-staging' : 'dist',
      sourcemap: mode === 'staging' || mode === 'development',
      rollupOptions: {
        output: {
          // Pin shared libraries and base utilities into dedicated vendor
          // chunks. Otherwise rolldown places axios + apiClient + BaseService
          // alongside the main chunk, while service classes that extend
          // BaseService end up in feature chunks, producing circular imports
          // (feature -> index -> feature). At module init the imported binding
          // is undefined and the app crashes ("Cannot read properties of
          // undefined (reading 'create')", "Class extends value undefined").
          manualChunks(id: string) {
            if (id.includes('/node_modules/axios/')) return 'vendor-axios'
            if (
              id.includes('/src/utils/api/') ||
              id.includes('/src/utils/api-client') ||
              id.includes('/src/services/base/')
            ) {
              return 'vendor-api'
            }
          },
        },
      },
    },
    server: {
      host: true,
      allowedHosts: ['local.legal.org.ua', 'local-platform.legal.org.ua', 'usa.legal.org.ua', 'uk.legal.org.ua', 'de.legal.org.ua', 'fr.legal.org.ua', 'nl.legal.org.ua', 'ee.legal.org.ua', 'eu.legal.org.ua', 'ua.legal.org.ua'],
      ...(hasLocalCerts && {
        https: {
          cert: fs.readFileSync(certFile),
          key: fs.readFileSync(keyFile),
        },
      }),
      hmr: {
        host: 'local.legal.org.ua',
        ...(isDocker ? { clientPort: 443, protocol: 'wss' } : { port: 5173, protocol: 'wss' }),
      },
      watch: isDocker ? {
        usePolling: true,
        interval: 1000,
      } : undefined,
      proxy: mode === 'development' ? {
        '/api': {
          target: 'https://stage.legal.org.ua',
          changeOrigin: true,
        },
      } : undefined,
    },
  }
})
