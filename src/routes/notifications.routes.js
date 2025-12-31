/**
 * Rutas para notificaciones
 */

import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { 
  sendCriticalAlertsNotification,
  sendStockRiskNotification 
} from '../services/notificationService.js';

const router = express.Router();

/**
 * POST /api/notifications/send/alerts
 * Envía notificación de alertas críticas
 */
router.post('/send/alerts', asyncHandler(async (req, res) => {
  const result = await sendCriticalAlertsNotification();
  res.json({
    success: result.sent,
    ...result
  });
}));

/**
 * POST /api/notifications/send/stock-risk
 * Envía notificación de stock bajo
 */
router.post('/send/stock-risk', asyncHandler(async (req, res) => {
  const result = await sendStockRiskNotification();
  res.json({
    success: result.sent,
    ...result
  });
}));

export default router;



