/**
 * Rutas para integraciones con sistemas externos
 */

import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  sendWebhook,
  sendSlackNotification,
  sendEmail,
  syncWithExternalSystem,
  getIntegrationsStatus
} from '../services/integrationService.js';
import { generateAllAlerts } from '../services/alertService.js';

const router = express.Router();

/**
 * GET /api/integrations/status
 * Obtiene estado de todas las integraciones
 */
router.get('/status', asyncHandler(async (req, res) => {
  const status = getIntegrationsStatus();
  res.json({
    success: true,
    integrations: status
  });
}));

/**
 * POST /api/integrations/webhook
 * Envía datos a webhook externo
 */
router.post('/webhook', asyncHandler(async (req, res) => {
  const { event, data } = req.body;
  
  if (!event || !data) {
    return res.status(400).json({
      success: false,
      error: 'Evento y datos requeridos'
    });
  }
  
  const result = await sendWebhook(event, data);
  res.json({
    success: result.sent,
    ...result
  });
}));

/**
 * POST /api/integrations/slack
 * Envía notificación a Slack
 */
router.post('/slack', asyncHandler(async (req, res) => {
  const { message, severity = 'info' } = req.body;
  
  if (!message) {
    return res.status(400).json({
      success: false,
      error: 'Mensaje requerido'
    });
  }
  
  const result = await sendSlackNotification(message, severity);
  res.json({
    success: result.sent,
    ...result
  });
}));

/**
 * POST /api/integrations/email
 * Envía email
 */
router.post('/email', asyncHandler(async (req, res) => {
  const { to, subject, body, html = false } = req.body;
  
  if (!to || !subject || !body) {
    return res.status(400).json({
      success: false,
      error: 'Destinatario, asunto y cuerpo requeridos'
    });
  }
  
  const result = await sendEmail(to, subject, body, html);
  res.json({
    success: result.sent,
    ...result
  });
}));

/**
 * POST /api/integrations/sync/:systemName
 * Sincroniza con sistema externo
 */
router.post('/sync/:systemName', asyncHandler(async (req, res) => {
  const { systemName } = req.params;
  const { data } = req.body;
  
  const result = await syncWithExternalSystem(systemName, data);
  res.json({
    success: result.success,
    ...result
  });
}));

/**
 * POST /api/integrations/alerts/broadcast
 * Envía alertas a todos los canales configurados
 */
router.post('/alerts/broadcast', asyncHandler(async (req, res) => {
  const alerts = await generateAllAlerts();
  const criticalAlerts = alerts.filter(a => a.severity === 'CRITICAL');
  
  const results = {
    webhook: null,
    slack: null,
    email: null
  };
  
  if (criticalAlerts.length > 0) {
    const message = `${criticalAlerts.length} alertas críticas detectadas`;
    
    // Enviar a todos los canales
    results.webhook = await sendWebhook('critical_alert', { alerts: criticalAlerts });
    results.slack = await sendSlackNotification(message, 'critical');
    
    if (criticalAlerts.length >= 5) {
      const emailBody = criticalAlerts.map(a => `- ${a.title}: ${a.message}`).join('\n');
      results.email = await sendEmail(
        undefined, // Usará recipients por defecto
        '🚨 Alertas Críticas en el Almacén',
        emailBody
      );
    }
  }
  
  res.json({
    success: true,
    alertsCount: criticalAlerts.length,
    results
  });
}));

export default router;



