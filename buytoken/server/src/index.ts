/**
 * SecondLayer Payment Server
 * Main entry point for the Express server
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import passport from './config/passport.js';
import { testConnection } from './config/database.js';
import { errorHandler } from './middleware/error-handler.js';
import { requestLogger } from './middleware/logger.js';

// Import routes (will be created next)
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import subscriptionRoutes from './routes/subscriptions.js';
import paymentRoutes from './routes/payments.js';
import usageRoutes from './routes/usage.js';
import adminRoutes from './routes/admin.js';

// Load environment variables
dotenv.config();

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express app
const app = express();
const PORT = process.env.HTTP_PORT || 3001;
const HOST = process.env.HTTP_HOST || 'localhost';

// ============================================================================
// Middleware
// ============================================================================

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // Disable for development, enable in production
}));

// CORS configuration
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8000';
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true,
}));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Passport
app.use(passport.initialize());

// Request logging
app.use(requestLogger);

// ============================================================================
// Static Files (Frontend)
// ============================================================================

// Serve static frontend files from buytoken/ directory
// __dirname = dist/, so ../../ goes to buytoken/
const publicPath = path.join(__dirname, '../..');
app.use(express.static(publicPath));

// ============================================================================
// Health Check
// ============================================================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// ============================================================================
// API Routes
// ============================================================================

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/admin', adminRoutes);

// ============================================================================
// Error Handling
// ============================================================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: {
      message: 'Route not found',
      statusCode: 404,
      path: req.path,
    },
  });
});

// Global error handler
app.use(errorHandler);

// ============================================================================
// Server Startup
// ============================================================================

async function startServer() {
  try {
    // Test database connection
    const dbConnected = await testConnection();
    if (!dbConnected) {
      throw new Error('Failed to connect to database');
    }

    // Start listening
    app.listen(PORT, () => {
      console.log(`
╔════════════════════════════════════════════════════════════════╗
║                                                                ║
║  🚀 SecondLayer Payment Server                                ║
║                                                                ║
║  Status:    Running                                            ║
║  Port:      ${PORT}                                           ║
║  Host:      ${HOST}                                           ║
║  Frontend:  ${FRONTEND_URL}                                   ║
║  API Docs:  http://${HOST}:${PORT}/api                        ║
║                                                                ║
║  Health:    http://${HOST}:${PORT}/health                     ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝
      `);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
