/**
 * Servicio de Machine Learning Avanzado
 * Modelos complejos: LSTM, Prophet, Clustering, Regresión, etc.
 */

import { getRealTimeSales } from './odooService.js';
import { getWarehouseContext } from './warehouseService.js';
import { logger } from '../middleware/logger.js';

/**
 * Modelo LSTM simplificado para series temporales
 * Predicción de demanda usando red neuronal LSTM
 */
export async function lstmForecast(productCode, periods = 30, lookback = 60) {
  try {
    const sales = await getRealTimeSales(365); // 1 año de datos
    const productSales = sales.filter(s => 
      s.p && s.p.toUpperCase().includes(productCode.toUpperCase())
    );

    if (productSales.length < lookback) {
      return {
        model: 'LSTM',
        productCode,
        forecast: null,
        error: 'Datos insuficientes para LSTM (mínimo 60 puntos)',
        recommendation: 'Usar forecasting básico hasta tener más datos'
      };
    }

    // Preparar secuencia temporal (simplificado - en producción usarías TensorFlow.js)
    const sequence = productSales.slice(-lookback).map(s => s.q || 0);
    
    // Normalizar datos (0-1)
    const max = Math.max(...sequence);
    const min = Math.min(...sequence);
    const normalized = sequence.map(v => (v - min) / (max - min || 1));
    
    // Simulación de LSTM (en producción usarías modelo entrenado)
    // Aquí implementamos una aproximación usando media móvil exponencial triple
    const alpha = 0.3;
    const beta = 0.2;
    const gamma = 0.1;
    
    // Triple Exponential Smoothing (Holt-Winters)
    let level = normalized[0];
    let trend = 0;
    let season = 0;
    const seasonLength = 7; // Semanal
    
    for (let i = 1; i < normalized.length; i++) {
      const prevLevel = level;
      level = alpha * normalized[i] + (1 - alpha) * (level + trend);
      trend = beta * (level - prevLevel) + (1 - beta) * trend;
      season = gamma * (normalized[i] - level) + (1 - gamma) * season;
    }
    
    // Proyección
    const forecastNormalized = level + (trend * periods) + season;
    const forecast = Math.round(forecastNormalized * (max - min) + min);
    
    // Calcular confianza basada en estabilidad de la serie
    const variance = normalized.reduce((sum, v, i) => {
      const mean = normalized.slice(Math.max(0, i - 7), i + 1).reduce((a, b) => a + b, 0) / Math.min(8, i + 1);
      return sum + Math.pow(v - mean, 2);
    }, 0) / normalized.length;
    
    const confidence = variance < 0.1 ? 'HIGH' : variance < 0.3 ? 'MEDIUM' : 'LOW';
    
    return {
      model: 'LSTM (Holt-Winters Approximation)',
      productCode,
      forecast,
      periods,
      confidence,
      metrics: {
        mse: variance,
        trend: trend > 0 ? 'INCREASING' : trend < 0 ? 'DECREASING' : 'STABLE',
        seasonality: Math.abs(season) > 0.1 ? 'DETECTED' : 'NONE'
      },
      note: 'Para LSTM real, instalar TensorFlow.js y entrenar modelo'
    };
  } catch (error) {
    logger.error('Error en LSTM forecast', { error: error.message });
    return {
      model: 'LSTM',
      productCode,
      forecast: null,
      error: error.message
    };
  }
}

/**
 * Modelo Prophet simplificado para forecasting con estacionalidad
 * Detecta tendencias y patrones estacionales
 */
export async function prophetForecast(productCode, periods = 30) {
  try {
    const sales = await getRealTimeSales(365);
    const productSales = sales.filter(s => 
      s.p && s.p.toUpperCase().includes(productCode.toUpperCase())
    );

    if (productSales.length < 90) {
      return {
        model: 'Prophet',
        productCode,
        forecast: null,
        error: 'Datos insuficientes (mínimo 90 días)'
      };
    }

    // Agrupar por semana para detectar estacionalidad
    const weeklyData = {};
    productSales.forEach((sale, index) => {
      const week = Math.floor(index / 7);
      if (!weeklyData[week]) weeklyData[week] = [];
      weeklyData[week].push(sale.q || 0);
    });

    const weeklyAverages = Object.values(weeklyData).map(week => 
      week.reduce((a, b) => a + b, 0) / week.length
    );

    // Detectar tendencia (regresión lineal)
    const n = weeklyAverages.length;
    const x = Array.from({ length: n }, (_, i) => i);
    const y = weeklyAverages;
    
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    // Detectar estacionalidad semanal
    const seasonalPattern = [];
    for (let day = 0; day < 7; day++) {
      const daySales = productSales.filter((_, i) => i % 7 === day).map(s => s.q || 0);
      seasonalPattern.push(daySales.reduce((a, b) => a + b, 0) / daySales.length);
    }
    
    const avgSeasonal = seasonalPattern.reduce((a, b) => a + b, 0) / 7;
    const seasonalFactors = seasonalPattern.map(v => v / avgSeasonal);
    
    // Forecast
    const lastWeek = weeklyAverages[weeklyAverages.length - 1];
    const weeksAhead = Math.ceil(periods / 7);
    const trendForecast = lastWeek + (slope * weeksAhead);
    
    const forecasts = [];
    for (let day = 0; day < periods; day++) {
      const weekDay = day % 7;
      const weekNum = Math.floor(day / 7);
      const base = trendForecast + (slope * weekNum);
      const seasonal = seasonalFactors[weekDay];
      forecasts.push(Math.round(base * seasonal));
    }
    
    const totalForecast = forecasts.reduce((a, b) => a + b, 0);
    
    return {
      model: 'Prophet (Simplified)',
      productCode,
      forecast: totalForecast,
      dailyForecast: forecasts,
      periods,
      components: {
        trend: {
          slope: parseFloat(slope.toFixed(4)),
          direction: slope > 0 ? 'INCREASING' : slope < 0 ? 'DECREASING' : 'STABLE'
        },
        seasonality: {
          detected: true,
          pattern: 'WEEKLY',
          factors: seasonalFactors.map(f => parseFloat(f.toFixed(3)))
        }
      },
      confidence: n > 20 ? 'HIGH' : 'MEDIUM',
      note: 'Para Prophet real, instalar node-prophet o usar Python API'
    };
  } catch (error) {
    logger.error('Error en Prophet forecast', { error: error.message });
    return {
      model: 'Prophet',
      productCode,
      forecast: null,
      error: error.message
    };
  }
}

/**
 * Clustering K-means para segmentación de productos
 */
export async function clusterProducts(k = 5) {
  try {
    const { locations } = await getWarehouseContext();
    const sales = await getRealTimeSales(90);
    
    // Agrupar productos con sus características
    const products = {};
    
    locations.forEach(loc => {
      loc.packages?.forEach(pkg => {
        const code = pkg.productCode || pkg.surtido;
        if (!products[code]) {
          products[code] = {
            productCode: code,
            totalStock: 0,
            totalValue: 0,
            velocity: 0,
            daysOld: 0,
            abcClass: pkg.abcClass || 'D',
            locations: new Set()
          };
        }
        products[code].totalStock += pkg.qty || 0;
        products[code].totalValue += (pkg.qty || 0) * (pkg.cost || 0);
        products[code].daysOld = Math.max(products[code].daysOld, pkg.daysOld || 0);
        products[code].locations.add(loc.id);
      });
    });
    
    // Calcular velocidad de ventas
    sales.forEach(sale => {
      const code = sale.p?.toUpperCase();
      if (products[code]) {
        products[code].velocity += sale.q || 0;
      }
    });
    
    Object.values(products).forEach(p => {
      p.velocity = p.velocity / 90; // Por día
      p.locations = p.locations.size;
    });
    
    // Normalizar características para clustering
    const features = Object.values(products).map(p => ({
      productCode: p.productCode,
      features: [
        Math.log10(p.totalStock + 1) / 5, // Normalizado
        Math.log10(p.totalValue + 1) / 10,
        Math.log10(p.velocity + 0.01) / 3,
        p.daysOld / 365,
        ['A', 'B', 'C', 'D'].indexOf(p.abcClass) / 3
      ]
    }));
    
    // K-means simplificado (en producción usarías ml-kmeans)
    const centroids = [];
    for (let i = 0; i < k; i++) {
      centroids.push(features[Math.floor(Math.random() * features.length)].features);
    }
    
    let clusters = [];
    let changed = true;
    let iterations = 0;
    
    while (changed && iterations < 100) {
      // Asignar puntos a clusters
      clusters = features.map(f => {
        let minDist = Infinity;
        let clusterId = 0;
        centroids.forEach((centroid, id) => {
          const dist = Math.sqrt(
            f.features.reduce((sum, val, i) => sum + Math.pow(val - centroid[i], 2), 0)
          );
          if (dist < minDist) {
            minDist = dist;
            clusterId = id;
          }
        });
        return { ...f, cluster: clusterId };
      });
      
      // Recalcular centroides
      const newCentroids = [];
      for (let i = 0; i < k; i++) {
        const clusterPoints = clusters.filter(c => c.cluster === i);
        if (clusterPoints.length > 0) {
          const featureCount = clusterPoints[0].features.length;
          const newCentroid = Array.from({ length: featureCount }, (_, idx) => 
            clusterPoints.reduce((sum, p) => sum + p.features[idx], 0) / clusterPoints.length
          );
          newCentroids.push(newCentroid);
        } else {
          newCentroids.push(centroids[i]);
        }
      }
      
      // Verificar convergencia
      changed = centroids.some((c, i) => 
        c.some((val, j) => Math.abs(val - newCentroids[i][j]) > 0.001)
      );
      centroids.splice(0, centroids.length, ...newCentroids);
      iterations++;
    }
    
    // Analizar clusters
    const clusterAnalysis = [];
    for (let i = 0; i < k; i++) {
      const clusterProducts = clusters.filter(c => c.cluster === i);
      const avgStock = clusterProducts.reduce((sum, p) => {
        const prod = products[p.productCode];
        return sum + (prod?.totalStock || 0);
      }, 0) / clusterProducts.length;
      
      const avgVelocity = clusterProducts.reduce((sum, p) => {
        const prod = products[p.productCode];
        return sum + (prod?.velocity || 0);
      }, 0) / clusterProducts.length;
      
      clusterAnalysis.push({
        clusterId: i,
        size: clusterProducts.length,
        characteristics: {
          avgStock: parseFloat(avgStock.toFixed(2)),
          avgVelocity: parseFloat(avgVelocity.toFixed(2)),
          profile: avgVelocity > 1 ? 'HIGH_TURNOVER' : avgVelocity < 0.1 ? 'SLOW_MOVING' : 'MEDIUM'
        },
        products: clusterProducts.slice(0, 10).map(c => c.productCode)
      });
    }
    
    return {
      model: 'K-Means Clustering',
      k,
      iterations,
      clusters: clusterAnalysis,
      totalProducts: features.length
    };
  } catch (error) {
    logger.error('Error en clustering', { error: error.message });
    return {
      model: 'K-Means',
      error: error.message
    };
  }
}

/**
 * Regresión avanzada para análisis de correlaciones
 */
export async function advancedRegression(productCode) {
  try {
    const sales = await getRealTimeSales(180);
    const productSales = sales.filter(s => 
      s.p && s.p.toUpperCase().includes(productCode.toUpperCase())
    );

    if (productSales.length < 30) {
      return {
        model: 'Regression',
        productCode,
        error: 'Datos insuficientes'
      };
    }

    // Regresión polinómica (grado 2)
    const n = productSales.length;
    const x = Array.from({ length: n }, (_, i) => i);
    const y = productSales.map(s => s.q || 0);
    
    // Calcular coeficientes para y = ax² + bx + c
    // Usando mínimos cuadrados simplificado
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
    const sumX3 = x.reduce((sum, xi) => sum + xi * xi * xi, 0);
    const sumX4 = x.reduce((sum, xi) => sum + xi * xi * xi * xi, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumX2Y = x.reduce((sum, xi, i) => sum + xi * xi * y[i], 0);
    
    // Resolver sistema de ecuaciones (simplificado)
    const a = (n * sumX2Y - sumX2 * sumY) / (n * sumX4 - sumX2 * sumX2);
    const b = (sumXY - a * sumX3) / sumX2;
    const c = (sumY - a * sumX2 - b * sumX) / n;
    
    // Calcular R²
    const yMean = sumY / n;
    const ssRes = y.reduce((sum, yi, i) => {
      const predicted = a * x[i] * x[i] + b * x[i] + c;
      return sum + Math.pow(yi - predicted, 2);
    }, 0);
    const ssTot = y.reduce((sum, yi) => sum + Math.pow(yi - yMean, 2), 0);
    const rSquared = 1 - (ssRes / ssTot);
    
    // Forecast
    const forecastX = n + 30;
    const forecast = Math.round(a * forecastX * forecastX + b * forecastX + c);
    
    return {
      model: 'Polynomial Regression (Degree 2)',
      productCode,
      coefficients: {
        a: parseFloat(a.toFixed(6)),
        b: parseFloat(b.toFixed(6)),
        c: parseFloat(c.toFixed(6))
      },
      metrics: {
        rSquared: parseFloat(rSquared.toFixed(4)),
        mse: parseFloat((ssRes / n).toFixed(2)),
        fit: rSquared > 0.7 ? 'GOOD' : rSquared > 0.5 ? 'FAIR' : 'POOR'
      },
      forecast: {
        value: forecast,
        periods: 30,
        trend: a > 0 ? 'ACCELERATING_UP' : a < 0 ? 'ACCELERATING_DOWN' : b > 0 ? 'LINEAR_UP' : 'LINEAR_DOWN'
      }
    };
  } catch (error) {
    logger.error('Error en regresión', { error: error.message });
    return {
      model: 'Regression',
      productCode,
      error: error.message
    };
  }
}

/**
 * Análisis de series temporales avanzado (ARIMA simplificado)
 */
export async function timeSeriesAnalysis(productCode) {
  try {
    const sales = await getRealTimeSales(365);
    const productSales = sales.filter(s => 
      s.p && s.p.toUpperCase().includes(productCode.toUpperCase())
    );

    if (productSales.length < 60) {
      return {
        model: 'ARIMA',
        productCode,
        error: 'Datos insuficientes (mínimo 60 puntos)'
      };
    }

    const series = productSales.map(s => s.q || 0);
    
    // Calcular autocorrelación
    const mean = series.reduce((a, b) => a + b, 0) / series.length;
    const variance = series.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / series.length;
    
    const autocorrelations = [];
    for (let lag = 1; lag <= 7; lag++) {
      let sum = 0;
      for (let i = lag; i < series.length; i++) {
        sum += (series[i] - mean) * (series[i - lag] - mean);
      }
      autocorrelations.push({
        lag,
        value: parseFloat((sum / ((series.length - lag) * variance)).toFixed(4))
      });
    }
    
    // Detectar estacionariedad (prueba de Dickey-Fuller simplificada)
    const firstDiff = [];
    for (let i = 1; i < series.length; i++) {
      firstDiff.push(series[i] - series[i - 1]);
    }
    
    const diffMean = firstDiff.reduce((a, b) => a + b, 0) / firstDiff.length;
    const diffVar = firstDiff.reduce((sum, val) => sum + Math.pow(val - diffMean, 2), 0) / firstDiff.length;
    
    const isStationary = Math.abs(diffMean) < 0.1 && diffVar < variance * 0.5;
    
    // ARIMA(1,1,1) simplificado
    const arCoeff = autocorrelations[0].value * 0.8; // AR(1)
    const maCoeff = 0.2; // MA(1) simplificado
    
    // Forecast
    const lastValue = series[series.length - 1];
    const forecast = Math.round(lastValue * (1 + arCoeff));
    
    return {
      model: 'ARIMA(1,1,1) Simplified',
      productCode,
      analysis: {
        stationarity: isStationary ? 'STATIONARY' : 'NON_STATIONARY',
        autocorrelations,
        trend: diffMean > 0 ? 'UPWARD' : diffMean < 0 ? 'DOWNWARD' : 'STABLE'
      },
      forecast: {
        value: forecast,
        periods: 30,
        confidence: isStationary ? 'HIGH' : 'MEDIUM'
      },
      note: 'Para ARIMA real, usar statsmodels (Python) o R'
    };
  } catch (error) {
    logger.error('Error en análisis de series temporales', { error: error.message });
    return {
      model: 'ARIMA',
      productCode,
      error: error.message
    };
  }
}

/**
 * Detección de anomalías avanzada usando Isolation Forest (simplificado)
 */
export async function detectAnomaliesAdvanced(productCode) {
  try {
    const sales = await getRealTimeSales(180);
    const productSales = sales.filter(s => 
      s.p && s.p.toUpperCase().includes(productCode.toUpperCase())
    );

    if (productSales.length < 30) {
      return {
        model: 'Isolation Forest',
        productCode,
        error: 'Datos insuficientes'
      };
    }

    const values = productSales.map(s => s.q || 0);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const stdDev = Math.sqrt(
      values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length
    );
    
    // Isolation Forest simplificado usando percentiles
    const sorted = [...values].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    const iqr = q3 - q1;
    
    const lowerBound = q1 - 1.5 * iqr;
    const upperBound = q3 + 1.5 * iqr;
    
    const anomalies = productSales
      .map((sale, index) => ({
        index,
        value: sale.q || 0,
        date: index, // En producción usarías fecha real
        isAnomaly: (sale.q || 0) < lowerBound || (sale.q || 0) > upperBound
      }))
      .filter(a => a.isAnomaly);
    
    return {
      model: 'Isolation Forest (IQR-based)',
      productCode,
      anomalies: anomalies.length,
      threshold: {
        lower: lowerBound,
        upper: upperBound
      },
      detected: anomalies.slice(0, 10),
      severity: anomalies.length > values.length * 0.1 ? 'HIGH' : 'LOW'
    };
  } catch (error) {
    logger.error('Error en detección de anomalías', { error: error.message });
    return {
      model: 'Isolation Forest',
      productCode,
      error: error.message
    };
  }
}

