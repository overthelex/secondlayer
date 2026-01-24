import { LegislationReference } from './legislation-service';

export interface RenderOptions {
  includeNavigation?: boolean;
  highlightArticles?: string[];
  maxArticlesPerPage?: number;
  theme?: 'light' | 'dark';
  format?: 'full' | 'compact';
}

export class LegislationRenderer {
  renderArticleHTML(article: LegislationReference, options: RenderOptions = {}): string {
    const theme = options.theme || 'light';
    const format = options.format || 'full';

    return `
<!DOCTYPE html>
<html lang="uk">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Стаття ${article.article_number} - ${article.rada_id}</title>
    ${this.getStyles(theme, format)}
</head>
<body>
    <div class="container">
        <div class="article-header">
            <div class="article-number">Стаття ${article.article_number}</div>
            ${article.title ? `<h1 class="article-title">${this.escapeHtml(article.title)}</h1>` : ''}
            <div class="article-meta">
                <a href="${article.url}" target="_blank" class="source-link">Переглянути на zakon.rada.gov.ua →</a>
            </div>
        </div>
        
        <div class="article-content">
            ${article.full_text_html || this.formatPlainText(article.full_text)}
        </div>

        ${format === 'full' ? this.renderFooter() : ''}
    </div>
</body>
</html>`;
  }

  renderMultipleArticlesHTML(
    articles: LegislationReference[],
    legislationTitle: string,
    options: RenderOptions = {}
  ): string {
    const theme = options.theme || 'light';
    const highlightArticles = options.highlightArticles || [];

    return `
<!DOCTYPE html>
<html lang="uk">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${this.escapeHtml(legislationTitle)}</title>
    ${this.getStyles(theme, 'full')}
    <style>
        .article-block {
            margin-bottom: 40px;
            padding-bottom: 40px;
            border-bottom: 1px solid #e0e0e0;
        }
        .article-block:last-child {
            border-bottom: none;
        }
        .article-block.highlighted {
            background: #fffbea;
            padding: 20px;
            border-left: 4px solid #f59e0b;
        }
        .toc {
            background: #f9f9f9;
            padding: 20px;
            margin-bottom: 40px;
            border-radius: 4px;
        }
        .toc h2 {
            margin-top: 0;
            font-size: 18px;
        }
        .toc ul {
            list-style: none;
            padding: 0;
        }
        .toc li {
            margin: 8px 0;
        }
        .toc a {
            color: #000;
            text-decoration: none;
        }
        .toc a:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="legislation-header">
            <h1>${this.escapeHtml(legislationTitle)}</h1>
            <p class="meta">${articles.length} ${this.pluralize(articles.length, 'стаття', 'статті', 'статей')}</p>
        </div>

        ${options.includeNavigation ? this.renderTableOfContents(articles) : ''}

        <div class="articles-container">
            ${articles.map(article => this.renderArticleBlock(article, highlightArticles.includes(article.article_number))).join('\n')}
        </div>

        ${this.renderFooter()}
    </div>
</body>
</html>`;
  }

  private renderArticleBlock(article: LegislationReference, highlighted: boolean): string {
    return `
        <div class="article-block ${highlighted ? 'highlighted' : ''}" id="article-${article.article_number}">
            <div class="article-header">
                <div class="article-number">Стаття ${article.article_number}</div>
                ${article.title ? `<h2 class="article-title">${this.escapeHtml(article.title)}</h2>` : ''}
            </div>
            
            <div class="article-content">
                ${article.full_text_html || this.formatPlainText(article.full_text)}
            </div>
        </div>`;
  }

  private renderTableOfContents(articles: LegislationReference[]): string {
    return `
        <div class="toc">
            <h2>Зміст</h2>
            <ul>
                ${articles.map(article => `
                    <li>
                        <a href="#article-${article.article_number}">
                            Стаття ${article.article_number}${article.title ? `: ${this.escapeHtml(article.title)}` : ''}
                        </a>
                    </li>
                `).join('')}
            </ul>
        </div>`;
  }

  private getStyles(theme: 'light' | 'dark', format: 'full' | 'compact'): string {
    const isDark = theme === 'dark';
    const isCompact = format === 'compact';

    return `
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
            line-height: 1.7;
            color: ${isDark ? '#e0e0e0' : '#1a1a1a'};
            background: ${isDark ? '#1a1a1a' : '#f5f5f5'};
            padding: ${isCompact ? '10px' : '20px'};
        }
        .container {
            max-width: ${isCompact ? '100%' : '900px'};
            margin: 0 auto;
            background: ${isDark ? '#2d2d2d' : 'white'};
            padding: ${isCompact ? '20px' : '40px'};
            box-shadow: ${isCompact ? 'none' : '0 1px 3px rgba(0,0,0,0.1)'};
        }
        .legislation-header h1 {
            font-size: ${isCompact ? '20px' : '24px'};
            font-weight: 600;
            margin-bottom: 8px;
            color: ${isDark ? '#fff' : '#000'};
        }
        .article-header {
            margin-bottom: 20px;
        }
        .article-number {
            display: inline-block;
            font-size: ${isCompact ? '11px' : '12px'};
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: ${isDark ? '#999' : '#666'};
            margin-bottom: 8px;
        }
        .article-title {
            font-size: ${isCompact ? '16px' : '20px'};
            font-weight: 600;
            color: ${isDark ? '#fff' : '#000'};
            margin: 8px 0;
        }
        .article-meta {
            margin-top: 8px;
        }
        .source-link {
            font-size: ${isCompact ? '12px' : '13px'};
            color: ${isDark ? '#60a5fa' : '#000'};
            text-decoration: none;
        }
        .source-link:hover {
            text-decoration: underline;
        }
        .article-content {
            font-size: ${isCompact ? '14px' : '15px'};
            line-height: 1.7;
            color: ${isDark ? '#d0d0d0' : '#333'};
        }
        .article-content p {
            margin: 16px 0;
        }
        .article-content ol, .article-content ul {
            margin: 16px 0 16px 24px;
        }
        .article-content li {
            margin: 8px 0;
        }
        .meta {
            color: ${isDark ? '#999' : '#666'};
            font-size: ${isCompact ? '13px' : '14px'};
            margin-bottom: 20px;
        }
        .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid ${isDark ? '#444' : '#e0e0e0'};
            font-size: 13px;
            color: ${isDark ? '#666' : '#999'};
        }
        a {
            color: ${isDark ? '#60a5fa' : '#000'};
        }
    </style>`;
  }

  private formatPlainText(text: string): string {
    const paragraphs = text.split(/\n\n+/);
    return paragraphs
      .map(p => {
        const trimmed = p.trim();
        if (!trimmed) return '';
        
        if (/^\d+\)/.test(trimmed)) {
          return `<p>${this.escapeHtml(trimmed)}</p>`;
        }
        
        return `<p>${this.escapeHtml(trimmed)}</p>`;
      })
      .join('\n');
  }

  private renderFooter(): string {
    return `
        <div class="footer">
            Згенеровано: SecondLayer MCP Backend • Дані з zakon.rada.gov.ua
        </div>`;
  }

  private escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, m => map[m]);
  }

  private pluralize(count: number, one: string, few: string, many: string): string {
    const mod10 = count % 10;
    const mod100 = count % 100;

    if (mod10 === 1 && mod100 !== 11) {
      return one;
    }
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
      return few;
    }
    return many;
  }

  renderProgressiveLoadingHTML(
    legislationTitle: string,
    radaId: string,
    totalArticles: number,
    _tableOfContents: any[]
  ): string {
    return `
<!DOCTYPE html>
<html lang="uk">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${this.escapeHtml(legislationTitle)}</title>
    ${this.getStyles('light', 'full')}
    <style>
        .loading {
            text-align: center;
            padding: 40px;
            color: #666;
        }
        .article-skeleton {
            background: #f0f0f0;
            height: 200px;
            margin: 20px 0;
            border-radius: 4px;
            animation: pulse 1.5s ease-in-out infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        .load-more {
            text-align: center;
            margin: 40px 0;
        }
        .load-more button {
            background: #000;
            color: white;
            border: none;
            padding: 12px 24px;
            font-size: 14px;
            cursor: pointer;
            border-radius: 4px;
        }
        .load-more button:hover {
            background: #333;
        }
    </style>
    <script>
        let currentPage = 0;
        const articlesPerPage = 10;
        const radaId = '${radaId}';

        async function loadMoreArticles() {
            const button = document.getElementById('load-more-btn');
            button.disabled = true;
            button.textContent = 'Завантаження...';

            // This would call your API endpoint
            // const response = await fetch(\`/api/legislation/\${radaId}/articles?page=\${currentPage}&limit=\${articlesPerPage}\`);
            // const articles = await response.json();
            
            // For now, show skeleton
            const container = document.getElementById('articles-container');
            container.innerHTML += '<div class="article-skeleton"></div>';
            
            currentPage++;
            button.disabled = false;
            button.textContent = 'Завантажити ще';
        }
    </script>
</head>
<body>
    <div class="container">
        <div class="legislation-header">
            <h1>${this.escapeHtml(legislationTitle)}</h1>
            <p class="meta">${totalArticles} ${this.pluralize(totalArticles, 'стаття', 'статті', 'статей')}</p>
        </div>

        <div id="articles-container">
            <div class="loading">
                <p>Завантаження статей...</p>
                <div class="article-skeleton"></div>
                <div class="article-skeleton"></div>
            </div>
        </div>

        <div class="load-more">
            <button id="load-more-btn" onclick="loadMoreArticles()">Завантажити статті</button>
        </div>

        ${this.renderFooter()}
    </div>
</body>
</html>`;
  }
}
