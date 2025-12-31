/**
 * Sistema de alertas configurable
 */

import { analyzeStockRisk, detectDeadStock } from './predictiveService.js';
import { getWarehouseContext } from './warehouseService.js';
import { logger } from '../middleware/logger.js';

// Configuración de alertas
const ALERT_CONFIG = {
  stockLow: {
    enabled: true,
    threshold: 14, // días hasta stock bajo
    severity: 'HIGH'
  },
  deadStock: {
    enabled: true,
    daysThreshold: 180,
    severity: 'MEDIUM'
  },
  highOccupancy: {
    enabled: true,
    threshold: 95, // porcentaje
    severity: 'MEDIUM'
  },
  lowOccupancy: {
    enabled: true,
    threshold: 10, // porcentaje
    severity: 'LOW'
  }
};

/**
 * Genera todas las alertas activas
 */
export async function generateAllAlerts() {
  const alerts = [];
  
  try {
    // Alertas de stock bajo
    if (ALERT_CONFIG.stockLow.enabled) {
      const stockRisks = await analyzeStockRisk(ALERT_CONFIG.stockLow.threshold);
      stockRisks.forEach(risk => {
        if (risk.risk === 'CRITICAL' || risk.risk === 'HIGH') {
          alerts.push({
            type: 'STOCK_LOW',
            severity: risk.risk === 'CRITICAL' ? 'CRITICAL' : 'HIGH',
            title: `Stock bajo: ${risk.productCode}`,
            message: risk.recommendation,
            productCode: risk.productCode,
            daysUntilOut: risk.daysUntilOut,
            currentStock: risk.currentStock,
            timestamp: new Date().toISOString()
          });
        }
      });
    }

    // Alertas de stock muerto
    if (ALERT_CONFIG.deadStock.enabled) {
      const deadStock = await detectDeadStock(ALERT_CONFIG.deadStock.daysThreshold);
      if (deadStock.length > 0) {
        const topDeadStock = deadStock.slice(0, 10);
        const totalValue = deadStock.reduce((sum, item) => sum + item.totalValue, 0);
        
        alerts.push({
          type: 'DEAD_STOCK',
          severity: ALERT_CONFIG.deadStock.severity,
          title: `${deadStock.length} productos con stock muerto`,
          message: `Valor total en riesgo: €${totalValue.toFixed(2)}`,
          count: deadStock.length,
          totalValue,
          topProducts: topDeadStock.map(p => ({
            productCode: p.productCode,
            quantity: p.totalQuantity,
            value: p.totalValue,
            daysOld: p.maxDaysOld
          })),
          timestamp: new Date().toISOString()
        });
      }
    }

    // Alertas de ocupación
    if (ALERT_CONFIG.highOccupancy.enabled || ALERT_CONFIG.lowOccupancy.enabled) {
      const { locations } = await getWarehouseContext();
      
      const highOccupancy = locations.filter(loc => 
        (loc.occupancyPercentage || 0) >= ALERT_CONFIG.highOccupancy.threshold
      );
      
      const lowOccupancy = locations.filter(loc => 
        (loc.occupancyPercentage || 0) <= ALERT_CONFIG.lowOccupancy.threshold && 
        (loc.totalStock || 0) > 0
      );

      if (highOccupancy.length > 0 && ALERT_CONFIG.highOccupancy.enabled) {
        alerts.push({
          type: 'HIGH_OCCUPANCY',
          severity: ALERT_CONFIG.highOccupancy.severity,
          title: `${highOccupancy.length} ubicaciones con ocupación crítica`,
          message: `Algunas ubicaciones están al ${ALERT_CONFIG.highOccupancy.threshold}% o más`,
          count: highOccupancy.length,
          locations: highOccupancy.map(loc => ({
            id: loc.id,
            occupancy: loc.occupancyPercentage
          })),
          timestamp: new Date().toISOString()
        });
      }

      if (lowOccupancy.length > 50 && ALERT_CONFIG.lowOccupancy.enabled) {
        alerts.push({
          type: 'LOW_OCCUPANCY',
          severity: ALERT_CONFIG.lowOccupancy.severity,
          title: `${lowOccupancy.length} ubicaciones con ocupación baja`,
          message: 'Oportunidad de consolidación de espacio',
          count: lowOccupancy.length,
          timestamp: new Date().toISOString()
        });
      }
    }

  } catch (error) {
    logger.error('Error generando alertas', { error: error.message });
  }

  // Ordenar por severidad
  const severityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return alerts;
}

/**
 * Obtiene alertas filtradas por tipo o severidad
 */
export async function getAlerts(filters = {}) {
  const allAlerts = await generateAllAlerts();
  
  let filtered = allAlerts;
  
  if (filters.type) {
    filtered = filtered.filter(a => a.type === filters.type);
  }
  
  if (filters.severity) {
    filtered = filtered.filter(a => a.severity === filters.severity);
  }
  
  if (filters.limit) {
    filtered = filtered.slice(0, filters.limit);
  }
  
  return filtered;
}

/**
 * Actualiza configuración de alertas
 */
export function updateAlertConfig(newConfig) {
  Object.assign(ALERT_CONFIG, newConfig);
  logger.info('Configuración de alertas actualizada', { config: ALERT_CONFIG });
}

/**
 * Obtiene configuración actual de alertas
 */
export function getAlertConfig() {
  return { ...ALERT_CONFIG };
}



