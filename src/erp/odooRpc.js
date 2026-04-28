// ==================================================================================
//  src/erp/odooRpc.js
//  Wrapper unificado XML-RPC para Odoo (Fase 3.A.1 auditoría 2026-04-28).
//
//  Diseño:
//  - Lee la configuración una sola vez de process.env (ODOO_URL, ODOO_DATABASE,
//    ODOO_USERNAME, ODOO_PASSWORD). Acepta ODOO_DB como alias por compat.
//  - Cachea el `uid` después de autenticar (evita re-autenticar en cada llamada).
//  - Convierte los callbacks de la lib `xmlrpc` a Promises.
//  - Aplica un timeout configurable (env ODOO_RPC_TIMEOUT_MS, default 30 s).
//
//  IMPORTANTE — compatibilidad hacia atrás:
//  - Este módulo NO REEMPLAZA todavía las llamadas xmlrpc inline existentes en
//    server.js, sync_odoo.js, odoo_cache.js. Solo añade una utilidad para que el
//    código nuevo (o migraciones futuras) la use. Migración archivo por archivo.
//  - Si las envs no están configuradas, ensureOdooEnv() lanza un error claro al
//    invocarse, NO al importar.
// ==================================================================================

import xmlrpc from 'xmlrpc';

const DEFAULT_TIMEOUT_MS = parseInt(process.env.ODOO_RPC_TIMEOUT_MS, 10) > 0
  ? parseInt(process.env.ODOO_RPC_TIMEOUT_MS, 10)
  : 30_000;

function getConfig() {
  return {
    url: process.env.ODOO_URL,
    db: process.env.ODOO_DATABASE || process.env.ODOO_DB,
    username: process.env.ODOO_USERNAME,
    password: process.env.ODOO_PASSWORD,
  };
}

export function ensureOdooEnv() {
  const cfg = getConfig();
  const missing = [];
  if (!cfg.url) missing.push('ODOO_URL');
  if (!cfg.db) missing.push('ODOO_DATABASE');
  if (!cfg.username) missing.push('ODOO_USERNAME');
  if (!cfg.password) missing.push('ODOO_PASSWORD');
  if (missing.length > 0) {
    throw new Error(
      `[odooRpc] Faltan variables de entorno: ${missing.join(', ')}. ` +
      `Configúralas en .env (dev) o en Railway → Variables.`
    );
  }
  return cfg;
}

// Promisifica una xmlrpc call con timeout.
function rpcCall(client, method, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`[odooRpc] Timeout (${timeoutMs} ms) en ${method}`));
    }, timeoutMs);

    client.methodCall(method, args, (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) return reject(err);
      resolve(value);
    });
  });
}

// Cliente común (reutilizado para auth) y modelos (reutilizado para queries).
let _commonClient = null;
let _modelsClient = null;
let _cachedUid = null;
let _cachedUidExpiresAt = 0;
const UID_TTL_MS = 30 * 60 * 1000; // 30 min

function commonClient() {
  const cfg = getConfig();
  if (!_commonClient) {
    _commonClient = xmlrpc.createSecureClient({ url: `${cfg.url}/xmlrpc/2/common` });
  }
  return _commonClient;
}

function modelsClient() {
  const cfg = getConfig();
  if (!_modelsClient) {
    _modelsClient = xmlrpc.createSecureClient({ url: `${cfg.url}/xmlrpc/2/object` });
  }
  return _modelsClient;
}

export async function odooAuth({ force = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cfg = ensureOdooEnv();
  if (!force && _cachedUid && Date.now() < _cachedUidExpiresAt) {
    return _cachedUid;
  }
  const uid = await rpcCall(commonClient(), 'authenticate', [cfg.db, cfg.username, cfg.password, {}], timeoutMs);
  if (!uid) throw new Error('[odooRpc] Autenticación Odoo fallida (uid vacío)');
  _cachedUid = uid;
  _cachedUidExpiresAt = Date.now() + UID_TTL_MS;
  return uid;
}

/**
 * Invoca un método de un modelo Odoo vía XML-RPC `execute_kw`.
 *
 * @param {string} model   - p. ej. 'product.product'
 * @param {string} op      - p. ej. 'search_read', 'read', 'create', 'write'
 * @param {Array}  params  - argumentos posicionales (array de arrays según op)
 * @param {Object} options - keyword args (fields, limit, offset, order, ...)
 * @param {Object} ctx     - { timeoutMs?: number, retry?: number }
 * @returns {Promise<any>}
 */
export async function odooExecute(model, op, params = [], options = {}, ctx = {}) {
  const cfg = ensureOdooEnv();
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retry = ctx.retry ?? 1;

  let lastErr = null;
  for (let attempt = 0; attempt <= retry; attempt++) {
    try {
      const uid = await odooAuth({ timeoutMs });
      return await rpcCall(
        modelsClient(),
        'execute_kw',
        [cfg.db, uid, cfg.password, model, op, params, options],
        timeoutMs
      );
    } catch (err) {
      lastErr = err;
      // Si el uid expiró, forzar re-auth y reintentar
      if (attempt < retry) {
        _cachedUid = null;
        _cachedUidExpiresAt = 0;
      }
    }
  }
  throw lastErr;
}

// Helper para search + read combinado (patrón muy frecuente).
export function odooSearchRead(model, domain, fields, opts = {}) {
  const { limit, offset, order } = opts;
  const options = {};
  if (fields) options.fields = fields;
  if (typeof limit === 'number') options.limit = limit;
  if (typeof offset === 'number') options.offset = offset;
  if (order) options.order = order;
  return odooExecute(model, 'search_read', [domain || []], options);
}

// Diagnóstico para `/health` u otros endpoints.
export function odooClientStats() {
  return {
    uidCached: Boolean(_cachedUid),
    uidExpiresIn: _cachedUid ? Math.max(0, _cachedUidExpiresAt - Date.now()) : 0,
    config: {
      hasUrl: Boolean(process.env.ODOO_URL),
      hasDb: Boolean(process.env.ODOO_DATABASE || process.env.ODOO_DB),
      hasUser: Boolean(process.env.ODOO_USERNAME),
      hasPassword: Boolean(process.env.ODOO_PASSWORD),
    },
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}
