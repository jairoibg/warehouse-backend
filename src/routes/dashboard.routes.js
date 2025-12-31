/**
 * Rutas para dashboard ejecutivo
 */

import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { logger } from '../middleware/logger.js';
import { getWarehouseContext } from '../services/warehouseService.js';
import { strategicAnalyzer } from '../../strategic_analyzer.js';
import { getRealTimeSales } from '../services/odooService.js';
import { analyzeStockRisk, detectDeadStock } from '../services/predictiveService.js';
import { generateAllAlerts } from '../services/alertService.js';
import {
  getCachedMetrics,
  setCachedMetrics,
  getCachedAlerts,
  setCachedAlerts,
  getCachedOverview,
  setCachedOverview,
  clearCache,
  getCacheInfo
} from '../services/dashboardCacheService.js';

const router = express.Router();

/**
 * GET /api/dashboard/health
 * Health check simple
 */
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * GET /api/dashboard/metrics
 * KPIs principales para el dashboard (con caché)
 */
router.get('/metrics', asyncHandler(async (req, res) => {
  // Verificar caché primero
  const cached = getCachedMetrics();
  if (cached && !req.query.force) {
    return res.json({ 
      ...cached,
      cached: true,
      cacheAge: Date.now() - (cached._cacheTimestamp || 0)
    });
  }

  // Timeout wrapper para evitar que se cuelgue
  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error('Timeout calculando métricas')), 30000)
  );

  try {
    const { locations, totalValue, itemsWithCost, totalItems } = await Promise.race([
      getWarehouseContext(),
      timeoutPromise
    ]);
    
    const intelligence = await Promise.race([
      strategicAnalyzer.gatherIntelligence(locations),
      timeoutPromise
    ]);
    
    // Calcular métricas adicionales
    const totalLocations = locations.length;
  const occupiedLocations = locations.filter(loc => (loc.totalStock || 0) > 0).length;
  const emptyLocations = totalLocations - occupiedLocations;
  
  const totalStock = locations.reduce((sum, loc) => sum + (loc.totalStock || 0), 0);
  const avgOccupancy = totalLocations > 0 
    ? locations.reduce((sum, loc) => sum + (loc.occupancyPercentage || 0), 0) / totalLocations 
    : 0;
  
  const criticalIssues = intelligence.issues.filter(i => i.type === 'critical');
  
  const kpis = {
    inventoryValue: { 
      value: totalValue,
      formatted: `€${totalValue.toLocaleString('es-ES', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`
    },
    occupancyRate: { 
      value: parseFloat(intelligence.basic.occupancyRate) || 0,
      formatted: `${(parseFloat(intelligence.basic.occupancyRate) || 0).toFixed(1)}%`
    },
    totalLocations: {
      value: totalLocations,
      occupied: occupiedLocations,
      empty: emptyLocations
    },
    totalStock: {
      value: totalStock,
      formatted: totalStock.toLocaleString('es-ES')
    },
    averageOccupancy: {
      value: parseFloat(avgOccupancy.toFixed(2)),
      formatted: `${avgOccupancy.toFixed(1)}%`
    },
    criticalIssues: criticalIssues.length,
    criticalIssuesDetails: criticalIssues.map(i => ({
      type: i.type,
      title: i.title || i.message || 'Problema crítico',
      message: i.message || i.description || '',
      severity: i.severity || 'CRITICAL'
    })),
    opportunities: intelligence.opportunities.length,
    abc: intelligence.abc.distribution,
    seasons: intelligence.seasons
  };

  const response = { 
    kpis, 
    summary: { 
      health: kpis.criticalIssues === 0 ? 'excellent' : kpis.criticalIssues <= 3 ? 'good' : 'fair',
      timestamp: new Date().toISOString()
    },
    _cacheTimestamp: Date.now()
  };

    // Guardar en caché
    setCachedMetrics(response);

    res.json(response);
  } catch (error) {
    // Si hay timeout o error, devolver datos básicos desde caché si existe
    if (cached) {
      logger.warn('Error calculando métricas, usando caché', { error: error.message });
      return res.json({ 
        ...cached,
        cached: true,
        cacheAge: Date.now() - (cached._cacheTimestamp || 0),
        warning: 'Datos en caché debido a timeout'
      });
    }
    // Si no hay caché, lanzar el error para que lo maneje el errorHandler
    throw error;
  }
}));

/**
 * GET /api/dashboard/alerts
 * Alertas activas para el dashboard (con caché)
 */
router.get('/alerts', asyncHandler(async (req, res) => {
  // Verificar caché
  const cached = getCachedAlerts();
  if (cached && !req.query.force) {
    return res.json({ 
      ...cached,
      cached: true
    });
  }

  const { limit = 20, severity } = req.query;
  const alerts = await generateAllAlerts();
  
  let filtered = alerts;
  if (severity) {
    filtered = filtered.filter(a => a.severity === severity);
  }
  if (limit) {
    filtered = filtered.slice(0, parseInt(limit));
  }
  
  const response = {
    success: true,
    total: alerts.length,
    showing: filtered.length,
    alerts: filtered,
    _cacheTimestamp: Date.now()
  };

  // Guardar en caché
  setCachedAlerts(response);

  res.json(response);
}));

/**
 * GET /api/dashboard/overview
 * Vista general completa del dashboard (con caché)
 */
router.get('/overview', asyncHandler(async (req, res) => {
  // Verificar caché
  const cached = getCachedOverview();
  if (cached && !req.query.force) {
    return res.json({ 
      ...cached,
      cached: true
    });
  }

  const { locations, totalValue } = await getWarehouseContext();
  const intelligence = await strategicAnalyzer.gatherIntelligence(locations);
  
  // Análisis de riesgo rápido
  const stockRisks = await analyzeStockRisk(30);
  const criticalRisks = stockRisks.filter(r => r.risk === 'CRITICAL').length;
  
  // Stock muerto
  const deadStock = await detectDeadStock(180);
  const deadStockValue = deadStock.reduce((sum, item) => sum + item.totalValue, 0);
  
  // Ventas recientes
  let recentSales = null;
  try {
    recentSales = await getRealTimeSales(7);
  } catch (e) {
    console.warn('No se pudieron obtener ventas recientes');
  }
  
  const salesStats = recentSales ? {
    totalUnits: recentSales.reduce((sum, s) => sum + (s.q || 0), 0),
    totalValue: recentSales.reduce((sum, s) => sum + (s.v || 0), 0),
    uniqueProducts: new Set(recentSales.map(s => s.p)).size
  } : null;

  const occupiedLocations = locations.filter(l => (l.totalStock || 0) > 0).length;

  const response = {
    success: true,
    timestamp: new Date().toISOString(),
    overview: {
      inventory: {
        totalValue,
        totalLocations: locations.length,
        occupiedLocations: occupiedLocations,
        occupancyRate: parseFloat(intelligence.basic.occupancyRate) || 0
      },
      risks: {
        stockLow: {
          critical: criticalRisks,
          high: stockRisks.filter(r => r.risk === 'HIGH').length,
          total: stockRisks.length
        },
        deadStock: {
          count: deadStock.length,
          totalValue: deadStockValue
        }
      },
      sales: salesStats,
      health: {
        status: intelligence.issues.filter(i => i.type === 'critical').length === 0 ? 'excellent' : 'attention',
        criticalIssues: intelligence.issues.filter(i => i.type === 'critical').length,
        opportunities: intelligence.opportunities.length
      }
    },
    _cacheTimestamp: Date.now()
  };

  // Guardar en caché
  setCachedOverview(response);

  res.json(response);
}));

/**
 * POST /api/dashboard/refresh
 * Fuerza recarga del dashboard (limpia caché)
 */
router.post('/refresh', asyncHandler(async (req, res) => {
  clearCache();
  res.json({ 
    success: true, 
    message: 'Caché limpiado. El próximo request recargará los datos.',
    cacheInfo: getCacheInfo()
  });
}));

export default router;

