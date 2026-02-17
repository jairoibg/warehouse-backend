/**
 * Rutas para gestión de devoluciones B2B
 */

import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { asyncHandler } from '../middleware/errorHandler.js';
import { odooExecute, odooAuth } from '../services/odooService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

const DEVOLUCIONES_FILE = path.join(__dirname, '../../data', 'devoluciones.json');

// Asegurar que existe el archivo
const DATA_DIR = path.join(__dirname, '../../data');
import fsSync from 'fs';
if (!fsSync.existsSync(DATA_DIR)) {
  fsSync.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fsSync.existsSync(DEVOLUCIONES_FILE)) {
  fsSync.writeFileSync(DEVOLUCIONES_FILE, '[]', 'utf8');
}

async function getDevoluciones() {
  try {
    const data = await fs.readFile(DEVOLUCIONES_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
}

async function saveDevoluciones(devoluciones) {
  await fs.writeFile(DEVOLUCIONES_FILE, JSON.stringify(devoluciones, null, 2), 'utf8');
}

async function buscarEnOdoo(query, tipo = 'todos') {
  console.log(`🔍 [DEVOLUCIONES] Buscando "${query}" tipo: ${tipo}`);
  
  const uid = await odooAuth();

  let domain = [
    ['picking_type_id.code', '=', 'outgoing'],
    ['state', '=', 'done']
  ];

  const q = query.trim();
  
  if (tipo === 'pedido') {
    domain.push('|');
    domain.push(['origin', 'ilike', q]);
    domain.push(['sale_id.name', 'ilike', q]);
  } else if (tipo === 'albaran') {
    domain.push(['name', 'ilike', q]);
  } else if (tipo === 'cliente') {
    domain.push(['partner_id.name', 'ilike', q]);
  } else {
    domain.push('|', '|', '|');
    domain.push(['name', 'ilike', q]);
    domain.push(['origin', 'ilike', q]);
    domain.push(['partner_id.name', 'ilike', q]);
    domain.push(['sale_id.name', 'ilike', q]);
  }

  try {
    const pickings = await odooExecute(
      'stock.picking',
      'search_read',
      [domain],
      { 
        fields: ['id', 'name', 'partner_id', 'origin', 'date_done', 'carrier_id', 'company_id', 'sale_id'],
        limit: 20,
        order: 'date_done desc'
      }
    );

    const devolucionesExistentes = await getDevoluciones();

    const resultados = pickings.map(p => {
      let company = 'Black';
      if (p.company_id) {
        const companyName = p.company_id[1] || '';
        if (companyName.toLowerCase().includes('gold')) company = 'Gold';
      }
      if (p.name && p.name.includes('CLAGD')) company = 'Gold';

      return {
        picking_id: p.id,
        albaran: p.name,
        cliente: p.partner_id ? p.partner_id[1] : 'N/A',
        partner_id: p.partner_id ? p.partner_id[0] : null,
        pedido: p.sale_id ? p.sale_id[1] : (p.origin || 'N/A'),
        fecha_envio: p.date_done,
        carrier: p.carrier_id ? p.carrier_id[1] : null,
        company: company,
        devolucion_existente: devolucionesExistentes.find(d => d.picking_id === p.id) || null
      };
    });

    return { resultados };
  } catch (error) {
    console.error('❌ Error buscando en Odoo:', error);
    return { error: error.message };
  }
}

/**
 * GET /api/devoluciones/buscar
 * Buscar expediciones en Odoo
 */
router.get('/buscar', asyncHandler(async (req, res) => {
  const { q, tipo = 'todos' } = req.query;
  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'Búsqueda muy corta (mín. 2 caracteres)' });
  }
  const resultado = await buscarEnOdoo(q, tipo);
  res.json(resultado);
}));

/**
 * POST /api/devoluciones
 * Registrar nueva devolución
 */
router.post('/', asyncHandler(async (req, res) => {
  const { picking_id, picking_name, partner_name, partner_id, company, tracking_retorno, recibido_por, notas } = req.body;
  if (!picking_id || !picking_name) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }
  const devoluciones = await getDevoluciones();
  const existe = devoluciones.find(d => d.picking_id === picking_id);
  if (existe) {
    return res.status(400).json({ error: 'Esta expedición ya tiene una devolución registrada' });
  }
  const nuevaDevolucion = {
    id: Date.now(),
    picking_id,
    picking_name,
    partner_name,
    partner_id: partner_id || null,
    company: company || 'Black',
    tracking_retorno: tracking_retorno || null,
    recibido_por: recibido_por || 'Operario',
    notas: notas || null,
    fecha_recepcion: new Date().toISOString(),
    estado: 'recibido'
  };
  devoluciones.push(nuevaDevolucion);
  await saveDevoluciones(devoluciones);
  console.log(`✅ [DEVOLUCIONES] Registrada: ${picking_name} por ${recibido_por}`);
  res.json({ success: true, devolucion: nuevaDevolucion });
}));

/**
 * GET /api/devoluciones
 * Listar devoluciones
 */
router.get('/', asyncHandler(async (req, res) => {
  const { company, limit = 50, offset = 0 } = req.query;
  let devoluciones = await getDevoluciones();
  if (company) {
    devoluciones = devoluciones.filter(d => d.company && d.company.toLowerCase() === company.toLowerCase());
  }
  devoluciones.sort((a, b) => new Date(b.fecha_recepcion) - new Date(a.fecha_recepcion));
  const total = devoluciones.length;
  const paginadas = devoluciones.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
  res.json({ devoluciones: paginadas, total, limit: parseInt(limit), offset: parseInt(offset) });
}));

/**
 * GET /api/devoluciones/stats
 * Estadísticas de devoluciones
 */
router.get('/stats', asyncHandler(async (req, res) => {
  const devoluciones = await getDevoluciones();
  const now = new Date();
  const hoy = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const inicioSemana = new Date(hoy);
  inicioSemana.setDate(hoy.getDate() - hoy.getDay());
  const inicioMes = new Date(now.getFullYear(), now.getMonth(), 1);
  const hace30Dias = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const contadores = {
    hoy: devoluciones.filter(d => new Date(d.fecha_recepcion) >= hoy).length,
    semana: devoluciones.filter(d => new Date(d.fecha_recepcion) >= inicioSemana).length,
    mes: devoluciones.filter(d => new Date(d.fecha_recepcion) >= inicioMes).length,
    total: devoluciones.length
  };

  const devs30Dias = devoluciones.filter(d => new Date(d.fecha_recepcion) >= hace30Dias);
  const porCompany = {};
  devs30Dias.forEach(d => {
    const comp = d.company || 'Sin empresa';
    porCompany[comp] = (porCompany[comp] || 0) + 1;
  });

  const ultimas = devoluciones.sort((a, b) => new Date(b.fecha_recepcion) - new Date(a.fecha_recepcion)).slice(0, 5);

  res.json({
    contadores,
    por_company: Object.entries(porCompany).map(([company, count]) => ({ company, count })),
    ultimas
  });
}));

/**
 * DELETE /api/devoluciones/:id
 * Eliminar devolución
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  let devoluciones = await getDevoluciones();
  const index = devoluciones.findIndex(d => d.id === parseInt(id));
  if (index === -1) {
    return res.status(404).json({ error: 'Devolución no encontrada' });
  }
  const eliminada = devoluciones.splice(index, 1)[0];
  await saveDevoluciones(devoluciones);
  console.log(`🗑️ [DEVOLUCIONES] Eliminada: ${eliminada.picking_name}`);
  res.json({ success: true, eliminada });
}));

/**
 * POST /api/devoluciones/migrate-partner-ids
 * Migración: rellenar partner_id en devoluciones antiguas buscando en Odoo por picking_id
 */
router.post('/migrate-partner-ids', asyncHandler(async (req, res) => {
  console.log('🔄 [DEVOLUCIONES] Iniciando migración de partner_ids...');
  const devoluciones = await getDevoluciones();
  const sinPartnerId = devoluciones.filter(d => !d.partner_id && d.picking_id);

  if (sinPartnerId.length === 0) {
    return res.json({ success: true, message: 'Todas las devoluciones ya tienen partner_id', migrated: 0 });
  }

  console.log(`📋 [DEVOLUCIONES] ${sinPartnerId.length} devoluciones sin partner_id`);
  const auth = await odooAuth();
  let migrated = 0;
  const errors = [];

  for (const dev of sinPartnerId) {
    try {
      const pickings = await odooExecute(
        auth, 'stock.picking', 'search_read',
        [[['id', '=', dev.picking_id]]],
        { fields: ['partner_id'], limit: 1 }
      );
      if (pickings.length > 0 && pickings[0].partner_id) {
        dev.partner_id = pickings[0].partner_id[0];
        migrated++;
        console.log(`  ✅ ${dev.picking_name} → partner_id: ${dev.partner_id}`);
      } else {
        console.log(`  ⚠️ ${dev.picking_name} → no se encontró en Odoo`);
        errors.push(dev.picking_name);
      }
    } catch (err) {
      console.error(`  ❌ ${dev.picking_name} → error: ${err.message}`);
      errors.push(dev.picking_name);
    }
  }

  await saveDevoluciones(devoluciones);
  console.log(`🔄 [DEVOLUCIONES] Migración completada: ${migrated}/${sinPartnerId.length}`);
  res.json({ success: true, migrated, total: sinPartnerId.length, errors });
}));

export default router;



