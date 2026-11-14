/**
 * Auth Diia — Diia government ID auth + digital signing (Дія.Підпис)
 */

import { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { getUserService } from '../middleware/dual-auth.js';
import { getDiiaService, DiiaPermissionError, type DiiaSignFile } from '../services/diia-service.js';
import { provisionAuthentikUser } from '../services/authentik-service.js';
import { provisionNextcloudUser } from '../services/nextcloud-provisioning.js';
import {
  generateToken,
  generateBannerAsync,
  getAuthCache,
} from './auth-common.js';

const DIIA_SESSION_TTL = 600; // 10 minutes
const DIIA_SIGN_SESSION_TTL = 900; // 15 minutes — signing may take longer than auth

// ============================================================================
// Diia Auth
// ============================================================================

/**
 * GET /auth/diia
 * Initiates Diia authentication flow.
 */
export async function diiaAuthInit(req: Request, res: Response): Promise<void> {
  try {
    const diiaService = getDiiaService();

    if (!diiaService.isConfigured()) {
      const frontendUrl = (() => {
        const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        return `${protocol}://${host}`;
      })();
      res.redirect(`${frontendUrl}/login?error=diia_not_configured`);
      return;
    }

    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${protocol}://${host}`;
    const callbackUrl = `${baseUrl}/auth/diia/callback`;

    const session = await diiaService.initAuthSession(callbackUrl);
    const { requestId, hashedRequestId, deeplink } = session;

    const authCache = getAuthCache();
    if (authCache) {
      const pending = JSON.stringify({ status: 'pending' });
      const pendingWithMapping = JSON.stringify({ status: 'pending', plainRequestId: requestId });
      await authCache.set(`diia:session:${requestId}`, pending, DIIA_SESSION_TTL);
      await authCache.set(`diia:session:${hashedRequestId}`, pendingWithMapping, DIIA_SESSION_TTL);
    }

    const params = new URLSearchParams({
      diia_session: requestId,
      diia_deeplink: deeplink,
    });

    // Persist session ID in cookie so GET /auth/diia/callback can resume polling
    // after Diia app redirects back (mobile same-device flow loses the original tab)
    res.cookie('diia_session', requestId, {
      httpOnly: false,
      secure: true,
      sameSite: 'lax',
      maxAge: DIIA_SESSION_TTL * 1000,
      path: '/',
    });

    res.redirect(`${baseUrl}/login?${params.toString()}`);
  } catch (error: any) {
    logger.error('[Diia] Auth init failed:', error);
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const errorCode = error instanceof DiiaPermissionError ? 'diia_scope_forbidden' : 'diia_failed';
    res.redirect(`${protocol}://${host}/login?error=${errorCode}`);
  }
}

/**
 * POST /auth/diia/callback
 * Unified Diia webhook — handles both auth and sign callbacks.
 * Diia sends the signed package here after user completes auth or signs documents.
 * Distinguishes auth vs sign by checking which Redis session key exists for the traceId.
 */
export async function diiaCallback(req: Request, res: Response): Promise<Response> {
  const traceId = (req.headers['x-document-request-trace-id'] as string) || '';
  logger.info('[Diia] Webhook received', { traceId, contentType: req.headers['content-type'] });

  try {
    if (!traceId) {
      return res.status(400).json({ success: false, error: 'Missing X-Document-Request-Trace-Id' });
    }

    const authCache = getAuthCache();

    // Check if this is a sign session
    let signSessionRaw: string | null = null;
    if (authCache) {
      signSessionRaw = await authCache.get(`diia:sign:${traceId}`);
    }

    if (signSessionRaw) {
      // --- Sign callback flow ---
      return handleSignCallback(req, res, traceId, signSessionRaw);
    }

    // --- Auth callback flow ---
    return handleAuthCallback(req, res, traceId);
  } catch (error: any) {
    logger.error('[Diia] Webhook failed:', error);
    return res.json({ success: true });
  }
}

async function handleAuthCallback(req: Request, res: Response, traceId: string): Promise<Response> {
  const userService = getUserService();
  if (!userService) {
    return res.status(503).json({ success: false, error: 'Service unavailable' });
  }

  const authCache = getAuthCache();
  const hashedKey = `diia:session:${traceId}`;
  let sessionData: { status: string; plainRequestId?: string } | null = null;

  if (authCache) {
    const raw = await authCache.get(hashedKey);
    if (raw) sessionData = JSON.parse(raw);
  }

  const email = `diia_${traceId.substring(0, 16)}@diia.legal.org.ua`;
  const name = 'Дія Користувач';
  let user = await userService.findByEmail(email);
  if (!user) {
    user = await userService.createUser({
      googleId: null,
      email,
      name,
      emailVerified: true,
    });
    logger.info('[Diia] Created user from webhook', { userId: user.id, traceId });
    generateBannerAsync(user.id, name);
    provisionAuthentikUser({ email, name }).catch(() => {});
    provisionNextcloudUser({ email, name }).catch(() => {});
  } else {
    await userService.updateLastLogin(user.id);
    logger.info('[Diia] Existing user webhook auth', { userId: user.id, traceId });
  }

  if (authCache) {
    const completeData = JSON.stringify({ status: 'complete', userId: user.id });
    await authCache.set(hashedKey, completeData, DIIA_SESSION_TTL);

    if (sessionData?.plainRequestId) {
      await authCache.set(
        `diia:session:${sessionData.plainRequestId}`,
        completeData,
        DIIA_SESSION_TTL,
      );
    }
  }

  return res.json({ success: true });
}

async function handleSignCallback(_req: Request, res: Response, traceId: string, signSessionRaw: string): Promise<Response> {
  const authCache = getAuthCache();
  const hashedKey = `diia:sign:${traceId}`;
  const sessionData: { status: string; plainRequestId?: string; files?: DiiaSignFile[] } = JSON.parse(signSessionRaw);
  const signedData = _req.body;

  if (authCache) {
    const completeData = JSON.stringify({
      status: 'complete',
      signedData,
      files: sessionData?.files,
    });
    await authCache.set(hashedKey, completeData, DIIA_SIGN_SESSION_TTL);

    if (sessionData?.plainRequestId) {
      await authCache.set(
        `diia:sign:${sessionData.plainRequestId}`,
        completeData,
        DIIA_SIGN_SESSION_TTL,
      );
    }
  }

  logger.info('[Diia] Sign webhook processed', { traceId });
  return res.json({ success: true });
}

/**
 * GET /auth/diia/status/:sessionId
 * Frontend polls this to check if the Diia auth session has completed.
 */
export async function diiaAuthStatus(req: Request, res: Response): Promise<Response> {
  const { sessionId } = req.params;

  const authCache = getAuthCache();
  if (!authCache) {
    return res.status(503).json({ error: 'Cache unavailable' });
  }

  const raw = await authCache.get(`diia:session:${sessionId}`);
  if (!raw) {
    return res.status(404).json({ status: 'expired' });
  }

  const session = JSON.parse(raw) as { status: string; userId?: string };

  if (session.status === 'complete' && session.userId) {
    const userService = getUserService();
    if (!userService) return res.status(503).json({ error: 'Service unavailable' });

    const user = await userService.findById(session.userId);
    if (!user) return res.status(404).json({ status: 'expired' });

    await authCache.del(`diia:session:${sessionId}`);
    const token = generateToken(user);
    return res.json({ status: 'complete', token });
  }

  return res.json({ status: session.status });
}

// ============================================================================
// Дія.Підпис (Document Signing)
// ============================================================================

/**
 * POST /auth/diia/sign
 * Initiate a Дія.Підпис signing session.
 */
export async function diiaSignInit(req: Request, res: Response): Promise<Response> {
  try {
    const diiaService = getDiiaService();

    if (!diiaService.isConfigured()) {
      return res.status(501).json({ error: 'Дія.Підпис не налаштовано' });
    }

    const { files, returnUrl } = req.body as {
      files?: DiiaSignFile[];
      returnUrl?: string;
    };

    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'Необхідно передати масив files з fileName та fileHash' });
    }

    for (const file of files) {
      if (!file.fileName || !file.fileHash) {
        return res.status(400).json({ error: 'Кожен файл повинен мати fileName та fileHash' });
      }
    }

    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${protocol}://${host}`;
    const callbackUrl = `${baseUrl}/auth/diia/callback`;
    const effectiveReturnUrl = returnUrl || `${baseUrl}/documents`;

    const session = await diiaService.initSigningSession(effectiveReturnUrl, files);
    const { requestId, hashedRequestId, deeplink } = session;

    const authCache = getAuthCache();
    if (authCache) {
      const pending = JSON.stringify({
        status: 'pending',
        files,
      });
      const pendingWithMapping = JSON.stringify({
        status: 'pending',
        plainRequestId: requestId,
        files,
      });
      await authCache.set(`diia:sign:${requestId}`, pending, DIIA_SIGN_SESSION_TTL);
      await authCache.set(`diia:sign:${hashedRequestId}`, pendingWithMapping, DIIA_SIGN_SESSION_TTL);
    }

    logger.info('[Diia] Sign session initiated', { sessionId: requestId, fileCount: files.length });

    return res.json({ sessionId: requestId, deeplink });
  } catch (error: any) {
    logger.error('[Diia] Sign init failed:', error);
    const errorCode = error instanceof DiiaPermissionError ? 'scope_forbidden' : 'sign_failed';
    return res.status(500).json({ error: errorCode, message: error.message });
  }
}

/**
 * GET /auth/diia/sign/status/:sessionId
 * Frontend polls this to check if the signing session has completed.
 */
export async function diiaSignStatus(req: Request, res: Response): Promise<Response> {
  const { sessionId } = req.params;

  const authCache = getAuthCache();
  if (!authCache) {
    return res.status(503).json({ error: 'Cache unavailable' });
  }

  const raw = await authCache.get(`diia:sign:${sessionId}`);
  if (!raw) {
    return res.status(404).json({ status: 'expired' });
  }

  const session = JSON.parse(raw) as {
    status: string;
    signedData?: any;
    files?: DiiaSignFile[];
  };

  if (session.status === 'complete') {
    await authCache.del(`diia:sign:${sessionId}`);
    return res.json({
      status: 'complete',
      signedData: session.signedData,
      files: session.files,
    });
  }

  return res.json({ status: session.status });
}
