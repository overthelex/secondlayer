/**
 * Spain Legal Tools - BOE legislation + AEPD GDPR decisions
 *
 * 5 tools:
 * - spain_boe_search — Search Spanish legislation (BOE consolidated laws)
 * - spain_boe_get_text — Get full text of a specific BOE law
 * - spain_aepd_search — Search AEPD GDPR/data protection decisions
 * - spain_aepd_get_resolution — Get a specific AEPD resolution
 * - spain_aepd_stats — Get AEPD statistics by year and procedure type
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';

export class SpainLegalTools extends BaseToolHandler {
  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'spain_boe_search',
        description: `Buscar legislacion espanola consolidada en el Boletin Oficial del Estado (BOE).

Base de datos con 12.228 normas consolidadas: Leyes, Reales Decretos, Leyes Organicas, Ordenes, Resoluciones, etc.
Busqueda por texto completo (full-text search en espanol) con filtros opcionales por rango normativo y fechas.
Fuente: BOE.es (Agencia Estatal Boletin Oficial del Estado)`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Texto de busqueda (ej: "proteccion de datos", "ley de contratos del sector publico")',
            },
            rango: {
              type: 'string',
              description: 'Filtro por rango normativo (ej: "Ley", "Real Decreto", "Real Decreto-ley", "Orden", "Ley Organica", "Resolucion")',
            },
            fecha_from: {
              type: 'string',
              description: 'Fecha minima de publicacion (formato YYYY-MM-DD)',
            },
            fecha_to: {
              type: 'string',
              description: 'Fecha maxima de publicacion (formato YYYY-MM-DD)',
            },
            limit: {
              type: 'number',
              default: 10,
              maximum: 50,
              description: 'Numero maximo de resultados (por defecto 10)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'spain_boe_get_text',
        description: `Obtener el texto completo y metadatos de una norma espanola del BOE por su identificador.

Devuelve: titulo, rango, departamento, fechas, estado de consolidacion, texto completo y enlaces.
Usar tras buscar con spain_boe_search para obtener el contenido integro de una ley o decreto.`,
        inputSchema: {
          type: 'object',
          properties: {
            boe_id: {
              type: 'string',
              description: 'Identificador BOE de la norma (ej: "BOE-A-2018-13593" para la LOPDGDD)',
            },
          },
          required: ['boe_id'],
        },
      },
      {
        name: 'spain_aepd_search',
        description: `Buscar resoluciones de la Agencia Espanola de Proteccion de Datos (AEPD).

Base de datos con 46.098 resoluciones sobre proteccion de datos / RGPD.
Busqueda por texto en el extracto de la resolucion con filtros opcionales por fecha.
Fuente: AEPD.es`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Texto de busqueda (ej: "videovigilancia", "consentimiento", "brecha de seguridad")',
            },
            fecha_from: {
              type: 'string',
              description: 'Fecha minima de firma (formato YYYY-MM-DD)',
            },
            fecha_to: {
              type: 'string',
              description: 'Fecha maxima de firma (formato YYYY-MM-DD)',
            },
            limit: {
              type: 'number',
              default: 10,
              maximum: 50,
              description: 'Numero maximo de resultados (por defecto 10)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'spain_aepd_get_resolution',
        description: `Obtener los datos completos de una resolucion de la AEPD por su referencia.

Devuelve: referencia, expediente, fecha, extracto, tipo de procedimiento, conceptos, articulos infringidos y enlace al PDF.
Usar tras buscar con spain_aepd_search para obtener el detalle completo de una resolucion.`,
        inputSchema: {
          type: 'object',
          properties: {
            reference: {
              type: 'string',
              description: 'Referencia de la resolucion AEPD (ej: "PS-00211-2025")',
            },
          },
          required: ['reference'],
        },
      },
      {
        name: 'spain_aepd_stats',
        description: `Obtener estadisticas agregadas de las resoluciones de la AEPD.

Devuelve: total de resoluciones, distribucion por ano y por tipo de procedimiento.
Util para analizar tendencias en la aplicacion del RGPD en Espana.`,
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    ];
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    switch (name) {
      case 'spain_boe_search':
        return await this.searchBOE(args);
      case 'spain_boe_get_text':
        return await this.getBOEText(args);
      case 'spain_aepd_search':
        return await this.searchAEPD(args);
      case 'spain_aepd_get_resolution':
        return await this.getAEPDResolution(args);
      case 'spain_aepd_stats':
        return await this.getAEPDStats();
      default:
        return null;
    }
  }

  // ========================= BOE Tools =========================

  private async searchBOE(args: any): Promise<ToolResult> {
    const query = String(args.query || '').trim();
    if (!query) {
      return this.wrapError('El parametro "query" es obligatorio');
    }

    const rango = args.rango?.trim();
    const fechaFrom = args.fecha_from?.trim();
    const fechaTo = args.fecha_to?.trim();
    const limit = Math.min(Number(args.limit) || 10, 50);

    logger.info('[MCP Tool] spain_boe_search', { query: query.substring(0, 100), rango, fechaFrom, fechaTo, limit });

    try {
      // Build the tsquery from the user's search text
      // Split query into words and join with & for AND semantics
      const tsqueryWords = query
        .replace(/[^\w\sáéíóúñüÁÉÍÓÚÑÜ]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 1)
        .map(w => `${w}:*`)
        .join(' & ');

      if (!tsqueryWords) {
        return this.wrapError('La consulta no contiene palabras validas para la busqueda');
      }

      const conditions: string[] = [];
      const params: any[] = [];
      let paramIdx = 1;

      // Full-text search across title and full_text
      conditions.push(`(
        to_tsvector('spanish', coalesce(title, '')) || to_tsvector('spanish', coalesce(full_text, ''))
      ) @@ plainto_tsquery('spanish', $${paramIdx})`);
      params.push(tsqueryWords);
      paramIdx++;

      if (rango) {
        conditions.push(`rango ILIKE $${paramIdx++}`);
        params.push(`%${rango}%`);
      }

      if (fechaFrom) {
        conditions.push(`fecha_publicacion >= $${paramIdx++}`);
        params.push(fechaFrom);
      }

      if (fechaTo) {
        conditions.push(`fecha_publicacion <= $${paramIdx++}`);
        params.push(fechaTo);
      }

      const whereClause = conditions.join(' AND ');

      // Count total matches
      const countResult = await this.db.query(
        `SELECT count(*) AS total FROM spain_boe_legislation WHERE ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].total, 10);

      // Fetch results with snippet
      params.push(limit);
      const dataQuery = `
        SELECT
          boe_id,
          title,
          rango,
          departamento,
          fecha_publicacion,
          fecha_disposicion,
          estado_consolidacion,
          url_eli,
          url_html,
          safe_ts_headline('spanish'::regconfig, coalesce(full_text, ''), to_tsquery('spanish', $1),
            'MaxWords=60, MinWords=30, StartSel=<<, StopSel=>>') AS snippet
        FROM spain_boe_legislation
        WHERE ${whereClause}
        ORDER BY ts_rank(
          to_tsvector('spanish', coalesce(title, '')) || to_tsvector('spanish', coalesce(full_text, '')),
          to_tsquery('spanish', $1)
        ) DESC, fecha_publicacion DESC
        LIMIT $${paramIdx}
      `;
      const result = await this.db.query(dataQuery, params);

      return this.wrapResponse({
        source: 'Boletin Oficial del Estado (BOE.es) - Legislacion consolidada',
        query,
        total_found: total,
        returned: result.rows.length,
        limit,
        results: result.rows.map((r: any) => ({
          boe_id: r.boe_id,
          title: r.title,
          rango: r.rango,
          departamento: r.departamento,
          fecha_publicacion: r.fecha_publicacion,
          fecha_disposicion: r.fecha_disposicion,
          estado_consolidacion: r.estado_consolidacion,
          url_eli: r.url_eli,
          url_html: r.url_html,
          snippet: r.snippet,
        })),
      });
    } catch (error: any) {
      logger.error('[MCP Tool] spain_boe_search failed', { error: error.message });
      return this.wrapError(`Error en la busqueda BOE: ${error.message}`);
    }
  }

  private async getBOEText(args: any): Promise<ToolResult> {
    const boeId = String(args.boe_id || '').trim();
    if (!boeId) {
      return this.wrapError('El parametro "boe_id" es obligatorio');
    }

    logger.info('[MCP Tool] spain_boe_get_text', { boeId });

    try {
      const result = await this.db.query(
        `SELECT
          boe_id, title, rango, departamento, ambito,
          fecha_disposicion, fecha_publicacion, fecha_vigencia,
          numero_oficial, estado_consolidacion,
          url_eli, url_html,
          full_text, metadata
        FROM spain_boe_legislation
        WHERE boe_id = $1`,
        [boeId]
      );

      if (result.rows.length === 0) {
        return this.wrapError(`No se encontro la norma con identificador BOE: ${boeId}`);
      }

      const r = result.rows[0];
      return this.wrapResponse({
        source: 'Boletin Oficial del Estado (BOE.es)',
        boe_id: r.boe_id,
        title: r.title,
        rango: r.rango,
        departamento: r.departamento,
        ambito: r.ambito,
        fecha_disposicion: r.fecha_disposicion,
        fecha_publicacion: r.fecha_publicacion,
        fecha_vigencia: r.fecha_vigencia,
        numero_oficial: r.numero_oficial,
        estado_consolidacion: r.estado_consolidacion,
        url_eli: r.url_eli,
        url_html: r.url_html,
        full_text: r.full_text,
        metadata: r.metadata,
      });
    } catch (error: any) {
      logger.error('[MCP Tool] spain_boe_get_text failed', { error: error.message });
      return this.wrapError(`Error al obtener norma BOE: ${error.message}`);
    }
  }

  // ========================= AEPD Tools =========================

  private async searchAEPD(args: any): Promise<ToolResult> {
    const query = String(args.query || '').trim();
    if (!query) {
      return this.wrapError('El parametro "query" es obligatorio');
    }

    const fechaFrom = args.fecha_from?.trim();
    const fechaTo = args.fecha_to?.trim();
    const limit = Math.min(Number(args.limit) || 10, 50);

    logger.info('[MCP Tool] spain_aepd_search', { query: query.substring(0, 100), fechaFrom, fechaTo, limit });

    try {
      const tsqueryWords = query
        .replace(/[^\w\sáéíóúñüÁÉÍÓÚÑÜ]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 1)
        .map(w => `${w}:*`)
        .join(' & ');

      if (!tsqueryWords) {
        return this.wrapError('La consulta no contiene palabras validas para la busqueda');
      }

      const conditions: string[] = [];
      const params: any[] = [];
      let paramIdx = 1;

      conditions.push(`to_tsvector('spanish', coalesce(extracto, '')) @@ plainto_tsquery('spanish', $${paramIdx})`);
      params.push(tsqueryWords);
      paramIdx++;

      if (fechaFrom) {
        conditions.push(`fecha_firma >= $${paramIdx++}`);
        params.push(fechaFrom);
      }

      if (fechaTo) {
        conditions.push(`fecha_firma <= $${paramIdx++}`);
        params.push(fechaTo);
      }

      const whereClause = conditions.join(' AND ');

      const countResult = await this.db.query(
        `SELECT count(*) AS total FROM spain_aepd_resolutions WHERE ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].total, 10);

      params.push(limit);
      const dataQuery = `
        SELECT
          reference,
          expediente,
          fecha_firma,
          tipo_procedimiento,
          conceptos,
          articulos_infringidos,
          pdf_url,
          safe_ts_headline('spanish'::regconfig, coalesce(extracto, ''), to_tsquery('spanish', $1),
            'MaxWords=60, MinWords=30, StartSel=<<, StopSel=>>') AS snippet
        FROM spain_aepd_resolutions
        WHERE ${whereClause}
        ORDER BY ts_rank(
          to_tsvector('spanish', coalesce(extracto, '')),
          to_tsquery('spanish', $1)
        ) DESC, fecha_firma DESC
        LIMIT $${paramIdx}
      `;
      const result = await this.db.query(dataQuery, params);

      return this.wrapResponse({
        source: 'Agencia Espanola de Proteccion de Datos (AEPD)',
        query,
        total_found: total,
        returned: result.rows.length,
        limit,
        results: result.rows.map((r: any) => ({
          reference: r.reference,
          expediente: r.expediente,
          fecha_firma: r.fecha_firma,
          tipo_procedimiento: r.tipo_procedimiento,
          conceptos: r.conceptos,
          articulos_infringidos: r.articulos_infringidos,
          pdf_url: r.pdf_url,
          snippet: r.snippet,
        })),
      });
    } catch (error: any) {
      logger.error('[MCP Tool] spain_aepd_search failed', { error: error.message });
      return this.wrapError(`Error en la busqueda AEPD: ${error.message}`);
    }
  }

  private async getAEPDResolution(args: any): Promise<ToolResult> {
    const reference = String(args.reference || '').trim();
    if (!reference) {
      return this.wrapError('El parametro "reference" es obligatorio');
    }

    logger.info('[MCP Tool] spain_aepd_get_resolution', { reference });

    try {
      const result = await this.db.query(
        `SELECT
          reference, expediente, fecha_firma, extracto,
          tipo_procedimiento, conceptos, articulos_infringidos,
          pdf_url, metadata
        FROM spain_aepd_resolutions
        WHERE reference = $1`,
        [reference]
      );

      if (result.rows.length === 0) {
        return this.wrapError(`No se encontro la resolucion AEPD con referencia: ${reference}`);
      }

      const r = result.rows[0];
      return this.wrapResponse({
        source: 'Agencia Espanola de Proteccion de Datos (AEPD)',
        reference: r.reference,
        expediente: r.expediente,
        fecha_firma: r.fecha_firma,
        extracto: r.extracto,
        tipo_procedimiento: r.tipo_procedimiento,
        conceptos: r.conceptos,
        articulos_infringidos: r.articulos_infringidos,
        pdf_url: r.pdf_url,
        metadata: r.metadata,
      });
    } catch (error: any) {
      logger.error('[MCP Tool] spain_aepd_get_resolution failed', { error: error.message });
      return this.wrapError(`Error al obtener resolucion AEPD: ${error.message}`);
    }
  }

  private async getAEPDStats(): Promise<ToolResult> {
    logger.info('[MCP Tool] spain_aepd_stats');

    try {
      // Total count
      const totalResult = await this.db.query(
        `SELECT count(*) AS total FROM spain_aepd_resolutions`
      );
      const total = parseInt(totalResult.rows[0].total, 10);

      // Count by year
      const byYearResult = await this.db.query(`
        SELECT
          EXTRACT(YEAR FROM fecha_firma)::int AS year,
          count(*) AS count
        FROM spain_aepd_resolutions
        WHERE fecha_firma IS NOT NULL
        GROUP BY year
        ORDER BY year DESC
      `);

      // Count by tipo_procedimiento
      const byTypeResult = await this.db.query(`
        SELECT
          coalesce(tipo_procedimiento, 'Sin clasificar') AS tipo_procedimiento,
          count(*) AS count
        FROM spain_aepd_resolutions
        GROUP BY tipo_procedimiento
        ORDER BY count DESC
      `);

      return this.wrapResponse({
        source: 'Agencia Espanola de Proteccion de Datos (AEPD)',
        total_resolutions: total,
        by_year: byYearResult.rows.map((r: any) => ({
          year: r.year,
          count: parseInt(r.count, 10),
        })),
        by_tipo_procedimiento: byTypeResult.rows.map((r: any) => ({
          tipo_procedimiento: r.tipo_procedimiento,
          count: parseInt(r.count, 10),
        })),
      });
    } catch (error: any) {
      logger.error('[MCP Tool] spain_aepd_stats failed', { error: error.message });
      return this.wrapError(`Error al obtener estadisticas AEPD: ${error.message}`);
    }
  }
}
