/**
 * Rutas para generación de reportes
 */

import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { 
  generateInventoryCSV, 
  generateAlertsReport, 
  generateStockRiskReport, 
  generateDeadStockReport,
  generateExecutiveReport 
} from '../services/reportService.js';
import { generateExcelReport, generatePDFReport } from '../services/exportService.js';
import { generateVariantCostReport } from '../services/variantCostReportService.js';
import { getConfig } from '../config/env.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

/**
 * POST /api/reports/inventory
 * Genera reporte CSV de inventario
 */
router.post('/inventory', asyncHandler(async (req, res) => {
  const { brand, abc_class } = req.body;
  const report = await generateInventoryCSV({ brand, abc_class });
  
  const config = getConfig();
  const downloadUrl = `http://${config.server.host}:${config.server.port}/api/reports/download/${report.filename}`;
  
  res.json({
    success: true,
    filename: report.filename,
    download_url: downloadUrl,
    count: report.count,
    message: `Reporte generado con ${report.count} ubicaciones`
  });
}));

/**
 * POST /api/reports/alerts
 * Genera reporte de alertas
 */
router.post('/alerts', asyncHandler(async (req, res) => {
  const report = await generateAlertsReport();
  
  const config = getConfig();
  const downloadUrl = `http://${config.server.host}:${config.server.port}/api/reports/download/${report.filename}`;
  
  res.json({
    success: true,
    filename: report.filename,
    download_url: downloadUrl,
    count: report.count
  });
}));

/**
 * POST /api/reports/stock-risk
 * Genera reporte de stock en riesgo
 */
router.post('/stock-risk', asyncHandler(async (req, res) => {
  const { daysAhead = 30 } = req.body;
  const report = await generateStockRiskReport(daysAhead);
  
  const config = getConfig();
  const downloadUrl = `http://${config.server.host}:${config.server.port}/api/reports/download/${report.filename}`;
  
  res.json({
    success: true,
    filename: report.filename,
    download_url: downloadUrl,
    count: report.count,
    daysAhead
  });
}));

/**
 * POST /api/reports/dead-stock
 * Genera reporte de stock muerto
 */
router.post('/dead-stock', asyncHandler(async (req, res) => {
  const { daysThreshold = 180 } = req.body;
  const report = await generateDeadStockReport(daysThreshold);
  
  const config = getConfig();
  const downloadUrl = `http://${config.server.host}:${config.server.port}/api/reports/download/${report.filename}`;
  
  res.json({
    success: true,
    filename: report.filename,
    download_url: downloadUrl,
    count: report.count,
    daysThreshold
  });
}));

/**
 * POST /api/reports/executive
 * Genera reporte ejecutivo completo
 */
router.post('/executive', asyncHandler(async (req, res) => {
  const report = await generateExecutiveReport();
  
  const config = getConfig();
  const downloadUrl = `http://${config.server.host}:${config.server.port}/api/reports/download/${report.filename}`;
  
  res.json({
    success: true,
    filename: report.filename,
    download_url: downloadUrl,
    message: 'Reporte ejecutivo generado correctamente'
  });
}));

/**
 * POST /api/reports/excel
 * Genera reporte Excel
 */
router.post('/excel', asyncHandler(async (req, res) => {
  const { type = 'inventory' } = req.body;
  const report = await generateExcelReport(type);
  
  const config = getConfig();
  const downloadUrl = `http://${config.server.host}:${config.server.port}/api/reports/download/${report.filename}`;
  
  res.json({
    success: true,
    filename: report.filename,
    download_url: downloadUrl,
    format: 'CSV',
    note: 'Para Excel real con formato, instalar exceljs'
  });
}));

/**
 * POST /api/reports/pdf
 * Genera reporte PDF
 */
router.post('/pdf', asyncHandler(async (req, res) => {
  const report = await generatePDFReport();
  
  const config = getConfig();
  const downloadUrl = `http://${config.server.host}:${config.server.port}/api/reports/download/${report.filename}`;
  
  res.json({
    success: true,
    filename: report.filename,
    download_url: downloadUrl,
    format: report.format,
    note: report.note
  });
}));

/**
 * POST /api/reports/variant-costs
 * Genera reporte Excel con todas las variantes y sus costes
 */
router.post('/variant-costs', asyncHandler(async (req, res) => {
  const report = await generateVariantCostReport();
  
  const config = getConfig();
  const downloadUrl = `http://${config.server.host}:${config.server.port}/api/reports/download/${report.filename}`;
  
  res.json({
    success: true,
    filename: report.filename,
    download_url: downloadUrl,
    recordCount: report.recordCount,
    variantCount: report.variantCount,
    totalCost: report.totalCost,
    message: `Reporte generado con ${report.recordCount} registros de ${report.variantCount} variantes`
  });
}));

/**
 * GET /api/reports/download/:filename
 * Descarga un reporte (busca en exports y reports)
 */
router.get('/download/:filename', asyncHandler(async (req, res) => {
  const { filename } = req.params;
  const REPORTS_DIR = path.join(__dirname, '../../reports');
  const EXPORTS_DIR = path.join(__dirname, '../../exports');
  
  // Intentar primero en exports, luego en reports
  let filepath = path.join(EXPORTS_DIR, filename);
  let resolvedDir = path.resolve(EXPORTS_DIR);
  
  try {
    await fs.access(filepath);
  } catch {
    // Si no existe en exports, intentar en reports
    filepath = path.join(REPORTS_DIR, filename);
    resolvedDir = path.resolve(REPORTS_DIR);
  }
  
  // Validar que el archivo existe y está en el directorio correcto
  const resolvedPath = path.resolve(filepath);
  
  if (!resolvedPath.startsWith(resolvedDir)) {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  
  try {
    await fs.access(filepath);
    res.download(filepath, filename);
  } catch (error) {
    res.status(404).json({ error: 'Archivo no encontrado' });
  }
}));

export default router;

