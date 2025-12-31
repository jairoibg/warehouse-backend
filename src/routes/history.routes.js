/**
 * Rutas para historial y comparativas
 */

import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getMetricsHistory, getPeriodComparison } from '../services/historyService.js';

const router = express.Router();

/**
 * GET /api/history/metrics
 * Obtiene historial de métricas
 */
router.get('/metrics', asyncHandler(async (req, res) => {
  const { days = 30 } = req.query;
  const history = await getMetricsHistory(parseInt(days));
  
  res.json({
    success: true,
    days: parseInt(days),
    count: history.length,
    data: history
  });
}));

/**
 * GET /api/history/comparison
 * Compara dos períodos
 */
router.get('/comparison', asyncHandler(async (req, res) => {
  const { period1 = 7, period2 = 30 } = req.query;
  const comparison = await getPeriodComparison(parseInt(period1), parseInt(period2));
  
  if (!comparison) {
    return res.status(404).json({
      success: false,
      error: 'No hay suficientes datos históricos para la comparación'
    });
  }
  
  res.json({
    success: true,
    comparison
  });
}));

export default router;



