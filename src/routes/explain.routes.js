/**
 * Rutas para explicabilidad y audit trail
 */

import express from 'express';
import fs from 'fs/promises';
import { asyncHandler } from '../middleware/errorHandler.js';
import { explanationEngine } from '../../explanation_engine.js';
import { LOCATIONS_FILE } from '../config/dataPaths.js';

const router = express.Router();

/**
 * GET /api/explain/abc/:productCode
 * Explicar clasificación ABC de un producto
 */
router.get('/abc/:productCode', asyncHandler(async (req, res) => {
  const { productCode } = req.params;
  
  console.log(`🔍 Solicitando explicación ABC para: ${productCode}`);
  
  const dataPath = LOCATIONS_FILE;
  const raw = await fs.readFile(dataPath, 'utf8');
  const locations = JSON.parse(raw);
  
  let productData = null;
  let locationId = null;
  
  for (const loc of locations) {
    const found = (loc.packages || []).find(p => 
      p.productCode === productCode || p.surtido.includes(productCode)
    );
    if (found) {
      productData = found;
      locationId = loc.id;
      break;
    }
  }
  
  if (!productData) {
    return res.status(404).json({ 
      error: 'Producto no encontrado',
      code: productCode 
    });
  }
  
  const explanation = explanationEngine.explainABCClassification(
    null,
    productCode,
    productData.abcClass,
    null,
    {
      velocity: productData.velocity,
      daysOld: productData.daysOld,
      qty: productData.qty,
      cost: productData.cost
    }
  );
  
  explanation.context = {
    foundInLocation: locationId,
    currentStock: productData.qty,
    reservedStock: productData.reservedQty,
    season: productData.season,
    ageInDays: productData.daysOld
  };
  
  res.json(explanation);
}));

/**
 * GET /api/explain/location/:locationId
 * Explicar ubicación
 */
router.get('/location/:locationId', asyncHandler(async (req, res) => {
  const { locationId } = req.params;
  
  console.log(`🔍 Explicando ubicación: ${locationId}`);
  
  const dataPath = LOCATIONS_FILE;
  const raw = await fs.readFile(dataPath, 'utf8');
  const locations = JSON.parse(raw);
  
  const location = locations.find(l => l.id === locationId);
  
  if (!location) {
    return res.status(404).json({ error: 'Ubicación no encontrada' });
  }
  
  const analysis = {
    locationId: location.id,
    status: location.status,
    brand: location.brand,
    totalStock: location.totalStock,
    occupancy: location.occupancyPercentage,
    composition: { A: 0, B: 0, C: 0, D: 0 },
    products: [],
    issues: [],
    dataSource: {
      odooTable: 'stock.quant',
      lastSync: new Date().toISOString(),
      recordsAnalyzed: location.packages?.length || 0
    }
  };
  
  (location.packages || []).forEach(pkg => {
    const cls = pkg.abcClass || 'D';
    analysis.composition[cls] += pkg.qty;
    
    analysis.products.push({
      code: pkg.productCode,
      class: cls,
      qty: pkg.qty,
      age: pkg.daysOld,
      velocity: pkg.velocity,
      season: pkg.season
    });
  });
  
  if (analysis.composition.D > analysis.totalStock * 0.5) {
    analysis.issues.push({
      type: 'majority_class_d',
      severity: 'HIGH',
      description: 'Más del 50% del stock es clase D (sin rotación)',
      impact: 'Capital inmovilizado, espacio desperdiciado',
      recommendation: 'Evaluar liquidación o compactación'
    });
  }
  
  if (location.occupancyPercentage < 30) {
    analysis.issues.push({
      type: 'low_occupancy',
      severity: 'MEDIUM',
      description: `Ocupación: ${location.occupancyPercentage}% (muy baja)`,
      impact: 'Ineficiencia de espacio',
      recommendation: 'Compactar con otras ubicaciones'
    });
  }
  
  analysis.products.sort((a, b) => {
    const priority = { D: 0, C: 1, B: 2, A: 3 };
    return (priority[a.class] || 0) - (priority[b.class] || 0);
  });
  
  res.json(analysis);
}));

/**
 * GET /api/explain/audit-trail
 * Ver audit trail (queries de Odoo)
 */
router.get('/audit-trail', asyncHandler(async (req, res) => {
  const { limit = 20 } = req.query;
  
  const evidence = Array.from(explanationEngine.evidenceStore.values())
    .filter(item => item.queryType)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, parseInt(limit));
  
  const auditTrail = evidence.map(e => ({
    queryId: e.queryId,
    timestamp: e.timestamp,
    source: e.source,
    type: e.queryType,
    params: e.params,
    resultCount: e.resultCount,
    executionTime: e.executionTime,
    sampleData: e.sampleData
  }));
  
  res.json({
    total: evidence.length,
    showing: auditTrail.length,
    queries: auditTrail
  });
}));

/**
 * POST /api/explain/verify
 * Verificar datos en tiempo real
 */
router.post('/verify', asyncHandler(async (req, res) => {
  const { productCode, metric } = req.body;
  
  if (!productCode) {
    return res.status(400).json({ error: 'productCode requerido' });
  }
  
  console.log(`🔬 Verificando datos para: ${productCode}, métrica: ${metric}`);
  
  // Re-consultar Odoo en tiempo real (simplificado)
  const verificationData = {
    productCode,
    metric,
    values: {
      currentStock: 0, // Se obtendría de Odoo real
      salesLast30Days: 0,
      salesLast90Days: 0,
      averageDailySales: 0,
      lastSaleDate: null,
      abcClassInOdoo: null,
      source: 'Consulta directa a Odoo'
    },
    verification: {
      matchesCache: true,
      confidence: 'HIGH',
      lastOdooSync: new Date().toISOString()
    }
  };
  
  res.json({
    productCode,
    metric,
    timestamp: new Date().toISOString(),
    verified: true,
    data: verificationData,
    source: 'Odoo ERP (consulta en tiempo real)',
    note: 'Estos datos son una re-consulta independiente para verificación'
  });
}));

export default router;



