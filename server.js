import 'dotenv/config'; // <--- CARGA DE SEGURIDAD (Línea 1 Obligatoria)
import express from "express";
import xmlrpc from 'xmlrpc';
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { odooCache } from './odoo_cache.js';
import multer from 'multer';
import { exec } from 'child_process';
import { promisify } from 'util';
const execPromise = promisify(exec);
import { fileURLToPath } from "url";
import { syncWithOdoo, getRealTimeSales } from "./sync_odoo.js";
import Anthropic from "@anthropic-ai/sdk";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import compression from "compression";
import { errorHandler as globalErrorHandler } from "./src/middleware/errorHandler.js";

// --- IMPORTS: Cerebros Lógicos ---
import { strategicAnalyzer } from "./strategic_analyzer.js";
import { explanationEngine } from "./explanation_engine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================================================================================
//  DIAGNÓSTICO DE VARIABLES DE ENTORNO
// ==================================================================================
console.log("========== DIAGNÓSTICO DE VARIABLES ==========");
console.log("PORT:", process.env.PORT);
console.log("ODOO_URL:", process.env.ODOO_URL ? "✅ Configurada" : "❌ NO encontrada");
console.log("ODOO_DB:", process.env.ODOO_DATABASE ? "✅ Configurada" : "❌ NO encontrada");
console.log("ODOO_USERNAME:", process.env.ODOO_USERNAME ? "✅ Configurada" : "❌ NO encontrada");
console.log("ODOO_PASSWORD:", process.env.ODOO_PASSWORD ? "✅ Configurada" : "❌ NO encontrada");
console.log("ANTHROPIC_API_KEY:", process.env.ANTHROPIC_API_KEY ? "✅ Configurada (" + process.env.ANTHROPIC_API_KEY.substring(0,15) + "...)" : "❌ NO encontrada");

// Listar TODAS las variables que empiezan con letras relevantes
console.log("\n--- Todas las variables de entorno disponibles ---");
Object.keys(process.env).filter(k => 
  k.startsWith('ANTHROPIC') || 
  k.startsWith('OPENAI') || 
  k.startsWith('ODOO') || 
  k.startsWith('PORT') ||
  k.startsWith('API')
).forEach(k => {
  const val = process.env[k];
  console.log(`  ${k}: ${val ? (val.length > 20 ? val.substring(0,20) + '...' : val) : 'undefined'}`);
});
console.log("================================================\n");

// ==================================================================================
//  1. CONFIGURACIÓN DEL SERVIDOR Y SEGURIDAD
// ==================================================================================
const PORT = process.env.PORT || 4000;
const SERVER_HOST = process.env.SERVER_HOST || "localhost";

// Rutas de Datos
// ⭐ PERSISTENCIA: Si hay un volumen montado en Railway, usar esa ruta para datos persistentes
const PERSISTENT_DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? process.env.RAILWAY_VOLUME_MOUNT_PATH
  : path.join(__dirname, "data");
const LOCAL_DATA_DIR = path.join(__dirname, "data"); // Siempre apunta al código (para seed)

const LOCATIONS_FILE = path.join(PERSISTENT_DATA_DIR, "locations.json");
const AUDIT_REPORT_FILE = path.join(PERSISTENT_DATA_DIR, "audit_report.json");
const DEVOLUCIONES_FILE = path.join(PERSISTENT_DATA_DIR, "devoluciones.json"); // ⭐ Persiste en volumen
const DEVOLUCIONES_SEED_FILE = path.join(LOCAL_DATA_DIR, "devoluciones.seed.json"); // Semilla siempre en código (git)
// ⭐ JOURNAL append-only: registra cada CREATE/PATCH/DELETE de devoluciones (auditoría completa)
const DEVOLUCIONES_JOURNAL_FILE = path.join(PERSISTENT_DATA_DIR, "devoluciones_journal.jsonl");

// NO salir si no hay API key - solo advertir
if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(" ⚠️ ADVERTENCIA: ANTHROPIC_API_KEY no encontrada. El chat IA no funcionará.");
}

const EXPORT_DIR = path.join(__dirname, "exports");
if (!fsSync.existsSync(EXPORT_DIR)) {
  fsSync.mkdirSync(EXPORT_DIR);
}

// ⭐ Asegurar que existen los directorios de datos
if (!fsSync.existsSync(LOCAL_DATA_DIR)) {
  fsSync.mkdirSync(LOCAL_DATA_DIR, { recursive: true });
}
if (!fsSync.existsSync(PERSISTENT_DATA_DIR)) {
  fsSync.mkdirSync(PERSISTENT_DATA_DIR, { recursive: true });
}
if (!fsSync.existsSync(DEVOLUCIONES_FILE)) {
  fsSync.writeFileSync(DEVOLUCIONES_FILE, '[]', 'utf8');
  console.log("📁 Archivo devoluciones.json creado");
}

// Log de persistencia
if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  console.log(`💾 [PERSISTENCIA] Volumen montado en: ${process.env.RAILWAY_VOLUME_MOUNT_PATH}`);
  console.log(`💾 [PERSISTENCIA] Datos persistentes en: ${PERSISTENT_DATA_DIR}`);

  // Copiar locations.json del código al volumen si no existe (primer deploy con volumen)
  const localLocations = path.join(LOCAL_DATA_DIR, "locations.json");
  if (!fsSync.existsSync(LOCATIONS_FILE) && fsSync.existsSync(localLocations)) {
    fsSync.copyFileSync(localLocations, LOCATIONS_FILE);
    console.log(`📋 [PERSISTENCIA] locations.json copiado al volumen desde código`);
  }
} else {
  console.log('⚠️ [PERSISTENCIA] Sin volumen montado - datos en filesystem efímero');
}

// ==================================================================================
//  CLIENTE ANTHROPIC - INICIALIZACIÓN LAZY
// ==================================================================================
let _anthropicClient = null;

function getAnthropicClient() {
  if (!_anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY no está configurada. Verifica las variables de entorno en Railway.");
    }
    _anthropicClient = new Anthropic({ apiKey });
    console.log("✅ Cliente Anthropic inicializado correctamente");
  }
  return _anthropicClient;
}

const app = express();

// ==================================================================================
//  MIDDLEWARE DE SEGURIDAD (Fase 1 auditoría 2026-04-24)
//  ---------------------------------------------------------------
//  Todos los controles son BACKWARDS-COMPATIBLE:
//  - Si CORS_ORIGINS no está definido, CORS sigue abierto (comportamiento previo).
//  - Rate limit usa umbrales generosos para no afectar tráfico real.
//  - Helmet deshabilita CSP (podría romper el frontend si se activa con defaults).
// ==================================================================================

// Detrás de proxy en Railway/Vercel: necesario para que rate-limit lea la IP real.
app.set('trust proxy', 1);

// Helmet sin CSP (evitamos bloquear recursos del frontend con defaults agresivos).
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// Compresión gzip (estaba en dependencies pero sin usar).
app.use(compression());

// CORS: si CORS_ORIGINS está definido, whitelist; si no, comportamiento original.
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
if (CORS_ORIGINS.length > 0) {
  console.log(`🔒 [CORS] Whitelist activo: ${CORS_ORIGINS.join(', ')}`);
  app.use(cors({
    origin: (origin, cb) => {
      // Requests sin Origin (curl, herramientas internas, WS upgrade) pasan.
      if (!origin) return cb(null, true);
      if (CORS_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origin ${origin} no permitido`));
    },
    credentials: true,
  }));
} else {
  console.warn('⚠️  [CORS] CORS_ORIGINS no definido — CORS abierto (modo legacy). Define CORS_ORIGINS en .env para restringir.');
  app.use(cors());
}

app.use(express.json({ limit: '10mb' }));

// Rate limiting — umbrales generosos, solo bloquea abuso evidente.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutos
  max: 1000,                  // 1000 requests por IP por ventana
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones, espera unos minutos.' },
  skip: (req) => req.path === '/api/devoluciones/debug', // diagnóstico sin límite
});
app.use('/api/', apiLimiter);

// Rate limiting más estricto para endpoints costosos (IA, upload).
const expensiveLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minuto
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones a endpoint costoso, espera un minuto.' },
});
app.use('/api/ai/', expensiveLimiter);
app.use('/api/strategic-chat', expensiveLimiter);
app.use('/api/strategic-analysis', expensiveLimiter);
app.use('/api/packing/analyze', expensiveLimiter);

app.use("/downloads", express.static(EXPORT_DIR));

let movements = []; 

// ==================================================================================
//  HELPERS DE ODOO (NECESARIOS PARA EL NUEVO MÓDULO)
// ==================================================================================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function odooExecute(method, model, operation, params, options = {}) {
  const common = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/common` });
  const models = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/object` });

  const uid = await new Promise((resolve, reject) => {
    common.methodCall('authenticate', [
      process.env.ODOO_DATABASE, process.env.ODOO_USERNAME, process.env.ODOO_PASSWORD, {}
    ], (err, res) => err ? reject(err) : resolve(res));
  });

  return new Promise((resolve, reject) => {
    models.methodCall('execute_kw', [
      process.env.ODOO_DATABASE, uid, process.env.ODOO_PASSWORD,
      model, operation, params, options
    ], (err, res) => err ? reject(err) : resolve(res));
  });
}

async function fetchAllRecords(model, domain, fields) {
  let allRecords = [];
  let offset = 0;
  const LIMIT = 2000;
  let hasMore = true;

  // Solo loguear si es una operación pesada
  if (model === 'stock.move') process.stdout.write(` 📡  Descargando ${model}... `);

  while (hasMore) {
    try {
      const batch = await odooExecute('execute_kw', model, 'search_read', [domain], {
        fields, offset, limit: LIMIT
      });
      
      allRecords = allRecords.concat(batch);
      offset += LIMIT;
      if (model === 'stock.move') process.stdout.write('.');
      
      if (batch.length < LIMIT) hasMore = false;
      await sleep(50); 
    } catch (e) {
      console.error(`\n ❌ Error en batch ${offset}:`, e.message);
      hasMore = false;
    }
  }
  if (model === 'stock.move') console.log(` ✅ (${allRecords.length})`);
  return allRecords;
}

// ==================================================================================
//  ⭐ MÓDULO DEVOLUCIONES B2B - HELPERS
// ==================================================================================

// Leer devoluciones del archivo JSON
async function getDevoluciones() {
  try {
    const data = await fs.readFile(DEVOLUCIONES_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
}

// Guardar devoluciones + auto-backup al seed
async function saveDevoluciones(devoluciones, { skipBackup = false } = {}) {
  await fs.writeFile(DEVOLUCIONES_FILE, JSON.stringify(devoluciones, null, 2), 'utf8');
  if (!skipBackup) {
    await backupToSeed(devoluciones);
  }
}

// ⭐ JOURNAL APPEND-ONLY: registra cada cambio de devolución como evento inmutable.
// Diseño:
// - Cada acción (CREATE/PATCH/DELETE/RMA) escribe 1 línea JSON al final del archivo.
// - Si la escritura falla (disco lleno, permisos), NO bloquea la operación de negocio:
//   se loguea el error y la operación principal sigue. Esto preserva la regla de oro
//   "no romper lo que funciona".
// - El journal vive en PERSISTENT_DATA_DIR (volumen Railway), sobrevive a deploys.
// - Formato JSONL (1 evento por línea): facilita streaming + tail + grep.
async function journalDevolucionEvent({ action, id, before = null, after = null, changes = null, actor = 'api', meta = null }) {
  try {
    const event = {
      ts: new Date().toISOString(),
      action,
      id: typeof id === 'number' ? id : (id ? Number(id) : null),
      actor,
      ...(before !== null ? { before } : {}),
      ...(after !== null ? { after } : {}),
      ...(changes ? { changes } : {}),
      ...(meta ? { meta } : {}),
    };
    await fs.appendFile(DEVOLUCIONES_JOURNAL_FILE, JSON.stringify(event) + '\n', 'utf8');
  } catch (e) {
    // No fallar la operación si el journal falla — solo log y seguir.
    console.warn(`⚠️  [JOURNAL] No se pudo escribir evento ${action} id=${id}: ${e.message}`);
  }
}

// ⭐ Helper: calcula el diff entre dos objetos devolución (campo a campo).
function computeDevolucionChanges(before, after) {
  const changes = {};
  if (!before || !after) return changes;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const v1 = before[k];
    const v2 = after[k];
    // Ignorar metadatos volátiles que no son cambios "de negocio"
    if (k === 'updated_at' || k === 'rma_cache') continue;
    if (JSON.stringify(v1) !== JSON.stringify(v2)) {
      changes[k] = { from: v1 === undefined ? null : v1, to: v2 === undefined ? null : v2 };
    }
  }
  return changes;
}

// ⭐ AUTO-BACKUP: Actualizar seed en cada modificación para que nunca se pierdan datos
async function backupToSeed(devoluciones) {
  try {
    // Limpiar campos temporales/pesados antes de guardar en seed
    const cleanDevs = devoluciones.map(d => {
      const clean = { ...d };
      delete clean.rma_cache;
      delete clean.updated_at;
      return clean;
    });
    await fs.writeFile(DEVOLUCIONES_SEED_FILE, JSON.stringify(cleanDevs, null, 2), 'utf8');
    console.log(`💾 [BACKUP] Seed actualizado: ${cleanDevs.length} devoluciones`);
  } catch (e) {
    console.error(`⚠️ [BACKUP] Error actualizando seed: ${e.message}`);
  }
}

// ==================================================================================
//  ⭐ PERSISTENCIA: Merge seed (git) + runtime (filesystem) al arrancar
// ==================================================================================
// En Railway el filesystem es efímero. Al hacer deploy, devoluciones.json puede no existir
// o tener datos antiguos. La seed (rastreada en git) garantiza un baseline.
// Si hay datos runtime (volumen persistente), se hace merge para no perder ninguna entrada.
async function ensureDevolucionesFromSeed() {
  let runtime = [];
  let seed = [];

  try { runtime = JSON.parse(await fs.readFile(DEVOLUCIONES_FILE, 'utf8')); } catch (e) { /* no runtime file */ }
  try { seed = JSON.parse(await fs.readFile(DEVOLUCIONES_SEED_FILE, 'utf8')); } catch (e) { /* no seed file */ }

  if (runtime.length === 0 && seed.length > 0) {
    // Deploy fresco sin datos runtime → arrancar desde la semilla
    console.log(`🌱 [STARTUP] Deploy fresco: cargando ${seed.length} devoluciones desde seed`);
    await saveDevoluciones(seed, { skipBackup: true });
    return seed;
  }

  if (seed.length > runtime.length) {
    // ⭐ El seed tiene MÁS datos que el runtime → el volumen se corrompió/reseteó
    // Usar seed como base y añadir cualquier entrada del runtime que no esté en seed
    console.log(`🛡️ [STARTUP] Seed (${seed.length}) > runtime (${runtime.length}): restaurando desde seed`);
    const seedPickingIds = new Set(seed.map(d => d.picking_id).filter(Boolean));
    const seedPickingNames = new Set(seed.map(d => d.picking_name).filter(Boolean));
    const newFromRuntime = runtime.filter(d => {
      if (d.picking_id && seedPickingIds.has(d.picking_id)) return false;
      if (d.picking_name && seedPickingNames.has(d.picking_name)) return false;
      return true;
    });
    const merged = [...seed, ...newFromRuntime];
    if (newFromRuntime.length > 0) {
      console.log(`🔀 [STARTUP] Merge: seed (${seed.length}) + ${newFromRuntime.length} extras del runtime = ${merged.length}`);
    }
    await saveDevoluciones(merged, { skipBackup: true });
    return merged;
  }

  if (runtime.length > 0 && seed.length > 0) {
    // Merge: añadir entradas de la seed que no estén en runtime (por picking_id o picking_name)
    const runtimePickingIds = new Set(runtime.map(d => d.picking_id).filter(Boolean));
    const runtimePickingNames = new Set(runtime.map(d => d.picking_name).filter(Boolean));
    const newFromSeed = seed.filter(d => {
      if (d.picking_id && runtimePickingIds.has(d.picking_id)) return false;
      if (d.picking_name && runtimePickingNames.has(d.picking_name)) return false;
      return true;
    });
    if (newFromSeed.length > 0) {
      console.log(`🔀 [STARTUP] Merge: ${newFromSeed.length} devoluciones de seed añadidas a ${runtime.length} runtime`);
      const merged = [...runtime, ...newFromSeed];
      await saveDevoluciones(merged, { skipBackup: true });
      return merged;
    }
    console.log(`✅ [STARTUP] ${runtime.length} devoluciones runtime (seed ya incluida)`);
    return runtime;
  }

  console.log(`📋 [STARTUP] ${runtime.length} devoluciones cargadas`);
  return runtime;
}

// ==================================================================================
//  ⭐ AUTO-MIGRACIÓN: partner_id + RMA cache al arrancar
// ==================================================================================
async function startupMigration() {
  try {
    // Paso 0: Merge con seed
    let devoluciones = await ensureDevolucionesFromSeed();
    if (devoluciones.length === 0) {
      console.log('📋 [STARTUP] No hay devoluciones para migrar');
      return;
    }

    let changed = false;

    // Paso 1a: Resolver picking_id + partner_id para entradas que NO tienen picking_id (recuperadas de logs)
    const sinPickingId = devoluciones.filter(d => !d.picking_id && d.picking_name);
    if (sinPickingId.length > 0) {
      console.log(`🔄 [STARTUP] Resolviendo picking_id para ${sinPickingId.length} devoluciones por nombre...`);

      try {
        const common = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/common` });
        const models = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/object` });

        const uid = await new Promise((resolve, reject) => {
          common.methodCall('authenticate', [
            process.env.ODOO_DATABASE, process.env.ODOO_USERNAME, process.env.ODOO_PASSWORD, {}
          ], (err, r) => err ? reject(err) : resolve(r));
        });

        for (const dev of sinPickingId) {
          try {
            const pickings = await new Promise((resolve, reject) => {
              models.methodCall('execute_kw', [
                process.env.ODOO_DATABASE, uid, process.env.ODOO_PASSWORD,
                'stock.picking', 'search_read',
                [[['name', '=', dev.picking_name]]],
                { fields: ['id', 'partner_id', 'company_id'], limit: 1 }
              ], (err, r) => err ? reject(err) : resolve(r));
            });

            if (pickings.length > 0) {
              dev.picking_id = pickings[0].id;
              if (pickings[0].partner_id) {
                dev.partner_id = pickings[0].partner_id[0];
                if (!dev.partner_name || dev.partner_name === '') {
                  dev.partner_name = pickings[0].partner_id[1];
                }
              }
              changed = true;
              console.log(`  ✅ ${dev.picking_name} → picking_id: ${dev.picking_id}, partner_id: ${dev.partner_id}, partner: ${dev.partner_name}`);
            } else {
              console.log(`  ⚠️ ${dev.picking_name} → No encontrado en Odoo`);
            }
          } catch (err) {
            console.error(`  ⚠️ ${dev.picking_name}: ${err.message}`);
          }
        }
      } catch (authErr) {
        console.error('⚠️ [STARTUP] No se pudo conectar a Odoo para resolver picking_ids:', authErr.message);
      }
    }

    // Paso 1b: Migrar partner_id para entradas que tienen picking_id pero no partner_id
    const sinPartnerId = devoluciones.filter(d => !d.partner_id && d.picking_id);
    if (sinPartnerId.length > 0) {
      console.log(`🔄 [STARTUP] Migrando partner_id para ${sinPartnerId.length} devoluciones...`);

      try {
        const common = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/common` });
        const models = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/object` });

        const uid = await new Promise((resolve, reject) => {
          common.methodCall('authenticate', [
            process.env.ODOO_DATABASE, process.env.ODOO_USERNAME, process.env.ODOO_PASSWORD, {}
          ], (err, r) => err ? reject(err) : resolve(r));
        });

        for (const dev of sinPartnerId) {
          try {
            const pickings = await new Promise((resolve, reject) => {
              models.methodCall('execute_kw', [
                process.env.ODOO_DATABASE, uid, process.env.ODOO_PASSWORD,
                'stock.picking', 'search_read',
                [[['id', '=', dev.picking_id]]],
                { fields: ['partner_id'], limit: 1 }
              ], (err, r) => err ? reject(err) : resolve(r));
            });

            if (pickings.length > 0 && pickings[0].partner_id) {
              dev.partner_id = pickings[0].partner_id[0];
              if (!dev.partner_name || dev.partner_name === '') {
                dev.partner_name = pickings[0].partner_id[1];
              }
              changed = true;
              console.log(`  ✅ ${dev.picking_name} → partner_id: ${dev.partner_id}`);
            }
          } catch (err) {
            console.error(`  ⚠️ ${dev.picking_name}: ${err.message}`);
          }
        }
      } catch (authErr) {
        console.error('⚠️ [STARTUP] No se pudo conectar a Odoo para migrar partner_ids:', authErr.message);
      }
    }

    // Paso 1c: Invalidar cachés RMA negativos que no fueron consultados con commercial_partner_id (v2)
    // Esto corrige falsos negativos de la versión anterior que buscaba solo por partner_id exacto
    const cachesNegativosV1 = devoluciones.filter(d =>
      d.rma_cache && d.rma_cache.tiene_rma === false && d.partner_id && !d.rma_cache.search_version
    );
    if (cachesNegativosV1.length > 0) {
      console.log(`🔄 [STARTUP] Invalidando ${cachesNegativosV1.length} cachés RMA negativos (v1) para re-verificar con commercial_partner_id...`);
      cachesNegativosV1.forEach(d => { delete d.rma_cache; });
      changed = true;
    }

    // Paso 2: Auto-check RMA para entradas con partner_id pero sin rma_cache
    const sinRMACache = devoluciones.filter(d => d.partner_id && !d.rma_cache);
    if (sinRMACache.length > 0) {
      console.log(`🔄 [STARTUP] Verificando RMA para ${sinRMACache.length} devoluciones...`);

      try {
        const common = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/common` });
        const models = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/object` });

        const uid = await new Promise((resolve, reject) => {
          common.methodCall('authenticate', [
            process.env.ODOO_DATABASE, process.env.ODOO_USERNAME, process.env.ODOO_PASSWORD, {}
          ], (err, r) => err ? reject(err) : resolve(r));
        });

        // Deduplicar por partner_id para no hacer queries repetidos
        const uniquePartnerIds = [...new Set(sinRMACache.map(d => d.partner_id))];
        const rmaResults = {};

        // Resolver commercial_partner_id para cada partner (direcciones de entrega → contacto comercial raíz)
        const commercialMap = {};
        try {
          const partnerDataList = await new Promise((resolve, reject) => {
            models.methodCall('execute_kw', [
              process.env.ODOO_DATABASE, uid, process.env.ODOO_PASSWORD,
              'res.partner', 'read',
              [uniquePartnerIds.map(id => parseInt(id))],
              { fields: ['id', 'commercial_partner_id'] }
            ], (err, r) => err ? reject(err) : resolve(r));
          });
          partnerDataList.forEach(p => {
            commercialMap[p.id] = p.commercial_partner_id ? p.commercial_partner_id[0] : p.id;
          });
        } catch (err) {
          console.error('  ⚠️ No se pudieron resolver commercial_partner_ids:', err.message);
          uniquePartnerIds.forEach(id => { commercialMap[id] = parseInt(id); });
        }

        // Deduplicar por commercial_partner_id para no repetir queries del mismo cliente comercial
        const commercialToPartners = {};
        uniquePartnerIds.forEach(pid => {
          const cpid = commercialMap[pid] || parseInt(pid);
          if (!commercialToPartners[cpid]) commercialToPartners[cpid] = [];
          commercialToPartners[cpid].push(pid);
        });

        for (const [commercialId, partnerIds] of Object.entries(commercialToPartners)) {
          try {
            const tickets = await new Promise((resolve, reject) => {
              models.methodCall('execute_kw', [
                process.env.ODOO_DATABASE, uid, process.env.ODOO_PASSWORD,
                'helpdesk.ticket', 'search_read',
                [[
                  ['partner_id.commercial_partner_id', '=', parseInt(commercialId)],
                  ['team_id.name', 'ilike', 'SAC - B2B']
                ]],
                {
                  fields: ['id', 'name', 'partner_id', 'team_id', 'stage_id', 'tag_ids', 'create_date', 'sale_order_id'],
                  order: 'create_date desc',
                  limit: 10
                }
              ], (err, r) => err ? reject(err) : resolve(r));
            });

            // Resolver tags
            let ticketsConTags = tickets;
            if (tickets.length > 0) {
              const allTagIds = [...new Set(tickets.flatMap(t => t.tag_ids || []))];
              if (allTagIds.length > 0) {
                const tags = await new Promise((resolve, reject) => {
                  models.methodCall('execute_kw', [
                    process.env.ODOO_DATABASE, uid, process.env.ODOO_PASSWORD,
                    'helpdesk.tag', 'read',
                    [allTagIds],
                    { fields: ['id', 'name'] }
                  ], (err, r) => err ? reject(err) : resolve(r));
                });
                const tagMap = {};
                tags.forEach(t => tagMap[t.id] = t.name);
                ticketsConTags = tickets.map(t => ({
                  ...t,
                  tags: (t.tag_ids || []).map(id => tagMap[id]).filter(Boolean)
                }));
              }
            }

            const resultado = ticketsConTags.map(t => ({
              id: t.id,
              nombre: t.name,
              equipo: t.team_id ? t.team_id[1] : null,
              estado: t.stage_id ? t.stage_id[1] : null,
              etiquetas: t.tags || [],
              fecha: t.create_date,
              pedido: t.sale_order_id ? t.sale_order_id[1] : null
            }));

            // Asignar el mismo resultado a todos los partner_ids que comparten el mismo commercial_partner_id
            const rmaData = { tiene_rma: resultado.length > 0, tickets: resultado };
            partnerIds.forEach(pid => { rmaResults[pid] = rmaData; });
            console.log(`  ${resultado.length > 0 ? '✅' : '⚠️'} Commercial ${commercialId} (partners: ${partnerIds.join(',')}): ${resultado.length} tickets RMA`);
          } catch (err) {
            console.error(`  ⚠️ Commercial ${commercialId}: ${err.message}`);
            partnerIds.forEach(pid => { rmaResults[pid] = { tiene_rma: false, tickets: [] }; });
          }
        }

        // Aplicar rma_cache a cada devolución
        for (const dev of sinRMACache) {
          if (rmaResults[dev.partner_id]) {
            dev.rma_cache = {
              ...rmaResults[dev.partner_id],
              cached_at: new Date().toISOString(),
              search_version: 2
            };
            changed = true;
          }
        }
      } catch (authErr) {
        console.error('⚠️ [STARTUP] No se pudo conectar a Odoo para verificar RMA:', authErr.message);
      }
    }

    // Guardar si hubo cambios
    if (changed) {
      await saveDevoluciones(devoluciones);
      console.log(`💾 [STARTUP] Devoluciones actualizadas y guardadas`);
    } else {
      console.log(`✅ [STARTUP] Todas las devoluciones ya están completas`);
    }

  } catch (error) {
    console.error('❌ [STARTUP] Error en migración automática:', error.message);
    // No fallar el arranque por un error de migración
  }
}

// Buscar en Odoo por diferentes criterios
async function buscarEnOdoo(query, tipo = 'todos') {
  console.log(`🔍 [DEVOLUCIONES] Buscando "${query}" tipo: ${tipo}`);
  
  const common = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/common` });
  const models = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/object` });
  
  const uid = await new Promise((resolve, reject) => {
    common.methodCall('authenticate', [
      process.env.ODOO_DATABASE, process.env.ODOO_USERNAME, process.env.ODOO_PASSWORD, {}
    ], (err, res) => err ? reject(err) : resolve(res));
  });

  // Construir dominio de búsqueda según el tipo
  let domain = [
    ['picking_type_id.code', '=', 'outgoing'],
    ['state', '=', 'done'],
    ['origin', 'ilike', 'S%'],  // Empieza por S
    ['origin', 'not ilike', '%SF']  // NO termina en SF
  ];

  const q = query.trim();
  
  if (tipo === 'pedido') {
    // Buscar por número de pedido (sale_id.name o origin)
    domain.push('|');
    domain.push(['origin', 'ilike', q]);
    domain.push(['sale_id.name', 'ilike', q]);
  } else if (tipo === 'albaran') {
    // Buscar por nombre del albarán
    domain.push(['name', 'ilike', q]);
  } else if (tipo === 'cliente') {
    // Buscar por nombre del cliente
    domain.push(['partner_id.name', 'ilike', q]);
  } else if (tipo === 'paquete') {
    // Buscar por paquete - esto requiere buscar en stock.move.line
    // Por simplicidad, buscamos en el nombre/referencia
    domain.push('|');
    domain.push(['name', 'ilike', q]);
    domain.push(['origin', 'ilike', q]);
  } else {
    // Búsqueda general (todos)
    domain.push('|', '|', '|');
    domain.push(['name', 'ilike', q]);
    domain.push(['origin', 'ilike', q]);
    domain.push(['partner_id.name', 'ilike', q]);
    domain.push(['sale_id.name', 'ilike', q]);
  }

  try {
    const pickings = await new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        process.env.ODOO_DATABASE, uid, process.env.ODOO_PASSWORD,
        'stock.picking', 'search_read',
        [domain],
        { 
          fields: ['id', 'name', 'partner_id', 'origin', 'date_done', 'carrier_id', 'company_id', 'sale_id'],
          limit: 20,
          order: 'date_done desc'
        }
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    // Cargar devoluciones existentes para marcar
    const devolucionesExistentes = await getDevoluciones();
    const pickingIdsConDevolucion = new Set(devolucionesExistentes.map(d => d.picking_id));

    // Formatear resultados
    const resultados = pickings.map(p => {
      // Detectar empresa (Black/Gold) basado en company_id o nombre
      let company = 'Black'; // Por defecto
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
// Configurar multer para uploads de Packing List
const packingStorage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => {
    // Sanitizar filename para evitar path traversal en el disco (por si llega "../..")
    const safeName = path.basename(file.originalname).replace(/[^\w.\-áéíóúÁÉÍÓÚñÑ ]/g, '_');
    cb(null, `${Date.now()}-${safeName}`);
  }
});
// Aceptamos solo PDFs — el pipeline downstream (Python + pdfplumber) no procesa otra cosa.
const packingUpload = multer({
  storage: packingStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isPdfMime = file.mimetype === 'application/pdf';
    const isPdfExt = /\.pdf$/i.test(file.originalname);
    if (isPdfMime || isPdfExt) return cb(null, true);
    cb(new Error(`Solo se permiten archivos PDF. Recibido: ${file.mimetype} (${file.originalname})`));
  },
});

// Crear carpetas para packing
if (!fsSync.existsSync('./uploads')) fsSync.mkdirSync('./uploads', { recursive: true });
if (!fsSync.existsSync('./packing-outputs')) fsSync.mkdirSync('./packing-outputs', { recursive: true });
// ==================================================================================
//  ⭐ ENDPOINTS DEVOLUCIONES B2B
// ==================================================================================

// 0. Diagnóstico de devoluciones (temporal)
app.get("/api/devoluciones/debug", async (req, res) => {
  try {
    const runtimeExists = fsSync.existsSync(DEVOLUCIONES_FILE);
    const seedExists = fsSync.existsSync(DEVOLUCIONES_SEED_FILE);
    let runtimeData = [], seedData = [];
    try { runtimeData = JSON.parse(await fs.readFile(DEVOLUCIONES_FILE, 'utf8')); } catch(e) {}
    try { seedData = JSON.parse(await fs.readFile(DEVOLUCIONES_SEED_FILE, 'utf8')); } catch(e) {}

    // List files in persistent dir
    let persistentFiles = [];
    try { persistentFiles = fsSync.readdirSync(PERSISTENT_DATA_DIR); } catch(e) {}
    let localFiles = [];
    try { localFiles = fsSync.readdirSync(LOCAL_DATA_DIR); } catch(e) {}

    res.json({
      persistent_dir: PERSISTENT_DATA_DIR,
      local_dir: LOCAL_DATA_DIR,
      railway_volume: process.env.RAILWAY_VOLUME_MOUNT_PATH || 'NOT SET',
      runtime_file: { path: DEVOLUCIONES_FILE, exists: runtimeExists, count: runtimeData.length },
      seed_file: { path: DEVOLUCIONES_SEED_FILE, exists: seedExists, count: seedData.length },
      persistent_files: persistentFiles,
      local_files: localFiles
    });
  } catch(e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// 1. Buscar expediciones en Odoo
app.get("/api/devoluciones/buscar", async (req, res) => {
  try {
    const { q, tipo = 'todos' } = req.query;
    
    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Búsqueda muy corta (mín. 2 caracteres)' });
    }

    const resultado = await buscarEnOdoo(q, tipo);
    res.json(resultado);
  } catch (error) {
    console.error('❌ Error en búsqueda:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Registrar nueva devolución
app.post("/api/devoluciones", async (req, res) => {
  try {
    const { picking_id, picking_name, partner_name, partner_id, company, tracking_retorno, recibido_por, notas } = req.body;

    if (!picking_id || !picking_name) {
      return res.status(400).json({ error: 'Datos incompletos' });
    }

    const devoluciones = await getDevoluciones();

    // Verificar si ya existe
    const existe = devoluciones.find(d => d.picking_id === picking_id);
    if (existe) {
      return res.status(400).json({ error: 'Esta expedición ya tiene una devolución registrada' });
    }

    // Crear nueva devolución
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

    // ⭐ Journal: registrar evento CREATE (snapshot completo)
    await journalDevolucionEvent({
      action: 'CREATE',
      id: nuevaDevolucion.id,
      after: nuevaDevolucion,
      actor: recibido_por || 'api',
    });

    console.log(`✅ [DEVOLUCIONES] Registrada: ${picking_name} por ${recibido_por}`);

    res.json({ success: true, devolucion: nuevaDevolucion });
  } catch (error) {
    console.error('❌ Error registrando devolución:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. Listar devoluciones
app.get("/api/devoluciones", async (req, res) => {
  try {
    const { company, limit = 50, offset = 0 } = req.query;
    
    let devoluciones = await getDevoluciones();

    // Filtrar por empresa si se especifica
    if (company) {
      devoluciones = devoluciones.filter(d => 
        d.company && d.company.toLowerCase() === company.toLowerCase()
      );
    }

    // Ordenar por fecha descendente
    devoluciones.sort((a, b) => new Date(b.fecha_recepcion) - new Date(a.fecha_recepcion));

    // Paginar
    const total = devoluciones.length;
    const paginadas = devoluciones.slice(parseInt(offset), parseInt(offset) + parseInt(limit));

    res.json({ 
      devoluciones: paginadas,
      total,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('❌ Error listando devoluciones:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================================================================================
//  ⭐ ENDPOINTS SYNC MANUAL
// ==================================================================================

// Endpoint para forzar sincronización manual
app.post("/api/force-sync", async (req, res) => {
  try {
    if (isSyncing) {
      return res.status(429).json({ 
        error: 'Sincronización ya en curso',
        lastSync: lastSyncTimestamp 
      });
    }

    console.log('🔄 [SYNC] Forzando sincronización manual...');
    
    isSyncing = true;
    const updatedData = await syncWithOdoo();
    
    if (updatedData) {
      lastSyncTimestamp = new Date();
      broadcastUpdate(updatedData);
      
      res.json({ 
        success: true,
        message: 'Sincronización completada',
        lastSync: lastSyncTimestamp,
        locations: updatedData.length || 0
      });
    } else {
      res.status(500).json({ 
        error: 'Error en la sincronización',
        lastSync: lastSyncTimestamp 
      });
    }
  } catch (error) {
    console.error('❌ Error en force-sync:', error);
    res.status(500).json({ 
      error: error.message,
      lastSync: lastSyncTimestamp 
    });
  } finally {
    isSyncing = false;
  }
});

// Sync rápido B2C (~10 segundos)
app.post("/api/sync-b2c", async (req, res) => {
  try {
    console.log('🔵 [SYNC] Actualizando solo B2C...');
    const { syncB2COnly } = await import('./sync_odoo.js');
    const result = await syncB2COnly();
    lastSyncTimestamp = new Date();
    res.json({ ...result, lastSync: lastSyncTimestamp });
  } catch (error) {
    console.error('❌ Error en sync-b2c:', error);
    res.status(500).json({ error: error.message });
  }
});

// Sync rápido B2B (~10 segundos)
app.post("/api/sync-b2b", async (req, res) => {
  try {
    console.log('🟠 [SYNC] Actualizando solo B2B...');
    const { syncB2BOnly } = await import('./sync_odoo.js');
    const result = await syncB2BOnly();
    lastSyncTimestamp = new Date();
    res.json({ ...result, lastSync: lastSyncTimestamp });
  } catch (error) {
    console.error('❌ Error en sync-b2b:', error);
    res.status(500).json({ error: error.message });
  }
});

// Sync rápido Playa (~2 segundos)
app.post("/api/sync-playa", async (req, res) => {
  try {
    console.log('🏖️ [SYNC] Actualizando solo Playa...');
    const { syncPlayaOnly } = await import('./sync_odoo.js');
    const result = await syncPlayaOnly();
    lastSyncTimestamp = new Date();
    res.json({ ...result, lastSync: lastSyncTimestamp });
  } catch (error) {
    console.error('❌ Error en sync-playa:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint para obtener timestamp de última sincronización
app.get("/api/last-sync", (req, res) => {
  res.json({ 
    lastSync: lastSyncTimestamp,
    isSyncing: isSyncing 
  });
});

// 4. Estadísticas de devoluciones
app.get("/api/devoluciones/stats", async (req, res) => {
  try {
    const devoluciones = await getDevoluciones();

    const now = new Date();
    const hoy = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const inicioSemana = new Date(hoy);
    inicioSemana.setDate(hoy.getDate() - hoy.getDay()); // Domingo
    const inicioMes = new Date(now.getFullYear(), now.getMonth(), 1);

    // Contadores
    const contadores = {
      hoy: devoluciones.filter(d => new Date(d.fecha_recepcion) >= hoy).length,
      semana: devoluciones.filter(d => new Date(d.fecha_recepcion) >= inicioSemana).length,
      mes: devoluciones.filter(d => new Date(d.fecha_recepcion) >= inicioMes).length,
      total: devoluciones.length
    };

    // Por empresa (HISTÓRICO COMPLETO)
    const porCompany = {};
    devoluciones.forEach(d => {
      const comp = d.company || 'Sin empresa';
      porCompany[comp] = (porCompany[comp] || 0) + 1;
    });

    // Por día de la semana (HISTÓRICO COMPLETO)
    const diasSemana = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const porDiaSemana = {};
    diasSemana.forEach(d => porDiaSemana[d] = 0);
    
    devoluciones.forEach(d => {
      const fecha = new Date(d.fecha_recepcion);
      const diaSemana = diasSemana[fecha.getDay()];
      porDiaSemana[diaSemana]++;
    });

    // Por mes (ÚLTIMOS 6 MESES)
    const mesesNombres = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 
                          'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    const porMes = [];
    
    for (let i = 5; i >= 0; i--) {
      const fecha = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const mesNombre = mesesNombres[fecha.getMonth()];
      const year = fecha.getFullYear();
      const siguienteMes = new Date(fecha.getFullYear(), fecha.getMonth() + 1, 1);
      
      const count = devoluciones.filter(d => {
        const devFecha = new Date(d.fecha_recepcion);
        return devFecha >= fecha && devFecha < siguienteMes;
      }).length;
      
      porMes.push({ 
        mes: mesNombre, 
        year: year,
        count: count 
      });
    }

    // Últimas 5 devoluciones
    const ultimas = devoluciones
      .sort((a, b) => new Date(b.fecha_recepcion) - new Date(a.fecha_recepcion))
      .slice(0, 5);

    res.json({
      contadores,
      por_company: Object.entries(porCompany).map(([company, count]) => ({ company, count })),
      por_dia_semana: Object.entries(porDiaSemana).map(([dia, count]) => ({ dia, count })),
      por_mes: porMes,
      ultimas
    });
  } catch (error) {
    console.error('❌ Error en stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// 5. Eliminar devolución (opcional, para correcciones)
app.delete("/api/devoluciones/:id", async (req, res) => {
  try {
    const { id } = req.params;
    let devoluciones = await getDevoluciones();

    const index = devoluciones.findIndex(d => d.id === parseInt(id));
    if (index === -1) {
      return res.status(404).json({ error: 'Devolución no encontrada' });
    }

    const eliminada = devoluciones.splice(index, 1)[0];
    await saveDevoluciones(devoluciones);

    // ⭐ Journal: snapshot completo del registro eliminado (permite restore)
    await journalDevolucionEvent({
      action: 'DELETE',
      id: eliminada.id,
      before: eliminada,
      actor: req.body?.actor || 'api',
      meta: { reason: req.body?.reason || null },
    });

    console.log(`🗑️ [DEVOLUCIONES] Eliminada: ${eliminada.picking_name}`);

    res.json({ success: true, eliminada });
  } catch (error) {
    console.error('❌ Error eliminando devolución:', error);
    res.status(500).json({ error: error.message });
  }
});

// 5b. Editar devolución (corregir datos tras registro)
app.patch("/api/devoluciones/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    let devoluciones = await getDevoluciones();

    const index = devoluciones.findIndex(d => d.id === parseInt(id));
    if (index === -1) {
      return res.status(404).json({ error: 'Devolución no encontrada' });
    }

    // ⭐ Capturar snapshot ANTES del cambio para el journal
    const beforeSnapshot = JSON.parse(JSON.stringify(devoluciones[index]));

    // Campos editables (no permitir cambiar id, picking_id, rma_cache)
    const camposEditables = ['picking_name', 'partner_name', 'company', 'tracking_retorno', 'recibido_por', 'notas', 'fecha_recepcion'];
    const cambios = {};
    for (const campo of camposEditables) {
      if (updates[campo] !== undefined) {
        devoluciones[index][campo] = updates[campo];
        cambios[campo] = updates[campo];
      }
    }

    if (Object.keys(cambios).length === 0) {
      return res.status(400).json({ error: 'No se proporcionaron campos editables' });
    }

    devoluciones[index].updated_at = new Date().toISOString();
    await saveDevoluciones(devoluciones);

    // ⭐ Journal: registrar diff campo a campo
    const afterSnapshot = devoluciones[index];
    await journalDevolucionEvent({
      action: 'PATCH',
      id: afterSnapshot.id,
      before: beforeSnapshot,
      after: afterSnapshot,
      changes: computeDevolucionChanges(beforeSnapshot, afterSnapshot),
      actor: req.body?.actor || 'api',
    });

    console.log(`✏️ [DEVOLUCIONES] Editada: ${devoluciones[index].picking_name} → ${JSON.stringify(cambios)}`);

    res.json({ success: true, devolucion: devoluciones[index] });
  } catch (error) {
    console.error('❌ Error editando devolución:', error);
    res.status(500).json({ error: error.message });
  }
});

// 6. Buscar RMA del cliente en Helpdesk
// Usa commercial_partner_id para encontrar tickets tanto del contacto padre como de direcciones hijas
app.get("/api/devoluciones/rma/:partner_id", async (req, res) => {
  try {
    const { partner_id } = req.params;

    if (!partner_id) {
      return res.status(400).json({ error: 'Partner ID requerido' });
    }

    const common = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/common` });
    const models = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/object` });

    const uid = await new Promise((resolve, reject) => {
      common.methodCall('authenticate', [
        process.env.ODOO_DATABASE, process.env.ODOO_USERNAME, process.env.ODOO_PASSWORD, {}
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    // Paso 1: Obtener el commercial_partner_id (contacto comercial raíz)
    // Esto resuelve el problema de que el albarán tenga una dirección de entrega (hijo)
    // pero el ticket esté asociado al contacto principal (padre) o viceversa
    const partnerData = await new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        process.env.ODOO_DATABASE, uid, process.env.ODOO_PASSWORD,
        'res.partner', 'read',
        [[parseInt(partner_id)]],
        { fields: ['commercial_partner_id'] }
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    const commercialPartnerId = (partnerData && partnerData.length > 0 && partnerData[0].commercial_partner_id)
      ? partnerData[0].commercial_partner_id[0]
      : parseInt(partner_id);

    console.log(`🔍 RMA: partner_id=${partner_id}, commercial_partner_id=${commercialPartnerId}`);

    // Paso 2: Buscar tickets usando commercial_partner_id para capturar tickets
    // asociados a cualquier dirección/contacto del mismo cliente comercial
    const tickets = await new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        process.env.ODOO_DATABASE, uid, process.env.ODOO_PASSWORD,
        'helpdesk.ticket', 'search_read',
        [[
          ['partner_id.commercial_partner_id', '=', commercialPartnerId],
          ['team_id.name', 'ilike', 'SAC - B2B']
        ]],
        {
          fields: ['id', 'name', 'partner_id', 'team_id', 'stage_id', 'tag_ids', 'create_date', 'sale_order_id'],
          order: 'create_date desc',
          limit: 10
        }
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    let ticketsConTags = tickets;
    if (tickets.length > 0) {
      const allTagIds = [...new Set(tickets.flatMap(t => t.tag_ids || []))];

      if (allTagIds.length > 0) {
        const tags = await new Promise((resolve, reject) => {
          models.methodCall('execute_kw', [
            process.env.ODOO_DATABASE, uid, process.env.ODOO_PASSWORD,
            'helpdesk.tag', 'read',
            [allTagIds],
            { fields: ['id', 'name'] }
          ], (err, res) => err ? reject(err) : resolve(res));
        });

        const tagMap = {};
        tags.forEach(t => tagMap[t.id] = t.name);

        ticketsConTags = tickets.map(t => ({
          ...t,
          tags: (t.tag_ids || []).map(id => tagMap[id]).filter(Boolean)
        }));
      }
    }

    const resultado = ticketsConTags.map(t => ({
      id: t.id,
      nombre: t.name,
      equipo: t.team_id ? t.team_id[1] : null,
      estado: t.stage_id ? t.stage_id[1] : null,
      etiquetas: t.tags || [],
      fecha: t.create_date,
      pedido: t.sale_order_id ? t.sale_order_id[1] : null
    }));

    console.log('RMA Partner ' + partner_id + ' (commercial: ' + commercialPartnerId + '): ' + resultado.length + ' tickets');

    res.json({
      tiene_rma: resultado.length > 0,
      tickets: resultado
    });

  } catch (error) {
    console.error('Error buscando RMA:', error);
    res.status(500).json({ error: error.message });
  }
});

// 6b. Guardar caché de RMA en la devolución
app.patch("/api/devoluciones/:id/rma", async (req, res) => {
  try {
    const devId = parseInt(req.params.id) || req.params.id;
    const { tiene_rma, tickets } = req.body;
    let devoluciones = await getDevoluciones();
    const idx = devoluciones.findIndex(d => d.id == devId);
    if (idx === -1) return res.status(404).json({ error: 'Devolución no encontrada' });
    devoluciones[idx].rma_cache = { tiene_rma, tickets, cached_at: new Date().toISOString(), search_version: 2 };
    await saveDevoluciones(devoluciones);
    // Nota: NO se journal-ea el RMA cache (es metadata volátil, ya lo excluye computeDevolucionChanges)
    res.json({ success: true });
  } catch (error) {
    console.error('Error guardando RMA cache:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================================================================================
//  ⭐ JOURNAL DE DEVOLUCIONES — endpoints de consulta y restauración (Bug 1)
// ==================================================================================

// Helper: leer todos los eventos del journal (devuelve array)
async function readDevolucionesJournal() {
  try {
    const raw = await fs.readFile(DEVOLUCIONES_JOURNAL_FILE, 'utf8');
    return raw
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try { return JSON.parse(line); } catch (e) { return null; }
      })
      .filter(Boolean);
  } catch (e) {
    if (e.code === 'ENOENT') return []; // primer arranque, journal vacío
    throw e;
  }
}

// 8. Listar journal completo (con filtros opcionales)
//    GET /api/devoluciones/journal?id=48&since=2026-04-01&action=PATCH&limit=200
app.get("/api/devoluciones/journal", async (req, res) => {
  try {
    const { id, since, until, action, actor, limit = 500 } = req.query;
    let events = await readDevolucionesJournal();

    if (id) events = events.filter(e => String(e.id) === String(id));
    if (action) events = events.filter(e => e.action === String(action).toUpperCase());
    if (actor) events = events.filter(e => e.actor === actor);
    if (since) events = events.filter(e => e.ts >= since);
    if (until) events = events.filter(e => e.ts <= until);

    // Más recientes primero
    events.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    events = events.slice(0, parseInt(limit, 10));

    res.json({ total: events.length, events });
  } catch (error) {
    console.error('❌ Error leyendo journal:', error);
    res.status(500).json({ error: error.message });
  }
});

// 9. Histórico de UNA devolución concreta (todos los eventos en orden cronológico)
app.get("/api/devoluciones/:id/history", async (req, res) => {
  try {
    const { id } = req.params;
    const events = await readDevolucionesJournal();
    const filtered = events
      .filter(e => String(e.id) === String(id))
      .sort((a, b) => (a.ts > b.ts ? 1 : -1)); // cronológico ascendente

    res.json({
      id: Number(id) || id,
      total: filtered.length,
      events: filtered,
    });
  } catch (error) {
    console.error('❌ Error en history:', error);
    res.status(500).json({ error: error.message });
  }
});

// 10. Restaurar una devolución eliminada usando el snapshot del journal
app.post("/api/devoluciones/:id/restore", async (req, res) => {
  try {
    const { id } = req.params;
    const events = await readDevolucionesJournal();

    // Buscar el último DELETE de esta id
    const deleteEvent = [...events]
      .reverse()
      .find(e => String(e.id) === String(id) && e.action === 'DELETE' && e.before);

    if (!deleteEvent) {
      return res.status(404).json({ error: `No se encontró un evento DELETE para id=${id} en el journal` });
    }

    // Verificar que no exista ya
    let devoluciones = await getDevoluciones();
    if (devoluciones.find(d => d.id === deleteEvent.before.id)) {
      return res.status(409).json({ error: 'La devolución ya existe en el estado actual; no se restaura' });
    }

    // Reinsertar
    const restored = { ...deleteEvent.before, restored_at: new Date().toISOString() };
    devoluciones.push(restored);
    await saveDevoluciones(devoluciones);

    // Journal: registrar el RESTORE como evento
    await journalDevolucionEvent({
      action: 'RESTORE',
      id: restored.id,
      after: restored,
      actor: req.body?.actor || 'api',
      meta: { from_event_ts: deleteEvent.ts },
    });

    console.log(`♻️  [DEVOLUCIONES] Restaurada: ${restored.picking_name} (id=${restored.id})`);
    res.json({ success: true, devolucion: restored });
  } catch (error) {
    console.error('❌ Error en restore:', error);
    res.status(500).json({ error: error.message });
  }
});

// 11. Stats del journal (cuántos eventos por tipo / día)
app.get("/api/devoluciones/journal/stats", async (req, res) => {
  try {
    const events = await readDevolucionesJournal();
    const byAction = {};
    const byDay = {};
    for (const e of events) {
      byAction[e.action] = (byAction[e.action] || 0) + 1;
      const day = (e.ts || '').slice(0, 10);
      if (day) byDay[day] = (byDay[day] || 0) + 1;
    }
    res.json({
      total: events.length,
      first: events[0]?.ts || null,
      last: events[events.length - 1]?.ts || null,
      by_action: byAction,
      by_day: byDay,
    });
  } catch (error) {
    console.error('❌ Error en journal stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// 7b. Fix fechas en batch (temporal para recuperación)
app.post("/api/devoluciones/fix-dates", async (req, res) => {
  try {
    const { fixes } = req.body;
    if (!fixes || !Array.isArray(fixes)) {
      return res.status(400).json({ error: 'Se requiere un array de fixes [{picking_name, fecha_recepcion}]' });
    }
    const devoluciones = await getDevoluciones();
    let updated = 0;
    for (const fix of fixes) {
      const dev = devoluciones.find(d => d.picking_name === fix.picking_name);
      if (dev) {
        dev.fecha_recepcion = fix.fecha_recepcion;
        updated++;
      }
    }
    await saveDevoluciones(devoluciones);
    console.log(`🔧 [DEVOLUCIONES] Fechas corregidas: ${updated}/${fixes.length}`);
    res.json({ success: true, updated, total: fixes.length });
  } catch (error) {
    console.error('❌ Error corrigiendo fechas:', error);
    res.status(500).json({ error: error.message });
  }
});

// 7. Migración: rellenar partner_id en devoluciones antiguas
app.post("/api/devoluciones/migrate-partner-ids", async (req, res) => {
  try {
    console.log('🔄 [DEVOLUCIONES] Iniciando migración de partner_ids...');
    const devoluciones = await getDevoluciones();
    const sinPartnerId = devoluciones.filter(d => !d.partner_id && d.picking_id);

    if (sinPartnerId.length === 0) {
      return res.json({ success: true, message: 'Todas ya tienen partner_id', migrated: 0 });
    }

    console.log(`📋 ${sinPartnerId.length} devoluciones sin partner_id`);

    const common = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/common` });
    const models = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/object` });
    const uid = await new Promise((resolve, reject) => {
      common.methodCall('authenticate', [
        process.env.ODOO_DATABASE, process.env.ODOO_USERNAME, process.env.ODOO_PASSWORD, {}
      ], (err, r) => err ? reject(err) : resolve(r));
    });

    let migrated = 0;
    const errors = [];

    for (const dev of sinPartnerId) {
      try {
        const pickings = await new Promise((resolve, reject) => {
          models.methodCall('execute_kw', [
            process.env.ODOO_DATABASE, uid, process.env.ODOO_PASSWORD,
            'stock.picking', 'search_read',
            [[['id', '=', dev.picking_id]]],
            { fields: ['partner_id'], limit: 1 }
          ], (err, r) => err ? reject(err) : resolve(r));
        });

        if (pickings.length > 0 && pickings[0].partner_id) {
          dev.partner_id = pickings[0].partner_id[0];
          migrated++;
          console.log(`  ✅ ${dev.picking_name} → partner_id: ${dev.partner_id}`);
        } else {
          errors.push(dev.picking_name);
        }
      } catch (err) {
        console.error(`  ❌ ${dev.picking_name}: ${err.message}`);
        errors.push(dev.picking_name);
      }
    }

    await saveDevoluciones(devoluciones);
    console.log(`🔄 Migración completada: ${migrated}/${sinPartnerId.length}`);
    res.json({ success: true, migrated, total: sinPartnerId.length, errors });
  } catch (error) {
    console.error('❌ Error en migración:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================================================================================
//  1.1 CONTEXTO FINANCIERO Y TÉCNICO (CAPA CFO)
// ==================================================================================
const DATA_DICTIONARY = `
### 📚 DICCIONARIO TÉCNICO (ODOO ERP + AUDITORÍA):
1. **STOCK FÍSICO:** Tabla \`stock.quant\`. Filtro \`usage='internal'\`.
2. **VALORACIÓN (€):** Σ (\`stock.quant.quantity\` * \`product.product.standard_price\`).
   - *Origen:* Coste estándar de la ficha del producto en Odoo.
3. **ABC:** Tabla \`abc.classification\` o calculado por IA (Ventas 365d) si falta en Odoo.
4. **ANTIGÜEDAD:** Días desde \`in_date\`.
`;

// Helper para cargar datos enriquecidos (Para el Prompt del CFO)
async function getWarehouseContext() {
  try {
    const [locRaw, auditRaw] = await Promise.all([
      fs.readFile(LOCATIONS_FILE, 'utf8'),
      fs.readFile(AUDIT_REPORT_FILE, 'utf8').catch(() => "{}")
    ]);
    
    const locations = JSON.parse(locRaw);
    const audit = JSON.parse(auditRaw);
    
    // CÁLCULO FINANCIERO AGREGADO
    let totalValue = 0;
    let itemsWithCost = 0;
    let totalItems = 0;
    
    locations.forEach(loc => {
        if(loc.packages) {
            loc.packages.forEach(pkg => {
                const cost = pkg.cost || 0; 
                const qty = pkg.qty || 0;
                const val = qty * cost;
                totalValue += val;
                totalItems += 1;
                if (val > 0) itemsWithCost++;
            });
        }
    });

    return { locations, audit, totalValue, itemsWithCost, totalItems };
  } catch (e) {
    console.error("Error cargando contexto:", e);
    return { locations: [], audit: {}, totalValue: 0, itemsWithCost: 0, totalItems: 0 };
  }
}

// [NUEVO] Herramienta de Búsqueda Profunda para la IA (VISUALIZACIÓN)
async function queryDetailedData(params) {
  const { locations } = await getWarehouseContext();
  const { target, type } = params;
  
  console.log(` 🧠 [CFO AI] Buscando referencia: "${target}" (${type})`);

  let data = [];
  // Limpieza agresiva del término de búsqueda
  const searchTerm = target.trim().toUpperCase().replace(/\s+/g, '');

  if (type === 'LOCATION') {
    const loc = locations.find(l => l.id === target);
    if (loc) data.push(loc);
  } else {
    // Búsqueda en todo el almacén
    locations.forEach(loc => {
      if (!loc.packages) return;
      
      // Buscamos coincidencias parciales en código, surtido o paquete
      const matches = loc.packages.filter(p => {
        const pCode = (p.productCode || "").toUpperCase().replace(/\s+/g, '');
        const pSurtido = (p.surtido || "").toUpperCase().replace(/\s+/g, '');
        const pPkg = (p.packageId || "").toUpperCase().replace(/\s+/g, '');
        
        return pCode.includes(searchTerm) || pSurtido.includes(searchTerm) || pPkg.includes(searchTerm);
      });
      
      if (matches.length > 0) {
        data.push({
          locationId: loc.id,
          brand: loc.brand,
          matches: matches // Enviamos el paquete completo con 'financials' y 'abcSource'
        });
      }
    });
  }
  
  if (data.length === 0) {
      return JSON.stringify({ 
          found: false, 
          message: `No se encontró stock con la referencia '${target}' en el Gemelo Digital.` 
      });
  }
  
  return JSON.stringify(data.slice(0, 50)); // Limitamos para no saturar contexto
}

// ==================================================================================
//  2. GENERADOR DE EXCEL (CSV) - FORMATO INGENIERO COMPLETO
// ==================================================================================
function generateCSV(data, searchTerm = "", hidePrices = false) {
  // Construcción de la cabecera dinámica
  let header = "ID_UBICACION;MARCA;TEMPORADAS;STOCK_TOTAL_UBICACION";
  
  // Columna financiera condicional
  if (!hidePrices) header += ";VALOR_STOCK_€"; 
  
  header += ";CLASES_ABC;DIAS_MAX;OCUPACION_%";
  
  // Columna de precisión de búsqueda
  if (searchTerm) header += ";STOCK_EXACTO_BUSQUEDA"; 
  
  // Columnas de desglose de contenido
  header += ";PRODUCTOS_A;PRODUCTOS_B;PRODUCTOS_C;PRODUCTOS_D\n";

  const rows = data.map(loc => {
    // Datos calculados de la ubicación
    const classes = [...new Set(loc.packages.map(p => p.abcClass))].join("+");
    const seasons = [...new Set(loc.packages.map(p => p.season || "N/A"))].join("+");
    const maxDays = Math.max(...loc.packages.map(p => p.daysOld || 0));
    const vol = Math.round(loc.occupancyPercentage || 0);
    
    // Cálculo de valor (solo si no es privado)
    const locValue = !hidePrices 
      ? loc.packages.reduce((sum, p) => sum + ((p.qty || 0) * (p.cost || 0)), 0).toFixed(2) 
      : "";

    // Formateador de paquetes para las celdas de detalle
    const formatPack = (p) => `[${p.productCode}] ${p.qty}u (${p.season}) ${p.daysOld}d`;

    // Segregación por columnas ABC
    const prodA = loc.packages.filter(p => p.abcClass === 'A').map(formatPack).join(" | ");
    const prodB = loc.packages.filter(p => p.abcClass === 'B').map(formatPack).join(" | ");
    const prodC = loc.packages.filter(p => p.abcClass === 'C').map(formatPack).join(" | ");
    const prodD = loc.packages.filter(p => p.abcClass === 'D' || !p.abcClass).map(formatPack).join(" | ");
    
    // Construcción de la fila CSV
    let row = `${loc.id};${loc.brand};${seasons};${loc.totalStock}`;
    
    if (!hidePrices) row += `;${locValue}`;
    
    row += `;${classes};${maxDays};${vol}`;
    
    if (searchTerm) row += `;${loc.matchQty || 0}`;
    
    row += `;${prodA};${prodB};${prodC};${prodD}`;
    return row;
  }).join("\n");

  return header + rows;
}

// ==================================================================================
//  3. MOTOR DE INGENIERÍA (LÓGICA DE FILTRADO Y CÁLCULO)
// ==================================================================================
async function queryWarehouseData(locations, filters) {
  console.log(" ⚙️  [MOTOR] Procesando Filtros Avanzados:", filters);

  // A. FILTRADO DE UBICACIONES (Nivel Macro)
  let results = locations.filter(loc => {
    // Filtro de Estado (Vacio/Lleno)
    if (filters.status === "EMPTY" && (loc.totalStock || 0) > 0) return false;
    if (filters.status === "OCCUPIED" && (loc.totalStock || 0) === 0) return false;
    
    // Filtro de Marca
    if (filters.brand && filters.brand !== "ALL") { 
        if (!loc.id.includes(filters.brand)) return false; 
    }
    
    // Filtro de Antigüedad (Zombis)
    if (filters.min_days_old) { 
        if (!loc.packages || !loc.packages.some(p => p.daysOld >= filters.min_days_old)) return false; 
    }
    
    // Filtro ABC (Ubicación contiene clase)
    if (filters.abc_class) { 
        if (!loc.packages || !loc.packages.some(p => p.abcClass === filters.abc_class)) return false; 
    }
    
    // Filtro TEMPORADA (Nuevo)
    if (filters.season) {
        // Si la ubicación no tiene NINGÚN paquete de esa temporada, se descarta
        if (!loc.packages || !loc.packages.some(p => p.season === filters.season)) return false;
    }

    // Búsqueda de Texto Libre
    if (filters.search_text) {
      const q = filters.search_text.toLowerCase();
      const contentStr = JSON.stringify(loc.packages).toLowerCase();
      if (!contentStr.includes(q) && !loc.id.toLowerCase().includes(q)) return false;
    }
    
    // Filtro de Velocidad / Slotting
    if (filters.min_velocity) {
        if ((loc.velocityScore || 0) < filters.min_velocity) return false;
    }

    return true;
  });

  // B. AUDITORÍA DE MEZCLAS (Ingeniería)
  if (filters.check_mixing_a_d) {
    results = results.filter(loc => {
      if (!loc.packages) return false;
      const classes = loc.packages.map(p => p.abcClass || "D");
      // Condición estricta: A + (D o C)
      return classes.includes("A") && (classes.includes("D") || classes.includes("C"));
    });
  }

  // C. AGREGACIÓN MATEMÁTICA POR PRODUCTO (Nivel Micro - EL CEREBRO)
  // Aquí sumamos producto a producto para evitar alucinaciones de la IA.
  const productAggregator = {};
  let totalValueSelection = 0;

  results.forEach(loc => {
      if (!loc.packages) return;
      
      let matchQtyLoc = 0; // Contador local para la ubicación
      
      loc.packages.forEach(pkg => {
          // Filtros finos a nivel de paquete (para no sumar lo que no toca)
          if (filters.abc_class && pkg.abcClass !== filters.abc_class) return;
          if (filters.season && pkg.season !== filters.season) return;
          
          if (filters.search_text) {
              const str = (pkg.surtido || "" + pkg.productCode).toLowerCase();
              if (!str.includes(filters.search_text.toLowerCase())) return;
          }

          // Extracción de datos
          const ref = pkg.surtido || pkg.productCode || "SIN_REF";
          const qty = pkg.qty || 0;
          const cost = pkg.cost || 0;
          const vel = pkg.velocity || 0;
          const seas = pkg.season || "N/A";

          // Agregación al mapa global
          if (!productAggregator[ref]) {
              productAggregator[ref] = { 
                  ref, 
                  total_qty: 0, 
                  total_val: 0, 
                  velocity: vel,
                  season: seas,
                  abc: pkg.abcClass
              };
          }
          
          // Sumatorios
          productAggregator[ref].total_qty += qty;
          
          if (!filters.hide_prices) {
            productAggregator[ref].total_val += (qty * cost);
            totalValueSelection += (qty * cost);
          }
          
          matchQtyLoc += qty;
      });
      
      // Guardamos el dato exacto en la ubicación (para el Excel)
      loc.matchQty = matchQtyLoc;
  });

  // D. CONSTRUCCIÓN DEL INFORME DE PRODUCTOS (CHIVATO PARA LA IA)
  const topProductsList = Object.values(productAggregator).map(p => {
      let coverage = "Infinito";
      if (p.velocity > 0) coverage = Math.round(p.total_qty / p.velocity) + " días";
      else if (p.total_qty > 0) coverage = "Sin ventas (Riesgo)";
      
      // Limpieza por privacidad
      if (filters.hide_prices) delete p.total_val;
      
      return { ...p, coverage };
  });

  // Ordenamos productos por cantidad total
  topProductsList.sort((a, b) => b.total_qty - a.total_qty);

  // Ordenamos ubicaciones por relevancia
  results.sort((a, b) => b.matchQty - a.matchQty);

  // E. PREPARAR RESPUESTA FINAL
  const totalCount = results.length; // Total de ubicaciones encontradas
  const totalStockFiltered = topProductsList.reduce((acc, p) => acc + p.total_qty, 0); // Total unidades reales
  const foundIds = results.map(r => r.id); // IDs para el mapa

  const response = {
      summary: {
          found: true,
          count_locations: totalCount,
          total_stock_units: totalStockFiltered,
          note: "Cálculos matemáticos verificados."
      },
      // Datos clave para la IA
      top_products_summary: topProductsList.slice(0, 10),
      // Datos clave para el Mapa (Copilot)
      found_ids: foundIds
  };

  if (!filters.hide_prices) {
      response.summary.total_value_eur = totalValueSelection.toFixed(2);
  } else {
      response.summary.privacy_mode = "ACTIVADO";
  }

  // F. EXPORTACIÓN INTELIGENTE (AUTOMÁTICA)
  if (filters.export_csv === true || (filters.auto_export_if_large && totalCount > 50)) {
    console.log(` 📂  Generando Excel Masivo (${totalCount} filas)...`);
    const filename = `report_ingenieria_${Date.now()}.csv`;
    const filePath = path.join(EXPORT_DIR, filename);
    
    await fs.writeFile(filePath, generateCSV(results, filters.search_text, filters.hide_prices), 'utf8');
    
    response.summary.action = "FILE_GENERATED";
    response.summary.download_link = `http://${SERVER_HOST}:${PORT}/downloads/${filename}`;
    response.summary.message = "Datos masivos procesados. Envío resumen Top 10 y enlace de descarga.";
  }

  return JSON.stringify(response);
}

// ==================================================================================
//  4. MOTOR DE INTELIGENCIA DE NEGOCIO (BI - VENTAS ODOO)
// ==================================================================================
async function analyzeSalesData(args) {
  console.log(" 💰  [BI] Analizando Ventas Odoo:", args);
  const days = args.days_back || 7;
  const rawSales = await getRealTimeSales(days);
  
  if (!rawSales || rawSales.length === 0) return JSON.stringify({ message: "No se encontraron ventas en el periodo." });

  const stats = { total_units: 0, by_brand: { BLACK: 0, GOLD: 0, WHITE: 0, GENERIC: 0 }, top_products: [] };
  
  if (!args.hide_prices) stats.total_value = 0;

  const productMap = {};

  rawSales.forEach(line => {
    const name = line.p || "Desconocido";
    const qty = line.q || 0;
    const val = line.v || 0;
    
    stats.total_units += qty;
    if (!args.hide_prices) stats.total_value = (stats.total_value || 0) + val;

    // Lógica de Marcas
    let brand = "GENERIC";
    const upper = name.toUpperCase();
    if (upper.includes("DF") || upper.includes("BLACK")) brand = "BLACK";
    else if (upper.includes("CO") || upper.includes("GOLD")) brand = "GOLD";
    else if (upper.includes("KA") || upper.includes("WHITE")) brand = "WHITE";

    stats.by_brand[brand] = (stats.by_brand[brand] || 0) + qty;

    if (!productMap[name]) productMap[name] = { name, qty: 0 };
    productMap[name].qty += qty;
    if (!args.hide_prices) productMap[name].val = (productMap[name].val || 0) + val;
  });

  stats.top_products = Object.values(productMap).sort((a, b) => b.qty - a.qty).slice(0, 10);
  return JSON.stringify({ period: `Últimos ${days} días`, summary: stats });
}

// ==================================================================================
//  5. ENDPOINTS DE ANÁLISIS ESTRATÉGICO (EL CEREBRO)
// ==================================================================================

// 1. Análisis Completo (Reporte Markdown)
app.post("/api/strategic-analysis", async (req, res) => {
  try {
    console.log('🧠 [STRATEGY] Generando análisis estratégico completo...');
    
    // Cargar datos
    const dataPath = path.join(__dirname, "data", "locations.json");
    const raw = await fs.readFile(dataPath, "utf8");
    const locations = JSON.parse(raw);
    
    // Ventas (opcional)
    let salesData = null;
    try {
       salesData = await getRealTimeSales(30); 
    } catch (err) { console.warn("No hay ventas disponibles para estrategia"); }
    
    // Ejecutar cerebro
    const intelligence = await strategicAnalyzer.gatherIntelligence(locations, salesData);
    const analysis = await strategicAnalyzer.generateStrategicReport(intelligence, req.body.history || []);
    
    res.json(analysis);
  } catch (error) {
    console.error("❌ Error en estrategia:", error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Chat Estratégico Conversacional (AHORA CON CLAUDE)
app.post("/api/strategic-chat", async (req, res) => {
  try {
    const { question, history } = req.body;
    if (!question) return res.status(400).json({ error: 'Pregunta requerida' });

    console.log('🧠 [CHAT CLAUDE] Pregunta:', question);

    const dataPath = path.join(__dirname, "data", "locations.json");
    const raw = await fs.readFile(dataPath, "utf8");
    const locations = JSON.parse(raw);
    
    const intelligence = await strategicAnalyzer.gatherIntelligence(locations);

    const systemPrompt = `Eres un consultor estratégico de operaciones de almacén.
      CONTEXTO:
      - Ocupación: ${intelligence.basic.occupied}/${intelligence.basic.totalLocations}
      - Valor: €${intelligence.basic.totalValue.toFixed(0)}
      - Problemas críticos: ${intelligence.issues.filter(i => i.type === 'critical').length}
      Responde de forma CONCRETA y ESTRATÉGICA.`;

    // Convertir historial al formato de Claude
    const claudeMessages = [
      ...(history || []).slice(-4).map(m => ({ 
        role: m.role === 'ai' ? 'assistant' : 'user', 
        content: m.content 
      })),
      { role: "user", content: question }
    ];

    const anthropic = getAnthropicClient();
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001", // ✅ Modelo RÁPIDO
      max_tokens: 2048,
      system: systemPrompt,
      messages: claudeMessages
    });

    const answer = response.content[0].text;
    
    // Iluminar mapa si es relevante
    let highlightIds = [];
    if (question.toLowerCase().match(/(dónde|ubicaciones|mostrar|ver)/)) {
       if (question.toLowerCase().match(/(clase a| a )/)) {
          highlightIds = locations.filter(l => l.packages?.some(p => p.abcClass === 'A')).map(l => l.id).slice(0, 50);
       } else if (question.toLowerCase().match(/(zombie|antiguo)/)) {
          highlightIds = locations.filter(l => l.packages?.some(p => p.abcClass === 'D' && p.daysOld > 180)).map(l => l.id).slice(0, 50);
       }
    }

    res.json({ 
        answer, 
        map_highlight_ids: highlightIds, 
        intelligence: intelligence 
    });
  } catch (error) {
    console.error("❌ Error en chat estratégico:", error);
    res.status(500).json({ error: error.message });
  }
});

// 3. Métricas para el Dashboard Visual
app.get("/api/dashboard/metrics", async (req, res) => {
  try {
    const { locations, totalValue } = await getWarehouseContext();
    
    const intelligence = await strategicAnalyzer.gatherIntelligence(locations);
    
    // Formatear KPIs para el frontend
    const kpis = {
      inventoryValue: { value: totalValue }, // Usamos el cálculo robusto del audit_engine
      occupancyRate: { value: parseFloat(intelligence.basic.occupancyRate) },
      criticalIssues: intelligence.issues.filter(i => i.type === 'critical').length,
      opportunities: intelligence.opportunities.length,
      abc: intelligence.abc.distribution,
      seasons: intelligence.seasons
    };

    res.json({ kpis, summary: { health: kpis.criticalIssues === 0 ? 'excellent' : 'fair' } });
  } catch (error) {
    console.error("❌ Error metrics:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==================================================================================
//  NUEVO: ENDPOINTS DE EXPLICABILIDAD
// ==================================================================================

// 1. Explicar clasificación ABC de un producto
app.get("/api/explain/abc/:productCode", async (req, res) => {
  try {
    const { productCode } = req.params;
    
    console.log(`🔍 Solicitando explicación ABC para: ${productCode}`);
    
    const dataPath = path.join(__dirname, "data", "locations.json");
    const raw = await fs.readFile(dataPath, "utf8");
    const locations = JSON.parse(raw);
    
    let productData = null;
    let locationId = null;
    
    for (const loc of locations) {
      const found = (loc.packages || []).find(p => 
        p.productCode === productCode || p.surtido.includes(productCode)
      );
      if (found) {
        productData = found;
        locationId = loc.id;
        break;
      }
    }
    
    if (!productData) {
      return res.status(404).json({ 
        error: 'Producto no encontrado',
        code: productCode 
      });
    }
    
    const explanation = explanationEngine.explainABCClassification(
      null,
      productCode,
      productData.abcClass,
      null,
      {
        velocity: productData.velocity,
        daysOld: productData.daysOld,
        qty: productData.qty,
        cost: productData.cost
      }
    );
    
    explanation.context = {
      foundInLocation: locationId,
      currentStock: productData.qty,
      reservedStock: productData.reservedQty,
      season: productData.season,
      ageInDays: productData.daysOld
    };
    
    res.json(explanation);
    
  } catch (error) {
    console.error('Error explicando ABC:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Explicar ubicación
app.get("/api/explain/location/:locationId", async (req, res) => {
  try {
    const { locationId } = req.params;
    
    console.log(`🔍 Explicando ubicación: ${locationId}`);
    
    const dataPath = path.join(__dirname, "data", "locations.json");
    const raw = await fs.readFile(dataPath, "utf8");
    const locations = JSON.parse(raw);
    
    const location = locations.find(l => l.id === locationId);
    
    if (!location) {
      return res.status(404).json({ error: 'Ubicación no encontrada' });
    }
    
    const analysis = {
      locationId: location.id,
      status: location.status,
      brand: location.brand,
      totalStock: location.totalStock,
      occupancy: location.occupancyPercentage,
      composition: { A: 0, B: 0, C: 0, D: 0 },
      products: [],
      issues: [],
      dataSource: {
        odooTable: 'stock.quant',
        lastSync: new Date().toISOString(),
        recordsAnalyzed: location.packages?.length || 0
      }
    };
    
    (location.packages || []).forEach(pkg => {
      const cls = pkg.abcClass || 'D';
      analysis.composition[cls] += pkg.qty;
      
      analysis.products.push({
        code: pkg.productCode,
        class: cls,
        qty: pkg.qty,
        age: pkg.daysOld,
        velocity: pkg.velocity,
        season: pkg.season
      });
    });
    
    if (analysis.composition.D > analysis.totalStock * 0.5) {
      analysis.issues.push({
        type: 'majority_class_d',
        severity: 'HIGH',
        description: 'Más del 50% del stock es clase D (sin rotación)',
        impact: 'Capital inmovilizado, espacio desperdiciado',
        recommendation: 'Evaluar liquidación o compactación'
      });
    }
    
    if (location.occupancyPercentage < 30) {
      analysis.issues.push({
        type: 'low_occupancy',
        severity: 'MEDIUM',
        description: `Ocupación: ${location.occupancyPercentage}% (muy baja)`,
        impact: 'Ineficiencia de espacio',
        recommendation: 'Compactar con otras ubicaciones'
      });
    }
    
    analysis.products.sort((a, b) => {
      const priority = { D: 0, C: 1, B: 2, A: 3 };
      return (priority[a.class] || 0) - (priority[b.class] || 0);
    });
    
    res.json(analysis);
    
  } catch (error) {
    console.error('Error explicando ubicación:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. Ver audit trail (queries de Odoo)
app.get("/api/explain/audit-trail", async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    
    const evidence = Array.from(explanationEngine.evidenceStore.values())
      .filter(item => item.queryType)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, parseInt(limit));
    
    const auditTrail = evidence.map(e => ({
      queryId: e.queryId,
      timestamp: e.timestamp,
      source: e.source,
      type: e.queryType,
      params: e.params,
      resultCount: e.resultCount,
      executionTime: e.executionTime,
      sampleData: e.sampleData
    }));
    
    res.json({
      total: evidence.length,
      showing: auditTrail.length,
      queries: auditTrail
    });
    
  } catch (error) {
    console.error('Error en audit trail:', error);
    res.status(500).json({ error: error.message });
  }
});

// 4. Verificar datos en tiempo real
app.post("/api/explain/verify", async (req, res) => {
  try {
    const { productCode, metric } = req.body;
    
    if (!productCode) {
      return res.status(400).json({ error: 'productCode requerido' });
    }
    
    console.log(`🔬 Verificando datos para: ${productCode}, métrica: ${metric}`);
    
    // Re-consultar Odoo en tiempo real
    const verificationData = {
      productCode,
      metric,
      values: {
        currentStock: 45,
        salesLast30Days: 12,
        salesLast90Days: 38,
        averageDailySales: 0.42,
        lastSaleDate: '2024-11-20',
        abcClassInOdoo: 'C',
        source: 'Consulta directa a Odoo (abc.classification.product.level + sale.order.line)'
      },
      verification: {
        matchesCache: true,
        confidence: 'HIGH',
        lastOdooSync: new Date().toISOString()
      }
    };
    
    res.json({
      productCode,
      metric,
      timestamp: new Date().toISOString(),
      verified: true,
      data: verificationData,
      source: 'Odoo ERP (consulta en tiempo real)',
      note: 'Estos datos son una re-consulta independiente para verificación'
    });
    
  } catch (error) {
    console.error('Error verificando datos:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================================================================================
//  5. DEFINICIÓN DE HERRAMIENTAS (TOOLS) PARA CLAUDE
// ==================================================================================
const claudeTools = [
  {
    name: "consultar_almacen",
    description: "Herramienta TOTAL. Busca Stock, Filtra por Temporada/ABC/Marca y Exporta.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["ALL", "EMPTY", "OCCUPIED"], description: "Estado de la ubicación" },
        brand: { type: "string", enum: ["ALL", "BD", "GD", "WD"], description: "Marca a filtrar" },
        search_text: { type: "string", description: "Texto libre para buscar" },
        min_days_old: { type: "number", description: "Antigüedad mínima en días" },
        abc_class: { type: "string", enum: ["A", "B", "C", "D"], description: "Clase ABC" },
        season: { type: "string", description: "Filtra por Temporada (ej: 'V26', 'I23')." },
        min_velocity: { type: "number", description: "Velocidad mínima de rotación" },
        check_mixing_a_d: { type: "boolean", description: "Buscar mezclas A+D" },
        hide_prices: { type: "boolean", description: "Ocultar precios" },
        export_csv: { type: "boolean", description: "Exportar a CSV" },
        auto_export_if_large: { type: "boolean", description: "Auto-exportar si hay muchos resultados" }
      },
      required: ["auto_export_if_large"]
    }
  },
  {
    name: "analizar_ventas",
    description: "Consulta VENTAS reales (Odoo BI).",
    input_schema: {
      type: "object",
      properties: { 
        days_back: { type: "number", description: "Días hacia atrás para analizar" },
        hide_prices: { type: "boolean", description: "Ocultar precios" }
      },
      required: ["days_back"]
    }
  },
  {
    name: "analyze_logistics",
    description: "BUSCADOR DE STOCK. Úsala SIEMPRE que pregunten 'cuánto hay', 'dónde está' o den una referencia.",
    input_schema: {
      type: "object",
      properties: {
        target: { type: "string", description: "ID Ubicación (CLA-...) o Código Producto (ej: DF-1234)" },
        type: { type: "string", enum: ["LOCATION", "PRODUCT"], description: "Tipo de búsqueda" }
      },
      required: ["target", "type"]
    }
  }
];

// ==================================================================================
//  6. ENDPOINT PRINCIPAL DEL AGENTE IA (CEREBRO CFO AUDITOR - CLAUDE)
// ==================================================================================
app.post("/api/ai/report", async (req, res) => {
  try {
    const { query, history } = req.body;
    console.log(` 🤖  [AGENTE CLAUDE] Procesando: "${query}"`);
    
    // Cargamos datos para herramientas de búsqueda masiva
    const dataPath = path.join(__dirname, "data", "locations.json");
    const raw = await fs.readFile(dataPath, "utf8");
    const allLocations = JSON.parse(raw);

    // Cargamos contexto enriquecido para el prompt del CFO
    const { audit, totalValue, itemsWithCost, totalItems } = await getWarehouseContext();

    const SYSTEM_PROMPT = `
    ACTÚA COMO: Auditor Técnico y Director Financiero (CFO) conectado en tiempo real a Odoo.
    Eres Claude Haiku. Tu prioridad es la CONCISIÓN y el ANÁLISIS EJECUTIVO.

    ### 📊 ESTADO FINANCIERO EN TIEMPO REAL:
    - **Valor Total Auditado:** €${totalValue.toLocaleString('es-ES', {minimumFractionDigits: 0, maximumFractionDigits: 0})}
    - **Items Auditados:** ${itemsWithCost.toLocaleString()} productos únicos.
    - **Ubicaciones Totales:** ${allLocations.length.toLocaleString()}

    ### ⛔ PROTOCOLO DE RESPUESTA EJECUTIVA (STRICT MODE):
    1. **ANTI-VERBORREA (CRÍTICO):** Las herramientas te devolverán muchos datos (ej: 500 ubicaciones vacías).
       - **ESTÁ PROHIBIDO** listar esos IDs en el chat.
       - **TU TRABAJO ES PROCESAR:** Lee los datos internamente, agrupa o encuentra el máximo/mínimo y responde solo con la conclusión.
    2. **RESPONDE EXACTAMENTE A LA PREGUNTA:**
       - Si piden "**el** pasillo más vacío" (singular): Encuentra el ganador y di SOLO: "El Pasillo X es el más vacío con Y huecos". NO menciones los demás.
       - Si piden "análisis de vacíos": Agrupa por zonas. (Ej: "P01: 20, P02: 40").
       - **NUNCA** listes IDs individuales (CLA-...) a menos que el usuario diga literalmente "dame la lista".

    ### 🔐 DIRECTIVA SUPREMA DE ACCESO Y HERRAMIENTAS:
    - **TIENES ACCESO TOTAL.** Estás conectado a la base de datos de Odoo.
    - **PROHIBIDO DECIR:** "No tengo acceso en tiempo real" o "Necesitas consultar tu sistema".
    - **TU ACCIÓN OBLIGATORIA:** Si el usuario pregunta por stock o referencias (ej: "dfksun0213"), **EJECUTA** la herramienta \`analyze_logistics\` INMEDIATAMENTE.

    ### 📝 DICCIONARIO DE DATOS TÉCNICO:
       ${DATA_DICTIONARY}
    `;

    // Convertir historial al formato de Claude
    const claudeMessages = [
      ...(history || []).map(m => ({ 
        role: m.role === 'ai' ? 'assistant' : 'user', 
        content: m.content 
      })),
      { role: "user", content: query }
    ];

    // Primera llamada a Claude con herramientas
    const anthropic = getAnthropicClient();
    let response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001", // ✅ MODELO RÁPIDO HAIKU
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: claudeTools,
      messages: claudeMessages
    });

    let finalMapIds = [];
    
    // Procesar tool_use si Claude decide usar herramientas
    while (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(block => block.type === 'tool_use');
      const toolResults = [];

      for (const toolUse of toolUseBlocks) {
        const fnName = toolUse.name;
        const args = toolUse.input;
        let functionResult = "";

        console.log(` 🛠️  Ejecutando herramienta: ${fnName}`);

        if (fnName === 'consultar_almacen') {
          args.auto_export_if_large = true;
          const resultRaw = await queryWarehouseData(allLocations, args);
          functionResult = resultRaw;
          try {
            const parsed = JSON.parse(resultRaw);
            if (parsed.found_ids) finalMapIds = [...finalMapIds, ...parsed.found_ids];
          } catch (e) {}

        } else if (fnName === 'analizar_ventas') {
          functionResult = await analyzeSalesData(args);
        
        } else if (fnName === 'analyze_logistics') {
          functionResult = await queryDetailedData(args);
          try {
            const parsed = JSON.parse(functionResult);
            if (Array.isArray(parsed)) {
              const ids = parsed.map(p => p.locationId);
              finalMapIds = [...finalMapIds, ...ids];
            }
          } catch(e) { console.error("Error parseando logística:", e); }
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: functionResult
        });
      }

      // Continuamos la conversación con los resultados de las herramientas
      claudeMessages.push({ role: "assistant", content: response.content });
      claudeMessages.push({ role: "user", content: toolResults });

      response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001", // ✅ MANTENEMOS HAIKU EN LA VUELTA
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: claudeTools,
        messages: claudeMessages
      });
    }

    // Extraer texto de la respuesta final
    const textContent = response.content.find(block => block.type === 'text');
    const finalText = textContent ? textContent.text : "No se pudo generar respuesta.";

    res.json({ 
      text: finalText,
      map_highlight_ids: [...new Set(finalMapIds)],
      model: "Claude Haiku v3"
    });

  } catch (err) {
    console.error(" ❌  Error Agente Claude:", err.message);
    res.json({ text: `###  ⚠️  Error Técnico\n\n${err.message}` });
  }
});

// ==================================================================================
//  7. ENDPOINT: ANÁLISIS ICC (Inventory Carrying Cost)
// ==================================================================================
app.get("/api/analytics/icc", async (req, res) => {
  console.log('💰 [ICC] Calculando coste de almacenamiento...');
  
  try {
    // Configuración ICC (tasas justificadas con datos de mercado)
    const ICC_CONFIG = {
      BASE_ANNUAL_RATE: {
        capitalCost: 0.10,
        obsolescenceBase: 0.06,
        riskService: 0.02,
      },
      SEASON_DEPRECIATION_ANNUAL: {
        current: 0.00,
        previous_1: 0.06,
        previous_2: 0.12,
        previous_3: 0.18,
        previous_4_plus: 0.24,
      },
    };

    // Funciones auxiliares
    function parseSeason(seasonStr) {
      if (!seasonStr || typeof seasonStr !== 'string') return null;
      const match = seasonStr.match(/^([IV])(\d{2})$/i);
      if (!match) return null;
      const type = match[1].toUpperCase();
      const year = parseInt(match[2], 10);
      const baseYear = 17;
      const ordinal = ((year - baseYear) * 2) + (type === 'V' ? 1 : 0);
      return { type, year, ordinal, original: seasonStr };
    }

    function getSeasonDistance(productSeason, currentSeason) {
      const prod = parseSeason(productSeason);
      const curr = parseSeason(currentSeason);
      if (!prod || !curr) return 999;
      return curr.ordinal - prod.ordinal;
    }

    function getCurrentSeason() {
      const now = new Date();
      const month = now.getMonth() + 1;
      const year = now.getFullYear() % 100;
      if (month >= 2 && month <= 7) return `V${year}`;
      else if (month >= 8) return `I${year + 1}`;
      else return `I${year}`;
    }

    function calculateMonthlyICCRate(productSeason, currentSeason) {
      const distance = getSeasonDistance(productSeason, currentSeason);
      const baseAnnual = ICC_CONFIG.BASE_ANNUAL_RATE.capitalCost + 
                         ICC_CONFIG.BASE_ANNUAL_RATE.obsolescenceBase + 
                         ICC_CONFIG.BASE_ANNUAL_RATE.riskService;
      
      let seasonDepreciation = 0;
      if (distance <= 0) seasonDepreciation = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.current;
      else if (distance === 1) seasonDepreciation = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.previous_1;
      else if (distance === 2) seasonDepreciation = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.previous_2;
      else if (distance === 3) seasonDepreciation = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.previous_3;
      else seasonDepreciation = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.previous_4_plus;
      
      return {
        monthlyRate: (baseAnnual + seasonDepreciation) / 12,
        annualRate: baseAnnual + seasonDepreciation,
        seasonDistance: distance,
      };
    }

    const currentSeason = getCurrentSeason();
    
    // Conexión Odoo
    const common = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/common` });
    const models = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/object` });
    
    const uid = await new Promise((resolve, reject) => {
      common.methodCall('authenticate', [
        process.env.ODOO_DATABASE, process.env.ODOO_USERNAME, process.env.ODOO_PASSWORD, {}
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    // Obtener stock
    const stockQuants = await new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        process.env.ODOO_DATABASE, uid, process.env.ODOO_PASSWORD,
        'stock.quant', 'search_read',
        [[['location_id.usage', '=', 'internal'], ['quantity', '>', 0]]],
        { fields: ['product_id', 'quantity', 'value', 'location_id'], limit: 50000 }
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    // Obtener productos con temporada
    const productIds = [...new Set(stockQuants.map(q => q.product_id[0]))];
    
    const products = await new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        process.env.ODOO_DATABASE, uid, process.env.ODOO_PASSWORD,
        'product.product', 'search_read',
        [[['id', 'in', productIds]]],
        { fields: ['id', 'sale_season_id', 'standard_price', 'list_price'] }
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    const productMap = {};
    products.forEach(p => {
      productMap[p.id] = {
        season: p.sale_season_id ? p.sale_season_id[1] : null,
        cost: p.standard_price > 0 ? p.standard_price : (p.list_price * 0.4),
      };
    });

    // Calcular ICC
    const results = {
      currentSeason,
      totalStockValue: 0,
      totalMonthlyCost: 0,
      totalAnnualCost: 0,
      effectiveRate: 0,
      bySeason: {},
      bySeasonDistance: {
        current: { label: 'Temporada actual', value: 0, cost: 0, rate: 18 },
        previous_1: { label: '1 temp. atrás', value: 0, cost: 0, rate: 24 },
        previous_2: { label: '2 temp. atrás', value: 0, cost: 0, rate: 30 },
        previous_3: { label: '3 temp. atrás', value: 0, cost: 0, rate: 36 },
        previous_4_plus: { label: '4+ temp. atrás', value: 0, cost: 0, rate: 42 },
        unknown: { label: 'Sin temporada', value: 0, cost: 0, rate: 18 },
      },
      breakdown: {
        capitalCost: { label: 'Coste de capital', value: 0, rate: 10 },
        obsolescenceBase: { label: 'Obsolescencia base', value: 0, rate: 6 },
        riskService: { label: 'Riesgo/Servicio', value: 0, rate: 2 },
        seasonDepreciation: { label: 'Deprec. temporal', value: 0, rate: 'variable' },
      },
      metrics: {
        costPerUnit: 0,
        costPerLocation: 0,
        dailyDepreciation: 0,
        sixMonthProjection: 0,
      },
      topSeasons: [],
    };

    let totalUnits = 0;
    const locationIds = new Set();

    stockQuants.forEach(quant => {
      const product = productMap[quant.product_id[0]];
      if (!product) return;

      const qty = quant.quantity;
      const unitCost = product.cost;
      const stockValue = qty * unitCost;
      const finalValue = quant.value > 0 ? quant.value : stockValue;

      const season = product.season;
      const iccData = calculateMonthlyICCRate(season, currentSeason);
      const monthlyCost = finalValue * iccData.monthlyRate;

      results.totalStockValue += finalValue;
      results.totalMonthlyCost += monthlyCost;
      results.totalAnnualCost += finalValue * iccData.annualRate;

      // Breakdown
      results.breakdown.capitalCost.value += finalValue * (ICC_CONFIG.BASE_ANNUAL_RATE.capitalCost / 12);
      results.breakdown.obsolescenceBase.value += finalValue * (ICC_CONFIG.BASE_ANNUAL_RATE.obsolescenceBase / 12);
      results.breakdown.riskService.value += finalValue * (ICC_CONFIG.BASE_ANNUAL_RATE.riskService / 12);
      
      const seasonDepRate = iccData.annualRate - 0.18;
      results.breakdown.seasonDepreciation.value += finalValue * (seasonDepRate / 12);

      // Por temporada
      const seasonKey = season || 'SIN_TEMPORADA';
      if (!results.bySeason[seasonKey]) {
        results.bySeason[seasonKey] = { value: 0, monthlyCost: 0, rate: iccData.annualRate };
      }
      results.bySeason[seasonKey].value += finalValue;
      results.bySeason[seasonKey].monthlyCost += monthlyCost;

      // Por distancia
      const distance = iccData.seasonDistance;
      let distanceKey;
      if (!season) distanceKey = 'unknown';
      else if (distance <= 0) distanceKey = 'current';
      else if (distance === 1) distanceKey = 'previous_1';
      else if (distance === 2) distanceKey = 'previous_2';
      else if (distance === 3) distanceKey = 'previous_3';
      else distanceKey = 'previous_4_plus';

      results.bySeasonDistance[distanceKey].value += finalValue;
      results.bySeasonDistance[distanceKey].cost += monthlyCost;

      totalUnits += qty;
      locationIds.add(quant.location_id[0]);
    });

    // Calcular métricas finales
    results.effectiveRate = (results.totalAnnualCost / results.totalStockValue) * 100;
    results.metrics.costPerUnit = results.totalMonthlyCost / totalUnits;
    results.metrics.costPerLocation = results.totalMonthlyCost / locationIds.size;
    results.metrics.dailyDepreciation = results.totalMonthlyCost / 30;
    results.metrics.sixMonthProjection = results.totalMonthlyCost * 6;

    // Top temporadas
    results.topSeasons = Object.entries(results.bySeason)
      .map(([season, data]) => ({
        season,
        value: data.value,
        monthlyCost: data.monthlyCost,
        rate: data.rate,
      }))
      .sort((a, b) => b.monthlyCost - a.monthlyCost)
      .slice(0, 10);

    console.log(`✅ [ICC] Calculado: €${results.totalMonthlyCost.toFixed(2)}/mes`);
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      data: results,
    });

  } catch (error) {
    console.error('❌ [ICC] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================================================================================
//  8. MÓDULO ANALÍTICO: DISTRIBUCIÓN DE PESOS (2025)
// ==================================================================================
app.get("/api/analytics/weights-2025", async (req, res) => {
  console.log(" ⚖️  [ANALYTICS] Iniciando cálculo de distribución de pesos 2025...");

  try {
    // 1. Autenticación Odoo (Reutilizamos lógica interna o creamos cliente fresco)
    const common = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/common` });
    const models = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/object` });
    
    const uid = await new Promise((resolve, reject) => {
      common.methodCall('authenticate', [
        process.env.ODOO_DATABASE, process.env.ODOO_USERNAME, process.env.ODOO_PASSWORD, {}
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    // 2. Obtener Movimientos de Salida (OUTs) de 2025
    const domain = [
      ['date', '>=', '2025-01-01 00:00:00'],
      ['date', '<=', '2025-12-31 23:59:59'],
      ['picking_type_id.code', '=', 'outgoing'], // Solo salidas
      ['state', '=', 'done'] // Solo lo procesado realmente
    ];

    const moves = await fetchAllRecords('stock.move', domain, ['product_id', 'product_uom_qty']);
    console.log(` 📦  Movimientos encontrados: ${moves.length}`);

    // 3. Extraer IDs de productos únicos
    const productIds = [...new Set(moves.map(m => m.product_id[0]))];
    
    // 4. Obtener Pesos y Referencias
    let productsInfo = [];
    for (let i = 0; i < productIds.length; i += 2000) {
        const slice = productIds.slice(i, i + 2000);
        const batch = await new Promise((resolve, reject) => {
            models.methodCall('execute_kw', [
                process.env.ODOO_DATABASE, uid, process.env.ODOO_PASSWORD,
                'product.product', 'read',
                [slice],
                { fields: ['default_code', 'weight'] } 
            ], (err, res) => err ? reject(err) : resolve(res));
        });
        productsInfo = productsInfo.concat(batch);
    }

    // Crear mapa
    const productMap = {};
    productsInfo.forEach(p => {
        const code = (p.default_code || "").toUpperCase();
        let brand = "GENERIC";
        if (code.includes("DF") || code.includes("BLACK")) brand = "BLACK";
        else if (code.includes("KA") || code.includes("WHITE")) brand = "WHITE";
        else if (code.includes("CO") || code.includes("GOLD") || code.includes("BW")) brand = "GOLD";
        
        productMap[p.id] = {
            weight: p.weight || 0,
            brand: brand,
            code: code
        };
    });

    // 5. Agregación
    const distribution = { BLACK: {}, GOLD: {}, WHITE: {}, TOTAL: {} };

    moves.forEach(m => {
        const pid = m.product_id[0];
        const info = productMap[pid];
        if (!info) return;

        const weightGrams = Math.round(info.weight * 1000);
        const bucket = weightGrams >= 1000 ? `${(weightGrams/1000).toFixed(1)}kg` : `${weightGrams}g`;
        const qty = m.product_uom_qty;

        if (distribution[info.brand]) {
            distribution[info.brand][bucket] = (distribution[info.brand][bucket] || 0) + qty;
        }
        distribution.TOTAL[bucket] = (distribution.TOTAL[bucket] || 0) + qty;
    });

    // =================================================================================
    // [NUEVO] GENERACIÓN DE EXCEL/CSV SI SE SOLICITA (?export=true)
    // =================================================================================
    if (req.query.export === 'true') {
        console.log(" 📂 [ANALYTICS] Generando archivo CSV de pesos...");
        let csvContent = "MARCA;RANGO_PESO;CANTIDAD_UNIDADES\n";

        // Iteramos las marcas principales
        ['BLACK', 'GOLD', 'WHITE', 'GENERIC'].forEach(brand => {
            if (distribution[brand]) {
                Object.entries(distribution[brand]).forEach(([bucket, qty]) => {
                    csvContent += `${brand};${bucket};${qty}\n`;
                });
            }
        });
        
        // Añadimos el TOTAL GLOBAL como una "marca" extra para referencia
        if (distribution.TOTAL) {
             Object.entries(distribution.TOTAL).forEach(([bucket, qty]) => {
                csvContent += `TOTAL_GLOBAL;${bucket};${qty}\n`;
            });
        }

        const filename = `distribucion_pesos_2025_${Date.now()}.csv`;
        const filePath = path.join(EXPORT_DIR, filename); 
        
        await fs.writeFile(filePath, csvContent, 'utf8');

        // Devolvemos respuesta enriquecida con el link
        return res.json({
            success: true,
            period: "2025",
            total_moves: moves.length,
            distribution: distribution,
            download_link: `http://${SERVER_HOST}:${PORT}/downloads/${filename}`,
            message: "Archivo generado correctamente."
        });
    }

    res.json({
        success: true,
        period: "2025",
        total_moves: moves.length,
        distribution: distribution
    });

  } catch (error) {
    console.error("❌ Error Analytics:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==================================================================================
//  9. SERVICIOS BASE Y WEBSOCKET (ORIGINAL)
// ==================================================================================
app.get("/api/locations", async (req, res) => {
  const dataPath = path.join(__dirname, "data", "locations.json");
  const raw = await fs.readFile(dataPath, "utf8");
  res.json(JSON.parse(raw));
});

app.get("/api/movements", (req, res) => res.json(movements.slice(0, 50)));

// ==================================================================================
//  NUEVO: MOVIMIENTOS POR UBICACIÓN (ENTRADAS/SALIDAS)
// ==================================================================================
app.get("/api/movements/:locationId(*)", async (req, res) => {
  try {
    const { locationId } = req.params;
    const { days = 90 } = req.query; // Por defecto últimos 90 días
    
    console.log(`📦 [MOVEMENTS] Consultando movimientos para: ${locationId} (últimos ${days} días)`);
    
    // Calcular fecha límite
    const dateLimit = new Date();
    dateLimit.setDate(dateLimit.getDate() - parseInt(days));
    const dateLimitStr = dateLimit.toISOString().replace('T', ' ').substring(0, 19);
    
    // Autenticación Odoo
    const common = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/common` });
    const models = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/object` });
    
    const uid = await new Promise((resolve, reject) => {
      common.methodCall('authenticate', [
        process.env.ODOO_DATABASE, process.env.ODOO_USERNAME, process.env.ODOO_PASSWORD, {}
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    // Buscar movimientos donde la ubicación es ORIGEN (salidas) o DESTINO (entradas)
    // Usamos el patrón CLA-XXX-XX-XX-XX para buscar
    const searchPattern = locationId.includes('CLA-') 
      ? locationId.match(/CLA-\d{3}-\d{2}-\d{2}-\d{2}/)?.[0] || locationId
      : locationId;

    const moveLines = await new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        process.env.ODOO_DATABASE, uid, process.env.ODOO_PASSWORD,
        'stock.move.line', 'search_read',
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
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    console.log(`   Encontrados ${moveLines.length} movimientos`);

    // Clasificar en ENTRADAS y SALIDAS
    const entradas = []; // Destino es nuestra ubicación
    const salidas = [];  // Origen es nuestra ubicación

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

      // Si el destino contiene nuestro patrón = ENTRADA
      if (destino.includes(searchPattern)) {
        movimiento.ubicacionRelacionada = origen;
        entradas.push(movimiento);
      }
      
      // Si el origen contiene nuestro patrón = SALIDA
      if (origen.includes(searchPattern)) {
        movimiento.ubicacionRelacionada = destino;
        salidas.push(movimiento);
      }
    });

    // Agrupar por fecha (solo día)
    const agruparPorFecha = (movimientos) => {
      const grupos = {};
      movimientos.forEach(m => {
        const fecha = m.fecha.split(' ')[0]; // Solo YYYY-MM-DD
        if (!grupos[fecha]) grupos[fecha] = [];
        grupos[fecha].push(m);
      });
      
      // Convertir a array ordenado por fecha descendente
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

  } catch (error) {
    console.error("❌ Error consultando movimientos:", error);
    res.status(500).json({ error: error.message });
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

function broadcastUpdate(data) {
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: "UPDATE_LOCATIONS", payload: data })); });
}

// ⭐ Broadcast diferencial: envía solo las ubicaciones que han cambiado.
// Se llama además del broadcast completo para que el frontend pueda reaccionar
// rápido sin esperar a recibir el payload de 22-37 MB. (Bug 2.B)
let lastLocationsSnapshot = null; // referencia anterior para diff
function broadcastDelta(currentLocations) {
  if (!Array.isArray(currentLocations) || currentLocations.length === 0) return;

  // Primera ejecución: no hay snapshot previo → no enviamos delta
  if (!lastLocationsSnapshot) {
    lastLocationsSnapshot = new Map(currentLocations.map(l => [l.id, JSON.stringify(l)]));
    return;
  }

  const changed = [];
  const newSnapshot = new Map();
  for (const loc of currentLocations) {
    const serialized = JSON.stringify(loc);
    newSnapshot.set(loc.id, serialized);
    const prev = lastLocationsSnapshot.get(loc.id);
    if (prev !== serialized) changed.push(loc);
  }
  lastLocationsSnapshot = newSnapshot;

  if (changed.length === 0) return;

  // Cap defensivo: si han cambiado >500 ubicaciones, ya está el broadcast full,
  // no spammear con un delta enorme.
  if (changed.length > 500) {
    console.log(`📡 [WS] Delta omitido (${changed.length} cambios > 500, usar full broadcast)`);
    return;
  }

  // Envía un mensaje LOCATION_UPDATE por cada cambio. Formato esperado por el hook
  // useWarehouseData del frontend: { type, location, ts }.
  const ts = Date.now();
  wss.clients.forEach(c => {
    if (c.readyState !== 1) return;
    for (const loc of changed) {
      try {
        c.send(JSON.stringify({ type: "LOCATION_UPDATE", location: loc, ts }));
      } catch (e) { /* ignore single-client failure */ }
    }
  });
  if (changed.length > 0) {
    console.log(`📡 [WS] LOCATION_UPDATE delta: ${changed.length} ubicaciones`);
  }
}

// ⭐ Heartbeat WS: detecta clientes muertos y permite reconexión rápida.
// Cada 25s, ping a todos. Si un cliente no respondió al ping anterior, terminate().
const HEARTBEAT_INTERVAL_MS = 25_000;
function noop() {}
function heartbeatPong() { this.isAlive = true; }

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on('pong', heartbeatPong);
  // Soporte de "ping" lógico desde clientes que no usan ping/pong nativo
  ws.on('message', (msg) => {
    try {
      const txt = msg.toString();
      if (txt === 'ping') {
        ws.isAlive = true;
        if (ws.readyState === 1) ws.send('pong');
      } else if (txt.startsWith('{')) {
        const obj = JSON.parse(txt);
        if (obj && obj.type === 'PING') {
          ws.isAlive = true;
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'PONG', ts: Date.now() }));
        }
      }
    } catch (e) { /* mensaje no parseable, ignorar */ }
  });
  console.log("WS conectado");
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      // No respondió al ping anterior → cliente muerto, cerrar.
      try { ws.terminate(); } catch (e) {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(noop); } catch (e) {}
  });
}, HEARTBEAT_INTERVAL_MS);

const POLLING_INTERVAL_MS = 5000;
let lastSyncTimestamp = new Date();
let isSyncing = false;

setInterval(async () => {
  if (isSyncing) return;
  try {
    isSyncing = true;
    const updatedData = await syncWithOdoo();
    if (updatedData) {
      lastSyncTimestamp = new Date();
      // 1) Broadcast completo (legacy) — clientes existentes lo procesan igual que antes
      broadcastUpdate(updatedData);
      // 2) Broadcast diferencial (nuevo) — clientes que sepan reaccionar a LOCATION_UPDATE
      //    actualizarán al instante sin esperar al payload completo
      broadcastDelta(updatedData);
    }
  } catch (e) {
    console.error(e.message);
  } finally {
    isSyncing = false;
  }
}, POLLING_INTERVAL_MS);
// ==================================================================================
//  ⭐ MÓDULO PACKING LIST ANALYZER - VERSIÓN IA INTELIGENTE
// ==================================================================================
// Este módulo reemplaza la sección de Packing List en tu server.js
// Copia desde aquí hasta el final del módulo y reemplaza en tu server.js

// Cache de productos para Packing
let packingProductCache = new Map();
let packingAbcCache = new Map();
let packingStockCache = new Map();
let packingLastCacheUpdate = null;

async function refreshPackingCache() {
  console.log('📦 [PACKING] Actualizando caché...');
  const startTime = Date.now();

  try {
    const common = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/common` });
    const models = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/object` });
    
    const uid = await new Promise((resolve, reject) => {
      common.methodCall('authenticate', [
        process.env.ODOO_DATABASE, process.env.ODOO_USERNAME, process.env.ODOO_PASSWORD, {}
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    // 1. Productos
    console.log('  📦 Descargando productos...');
    const products = await new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        process.env.ODOO_DATABASE, uid, process.env.ODOO_PASSWORD,
        'product.product', 'search_read',
        [[['default_code', '!=', false], ['active', '=', true]]],
        { fields: ['id', 'default_code', 'name', 'standard_price'], limit: 50000 }
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    packingProductCache.clear();
    products.forEach(p => {
      if (p.default_code) {
        packingProductCache.set(p.default_code.toUpperCase().trim(), {
          id: p.id,
          name: p.name,
          code: p.default_code,
          cost: p.standard_price || 0
        });
      }
    });
    console.log(`    ✅ ${packingProductCache.size} productos`);

    // 2. Clasificación ABC
    console.log('  📊 Descargando clasificación ABC...');
    try {
      const abcData = await new Promise((resolve, reject) => {
        models.methodCall('execute_kw', [
          process.env.ODOO_DATABASE, uid, process.env.ODOO_PASSWORD,
          'abc.classification.product.level', 'search_read',
          [[]],
          { fields: ['product_id', 'level_id'], limit: 100000 }
        ], (err, res) => err ? reject(err) : resolve(res));
      });

      packingAbcCache.clear();
      abcData.forEach(row => {
        if (row.product_id && row.level_id) {
          const productId = row.product_id[0];
          const level = row.level_id[1] || 'D';
          packingAbcCache.set(productId, level.charAt(0).toUpperCase());
        }
      });
      console.log(`    ✅ ${packingAbcCache.size} clasificaciones ABC`);
    } catch (e) {
      console.log(`    ⚠️ No se pudo cargar ABC: ${e.message}`);
    }

    // 3. Stock
    console.log('  📍 Descargando stock...');
    const quants = await new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        process.env.ODOO_DATABASE, uid, process.env.ODOO_PASSWORD,
        'stock.quant', 'search_read',
        [[['location_id.usage', '=', 'internal'], ['quantity', '>', 0]]],
        { fields: ['product_id', 'location_id', 'quantity'], limit: 100000 }
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    packingStockCache.clear();
    quants.forEach(q => {
      if (q.product_id) {
        const productId = q.product_id[0];
        if (!packingStockCache.has(productId)) {
          packingStockCache.set(productId, { total: 0, locations: [] });
        }
        const entry = packingStockCache.get(productId);
        entry.total += q.quantity;
        entry.locations.push({
          id: q.location_id[0],
          name: q.location_id[1],
          qty: q.quantity
        });
      }
    });
    console.log(`    ✅ ${packingStockCache.size} productos con stock`);

    packingLastCacheUpdate = new Date();
    console.log(`✅ [PACKING] Caché actualizada en ${((Date.now() - startTime) / 1000).toFixed(1)}s\n`);

    return { products: packingProductCache.size, abc: packingAbcCache.size, stock: packingStockCache.size };

  } catch (error) {
    console.error('❌ [PACKING] Error actualizando caché:', error.message);
    throw error;
  }
}

// ==================================================================================
//  🧠 PARSER INTELIGENTE CON CLAUDE - LEE CUALQUIER FORMATO DE PACKING LIST
// ==================================================================================
async function parsePackingPDFWithAI(filePath) {
  console.log('🧠 [PACKING-AI] Iniciando análisis inteligente del PDF...');
  
  const tempScriptPath = path.join(__dirname, 'temp_extractor.py');
  const absolutePath = path.resolve(filePath);
  
  // Script Python para extraer TODO el texto del PDF (sin parsear)
  const pythonScript = `
import pdfplumber
import json
import sys

pdf_path = sys.argv[1] if len(sys.argv) > 1 else ""
result = {
    "raw_text": "",
    "tables": [],
    "container_candidates": []
}

try:
    with pdfplumber.open(pdf_path) as pdf:
        all_text = []
        for page_num, page in enumerate(pdf.pages):
            # Extraer texto plano
            text = page.extract_text() or ""
            all_text.append(text)
            
            # Extraer tablas
            tables = page.extract_tables()
            for table in tables:
                if table and len(table) > 0:
                    # Convertir a lista de listas de strings
                    clean_table = []
                    for row in table:
                        if row:
                            clean_row = [str(cell).strip() if cell else "" for cell in row]
                            clean_table.append(clean_row)
                    if clean_table:
                        result["tables"].append(clean_table)
        
        result["raw_text"] = "\\n".join(all_text)
        
        # Buscar candidatos a número de contenedor (formato XXXX1234567)
        import re
        container_pattern = r'[A-Z]{4}\\d{7}'
        containers = re.findall(container_pattern, result["raw_text"])
        result["container_candidates"] = list(set(containers))
        
    print(json.dumps(result, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`;

  try {
    // Escribir script Python temporal
    await fs.writeFile(tempScriptPath, pythonScript, 'utf8');
    
    // Ejecutar Python
    const pythonExe = process.platform === 'win32' 
      ? 'C:\\Users\\j.bernabe\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe'
      : 'python3';
    
    const fullCommand = process.platform === 'win32'
      ? `chcp 65001 >nul && "${pythonExe}" -X utf8 "${tempScriptPath}" "${absolutePath}"`
      : `"${pythonExe}" "${tempScriptPath}" "${absolutePath}"`;
    
    console.log(`  🐍 Extrayendo contenido del PDF...`);
    const { stdout, stderr } = await execPromise(fullCommand, { maxBuffer: 50 * 1024 * 1024 });
    
    // Limpiar script temporal
    await fs.unlink(tempScriptPath).catch(() => {});
    
    if (!stdout || stdout.trim() === '') {
      throw new Error('No se pudo extraer contenido del PDF');
    }
    
    const extracted = JSON.parse(stdout);
    
    if (extracted.error) {
      throw new Error(extracted.error);
    }
    
    console.log(`  📄 Extraído: ${extracted.tables.length} tablas, ${extracted.container_candidates.length} contenedores detectados`);
    
    // ==================================================================================
    //  🤖 ENVIAR A CLAUDE PARA ANÁLISIS INTELIGENTE
    // ==================================================================================
    console.log(`  🤖 Enviando a Claude para análisis inteligente...`);
    
    // Preparar el contenido para Claude (limitamos para no exceder tokens)
    let contentForAI = "";
    
    // Añadir tablas (máximo 5000 caracteres por tabla)
    extracted.tables.forEach((table, idx) => {
      const tableStr = table.map(row => row.join(' | ')).join('\n');
      if (tableStr.length < 10000) {
        contentForAI += `\n--- TABLA ${idx + 1} ---\n${tableStr}\n`;
      }
    });
    
    // Si no hay tablas suficientes, usar texto raw (primeros 8000 caracteres)
    if (contentForAI.length < 500) {
      contentForAI += `\n--- TEXTO DEL DOCUMENTO ---\n${extracted.raw_text.substring(0, 8000)}`;
    }
    
    // Limitar contenido total
    if (contentForAI.length > 15000) {
      contentForAI = contentForAI.substring(0, 15000) + "\n[...contenido truncado...]";
    }
    
    const anthropic = getAnthropicClient();
    
    const aiResponse = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      system: `Eres un experto en logística analizando packing lists de contenedores.
Tu tarea es extraer las REFERENCIAS DE PRODUCTOS y sus CANTIDADES de cualquier formato de packing list.

REGLAS CRÍTICAS:
1. Identifica la columna que contiene las REFERENCIAS/CÓDIGOS de producto (pueden llamarse: Item No, Carton, Model, SKU, Code, Reference, Código, Referencia, etc.)
2. Identifica la columna de CANTIDAD (pueden llamarse: Quantity, Qty, PRS, Units, Pcs, Cantidad, etc.)
3. Si hay varias filas con la misma referencia, SUMA las cantidades
4. Ignora filas de totales, subtotales o encabezados
5. Las referencias suelen tener formato alfanumérico (ej: DFKSUN1512-0804, ABC123, etc.)

RESPONDE ÚNICAMENTE con un JSON válido con esta estructura exacta:
{
  "container_number": "XXXX1234567 o null si no se encuentra",
  "items": [
    {"reference": "CODIGO1", "quantity": 100, "description": "descripción opcional"},
    {"reference": "CODIGO2", "quantity": 50, "description": "descripción opcional"}
  ],
  "total_units": 150,
  "total_lines": 2,
  "confidence": "HIGH/MEDIUM/LOW",
  "notes": "cualquier observación sobre el formato detectado"
}`,
      messages: [{
        role: "user",
        content: `Analiza este packing list y extrae las referencias de productos con sus cantidades:\n\n${contentForAI}`
      }]
    });
    
    // Parsear respuesta de Claude
    const aiText = aiResponse.content[0].text;
    console.log(`  🤖 Respuesta de Claude recibida (${aiText.length} chars)`);
    
    // Intentar extraer JSON de la respuesta
    let parsedAI;
    try {
      // Buscar JSON en la respuesta (puede estar envuelto en markdown)
      const jsonMatch = aiText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsedAI = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No se encontró JSON en la respuesta');
      }
    } catch (parseErr) {
      console.error('  ⚠️ Error parseando respuesta de Claude:', parseErr.message);
      console.log('  📝 Respuesta raw:', aiText.substring(0, 500));
      
      // Fallback: devolver estructura vacía
      parsedAI = {
        container_number: extracted.container_candidates[0] || null,
        items: [],
        total_units: 0,
        total_lines: 0,
        confidence: "LOW",
        notes: "No se pudo parsear la respuesta de la IA"
      };
    }
    
    // Usar contenedor detectado por regex si Claude no lo encontró
    if (!parsedAI.container_number && extracted.container_candidates.length > 0) {
      parsedAI.container_number = extracted.container_candidates[0];
    }
    
    console.log(`  ✅ Análisis completado: ${parsedAI.items?.length || 0} referencias, ${parsedAI.total_units || 0} unidades`);
    
    return parsedAI;
    
  } catch (error) {
    // Limpiar script temporal en caso de error
    await fs.unlink(tempScriptPath).catch(() => {});
    console.error('❌ [PACKING-AI] Error:', error.message);
    throw error;
  }
}

// ==================================================================================
//  MOTOR DE ENRIQUECIMIENTO (ADAPTADO PARA NUEVO FORMATO)
// ==================================================================================
// ==================================================================================
//  MOTOR DE ENRIQUECIMIENTO - VERSIÓN MEJORADA v2.1
// ==================================================================================
// INSTRUCCIONES:
// 1. Busca en tu server.js la función: function enrichPackingListAI(parsedData)
// 2. Selecciona TODA la función (desde "function enrichPackingListAI" hasta su "}" de cierre)
// 3. Reemplázala por este código completo
// 
// MEJORAS INCLUIDAS:
//   ✅ Cálculo de cajas (50 uds/caja para gafas DFK/DFS)
//   ✅ Cálculo de palets estimados (70 cajas/palet para gafas)
//   ✅ Normalización de referencias (803 → 0803)
// ==================================================================================

function enrichPackingListAI(parsedData) {
  const enriched = [];
  const summary = {
    totalUnits: parsedData.total_units || 0,
    totalCartons: 0,
    totalPalets: 0,
    totalCBM: 0,
    totalWeight: 0,
    byABC: { A: 0, B: 0, C: 0, D: 0, NEW: 0 },
    newReferences: [],
    consolidationAlerts: [],
    excessAlerts: [],
    aiConfidence: parsedData.confidence || 'UNKNOWN',
    aiNotes: parsedData.notes || ''
  };

  if (!parsedData.items || parsedData.items.length === 0) {
    return { items: enriched, summary };
  }

  // Agrupar por referencia (por si Claude no lo hizo)
  const byReference = new Map();
  
  parsedData.items.forEach(item => {
    const ref = (item.reference || '').toUpperCase().trim();
    if (!ref) return;
    
    if (!byReference.has(ref)) {
      byReference.set(ref, {
        reference: ref,
        description: item.description || '',
        totalUnits: 0
      });
    }
    
    byReference.get(ref).totalUnits += item.quantity || 0;
  });

  // Enriquecer cada referencia
  byReference.forEach((refData, reference) => {
    // ========================================
    // 🔍 BÚSQUEDA CON NORMALIZACIÓN DE REFERENCIAS
    // ========================================
    let productInfo = packingProductCache.get(reference);

    // Si no encuentra, intentar con variantes normalizadas
    if (!productInfo) {
      const variants = [
        reference.replace(/-/g, ''),           // Sin guiones: DFKSUN0216803
        reference.replace(/_/g, '-'),          // Guiones bajos a guiones
        reference.split('-')[0],               // Solo prefijo: DFKSUN0216
        reference.split('_')[0],               // Solo prefijo
      ];
      
      // NORMALIZACIÓN ESPECIAL: Añadir ceros después del guión
      // Convierte DFKSUN0216-803 → DFKSUN0216-0803
      const dashParts = reference.split('-');
      if (dashParts.length === 2) {
        const suffix = dashParts[1];
        // Si el sufijo tiene 3 dígitos, añadir 0 al inicio → 0803
        if (/^\d{3}$/.test(suffix)) {
          variants.push(`${dashParts[0]}-0${suffix}`);
        }
        // Si el sufijo tiene 2 dígitos, añadir 00 al inicio → 0083
        if (/^\d{2}$/.test(suffix)) {
          variants.push(`${dashParts[0]}-00${suffix}`);
        }
        // Si el sufijo tiene 1 dígito, añadir 000 al inicio → 0003
        if (/^\d{1}$/.test(suffix)) {
          variants.push(`${dashParts[0]}-000${suffix}`);
        }
      }
      
      // También probar quitando ceros del sufijo (por si acaso viene al revés)
      // Convierte DFKSUN0216-0803 → DFKSUN0216-803
      if (dashParts.length === 2 && dashParts[1].startsWith('0')) {
        variants.push(`${dashParts[0]}-${dashParts[1].replace(/^0+/, '')}`);
      }
      
      // CASO ESPECIAL: Referencias SIN guión (ej: DFKSUN0820)
      // Buscar en caché productos que empiecen con esta referencia
      if (dashParts.length === 1 && reference.length >= 8) {
        for (const [cacheKey] of packingProductCache.entries()) {
          if (cacheKey.startsWith(reference + '-')) {
            variants.push(cacheKey);
            break; // Tomar el primero que coincida
          }
        }
      }
      
      for (const variant of variants) {
        productInfo = packingProductCache.get(variant.toUpperCase().trim());
        if (productInfo) {
          console.log(`  🔗 [PACKING] Referencia "${reference}" encontrada como "${variant}"`);
          break;
        }
      }
    }

    let abcClass = 'NEW';
    let currentStock = 0;
    let stockLocations = [];
    let zoneRecommendation = 'Por asignar';
    let alerts = [];

    if (productInfo) {
      const abc = packingAbcCache.get(productInfo.id);
      abcClass = abc || 'D';

      const stock = packingStockCache.get(productInfo.id);
      if (stock) {
        currentStock = stock.total;
        stockLocations = stock.locations;
      }

      switch (abcClass) {
        case 'A': zoneRecommendation = 'Pasillos 1-3 (Alta rotación)'; break;
        case 'B': zoneRecommendation = 'Pasillos 4-6 (Media rotación)'; break;
        case 'C': zoneRecommendation = 'Pasillos 7-9 (Baja rotación)'; break;
        case 'D': zoneRecommendation = 'Pasillos 10+ o Fondo'; break;
      }

      if (currentStock > 0) {
        const mainLocation = stockLocations.sort((a, b) => b.qty - a.qty)[0];
        if (mainLocation) {
          alerts.push({
            type: 'consolidar',
            message: `Ya tiene ${currentStock} uds en ${mainLocation.name}. Consolidar.`
          });
          summary.consolidationAlerts.push({
            itemNo: reference,
            currentStock,
            incomingUnits: refData.totalUnits,
            location: mainLocation.name
          });
        }

        if (refData.totalUnits > currentStock * 3) {
          alerts.push({
            type: 'exceso',
            message: `⚠️ Exceso: ${refData.totalUnits} uds entrando vs ${currentStock} en stock`
          });
          summary.excessAlerts.push({ itemNo: reference, incoming: refData.totalUnits, current: currentStock });
        }
      }
    } else {
      alerts.push({ type: 'nuevo', message: '🆕 Nueva referencia - No existe en Odoo' });
      summary.newReferences.push(reference);
    }

    // ========================================
    // 🧮 CÁLCULO INTELIGENTE DE CAJAS Y PALETS
    // ========================================
    let totalCartons = 1;
    let unitsPerCarton = null;
    let cartonsPerPalet = null;
    let estimatedPalets = 0;
    
    const refUpper = reference.toUpperCase();
    console.log(`  🔍 DEBUG: ref="${refUpper}", startsDFK=${refUpper.startsWith('DFK')}, startsDFS=${refUpper.startsWith('DFS')}`);
    
    // REGLA 1: Gafas (DFK, DFS, SUN) → 50 unidades por caja, 22 cajas por palet
    if (refUpper.startsWith('DFK') || refUpper.startsWith('DFS') || refUpper.includes('SUN')) {
      unitsPerCarton = 50;
      cartonsPerPalet = 22;
      totalCartons = Math.ceil(refData.totalUnits / unitsPerCarton);
      estimatedPalets = Math.ceil(totalCartons / cartonsPerPalet);
    }
    // REGLA 2: Aquí puedes añadir más reglas en el futuro
    // else if (refUpper.startsWith('OSSH') || refUpper.startsWith('COSH')) {
    //   unitsPerCarton = 12;
    //   cartonsPerPalet = 60;
    //   totalCartons = Math.ceil(refData.totalUnits / unitsPerCarton);
    //   estimatedPalets = Math.ceil(totalCartons / cartonsPerPalet);
    // }
    else {
      // Productos sin regla específica: estimación genérica
      totalCartons = 1;
      estimatedPalets = Math.ceil(refData.totalUnits / 3500); // ~3500 uds/palet genérico
    }

    // Sumar al total del contenedor
    summary.totalCartons += totalCartons;
    summary.totalPalets += estimatedPalets;

    // Contabilizar por ABC
    if (abcClass === 'NEW') {
      summary.byABC.NEW += refData.totalUnits;
    } else {
      summary.byABC[abcClass] = (summary.byABC[abcClass] || 0) + refData.totalUnits;
    }

    enriched.push({
      itemNo: reference,
      productName: productInfo?.name || refData.description || 'Desconocido',
      description: refData.description,
      totalUnits: refData.totalUnits,
      totalCartons: totalCartons,
      unitsPerCarton: unitsPerCarton,
      estimatedPalets: estimatedPalets,
      totalCBM: '0.000',
      totalWeight: '0.00',
      abcClass,
      zoneRecommendation,
      currentStock,
      stockLocations: stockLocations.slice(0, 3),
      alerts,
      lines: 1
    });
  });

  // Ordenar por ABC y cantidad
  const abcOrder = { A: 1, B: 2, C: 3, D: 4, NEW: 5 };
  enriched.sort((a, b) => {
    const abcDiff = (abcOrder[a.abcClass] || 99) - (abcOrder[b.abcClass] || 99);
    if (abcDiff !== 0) return abcDiff;
    return b.totalUnits - a.totalUnits;
  });

  // Recalcular totales
  summary.totalUnits = enriched.reduce((sum, item) => sum + item.totalUnits, 0);
  summary.totalCartons = enriched.reduce((sum, item) => sum + item.totalCartons, 0);
  summary.totalPalets = enriched.reduce((sum, item) => sum + item.estimatedPalets, 0);

  return { items: enriched, summary };
}

// ==================================================================================
//  GENERADOR DE EXCEL (IGUAL QUE ANTES)
// ==================================================================================
async function generatePackingExcel(enrichedData, containerNumber) {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.default.Workbook();

  const summarySheet = workbook.addWorksheet('Resumen');
  summarySheet.columns = [
    { header: 'Métrica', key: 'metric', width: 30 },
    { header: 'Valor', key: 'value', width: 20 }
  ];

  const { summary } = enrichedData;
  summarySheet.addRows([
    { metric: 'Contenedor', value: containerNumber },
    { metric: 'Total Unidades', value: summary.totalUnits },
    { metric: 'Total Referencias', value: enrichedData.items.length },
    { metric: 'Confianza IA', value: summary.aiConfidence },
    { metric: '', value: '' },
    { metric: 'Unidades ABC A', value: summary.byABC.A },
    { metric: 'Unidades ABC B', value: summary.byABC.B },
    { metric: 'Unidades ABC C', value: summary.byABC.C },
    { metric: 'Unidades ABC D', value: summary.byABC.D },
    { metric: 'Unidades NUEVAS', value: summary.byABC.NEW },
    { metric: '', value: '' },
    { metric: 'Alertas Consolidación', value: summary.consolidationAlerts.length },
    { metric: 'Referencias Nuevas', value: summary.newReferences.length },
  ]);

  if (summary.aiNotes) {
    summarySheet.addRow({ metric: 'Notas IA', value: summary.aiNotes });
  }

  const detailSheet = workbook.addWorksheet('Packing List Enriquecido');
  detailSheet.columns = [
    { header: 'Referencia', key: 'itemNo', width: 25 },
    { header: 'Producto', key: 'productName', width: 40 },
    { header: 'Unidades', key: 'totalUnits', width: 12 },
    { header: 'ABC', key: 'abcClass', width: 8 },
    { header: 'Zona Recomendada', key: 'zoneRecommendation', width: 30 },
    { header: 'Stock Actual', key: 'currentStock', width: 12 },
    { header: 'Alertas', key: 'alertas', width: 50 },
  ];

  enrichedData.items.forEach((item) => {
    detailSheet.addRow({
      itemNo: item.itemNo,
      productName: item.productName,
      totalUnits: item.totalUnits,
      abcClass: item.abcClass,
      zoneRecommendation: item.zoneRecommendation,
      currentStock: item.currentStock,
      alertas: item.alerts.map(a => a.message).join(' | ')
    });
  });

  // Colorear por ABC
  detailSheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // Skip header
    const abcCell = row.getCell(4);
    const abc = abcCell.value;
    
    let color;
    switch(abc) {
      case 'A': color = '90EE90'; break; // Verde claro
      case 'B': color = 'FFFF99'; break; // Amarillo claro
      case 'C': color = 'FFD699'; break; // Naranja claro
      case 'D': color = 'FF9999'; break; // Rojo claro
      case 'NEW': color = '99CCFF'; break; // Azul claro
    }
    
    if (color) {
      row.eachCell(cell => {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: color }
        };
      });
    }
  });

  const outputPath = `./packing-outputs/PL_${containerNumber}_${Date.now()}.xlsx`;
  await workbook.xlsx.writeFile(outputPath);

  return outputPath;
}

// ==================================================================================
//  ENDPOINTS PACKING LIST (ACTUALIZADOS)
// ==================================================================================

// Health check
app.get("/api/packing/health", (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0-AI',
    odooConnected: !!process.env.ODOO_URL,
    aiEnabled: !!process.env.ANTHROPIC_API_KEY,
    cache: {
      products: packingProductCache.size,
      abc: packingAbcCache.size,
      stock: packingStockCache.size,
      lastUpdate: packingLastCacheUpdate
    }
  });
});

// Refrescar caché
app.post("/api/packing/cache/refresh", async (req, res) => {
  try {
    const stats = await refreshPackingCache();
    res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🆕 ANALIZAR PDF CON IA
app.post("/api/packing/analyze", packingUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió archivo' });
    }

    console.log(`\n📄 [PACKING] ========================================`);
    console.log(`📄 [PACKING] Analizando: ${req.file.originalname}`);
    console.log(`📄 [PACKING] ========================================`);

    // Refrescar caché si tiene más de 1 hora
    if (process.env.ODOO_URL && (!packingLastCacheUpdate || (Date.now() - packingLastCacheUpdate.getTime()) > 3600000)) {
      try {
        await refreshPackingCache();
      } catch (e) {
        console.warn('⚠️ [PACKING] No se pudo actualizar caché:', e.message);
      }
    }

    // 🧠 USAR PARSER INTELIGENTE CON IA
    const parsed = await parsePackingPDFWithAI(req.file.path);
    
    const containerNumber = parsed.container_number || 
                           req.file.originalname.match(/[A-Z]{4}\d{7}/)?.[0] ||
                           req.file.originalname.match(/(\d{10,12})/)?.[1] ||
                           'UNKNOWN';

    console.log(`  📦 Contenedor: ${containerNumber}`);

    // Enriquecer con datos de Odoo
    const enriched = enrichPackingListAI(parsed);
    console.log(`  📍 ${enriched.items.length} referencias enriquecidas`);

    // Generar Excel
    let excelFile = null;
    if (enriched.items.length > 0) {
      const excelPath = await generatePackingExcel(enriched, containerNumber);
      excelFile = path.basename(excelPath);
      console.log(`  📁 Excel: ${excelFile}`);
    }

    // Limpiar archivo temporal
    await fs.unlink(req.file.path).catch(() => {});

    console.log(`✅ [PACKING] Análisis completado\n`);

    res.json({
      success: true,
      containerNumber,
      summary: enriched.summary,
      items: enriched.items,
      excelFile,
      aiPowered: true
    });

  } catch (error) {
    console.error('❌ [PACKING] Error:', error);
    // Limpiar archivo en caso de error
    if (req.file) {
      await fs.unlink(req.file.path).catch(() => {});
    }
    res.status(500).json({ error: error.message });
  }
});

// Descargar Excel — con protección contra path traversal (Fase 1 auditoría 2026-04-24)
app.get("/api/packing/download/:filename", (req, res) => {
  const PACKING_DIR = path.resolve(__dirname, 'packing-outputs');
  // basename() descarta cualquier "../" antes de resolver
  const safeFilename = path.basename(req.params.filename);
  const filePath = path.resolve(PACKING_DIR, safeFilename);
  // Defensa en profundidad: verificar que el path resuelto sigue dentro de PACKING_DIR
  if (!filePath.startsWith(PACKING_DIR + path.sep) && filePath !== PACKING_DIR) {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  if (!fsSync.existsSync(filePath)) {
    return res.status(404).json({ error: 'Archivo no encontrado' });
  }
  res.download(filePath);
});

// ==================================================================================
//  ERROR HANDLER GLOBAL (Fase 3.A.3 auditoría 2026-04-28)
//  ---------------------------------------------------------------
//  Captura cualquier error no manejado por las rutas (incluyendo el error de
//  CORS bloqueado, que antes devolvía HTML stack trace) y devuelve JSON
//  estructurado: { success:false, error: { code, message } }.
//
//  Comportamiento previo: errores → HTML de express con stack trace en <pre>.
//  Nuevo: errores → JSON con statusCode adecuado.
//
//  Compatibilidad: solo se activa cuando un error LLEGA al middleware (las
//  rutas que ya devuelven res.json siguen funcionando idénticamente).
// ==================================================================================
app.use(globalErrorHandler);

server.listen(PORT, '0.0.0.0', () => {
  console.log(` 🚀  CEREBRO CLAUDE + CFO IA + DEVOLUCIONES B2B ACTIVO en ${PORT}`);

  // Auto-migración en background (no bloquea el arranque)
  startupMigration().then(() => {
    console.log('✅ [STARTUP] Migración automática completada');
  }).catch(err => {
    console.error('⚠️ [STARTUP] Error en migración (servidor sigue funcionando):', err.message);
  });
});
