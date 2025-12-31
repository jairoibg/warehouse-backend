/**
 * Servicio de caché para dashboard
 * Mantiene los datos en memoria para evitar recargas innecesarias
 */

import { logger } from '../middleware/logger.js';

// Caché en memoria
const dashboardCache = {
  metrics: null,
  alerts: null,
  overview: null,
  lastUpdate: null,
  ttl: 5 * 60 * 1000, // 5 minutos de TTL
};

/**
 * Verifica si el caché es válido
 */
function isCacheValid(cacheEntry) {
  if (!cacheEntry || !cacheEntry.lastUpdate) return false;
  const age = Date.now() - cacheEntry.lastUpdate;
  return age < dashboardCache.ttl;
}

/**
 * Obtiene métricas del caché o null si no es válido
 */
export function getCachedMetrics() {
  if (isCacheValid({ lastUpdate: dashboardCache.lastUpdate })) {
    logger.debug('Dashboard: usando caché de métricas');
    return dashboardCache.metrics;
  }
  return null;
}

/**
 * Guarda métricas en caché
 */
export function setCachedMetrics(metrics) {
  dashboardCache.metrics = metrics;
  dashboardCache.lastUpdate = Date.now();
  logger.debug('Dashboard: métricas guardadas en caché');
}

/**
 * Obtiene alertas del caché o null si no es válido
 */
export function getCachedAlerts() {
  if (isCacheValid({ lastUpdate: dashboardCache.lastUpdate })) {
    logger.debug('Dashboard: usando caché de alertas');
    return dashboardCache.alerts;
  }
  return null;
}

/**
 * Guarda alertas en caché
 */
export function setCachedAlerts(alerts) {
  dashboardCache.alerts = alerts;
  dashboardCache.lastUpdate = Date.now();
  logger.debug('Dashboard: alertas guardadas en caché');
}

/**
 * Obtiene overview del caché o null si no es válido
 */
export function getCachedOverview() {
  if (isCacheValid({ lastUpdate: dashboardCache.lastUpdate })) {
    logger.debug('Dashboard: usando caché de overview');
    return dashboardCache.overview;
  }
  return null;
}

/**
 * Guarda overview en caché
 */
export function setCachedOverview(overview) {
  dashboardCache.overview = overview;
  dashboardCache.lastUpdate = Date.now();
  logger.debug('Dashboard: overview guardado en caché');
}

/**
 * Limpia el caché (forzar recarga)
 */
export function clearCache() {
  dashboardCache.metrics = null;
  dashboardCache.alerts = null;
  dashboardCache.overview = null;
  dashboardCache.lastUpdate = null;
  logger.info('Dashboard: caché limpiado');
}

/**
 * Obtiene información del caché
 */
export function getCacheInfo() {
  return {
    hasData: dashboardCache.metrics !== null,
    lastUpdate: dashboardCache.lastUpdate ? new Date(dashboardCache.lastUpdate).toISOString() : null,
    age: dashboardCache.lastUpdate ? Date.now() - dashboardCache.lastUpdate : null,
    isValid: isCacheValid({ lastUpdate: dashboardCache.lastUpdate })
  };
}



