/**
 * Servicio para generar reporte de costes por variante
 */

import ExcelJS from 'exceljs';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getWarehouseContext } from './warehouseService.js';
import { logger } from '../middleware/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXPORTS_DIR = path.join(__dirname, '../../exports');

// Asegurar directorio
import fsSync from 'fs';
if (!fsSync.existsSync(EXPORTS_DIR)) {
  fsSync.mkdirSync(EXPORTS_DIR, { recursive: true });
}

/**
 * Genera reporte Excel con todas las variantes y sus costes
 */
export async function generateVariantCostReport() {
  const workbook = new ExcelJS.Workbook();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `reporte_costes_variantes_${timestamp}.xlsx`;
  const filepath = path.join(EXPORTS_DIR, filename);
  
  const { locations } = await getWarehouseContext();
  
  // Agregar todas las líneas por paquete y variante
  const variantData = [];
  const packageMap = new Map(); // Para agrupar por paquete
  
  locations.forEach(loc => {
    if (!loc.packages || loc.packages.length === 0) return;
    
    loc.packages.forEach(pkg => {
      const packageId = pkg.packageId || 'SIN_PAQUETE';
      const productCode = pkg.productCode || pkg.surtido || 'SIN_REF';
      const qty = pkg.qty || 0;
      const cost = pkg.cost || 0;
      const totalCost = qty * cost;
      
      // Clave única: paquete + variante
      const key = `${packageId}|${productCode}`;
      
      if (!packageMap.has(key)) {
        packageMap.set(key, {
          packageId,
          productCode,
          variant: productCode, // La variante es el productCode
          locationId: loc.id,
          brand: loc.brand || 'N/A',
          warehouseType: loc.id.includes('Storage') ? 'B2C' : (loc.id.includes('EXTB2B') ? 'B2B' : 'OTRO'),
          qty: 0,
          cost: cost,
          totalCost: 0
        });
      }
      
      const entry = packageMap.get(key);
      entry.qty += qty;
      entry.totalCost += totalCost;
    });
  });
  
  // Convertir mapa a array y ordenar
  const reportData = Array.from(packageMap.values())
    .sort((a, b) => {
      // Ordenar por tipo de almacén (B2C primero), luego por paquete
      if (a.warehouseType !== b.warehouseType) {
        return a.warehouseType === 'B2C' ? -1 : 1;
      }
      return a.packageId.localeCompare(b.packageId);
    });
  
  // Hoja 1: Detalle por paquete y variante
  const detailSheet = workbook.addWorksheet('Detalle Paquetes-Variantes');
  detailSheet.columns = [
    { header: 'Paquete ID', key: 'packageId', width: 25 },
    { header: 'Variante (ProductCode)', key: 'variant', width: 30 },
    { header: 'Ubicación', key: 'locationId', width: 30 },
    { header: 'Tipo Almacén', key: 'warehouseType', width: 12 },
    { header: 'Marca', key: 'brand', width: 12 },
    { header: 'Cantidad', key: 'qty', width: 12 },
    { header: 'Coste Unitario (€)', key: 'cost', width: 18 },
    { header: 'Coste Total (€)', key: 'totalCost', width: 18 }
  ];
  
  // Estilo de encabezado
  detailSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  detailSheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF4472C4' }
  };
  
  // Añadir datos
  reportData.forEach(row => {
    detailSheet.addRow({
      packageId: row.packageId,
      variant: row.variant,
      locationId: row.locationId,
      warehouseType: row.warehouseType,
      brand: row.brand,
      qty: row.qty,
      cost: parseFloat(row.cost.toFixed(4)),
      totalCost: parseFloat(row.totalCost.toFixed(2))
    });
  });
  
  // Formato de números
  detailSheet.getColumn('qty').numFmt = '#,##0';
  detailSheet.getColumn('cost').numFmt = '#,##0.0000';
  detailSheet.getColumn('totalCost').numFmt = '#,##0.00';
  
  // Hoja 2: Resumen por variante
  const variantSummary = new Map();
  reportData.forEach(row => {
    if (!variantSummary.has(row.variant)) {
      variantSummary.set(row.variant, {
        variant: row.variant,
        totalQty: 0,
        avgCost: 0,
        totalCost: 0,
        packageCount: 0,
        locations: new Set()
      });
    }
    
    const summary = variantSummary.get(row.variant);
    summary.totalQty += row.qty;
    summary.totalCost += row.totalCost;
    summary.packageCount += 1;
    summary.locations.add(row.locationId);
  });
  
  // Calcular coste promedio
  variantSummary.forEach((summary, variant) => {
    summary.avgCost = summary.totalQty > 0 ? summary.totalCost / summary.totalQty : 0;
    summary.locationCount = summary.locations.size;
  });
  
  const summarySheet = workbook.addWorksheet('Resumen por Variante');
  summarySheet.columns = [
    { header: 'Variante (ProductCode)', key: 'variant', width: 30 },
    { header: 'Total Cantidad', key: 'totalQty', width: 15 },
    { header: 'Coste Promedio (€)', key: 'avgCost', width: 20 },
    { header: 'Coste Total (€)', key: 'totalCost', width: 18 },
    { header: 'Nº Paquetes', key: 'packageCount', width: 15 },
    { header: 'Nº Ubicaciones', key: 'locationCount', width: 15 }
  ];
  
  summarySheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  summarySheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF4472C4' }
  };
  
  const summaryArray = Array.from(variantSummary.values())
    .sort((a, b) => b.totalCost - a.totalCost); // Ordenar por coste total descendente
  
  summaryArray.forEach(row => {
    summarySheet.addRow({
      variant: row.variant,
      totalQty: row.totalQty,
      avgCost: parseFloat(row.avgCost.toFixed(4)),
      totalCost: parseFloat(row.totalCost.toFixed(2)),
      packageCount: row.packageCount,
      locationCount: row.locationCount
    });
  });
  
  summarySheet.getColumn('totalQty').numFmt = '#,##0';
  summarySheet.getColumn('avgCost').numFmt = '#,##0.0000';
  summarySheet.getColumn('totalCost').numFmt = '#,##0.00';
  summarySheet.getColumn('packageCount').numFmt = '#,##0';
  summarySheet.getColumn('locationCount').numFmt = '#,##0';
  
  // Hoja 3: Resumen por tipo de almacén
  const warehouseSummary = {
    B2C: { totalQty: 0, totalCost: 0, packageCount: 0, variantCount: 0 },
    B2B: { totalQty: 0, totalCost: 0, packageCount: 0, variantCount: 0 },
    OTRO: { totalQty: 0, totalCost: 0, packageCount: 0, variantCount: 0 }
  };
  
  const variantsByWarehouse = {
    B2C: new Set(),
    B2B: new Set(),
    OTRO: new Set()
  };
  
  reportData.forEach(row => {
    const summary = warehouseSummary[row.warehouseType];
    summary.totalQty += row.qty;
    summary.totalCost += row.totalCost;
    summary.packageCount += 1;
    variantsByWarehouse[row.warehouseType].add(row.variant);
  });
  
  Object.keys(warehouseSummary).forEach(key => {
    warehouseSummary[key].variantCount = variantsByWarehouse[key].size;
  });
  
  const warehouseSheet = workbook.addWorksheet('Resumen por Almacén');
  warehouseSheet.columns = [
    { header: 'Tipo Almacén', key: 'warehouseType', width: 15 },
    { header: 'Total Cantidad', key: 'totalQty', width: 15 },
    { header: 'Coste Total (€)', key: 'totalCost', width: 18 },
    { header: 'Nº Paquetes', key: 'packageCount', width: 15 },
    { header: 'Nº Variantes', key: 'variantCount', width: 15 }
  ];
  
  warehouseSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  warehouseSheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF4472C4' }
  };
  
  Object.entries(warehouseSummary).forEach(([type, data]) => {
    warehouseSheet.addRow({
      warehouseType: type,
      totalQty: data.totalQty,
      totalCost: parseFloat(data.totalCost.toFixed(2)),
      packageCount: data.packageCount,
      variantCount: data.variantCount
    });
  });
  
  warehouseSheet.getColumn('totalQty').numFmt = '#,##0';
  warehouseSheet.getColumn('totalCost').numFmt = '#,##0.00';
  warehouseSheet.getColumn('packageCount').numFmt = '#,##0';
  warehouseSheet.getColumn('variantCount').numFmt = '#,##0';
  
  await workbook.xlsx.writeFile(filepath);
  
  logger.info(`Reporte de costes por variante generado: ${filename}`);
  
  return { 
    filename, 
    filepath, 
    format: 'xlsx',
    recordCount: reportData.length,
    variantCount: variantSummary.size,
    totalCost: reportData.reduce((sum, r) => sum + r.totalCost, 0)
  };
}

