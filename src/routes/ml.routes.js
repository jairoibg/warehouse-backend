/**
 * Rutas para modelos de Machine Learning avanzados
 */

import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  lstmForecast,
  prophetForecast,
  clusterProducts,
  advancedRegression,
  timeSeriesAnalysis,
  detectAnomaliesAdvanced
} from '../services/mlService.js';
import {
  optimizeSpaceWithAI,
  optimizePickingRoutes,
  optimizeInventoryLevels
} from '../services/optimizationService.js';

const router = express.Router();

/**
 * POST /api/ml/lstm/:productCode
 * Forecasting usando LSTM
 */
router.post('/lstm/:productCode', asyncHandler(async (req, res) => {
  const { productCode } = req.params;
  const { periods = 30, lookback = 60 } = req.query;
  
  const result = await lstmForecast(productCode, parseInt(periods), parseInt(lookback));
  res.json({
    success: result.forecast !== null,
    ...result
  });
}));

/**
 * POST /api/ml/prophet/:productCode
 * Forecasting usando Prophet
 */
router.post('/prophet/:productCode', asyncHandler(async (req, res) => {
  const { productCode } = req.params;
  const { periods = 30 } = req.query;
  
  const result = await prophetForecast(productCode, parseInt(periods));
  res.json({
    success: result.forecast !== null,
    ...result
  });
}));

/**
 * GET /api/ml/cluster
 * Clustering de productos usando K-means
 */
router.get('/cluster', asyncHandler(async (req, res) => {
  const { k = 5 } = req.query;
  
  const result = await clusterProducts(parseInt(k));
  res.json({
    success: true,
    ...result
  });
}));

/**
 * POST /api/ml/regression/:productCode
 * Regresión avanzada
 */
router.post('/regression/:productCode', asyncHandler(async (req, res) => {
  const { productCode } = req.params;
  
  const result = await advancedRegression(productCode);
  res.json({
    success: !result.error,
    ...result
  });
}));

/**
 * POST /api/ml/timeseries/:productCode
 * Análisis de series temporales (ARIMA)
 */
router.post('/timeseries/:productCode', asyncHandler(async (req, res) => {
  const { productCode } = req.params;
  
  const result = await timeSeriesAnalysis(productCode);
  res.json({
    success: !result.error,
    ...result
  });
}));

/**
 * POST /api/ml/anomalies/:productCode
 * Detección de anomalías avanzada
 */
router.post('/anomalies/:productCode', asyncHandler(async (req, res) => {
  const { productCode } = req.params;
  
  const result = await detectAnomaliesAdvanced(productCode);
  res.json({
    success: true,
    ...result
  });
}));

/**
 * POST /api/ml/optimize/space
 * Optimización de espacio con IA
 */
router.post('/optimize/space', asyncHandler(async (req, res) => {
  const result = await optimizeSpaceWithAI();
  res.json({
    success: !result.error,
    ...result
  });
}));

/**
 * POST /api/ml/optimize/routes
 * Optimización de rutas de picking
 */
router.post('/optimize/routes', asyncHandler(async (req, res) => {
  const { items } = req.body;
  
  if (!items || !Array.isArray(items)) {
    return res.status(400).json({
      success: false,
      error: 'Items array requerido'
    });
  }
  
  const result = await optimizePickingRoutes(items);
  res.json({
    success: !result.error,
    ...result
  });
}));

/**
 * POST /api/ml/optimize/inventory/:productCode
 * Optimización de niveles de inventario (EOQ)
 */
router.post('/optimize/inventory/:productCode', asyncHandler(async (req, res) => {
  const { productCode } = req.params;
  
  const result = await optimizeInventoryLevels(productCode);
  res.json({
    success: !result.error,
    ...result
  });
}));

export default router;



