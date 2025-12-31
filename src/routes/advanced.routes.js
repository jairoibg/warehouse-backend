/**
 * Rutas para funcionalidades avanzadas
 */

import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { 
  calculateTotalStorageCosts, 
  analyzeProductProfitability, 
  analyzeCostsByBrand,
  analyzeSpaceEfficiency 
} from '../services/costAnalysisService.js';
import { 
  generateIntelligentRecommendations,
  generateSlottingRecommendations 
} from '../services/recommendationService.js';
import { 
  detectSeasonalPatterns, 
  analyzeInventoryTrends,
  detectAnomalies 
} from '../services/trendAnalysisService.js';
import { 
  simulateSalesIncrease, 
  simulateInventoryReduction,
  simulateSpaceOptimization 
} from '../services/scenarioService.js';

const router = express.Router();

/**
 * GET /api/advanced/costs
 * Análisis completo de costos
 */
router.get('/costs', asyncHandler(async (req, res) => {
  const [storageCosts, profitability, brandCosts, efficiency] = await Promise.all([
    calculateTotalStorageCosts(),
    analyzeProductProfitability(),
    analyzeCostsByBrand(),
    analyzeSpaceEfficiency()
  ]);
  
  res.json({
    success: true,
    storageCosts,
    profitability,
    brandCosts,
    efficiency
  });
}));

/**
 * GET /api/advanced/recommendations
 * Recomendaciones inteligentes
 */
router.get('/recommendations', asyncHandler(async (req, res) => {
  const recommendations = await generateIntelligentRecommendations();
  res.json({
    success: true,
    ...recommendations
  });
}));

/**
 * GET /api/advanced/slotting
 * Recomendaciones de slotting
 */
router.get('/slotting', asyncHandler(async (req, res) => {
  const slotting = await generateSlottingRecommendations();
  res.json({
    success: true,
    ...slotting
  });
}));

/**
 * GET /api/advanced/trends
 * Análisis de tendencias
 */
router.get('/trends', asyncHandler(async (req, res) => {
  const { days = 30 } = req.query;
  const [seasonal, inventory, anomalies] = await Promise.all([
    detectSeasonalPatterns(parseInt(days)),
    analyzeInventoryTrends(parseInt(days)),
    detectAnomalies(parseInt(days))
  ]);
  
  res.json({
    success: true,
    seasonal,
    inventory,
    anomalies
  });
}));

/**
 * POST /api/advanced/scenarios/sales-increase
 * Simula aumento de ventas
 */
router.post('/scenarios/sales-increase', asyncHandler(async (req, res) => {
  const { percentage = 20, days = 30 } = req.body;
  const scenario = await simulateSalesIncrease(percentage, days);
  res.json({
    success: true,
    ...scenario
  });
}));

/**
 * POST /api/advanced/scenarios/inventory-reduction
 * Simula reducción de inventario
 */
router.post('/scenarios/inventory-reduction', asyncHandler(async (req, res) => {
  const { percentage = 10 } = req.body;
  const scenario = await simulateInventoryReduction(percentage);
  res.json({
    success: true,
    ...scenario
  });
}));

/**
 * GET /api/advanced/scenarios/space-optimization
 * Simula optimización de espacio
 */
router.get('/scenarios/space-optimization', asyncHandler(async (req, res) => {
  const scenario = await simulateSpaceOptimization();
  res.json({
    success: true,
    ...scenario
  });
}));

export default router;



