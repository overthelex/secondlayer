/**
 * Request Logger Middleware
 * Logs all HTTP requests
 */

import { Request, Response, NextFunction } from 'express';

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();

  // Log when response finishes
  res.on('finish', () => {
    const duration = Date.now() - start;
    const statusColor = res.statusCode >= 400 ? '\x1b[31m' : '\x1b[32m'; // Red for errors, green for success
    const resetColor = '\x1b[0m';

    console.log(
      `${statusColor}${res.statusCode}${resetColor} ${req.method} ${req.path} - ${duration}ms`
    );
  });

  next();
}
