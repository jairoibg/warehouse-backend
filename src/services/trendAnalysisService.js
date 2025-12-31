/**
 * Análisis de tendencias y patrones estacionales
 */

import { getMetricsHistory } from './historyService.js';
import { getRealTimeSales } from './odooService.js';
import { logger } from '../middleware/logger.js';

/**
 * Detecta patrones estacionales en ventas
 */
export async function detectSeasonalPatterns(days = 365) {
  try {
    const sales = await getRealTimeSales(days);
    
    // Agrupar por mes
    const monthlySales = {};
    
    sales.forEach(sale => {
      // Nota: En producción, usarías la fecha real de la venta
      // Por ahora, simulamos distribución
      const month = new Date().getMonth();
      const monthKey = `${new Date().getFullYear()}-${String(month + 1).padStart(2, '0')}`;
      
      if (!monthlySales[monthKey]) {
        monthlySales[monthKey] = { units: 0, value: 0, products: new Set() };
      }
      
      monthlySales[monthKey].units += sale.q || 0;
      monthlySales[monthKey].value += sale.v || 0;
      if (sale.p) monthlySales[monthKey].products.add(sale.p);
    });
    
    // Calcular tendencia
    const months = Object.keys(monthlySales).sort();
    const values = months.map(m => monthlySales[m].units);
    
    let trend = 'STABLE';
    if (values.length >= 3) {
      const firstThird = values.slice(0, Math.floor(values.length / 3));
      const lastThird = values.slice(-Math.floor(values.length / 3));
      const firstAvg = firstThird.reduce((a, b) => a + b, 0) / firstThird.length;
      const lastAvg = lastThird.reduce((a, b) => a + b, 0) / lastThird.length;
      
      if (lastAvg > firstAvg * 1.15) trend = 'INCREASING';
      else if (lastAvg < firstAvg * 0.85) trend = 'DECREASING';
    }
    
    return {
      period: `${days} días`,
      monthlyBreakdown: Object.entries(monthlySales).map(([month, data]) => ({
        month,
        units: data.units,
        value: data.value,
        uniqueProducts: data.products.size
      })),
      trend,
      peakMonth: months.reduce((max, m) => 
        monthlySales[m].units > monthlySales[max].units ? m : max, months[0]
      ),
      lowMonth: months.reduce((min, m) => 
        monthlySales[m].units < monthlySales[min].units ? m : min, months[0]
      )
    };
  } catch (error) {
    logger.error('Error detectando patrones estacionales', { error: error.message });
    return null;
  }
}

/**
 * Analiza tendencias de inventario
 */
export async function analyzeInventoryTrends(days = 30) {
  const history = await getMetricsHistory(days);
  
  if (history.length < 2) {
    return null;
  }
  
  const first = history[0].metrics;
  const last = history[history.length - 1].metrics;
  
  const trends = {
    totalValue: {
      change: last.totalValue - first.totalValue,
      percentage: ((last.totalValue - first.totalValue) / first.totalValue) * 100,
      direction: last.totalValue > first.totalValue ? 'UP' : 'DOWN'
    },
    totalStock: {
      change: last.totalStock - first.totalStock,
      percentage: ((last.totalStock - first.totalStock) / first.totalStock) * 100,
      direction: last.totalStock > first.totalStock ? 'UP' : 'DOWN'
    },
    avgOccupancy: {
      change: last.avgOccupancy - first.avgOccupancy,
      percentage: ((last.avgOccupancy - first.avgOccupancy) / first.avgOccupancy) * 100,
      direction: last.avgOccupancy > first.avgOccupancy ? 'UP' : 'DOWN'
    },
    occupiedLocations: {
      change: last.occupiedLocations - first.occupiedLocations,
      percentage: ((last.occupiedLocations - first.occupiedLocations) / first.occupiedLocations) * 100,
      direction: last.occupiedLocations > first.occupiedLocations ? 'UP' : 'DOWN'
    }
  };
  
  // Calcular volatilidad (desviación estándar)
  const valueStdDev = calculateStdDev(history.map(h => h.metrics.totalValue));
  const occupancyStdDev = calculateStdDev(history.map(h => h.metrics.avgOccupancy));
  
  return {
    period: `${days} días`,
    trends,
    volatility: {
      value: valueStdDev,
      occupancy: occupancyStdDev
    },
    forecast: {
      nextWeekValue: last.totalValue + (trends.totalValue.change / history.length) * 7,
      nextWeekOccupancy: last.avgOccupancy + (trends.avgOccupancy.change / history.length) * 7
    }
  };
}

function calculateStdDev(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
  const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(avgSquaredDiff);
}

/**
 * Detecta anomalías en los datos
 */
export async function detectAnomalies(days = 30) {
  const history = await getMetricsHistory(days);
  
  if (history.length < 5) {
    return [];
  }
  
  const values = history.map(h => h.metrics.totalValue);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const stdDev = calculateStdDev(values);
  const threshold = 2 * stdDev; // 2 desviaciones estándar
  
  const anomalies = [];
  
  history.forEach((snapshot, index) => {
    const value = snapshot.metrics.totalValue;
    const deviation = Math.abs(value - mean);
    
    if (deviation > threshold) {
      anomalies.push({
        timestamp: snapshot.timestamp,
        metric: 'totalValue',
        value,
        expected: mean,
        deviation: deviation,
        deviationPercentage: (deviation / mean) * 100,
        type: value > mean ? 'SPIKE' : 'DROP'
      });
    }
  });
  
  return anomalies;
}



