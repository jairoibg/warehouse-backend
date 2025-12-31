/**
 * Servicio de historial y comparativas
 * Almacena y recupera datos históricos para gráficos
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getWarehouseContext } from './warehouseService.js';
import { logger } from '../middleware/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HISTORY_DIR = path.join(__dirname, '../../data/history');

// Asegurar que existe el directorio
import fsSync from 'fs';
if (!fsSync.existsSync(HISTORY_DIR)) {
  fsSync.mkdirSync(HISTORY_DIR, { recursive: true });
}

const HISTORY_FILE = path.join(HISTORY_DIR, 'metrics_history.json');

/**
 * Guarda snapshot de métricas actuales
 */
export async function saveMetricsSnapshot() {
  try {
    const { locations, totalValue } = await getWarehouseContext();
    
    const snapshot = {
      timestamp: new Date().toISOString(),
      metrics: {
        totalValue,
        totalLocations: locations.length,
        occupiedLocations: locations.filter(l => (l.totalStock || 0) > 0).length,
        totalStock: locations.reduce((sum, l) => sum + (l.totalStock || 0), 0),
        avgOccupancy: locations.reduce((sum, l) => sum + (l.occupancyPercentage || 0), 0) / locations.length,
        abcDistribution: {
          A: locations.reduce((sum, l) => sum + (l.packages?.filter(p => p.abcClass === 'A').length || 0), 0),
          B: locations.reduce((sum, l) => sum + (l.packages?.filter(p => p.abcClass === 'B').length || 0), 0),
          C: locations.reduce((sum, l) => sum + (l.packages?.filter(p => p.abcClass === 'C').length || 0), 0),
          D: locations.reduce((sum, l) => sum + (l.packages?.filter(p => p.abcClass === 'D' || !p.abcClass).length || 0), 0)
        }
      }
    };
    
    // Cargar historial existente
    let history = [];
    try {
      const data = await fs.readFile(HISTORY_FILE, 'utf8');
      history = JSON.parse(data);
    } catch (e) {
      // Archivo no existe, empezar nuevo
      history = [];
    }
    
    // Agregar nuevo snapshot
    history.push(snapshot);
    
    // Mantener solo últimos 90 días (aprox 2160 snapshots si se guarda cada hora)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90);
    
    history = history.filter(h => new Date(h.timestamp) >= cutoffDate);
    
    // Guardar
    await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
    
    logger.debug('Snapshot de métricas guardado', { timestamp: snapshot.timestamp });
    
    return snapshot;
  } catch (error) {
    logger.error('Error guardando snapshot', { error: error.message });
    throw error;
  }
}

/**
 * Obtiene historial de métricas
 * @param {number} days - Días hacia atrás
 * @returns {Array} Historial de snapshots
 */
export async function getMetricsHistory(days = 30) {
  try {
    const data = await fs.readFile(HISTORY_FILE, 'utf8');
    const history = JSON.parse(data);
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    
    return history.filter(h => new Date(h.timestamp) >= cutoffDate);
  } catch (error) {
    logger.warn('Error cargando historial', { error: error.message });
    return [];
  }
}

/**
 * Obtiene comparativa entre dos períodos
 */
export async function getPeriodComparison(period1Days = 7, period2Days = 30) {
  const history = await getMetricsHistory(Math.max(period1Days, period2Days));
  
  if (history.length === 0) {
    return null;
  }
  
  const now = new Date();
  const period1Start = new Date(now.getTime() - period1Days * 24 * 60 * 60 * 1000);
  const period2Start = new Date(now.getTime() - period2Days * 24 * 60 * 60 * 1000);
  
  const period1 = history.filter(h => new Date(h.timestamp) >= period1Start);
  const period2 = history.filter(h => {
    const date = new Date(h.timestamp);
    return date >= period2Start && date < period1Start;
  });
  
  if (period1.length === 0 || period2.length === 0) {
    return null;
  }
  
  const avg1 = {
    totalValue: period1.reduce((sum, h) => sum + h.metrics.totalValue, 0) / period1.length,
    avgOccupancy: period1.reduce((sum, h) => sum + h.metrics.avgOccupancy, 0) / period1.length,
    totalStock: period1.reduce((sum, h) => sum + h.metrics.totalStock, 0) / period1.length
  };
  
  const avg2 = {
    totalValue: period2.reduce((sum, h) => sum + h.metrics.totalValue, 0) / period2.length,
    avgOccupancy: period2.reduce((sum, h) => sum + h.metrics.avgOccupancy, 0) / period2.length,
    totalStock: period2.reduce((sum, h) => sum + h.metrics.totalStock, 0) / period2.length
  };
  
  return {
    period1: {
      days: period1Days,
      average: avg1,
      snapshots: period1.length
    },
    period2: {
      days: period2Days,
      average: avg2,
      snapshots: period2.length
    },
    changes: {
      totalValue: {
        absolute: avg1.totalValue - avg2.totalValue,
        percentage: ((avg1.totalValue - avg2.totalValue) / avg2.totalValue) * 100
      },
      avgOccupancy: {
        absolute: avg1.avgOccupancy - avg2.avgOccupancy,
        percentage: ((avg1.avgOccupancy - avg2.avgOccupancy) / avg2.avgOccupancy) * 100
      },
      totalStock: {
        absolute: avg1.totalStock - avg2.totalStock,
        percentage: ((avg1.totalStock - avg2.totalStock) / avg2.totalStock) * 100
      }
    }
  };
}

/**
 * Programa guardado automático de snapshots
 */
export function startHistoryCollection(intervalMinutes = 60) {
  const intervalMs = intervalMinutes * 60 * 1000;
  
  // Guardar inmediatamente
  saveMetricsSnapshot().catch(err => logger.error('Error en snapshot inicial', { error: err.message }));
  
  // Programar guardado periódico
  const interval = setInterval(() => {
    saveMetricsSnapshot().catch(err => logger.error('Error en snapshot programado', { error: err.message }));
  }, intervalMs);
  
  logger.info(`Recolección de historial iniciada (cada ${intervalMinutes} minutos)`);
  
  return interval;
}



