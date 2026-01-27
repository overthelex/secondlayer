import express from 'express';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import {
  OpenReyestrTools,
  SearchEntitiesSchema,
  GetEntityDetailsSchema,
  SearchBeneficiariesSchema,
  GetByEdrpouSchema,
} from './api/openreyestr-tools.js';

dotenv.config();

const app = express();
app.use(express.json());

const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5435'),
  user: process.env.POSTGRES_USER || 'openreyestr',
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB || 'openreyestr',
});

const tools = new OpenReyestrTools(pool);

// Auth middleware
function authenticateRequest(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization;
  const validKeys = (process.env.SECONDARY_LAYER_KEYS || '').split(',').map(k => k.trim());

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.substring(7);
  if (!validKeys.includes(token)) {
    return res.status(403).json({ error: 'Invalid API key' });
  }

  next();
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'openreyestr-mcp', timestamp: new Date().toISOString() });
});

// Search entities
app.post('/api/search', authenticateRequest, async (req, res) => {
  try {
    const params = SearchEntitiesSchema.parse(req.body);
    const results = await tools.searchEntities(params);
    res.json({ success: true, data: results, count: results.length });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Get entity details
app.get('/api/entity/:record', authenticateRequest, async (req, res) => {
  try {
    const { record } = req.params;
    const entityType = req.query.type as 'UO' | 'FOP' | 'FSU' | undefined;

    const details = await tools.getEntityDetails(record, entityType);
    if (!details) {
      return res.status(404).json({ success: false, error: 'Entity not found' });
    }

    res.json({ success: true, data: details });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Get by EDRPOU
app.get('/api/edrpou/:edrpou', authenticateRequest, async (req, res) => {
  try {
    const { edrpou } = req.params;
    const entity = await tools.getByEdrpou(edrpou);

    if (!entity) {
      return res.status(404).json({ success: false, error: 'Entity not found' });
    }

    res.json({ success: true, data: entity });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Search beneficiaries
app.post('/api/beneficiaries/search', authenticateRequest, async (req, res) => {
  try {
    const params = SearchBeneficiariesSchema.parse(req.body);
    const results = await tools.searchBeneficiaries(params.query, params.limit);
    res.json({ success: true, data: results, count: results.length });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Get statistics
app.get('/api/statistics', authenticateRequest, async (req, res) => {
  try {
    const stats = await tools.getStatistics();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
});

const PORT = parseInt(process.env.HTTP_PORT || '3004');

app.listen(PORT, () => {
  console.log(`OPENREYESTR HTTP Server running on port ${PORT}`);
});

export default app;
