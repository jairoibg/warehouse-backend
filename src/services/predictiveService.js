/**
 * Servicio de análisis predictivo
 * Predicción de stock bajo, forecasting de demanda, etc.
 */

import { getRealTimeSales } from './odooService.js';
import { getWarehouseContext } from './warehouseService.js';
import { logger } from '../middleware/logger.js';

/**
 * Calcula la velocidad de ventas promedio de un producto
 */
export async function calculateSalesVelocity(productCode, days = 90) {
  try {
    const sales = await getRealTimeSales(days);
    const productSales = sales.filter(s => 
      s.p && s.p.toUpperCase().includes(productCode.toUpperCase())
    );
    
    if (productSales.length === 0) {
      return 0;
    }
    
    const totalQty = productSales.reduce((sum, s) => sum + (s.q || 0), 0);
    return totalQty / days; // Unidades por día
  } catch (error) {
    logger.warn(`Error calculando velocidad de ventas para ${productCode}:`, error.message);
    return 0;
  }
}

/**
 * Predice cuándo un producto se quedará sin stock
 * @param {string} productCode - Código del producto
 * @param {number} currentStock - Stock actual
 * @param {number} daysAhead - Días hacia adelante para predecir (7, 14, 30)
 * @returns {Object} Predicción con días hasta stock bajo y recomendaciones
 */
export async function predictStockOut(productCode, currentStock, daysAhead = 30) {
  const velocity = await calculateSalesVelocity(productCode, 90);
  
  if (velocity === 0) {
    return {
      productCode,
      currentStock,
      velocity: 0,
      daysUntilOut: Infinity,
      risk: 'LOW',
      message: 'Producto sin rotación reciente',
      recommendation: 'Revisar si es producto estacional o discontinuado'
    };
  }

  const daysUntilOut = Math.floor(currentStock / velocity);
  const projectedStock = Math.max(0, currentStock - (velocity * daysAhead));
  
  let risk = 'LOW';
  let recommendation = '';
  
  if (daysUntilOut <= 7) {
    risk = 'CRITICAL';
    recommendation = 'URGENTE: Reponer inmediatamente';
  } else if (daysUntilOut <= 14) {
    risk = 'HIGH';
    recommendation = 'Reponer en los próximos días';
  } else if (daysUntilOut <= 30) {
    risk = 'MEDIUM';
    recommendation = 'Planificar reposición';
  } else {
    risk = 'LOW';
    recommendation = 'Stock suficiente';
  }

  return {
    productCode,
    currentStock,
    velocity: parseFloat(velocity.toFixed(2)),
    daysUntilOut,
    projectedStock: Math.round(projectedStock),
    risk,
    recommendation,
    reorderPoint: Math.ceil(velocity * 14) // Punto de reorden: 14 días de stock
  };
}

/**
 * Analiza todos los productos y detecta riesgo de stock bajo
 * @param {number} daysAhead - Días hacia adelante
 * @returns {Array} Lista de productos en riesgo
 */
export async function analyzeStockRisk(daysAhead = 30) {
  const { locations } = await getWarehouseContext();
  
  // Agrupar stock por producto
  const productStock = {};
  
  locations.forEach(loc => {
    if (!loc.packages) return;
    
    loc.packages.forEach(pkg => {
      const code = pkg.productCode || pkg.surtido || 'UNKNOWN';
      if (!productStock[code]) {
        productStock[code] = {
          productCode: code,
          totalStock: 0,
          locations: []
        };
      }
      productStock[code].totalStock += pkg.qty || 0;
      productStock[code].locations.push(loc.id);
    });
  });

  // Analizar cada producto
  const risks = [];
  
  for (const [code, data] of Object.entries(productStock)) {
    if (data.totalStock === 0) continue;
    
    try {
      const prediction = await predictStockOut(code, data.totalStock, daysAhead);
      if (prediction.risk !== 'LOW') {
        risks.push({
          ...prediction,
          locations: [...new Set(data.locations)]
        });
      }
    } catch (error) {
      console.warn(`Error analizando ${code}:`, error.message);
    }
  }

  // Ordenar por riesgo (CRITICAL primero)
  const riskOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  risks.sort((a, b) => riskOrder[a.risk] - riskOrder[b.risk]);

  return risks;
}

/**
 * Forecasting avanzado de demanda usando media móvil exponencial y análisis de tendencia
 * @param {string} productCode - Código del producto
 * @param {number} periods - Períodos a predecir (días)
 * @returns {Object} Forecast con tendencia, intervalos de confianza y proyecciones
 */
export async function forecastDemand(productCode, periods = 30) {
  const sales = await getRealTimeSales(90);
  const productSales = sales.filter(s => 
    s.p && s.p.toUpperCase().includes(productCode.toUpperCase())
  );

  if (productSales.length === 0) {
    return {
      productCode,
      forecast: 0,
      dailyAverage: 0,
      trend: 'STABLE',
      confidence: 'LOW',
      confidenceInterval: { min: 0, max: 0 },
      projections: {
        optimistic: 0,
        realistic: 0,
        pessimistic: 0
      },
      message: 'Sin datos históricos suficientes',
      recommendations: ['Recopilar más datos de ventas', 'Revisar si es producto nuevo']
    };
  }

  // Calcular total de unidades vendidas
  const totalUnits = productSales.reduce((sum, s) => sum + (s.q || 0), 0);
  const avgDaily = totalUnits / 90;
  
  // Media móvil ponderada (últimos 30 días tienen más peso)
  const recentSales = productSales.slice(-30);
  const olderSales = productSales.slice(0, -30);
  
  const recentAvg = recentSales.length > 0 
    ? recentSales.reduce((sum, s) => sum + (s.q || 0), 0) / recentSales.length 
    : avgDaily;
  const olderAvg = olderSales.length > 0
    ? olderSales.reduce((sum, s) => sum + (s.q || 0), 0) / olderSales.length
    : avgDaily;
  
  // Media móvil exponencial (EMA) - más peso a datos recientes
  const alpha = 0.3; // Factor de suavizado
  const ema = olderAvg * (1 - alpha) + recentAvg * alpha;
  
  // Calcular tendencia
  const firstThird = productSales.slice(0, Math.floor(productSales.length / 3));
  const middleThird = productSales.slice(
    Math.floor(productSales.length / 3), 
    Math.floor(productSales.length * 2 / 3)
  );
  const lastThird = productSales.slice(-Math.floor(productSales.length / 3));
  
  const firstAvg = firstThird.reduce((sum, s) => sum + (s.q || 0), 0) / firstThird.length;
  const middleAvg = middleThird.reduce((sum, s) => sum + (s.q || 0), 0) / middleThird.length;
  const lastAvg = lastThird.reduce((sum, s) => sum + (s.q || 0), 0) / lastThird.length;
  
  let trend = 'STABLE';
  let trendStrength = 0;
  
  if (lastAvg > middleAvg && middleAvg > firstAvg) {
    trend = 'INCREASING';
    trendStrength = ((lastAvg - firstAvg) / firstAvg) * 100;
  } else if (lastAvg < middleAvg && middleAvg < firstAvg) {
    trend = 'DECREASING';
    trendStrength = ((firstAvg - lastAvg) / firstAvg) * 100;
  }
  
  // Calcular volatilidad (desviación estándar)
  const values = productSales.map(s => s.q || 0);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);
  const coefficientOfVariation = mean > 0 ? (stdDev / mean) * 100 : 0;
  
  // Forecast base usando EMA
  const baseForecast = Math.round(ema * periods);
  
  // Ajustar según tendencia
  let adjustedForecast = baseForecast;
  if (trend === 'INCREASING' && trendStrength > 10) {
    adjustedForecast = Math.round(baseForecast * (1 + (trendStrength / 100) * 0.5));
  } else if (trend === 'DECREASING' && trendStrength > 10) {
    adjustedForecast = Math.round(baseForecast * (1 - (trendStrength / 100) * 0.3));
  }
  
  // Intervalos de confianza (95%)
  const marginOfError = stdDev * 1.96; // Z-score para 95%
  const confidenceInterval = {
    min: Math.max(0, Math.round((ema - marginOfError) * periods)),
    max: Math.round((ema + marginOfError) * periods)
  };
  
  // Proyecciones: optimista, realista, pesimista
  const projections = {
    optimistic: Math.round((ema + marginOfError * 0.5) * periods * 1.1),
    realistic: adjustedForecast,
    pessimistic: Math.max(0, Math.round((ema - marginOfError * 0.5) * periods * 0.9))
  };
  
  // Calcular nivel de confianza
  let confidence = 'LOW';
  if (productSales.length > 60 && coefficientOfVariation < 50) {
    confidence = 'HIGH';
  } else if (productSales.length > 30 && coefficientOfVariation < 80) {
    confidence = 'MEDIUM';
  }
  
  // Recomendaciones basadas en el forecast
  const recommendations = [];
  if (trend === 'INCREASING' && trendStrength > 20) {
    recommendations.push('Aumentar stock para satisfacer demanda creciente');
  } else if (trend === 'DECREASING' && trendStrength > 20) {
    recommendations.push('Reducir pedidos, demanda en declive');
  }
  if (coefficientOfVariation > 100) {
    recommendations.push('Alta volatilidad: considerar stock de seguridad mayor');
  }
  if (confidence === 'LOW') {
    recommendations.push('Datos insuficientes: recopilar más historial de ventas');
  }
  
  return {
    productCode,
    forecast: adjustedForecast,
    dailyAverage: parseFloat(ema.toFixed(2)),
    trend,
    trendStrength: parseFloat(trendStrength.toFixed(1)),
    confidence,
    confidenceInterval,
    projections,
    volatility: {
      stdDev: parseFloat(stdDev.toFixed(2)),
      coefficientOfVariation: parseFloat(coefficientOfVariation.toFixed(1))
    },
    periods,
    dataQuality: {
      sampleSize: productSales.length,
      daysOfData: 90,
      completeness: productSales.length > 0 ? 'GOOD' : 'POOR'
    },
    recommendations
  };
}

/**
 * Detecta productos con stock muerto (sin movimiento)
 * @param {number} daysThreshold - Días sin movimiento para considerar muerto
 * @returns {Array} Productos con stock muerto
 */
export async function detectDeadStock(daysThreshold = 180) {
  const { locations } = await getWarehouseContext();
  const deadStock = [];

  locations.forEach(loc => {
    if (!loc.packages) return;
    
    loc.packages.forEach(pkg => {
      if ((pkg.daysOld || 0) >= daysThreshold) {
        deadStock.push({
          productCode: pkg.productCode || pkg.surtido,
          location: loc.id,
          quantity: pkg.qty || 0,
          daysOld: pkg.daysOld,
          cost: pkg.cost || 0,
          totalValue: (pkg.qty || 0) * (pkg.cost || 0),
          abcClass: pkg.abcClass || 'D',
          season: pkg.season || 'N/A'
        });
      }
    });
  });

  // Agrupar por producto
  const grouped = {};
  deadStock.forEach(item => {
    const key = item.productCode;
    if (!grouped[key]) {
      grouped[key] = {
        productCode: key,
        totalQuantity: 0,
        totalValue: 0,
        locations: [],
        maxDaysOld: 0,
        abcClass: item.abcClass,
        season: item.season
      };
    }
    grouped[key].totalQuantity += item.quantity;
    grouped[key].totalValue += item.totalValue;
    grouped[key].locations.push(item.location);
    grouped[key].maxDaysOld = Math.max(grouped[key].maxDaysOld, item.daysOld);
  });

  return Object.values(grouped).sort((a, b) => b.totalValue - a.totalValue);
}

