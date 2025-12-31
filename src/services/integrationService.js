/**
 * Servicio de integraciones con sistemas externos
 */

import { logger } from '../middleware/logger.js';
import { getWarehouseContext } from './warehouseService.js';
import { generateAllAlerts } from './alertService.js';

// Configuración de integraciones
const INTEGRATIONS = {
  webhook: {
    enabled: process.env.WEBHOOK_ENABLED === 'true',
    url: process.env.WEBHOOK_URL,
    events: ['critical_alert', 'stock_low', 'dead_stock']
  },
  
  slack: {
    enabled: process.env.SLACK_ENABLED === 'true',
    webhookUrl: process.env.SLACK_WEBHOOK_URL,
    channel: process.env.SLACK_CHANNEL || '#warehouse-alerts'
  },
  
  email: {
    enabled: process.env.EMAIL_ENABLED === 'true',
    smtp: {
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    },
    from: process.env.EMAIL_FROM,
    recipients: process.env.EMAIL_RECIPIENTS?.split(',') || []
  }
};

/**
 * Envía datos a un webhook externo
 */
export async function sendWebhook(event, data) {
  if (!INTEGRATIONS.webhook.enabled || !INTEGRATIONS.webhook.url) {
    logger.debug('Webhook deshabilitado o URL no configurada');
    return { sent: false, reason: 'Webhook no configurado' };
  }
  
  if (!INTEGRATIONS.webhook.events.includes(event)) {
    logger.debug(`Evento ${event} no está en la lista de eventos del webhook`);
    return { sent: false, reason: 'Evento no configurado' };
  }
  
  try {
    const payload = {
      event,
      timestamp: new Date().toISOString(),
      data
    };
    
    // En producción, usarías fetch o axios
    logger.info('Enviando webhook', { 
      url: INTEGRATIONS.webhook.url, 
      event,
      payload: JSON.stringify(payload).substring(0, 100) 
    });
    
    // Simulación - en producción:
    // const response = await fetch(INTEGRATIONS.webhook.url, {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify(payload)
    // });
    
    return { sent: true, event, timestamp: payload.timestamp };
  } catch (error) {
    logger.error('Error enviando webhook', { error: error.message });
    return { sent: false, error: error.message };
  }
}

/**
 * Envía notificación a Slack
 */
export async function sendSlackNotification(message, severity = 'info') {
  if (!INTEGRATIONS.slack.enabled || !INTEGRATIONS.slack.webhookUrl) {
    logger.debug('Slack deshabilitado o webhook no configurado');
    return { sent: false, reason: 'Slack no configurado' };
  }
  
  try {
    const emoji = {
      critical: '🚨',
      high: '⚠️',
      medium: 'ℹ️',
      info: '📊'
    }[severity] || '📊';
    
    const payload = {
      channel: INTEGRATIONS.slack.channel,
      text: `${emoji} ${message}`,
      username: 'Warehouse Bot'
    };
    
    logger.info('Enviando notificación a Slack', { 
      channel: INTEGRATIONS.slack.channel,
      message: message.substring(0, 50) 
    });
    
    // En producción:
    // const response = await fetch(INTEGRATIONS.slack.webhookUrl, {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify(payload)
    // });
    
    return { sent: true, channel: INTEGRATIONS.slack.channel };
  } catch (error) {
    logger.error('Error enviando a Slack', { error: error.message });
    return { sent: false, error: error.message };
  }
}

/**
 * Envía email (requiere configuración SMTP)
 */
export async function sendEmail(to, subject, body, html = false) {
  if (!INTEGRATIONS.email.enabled) {
    logger.debug('Email deshabilitado');
    return { sent: false, reason: 'Email no configurado' };
  }
  
  try {
    // En producción, usarías nodemailer o similar
    logger.info('Enviando email', { 
      to,
      subject,
      bodyLength: body.length 
    });
    
    // Simulación - en producción:
    // const transporter = nodemailer.createTransport({
    //   host: INTEGRATIONS.email.smtp.host,
    //   port: INTEGRATIONS.email.smtp.port,
    //   secure: INTEGRATIONS.email.smtp.secure,
    //   auth: INTEGRATIONS.email.smtp.auth
    // });
    // 
    // await transporter.sendMail({
    //   from: INTEGRATIONS.email.from,
    //   to,
    //   subject,
    //   text: html ? undefined : body,
    //   html: html ? body : undefined
    // });
    
    return { sent: true, to, subject };
  } catch (error) {
    logger.error('Error enviando email', { error: error.message });
    return { sent: false, error: error.message };
  }
}

/**
 * Sincroniza datos con sistema externo (ej: ERP, WMS)
 */
export async function syncWithExternalSystem(systemName, data) {
  logger.info(`Sincronizando con sistema externo: ${systemName}`);
  
  // En producción, implementarías la lógica específica del sistema
  // Ejemplos: SAP, Oracle, sistemas WMS, etc.
  
  const syncResults = {
    system: systemName,
    timestamp: new Date().toISOString(),
    recordsProcessed: 0,
    success: true,
    errors: []
  };
  
  try {
    // Simulación de sincronización
    if (systemName === 'odoo') {
      // Ya implementado en odooService.js
      syncResults.recordsProcessed = data?.length || 0;
    } else {
      logger.warn(`Sistema ${systemName} no implementado aún`);
      syncResults.success = false;
      syncResults.errors.push(`Sistema ${systemName} no soportado`);
    }
    
    return syncResults;
  } catch (error) {
    logger.error(`Error sincronizando con ${systemName}`, { error: error.message });
    syncResults.success = false;
    syncResults.errors.push(error.message);
    return syncResults;
  }
}

/**
 * Obtiene estado de todas las integraciones
 */
export function getIntegrationsStatus() {
  return {
    webhook: {
      enabled: INTEGRATIONS.webhook.enabled,
      configured: !!INTEGRATIONS.webhook.url,
      events: INTEGRATIONS.webhook.events
    },
    slack: {
      enabled: INTEGRATIONS.slack.enabled,
      configured: !!INTEGRATIONS.slack.webhookUrl,
      channel: INTEGRATIONS.slack.channel
    },
    email: {
      enabled: INTEGRATIONS.email.enabled,
      configured: !!INTEGRATIONS.email.smtp.host && !!INTEGRATIONS.email.smtp.auth.user,
      recipients: INTEGRATIONS.email.recipients.length
    }
  };
}



