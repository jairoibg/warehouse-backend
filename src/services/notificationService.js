/**
 * Sistema de notificaciones (email, push, etc.)
 */

import { generateAllAlerts } from './alertService.js';
import { analyzeStockRisk } from './predictiveService.js';
import { logger } from '../middleware/logger.js';

// Configuración de notificaciones
const NOTIFICATION_CONFIG = {
  email: {
    enabled: process.env.EMAIL_ENABLED === 'true',
    recipients: process.env.EMAIL_RECIPIENTS?.split(',') || []
  },
  push: {
    enabled: process.env.PUSH_ENABLED === 'true'
  },
  thresholds: {
    criticalAlerts: 5,
    criticalStockRisks: 10,
    deadStockValue: 50000
  }
};

/**
 * Envía notificaciones de alertas críticas
 */
export async function sendCriticalAlertsNotification() {
  try {
    const alerts = await generateAllAlerts();
    const criticalAlerts = alerts.filter(a => a.severity === 'CRITICAL');
    
    if (criticalAlerts.length < NOTIFICATION_CONFIG.thresholds.criticalAlerts) {
      return { sent: false, reason: 'Below threshold' };
    }
    
    const message = {
      subject: `🚨 ${criticalAlerts.length} Alertas Críticas en el Almacén`,
      body: `Se han detectado ${criticalAlerts.length} alertas críticas que requieren atención inmediata:\n\n` +
            criticalAlerts.map(a => `- ${a.title}: ${a.message}`).join('\n'),
      alerts: criticalAlerts
    };
    
    // En producción, aquí enviarías el email
    if (NOTIFICATION_CONFIG.email.enabled) {
      logger.info('Notificación de alertas críticas', { 
        recipients: NOTIFICATION_CONFIG.email.recipients,
        alertCount: criticalAlerts.length 
      });
      // await sendEmail(NOTIFICATION_CONFIG.email.recipients, message.subject, message.body);
    }
    
    return { sent: true, message };
  } catch (error) {
    logger.error('Error enviando notificación', { error: error.message });
    return { sent: false, error: error.message };
  }
}

/**
 * Envía notificación de stock bajo crítico
 */
export async function sendStockRiskNotification() {
  try {
    const risks = await analyzeStockRisk(14); // Próximos 14 días
    const criticalRisks = risks.filter(r => r.risk === 'CRITICAL');
    
    if (criticalRisks.length < NOTIFICATION_CONFIG.thresholds.criticalStockRisks) {
      return { sent: false, reason: 'Below threshold' };
    }
    
    const message = {
      subject: `⚠️ ${criticalRisks.length} Productos con Stock Bajo Crítico`,
      body: `${criticalRisks.length} productos se quedarán sin stock en los próximos 14 días:\n\n` +
            criticalRisks.slice(0, 10).map(r => 
              `- ${r.productCode}: ${r.currentStock} uds (${r.daysUntilOut} días restantes)`
            ).join('\n'),
      risks: criticalRisks
    };
    
    if (NOTIFICATION_CONFIG.email.enabled) {
      logger.info('Notificación de stock bajo', { 
        recipients: NOTIFICATION_CONFIG.email.recipients,
        riskCount: criticalRisks.length 
      });
    }
    
    return { sent: true, message };
  } catch (error) {
    logger.error('Error enviando notificación de stock', { error: error.message });
    return { sent: false, error: error.message };
  }
}

/**
 * Programa notificaciones automáticas
 */
export function startNotificationScheduler(intervalHours = 24) {
  const intervalMs = intervalHours * 60 * 60 * 1000;
  
  // Enviar inmediatamente
  sendCriticalAlertsNotification().catch(err => 
    logger.error('Error en notificación inicial', { error: err.message })
  );
  
  // Programar envío periódico
  const interval = setInterval(() => {
    Promise.all([
      sendCriticalAlertsNotification(),
      sendStockRiskNotification()
    ]).catch(err => logger.error('Error en notificaciones programadas', { error: err.message }));
  }, intervalMs);
  
  logger.info(`Programador de notificaciones iniciado (cada ${intervalHours} horas)`);
  
  return interval;
}



