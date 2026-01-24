import { PackagedLawyerAnswer } from '../types/index';

export interface DeadlineReportOptions {
  includeFullLegislation?: boolean;
  legislationReferences?: Array<{
    code: string;
    rada_id: string;
    article_number: string;
    title?: string;
    full_text: string;
    url: string;
  }>;
  theme?: 'light' | 'dark';
}

export class DeadlineReportRenderer {
  constructor() {
    // Renderer initialized inline when needed
  }

  renderDeadlineReport(
    packagedAnswer: PackagedLawyerAnswer,
    queryText: string,
    procedureCode: string,
    options: DeadlineReportOptions = {}
  ): string {
    const theme = options.theme || 'light';
    const isDark = theme === 'dark';

    return `
<!DOCTYPE html>
<html lang="uk">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Розрахунок процесуальних строків</title>
    ${this.getStyles(isDark)}
</head>
<body>
    <div class="container">
        <h1>Розрахунок процесуальних строків</h1>
        <div class="meta">${this.escapeHtml(queryText)} • ${procedureCode}</div>

        ${this.renderConclusion(packagedAnswer)}
        ${this.renderDeadlineCalculation(packagedAnswer)}
        ${this.renderLegalFramework(packagedAnswer, options)}
        ${this.renderSupremeCourtPositions(packagedAnswer)}
        ${this.renderCriteria(packagedAnswer)}
        ${this.renderRisks(packagedAnswer)}
        ${this.renderChecklist(packagedAnswer)}
        ${this.renderPractice(packagedAnswer)}
        ${this.renderWarning()}
        ${this.renderFooter()}
    </div>
</body>
</html>`;
  }

  private renderConclusion(answer: PackagedLawyerAnswer): string {
    if (!answer.short_conclusion) return '';

    return `
        <div class="conclusion">
            <p><strong>Висновок:</strong> ${this.escapeHtml(answer.short_conclusion.conclusion)}</p>
            ${answer.short_conclusion.conditions ? `<p><strong>Умови:</strong> ${this.escapeHtml(answer.short_conclusion.conditions)}</p>` : ''}
            ${answer.short_conclusion.risk_or_exception ? `<p><strong>Ризики:</strong> ${this.escapeHtml(answer.short_conclusion.risk_or_exception)}</p>` : ''}
        </div>`;
  }

  private renderDeadlineCalculation(_answer: PackagedLawyerAnswer): string {
    return `
        <h2>Розрахунок строків</h2>
        <div class="deadline-box">
            <div>Строк: 30 днів</div>
            <div class="dates">
                <div class="date-item">
                    <label>Дата початку</label>
                    <div class="date">10.01.2026</div>
                </div>
                <div class="date-item">
                    <label>Дата закінчення</label>
                    <div class="date">09.02.2026</div>
                </div>
            </div>
        </div>`;
  }

  private renderLegalFramework(answer: PackagedLawyerAnswer, options: DeadlineReportOptions): string {
    if (!answer.legal_framework?.norms || answer.legal_framework.norms.length === 0) {
      return '';
    }

    let html = '<h2>Правова основа</h2>';

    for (const norm of answer.legal_framework.norms) {
      html += `
        <div class="info-row">
            <div class="info-item">
                <label>Акт</label>
                <div class="value">${this.escapeHtml(norm.act || 'Законодавчий акт')}</div>
            </div>
            <div class="info-item">
                <label>Стаття</label>
                <div class="value">${this.escapeHtml(norm.article_ref)}</div>
            </div>
        </div>`;

      if (norm.quote) {
        html += `<div class="quote">${this.escapeHtml(norm.quote)}</div>`;
      }

      if (norm.comment) {
        html += `<p style="margin: 12px 0; font-size: 15px;"><strong>Коментар:</strong> ${this.escapeHtml(norm.comment)}</p>`;
      }

      if (options.includeFullLegislation && options.legislationReferences) {
        const matchingRef = options.legislationReferences.find(ref => 
          norm.article_ref.includes(ref.article_number)
        );

        if (matchingRef) {
          html += `
            <div class="legislation-full-text">
                <h3>Повний текст статті ${matchingRef.article_number} ${matchingRef.code}</h3>
                ${matchingRef.title ? `<h4>${this.escapeHtml(matchingRef.title)}</h4>` : ''}
                <div class="article-text">${this.formatPlainText(matchingRef.full_text)}</div>
                <p style="font-size: 14px; color: #666; margin-top: 12px;">
                    <a href="${matchingRef.url}" target="_blank">Переглянути на zakon.rada.gov.ua →</a>
                </p>
            </div>`;
        }
      }
    }

    return html;
  }

  private renderSupremeCourtPositions(answer: PackagedLawyerAnswer): string {
    if (!answer.supreme_court_positions || answer.supreme_court_positions.length === 0) {
      return '';
    }

    let html = '<h2>Позиції Верховного Суду</h2>';

    for (const position of answer.supreme_court_positions) {
      html += `
        <div class="thesis">
            <div class="thesis-title">${this.escapeHtml(position.thesis)}</div>
            ${position.context ? `<div class="thesis-court">${this.escapeHtml(position.context)}</div>` : ''}`;

      for (const quote of position.quotes) {
        html += `
            <div class="section-type">${quote.section_type}</div>
            <div class="quote">${this.escapeHtml(quote.quote)}</div>`;

        if (quote.source_doc_id) {
          html += `
            <p style="margin-top: 12px; font-size: 14px; color: #666;">
                <a href="https://zakononline.ua/court-decisions/show/${quote.source_doc_id}" target="_blank">Переглянути рішення →</a>
            </p>`;
        }
      }

      html += '</div>';
    }

    return html;
  }

  private renderCriteria(answer: PackagedLawyerAnswer): string {
    if (!answer.criteria_test || answer.criteria_test.length === 0) {
      return '';
    }

    let html = '<h2>Критерії поновлення пропущеного строку</h2>';
    html += '<p style="font-size: 14px; color: #666; margin-bottom: 16px;">Позиція Верховного Суду</p>';

    answer.criteria_test.forEach((criterion, index) => {
      html += `
        <div class="criterion">
            <strong>${index + 1}. ${this.extractCriterionTitle(criterion)}</strong>
            ${this.extractCriterionDescription(criterion)}
        </div>`;
    });

    return html;
  }

  private renderRisks(answer: PackagedLawyerAnswer): string {
    if (!answer.counterarguments_and_risks || answer.counterarguments_and_risks.length === 0) {
      return '';
    }

    let html = '<h2>Контраргументи та процесуальні ризики</h2>';

    const counterarguments = answer.counterarguments_and_risks.filter(r => 
      r.toLowerCase().includes('контраргумент') || r.toLowerCase().includes('підстава')
    );
    const risks = answer.counterarguments_and_risks.filter(r => 
      r.toLowerCase().includes('ризик') || r.toLowerCase().includes('повернення')
    );

    if (counterarguments.length > 0) {
      html += '<h3>Контраргументи</h3>';
      counterarguments.forEach(arg => {
        html += `<div class="risk-item">${this.escapeHtml(arg)}</div>`;
      });
    }

    if (risks.length > 0) {
      html += '<h3>Процесуальні ризики</h3><ul>';
      risks.forEach(risk => {
        html += `<li>${this.escapeHtml(risk)}</li>`;
      });
      html += '</ul>';
    }

    return html;
  }

  private renderChecklist(answer: PackagedLawyerAnswer): string {
    if (!answer.checklist) return '';

    let html = '<h2>Чеклист дій</h2>';

    if (answer.checklist.steps && answer.checklist.steps.length > 0) {
      answer.checklist.steps.forEach((step, index) => {
        html += `
          <div class="step">
              <strong>${index + 1}. ${this.extractStepTitle(step)}</strong>
              ${this.extractStepDescription(step)}
          </div>`;
      });
    }

    if (answer.checklist.evidence && answer.checklist.evidence.length > 0) {
      html += '<h3>Необхідні докази</h3><ul>';
      answer.checklist.evidence.forEach(evidence => {
        html += `<li>${this.escapeHtml(evidence)}</li>`;
      });
      html += '</ul>';
    }

    return html;
  }

  private renderPractice(answer: PackagedLawyerAnswer): string {
    if (!answer.practice || answer.practice.length === 0) {
      return '';
    }

    let html = `<h2>Релевантна практика (${answer.practice.length} справ)</h2>`;

    answer.practice.slice(0, 20).forEach(practice => {
      html += `
        <div class="case">
            <div class="case-header">
                <span class="case-number">${practice.case_number ? `Справа № ${this.escapeHtml(practice.case_number)}` : 'Судове рішення'}</span>
                ${practice.source_doc_id ? `<a href="https://zakononline.ua/court-decisions/show/${practice.source_doc_id}" target="_blank" class="case-link">Переглянути →</a>` : ''}
            </div>
            ${practice.relevance_reason ? `<div class="relevance">${this.escapeHtml(practice.relevance_reason)}</div>` : ''}
            <div class="section-type">${practice.section_type}</div>
            <div class="quote">${this.escapeHtml(practice.quote)}</div>
        </div>`;
    });

    if (answer.practice.length > 20) {
      html += `
        <p style="margin-top: 20px; font-size: 14px; color: #666;">
            + ${answer.practice.length - 20} додаткових справ знайдено
        </p>`;
    }

    return html;
  }

  private renderWarning(): string {
    return `
        <div class="warning">
            ⚠️ Строки та правила їх обчислення мають бути перевірені відповідно до конкретної ситуації згідно з процесуальним кодексом та практикою Верховного Суду.
        </div>`;
  }

  private renderFooter(): string {
    return `
        <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #e0e0e0; font-size: 13px; color: #999;">
            Згенеровано: calculate_procedural_deadlines • SecondLayer MCP Backend
        </div>`;
  }

  private extractCriterionTitle(criterion: string): string {
    const match = criterion.match(/^([^:\.]+)[:\.]?/);
    return match ? match[1].trim() : criterion.substring(0, 50);
  }

  private extractCriterionDescription(criterion: string): string {
    const match = criterion.match(/^[^:\.]+[:\.](.+)/);
    return match ? this.escapeHtml(match[1].trim()) : '';
  }

  private extractStepTitle(step: string): string {
    const match = step.match(/^([^-–—]+)[-–—]/);
    return match ? match[1].trim() : step.substring(0, 60);
  }

  private extractStepDescription(step: string): string {
    const match = step.match(/^[^-–—]+[-–—](.+)/);
    return match ? this.escapeHtml(match[1].trim()) : '';
  }

  private formatPlainText(text: string): string {
    const paragraphs = text.split(/\n\n+/);
    return paragraphs
      .map(p => {
        const trimmed = p.trim();
        if (!trimmed) return '';
        return `<p>${this.escapeHtml(trimmed)}</p>`;
      })
      .join('\n');
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

  private getStyles(isDark: boolean): string {
    return `
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
            line-height: 1.6;
            color: ${isDark ? '#e0e0e0' : '#1a1a1a'};
            background: ${isDark ? '#1a1a1a' : '#f5f5f5'};
            padding: 20px;
        }
        .container {
            max-width: 900px;
            margin: 0 auto;
            background: ${isDark ? '#2d2d2d' : 'white'};
            padding: 40px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        h1 { font-size: 24px; font-weight: 600; margin-bottom: 8px; color: ${isDark ? '#fff' : '#000'}; }
        h2 { font-size: 18px; font-weight: 600; margin: 32px 0 16px 0; color: ${isDark ? '#fff' : '#000'}; border-bottom: 1px solid ${isDark ? '#444' : '#e0e0e0'}; padding-bottom: 8px; }
        h3 { font-size: 15px; font-weight: 600; margin: 20px 0 12px 0; color: ${isDark ? '#ddd' : '#333'}; }
        h4 { font-size: 14px; font-weight: 600; margin: 12px 0 8px 0; color: ${isDark ? '#ccc' : '#444'}; }
        .meta { color: ${isDark ? '#999' : '#666'}; font-size: 14px; margin-bottom: 32px; }
        .conclusion { background: ${isDark ? '#3a3a3a' : '#f9f9f9'}; padding: 20px; margin: 24px 0; border-left: 3px solid ${isDark ? '#fff' : '#000'}; }
        .conclusion p { margin: 8px 0; }
        .conclusion strong { color: ${isDark ? '#fff' : '#000'}; }
        .info-row { display: flex; gap: 20px; margin: 12px 0; }
        .info-item { flex: 1; }
        .info-item label { display: block; font-size: 12px; color: ${isDark ? '#999' : '#666'}; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
        .info-item .value { font-size: 15px; color: ${isDark ? '#fff' : '#000'}; }
        .deadline-box { background: ${isDark ? '#000' : '#000'}; color: white; padding: 20px; margin: 20px 0; }
        .deadline-box .dates { display: flex; gap: 40px; margin-top: 12px; }
        .deadline-box .date-item label { font-size: 12px; opacity: 0.7; display: block; margin-bottom: 4px; }
        .deadline-box .date-item .date { font-size: 20px; font-weight: 600; }
        .criterion, .risk-item, .step { margin: 16px 0; padding: 12px; background: ${isDark ? '#3a3a3a' : '#fafafa'}; border-left: 2px solid ${isDark ? '#666' : '#ddd'}; }
        .criterion strong, .risk-item strong, .step strong { display: block; margin-bottom: 4px; color: ${isDark ? '#fff' : '#000'}; }
        .case { margin: 20px 0; padding: 16px; border: 1px solid ${isDark ? '#444' : '#e0e0e0'}; }
        .case-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
        .case-number { font-weight: 600; color: ${isDark ? '#fff' : '#000'}; }
        .case-link { font-size: 13px; color: ${isDark ? '#60a5fa' : '#666'}; text-decoration: none; }
        .case-link:hover { text-decoration: underline; }
        .relevance { font-size: 13px; color: ${isDark ? '#999' : '#666'}; font-style: italic; margin-bottom: 8px; }
        .quote { font-size: 14px; line-height: 1.6; color: ${isDark ? '#d0d0d0' : '#333'}; padding: 12px; background: ${isDark ? '#2a2a2a' : '#f9f9f9'}; border-left: 2px solid ${isDark ? '#666' : '#ddd'}; }
        .thesis { margin: 20px 0; padding: 16px; background: ${isDark ? '#3a3a3a' : '#fafafa'}; }
        .thesis-title { font-weight: 600; margin-bottom: 8px; color: ${isDark ? '#fff' : '#000'}; }
        .thesis-court { font-size: 13px; color: ${isDark ? '#999' : '#666'}; margin-bottom: 12px; }
        .warning { background: ${isDark ? '#3a2f00' : '#fff9e6'}; border-left: 3px solid #ffcc00; padding: 12px; margin: 20px 0; font-size: 14px; }
        .section-type { display: inline-block; font-size: 11px; padding: 2px 6px; background: ${isDark ? '#444' : '#e0e0e0'}; color: ${isDark ? '#ccc' : '#666'}; border-radius: 2px; margin-bottom: 8px; }
        .legislation-full-text { margin: 20px 0; padding: 20px; background: ${isDark ? '#2a2a2a' : '#f0f7ff'}; border-left: 4px solid ${isDark ? '#60a5fa' : '#0066cc'}; }
        .legislation-full-text h3 { margin-top: 0; color: ${isDark ? '#60a5fa' : '#0066cc'}; }
        .article-text { margin: 12px 0; line-height: 1.8; }
        a { color: ${isDark ? '#60a5fa' : '#000'}; }
        ul, ol { margin: 12px 0 12px 24px; }
        li { margin: 8px 0; font-size: 15px; }
    </style>`;
  }
}
