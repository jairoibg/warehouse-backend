/**
 * Rutas para ubicaciones y movimientos
 */

import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getWarehouseContext } from '../services/warehouseService.js';
import { odooExecute, odooAuth } from '../services/odooService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Variable global para movimientos (temporal, luego se moverá a servicio)
let movements = [];

/**
 * GET /api/locations
 * Obtiene todas las ubicaciones
 */
router.get('/', asyncHandler(async (req, res) => {
  const dataPath = path.join(__dirname, '../../data', 'locations.json');
  const raw = await fs.readFile(dataPath, 'utf8');
  const locations = JSON.parse(raw);
  
  // Headers de caché para mejorar velocidad de carga (5 minutos)
  res.set('Cache-Control', 'public, max-age=300');
  res.json(locations);
}));

/**
 * GET /api/movements
 * Obtiene movimientos recientes
 */
router.get('/movements', (req, res) => {
  res.json(movements.slice(0, 50));
});

/**
 * Handler para obtener movimientos de una ubicación específica
 * Exportado para reutilización en rutas de compatibilidad
 */
export async function getLocationMovements(req, res) {
  const { locationId } = req.params;
  const { days = 90 } = req.query;
  
  console.log(`📦 [MOVEMENTS] Consultando movimientos para: ${locationId} (últimos ${days} días)`);
  
  const dateLimit = new Date();
  dateLimit.setDate(dateLimit.getDate() - parseInt(days));
  const dateLimitStr = dateLimit.toISOString().replace('T', ' ').substring(0, 19);
  
  const searchPattern = locationId.includes('CLA-') 
    ? locationId.match(/CLA-\d{3}-\d{2}-\d{2}-\d{2}/)?.[0] || locationId
    : locationId;

  const uid = await odooAuth();
  const moveLines = await odooExecute(
    'stock.move.line',
    'search_read',
    [[
      ['state', '=', 'done'],
      ['date', '>=', dateLimitStr],
      '|',
      ['location_id.complete_name', 'ilike', searchPattern],
      ['location_dest_id.complete_name', 'ilike', searchPattern]
    ]],
    { 
      fields: [
        'location_id', 
        'location_dest_id', 
        'product_id', 
        'qty_done', 
        'date', 
        'reference',
        'package_id',
        'result_package_id'
      ],
      order: 'date desc',
      limit: 500
    }
  );

  const entradas = [];
  const salidas = [];

  moveLines.forEach(m => {
    const origen = m.location_id ? m.location_id[1] : '';
    const destino = m.location_dest_id ? m.location_dest_id[1] : '';
    
    const movimiento = {
      fecha: m.date,
      producto: m.product_id ? m.product_id[1] : 'N/A',
      cantidad: m.qty_done,
      referencia: m.reference || 'N/A',
      paquete: m.package_id ? m.package_id[1] : (m.result_package_id ? m.result_package_id[1] : 'Sin paquete'),
      origen: origen,
      destino: destino
    };

    if (destino.includes(searchPattern)) {
      movimiento.ubicacionRelacionada = origen;
      entradas.push(movimiento);
    }
    
    if (origen.includes(searchPattern)) {
      movimiento.ubicacionRelacionada = destino;
      salidas.push(movimiento);
    }
  });

  const agruparPorFecha = (movimientos) => {
    const grupos = {};
    movimientos.forEach(m => {
      const fecha = m.fecha.split(' ')[0];
      if (!grupos[fecha]) grupos[fecha] = [];
      grupos[fecha].push(m);
    });
    
    return Object.entries(grupos)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([fecha, movs]) => ({
        fecha,
        movimientos: movs
      }));
  };

  res.json({
    locationId,
    periodo: `Últimos ${days} días`,
    entradas: {
      total: entradas.length,
      porFecha: agruparPorFecha(entradas)
    },
    salidas: {
      total: salidas.length,
      porFecha: agruparPorFecha(salidas)
    }
  });
}

/**
 * GET /api/movements/:locationId
 * Obtiene movimientos de una ubicación específica
 */
router.get('/movements/:locationId', asyncHandler(getLocationMovements));

export default router;

