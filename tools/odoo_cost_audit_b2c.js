#!/usr/bin/env node
/**
 * Odoo Stock Cost Audit (B2C Storage) - FULL VERSION (Company + Supplier Currency + EUR)
 * ------------------------------------------------------------------------------------
 * 1) Descarga stock.quant de ubicaciones internas (filtro "Storage" por defecto)
 * 2) Cruza con product.product.standard_price (coste en moneda de la compañía del contexto)
 * 3) Detecta productos con coste 0 en el contexto actual
 * 4) Diagnóstico multi-compañía (allowed_company_ids) con lectura SEGURA (no rompe por reglas)
 * 5) Descarga product.supplierinfo (vendor price) y su currency_id (moneda proveedor)
 * 6) Conversión a EUR (o TARGET_CURRENCY) usando res.currency._convert (cacheado)
 * 7) Export Excel:
 *    - Resumen
 *    - Quants_B2C (incluye moneda compañía y moneda proveedor + conversiones)
 *    - Productos_Coste_0
 *    - Diagnostico_Coste_0 (incluye monedas detectadas)
 *    - Bloqueados_por_seguridad
 *
 * ENV:
 *  ODOO_URL
 *  ODOO_DB
 *  ODOO_USER (alias: ODOO_USERNAME, ODOO_LOGIN, ODOO_EMAIL)
 *  ODOO_PASSWORD
 *
 * Opciones:
 *  LOCATION_FILTER=Storage
 *  ONLY_POSITIVE_QTY=1
 *  AUDIT_ALL_COMPANIES=1   (default 1)
 *  BATCH_SIZE=5000
 *  CONVERSION_DATE=YYYY-MM-DD (default hoy)
 *  TARGET_CURRENCY=EUR (default EUR)
 *  SUPPLIERINFO_LIMIT=200000 (default 200000)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import dotenv from "dotenv";
import xmlrpc from "xmlrpc";
import xlsx from "xlsx";

// -------------------- Carga robusta del .env --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envCandidates = [path.join(process.cwd(), ".env"), path.join(__dirname, ".env")];
let loadedEnv = false;
for (const p of envCandidates) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    loadedEnv = true;
    break;
  }
}
if (!loadedEnv) {
  console.warn("⚠️ No se encontró .env en el directorio actual ni junto al script. Usaré variables del entorno si existen.");
}

// -------------------- Helpers ENV --------------------
function pickEnv(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

const CFG = {
  url: pickEnv("ODOO_URL"),
  db: pickEnv("ODOO_DB"),
  user: pickEnv("ODOO_USER", "ODOO_USERNAME", "ODOO_LOGIN", "ODOO_EMAIL"),
  password: pickEnv("ODOO_PASSWORD"),

  locationFilter: pickEnv("LOCATION_FILTER") || "Storage",
  onlyPositiveQty: pickEnv("ONLY_POSITIVE_QTY") === "1",
  auditAllCompanies: pickEnv("AUDIT_ALL_COMPANIES") !== "0", // default ON
  batchSize: Number(pickEnv("BATCH_SIZE") || 5000),

  targetCurrencyCode: pickEnv("TARGET_CURRENCY") || "EUR",
  conversionDate: pickEnv("CONVERSION_DATE") || new Date().toISOString().slice(0, 10),

  supplierinfoLimit: Number(pickEnv("SUPPLIERINFO_LIMIT") || 200000),
};

function assertCfg() {
  const missing = [];
  if (!CFG.url) missing.push("ODOO_URL");
  if (!CFG.db) missing.push("ODOO_DB");
  if (!CFG.user) missing.push("ODOO_USER (o ODOO_USERNAME)");
  if (!CFG.password) missing.push("ODOO_PASSWORD");
  if (missing.length) {
    console.error(`❌ Falta configuración en .env: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (!CFG.url.startsWith("http")) {
    console.error("❌ ODOO_URL debe incluir http(s)://");
    process.exit(1);
  }
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}
function uniq(arr) {
  return Array.from(new Set(arr));
}
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function toMoney4(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "";
  return Number(n).toFixed(4);
}

// -------------------- XML-RPC --------------------
function clientCommon() {
  return CFG.url.startsWith("https")
    ? xmlrpc.createSecureClient({ url: `${CFG.url}/xmlrpc/2/common` })
    : xmlrpc.createClient({ url: `${CFG.url}/xmlrpc/2/common` });
}
function clientObject() {
  return CFG.url.startsWith("https")
    ? xmlrpc.createSecureClient({ url: `${CFG.url}/xmlrpc/2/object` })
    : xmlrpc.createClient({ url: `${CFG.url}/xmlrpc/2/object` });
}
function methodCall(client, method, params) {
  return new Promise((resolve, reject) => {
    client.methodCall(method, params, (err, res) => (err ? reject(err) : resolve(res)));
  });
}
async function authenticate() {
  const common = clientCommon();
  const uid = await methodCall(common, "authenticate", [CFG.db, CFG.user, CFG.password, {}]);
  if (!uid) throw new Error("No se pudo autenticar en Odoo (uid vacío). Revisa usuario/contraseña/DB.");
  return uid;
}
async function executeKw(uid, model, method, args = [], kwargs = {}) {
  const object = clientObject();
  return methodCall(object, "execute_kw", [CFG.db, uid, CFG.password, model, method, args, kwargs]);
}

// -------------------- Fetchers --------------------
async function fetchCompanies(uid) {
  const domain = [];
  const companies = await executeKw(uid, "res.company", "search_read", [domain], {
    fields: ["name", "currency_id"],
    limit: 500,
  });
  return companies.map((c) => ({
    id: c.id,
    name: c.name,
    currency_id: Array.isArray(c.currency_id) ? c.currency_id[0] : c.currency_id,
    currency_code: Array.isArray(c.currency_id) ? c.currency_id[1] : "",
  }));
}

async function fetchCurrencyByCode(uid, code) {
  const domain = [["name", "=", code]];
  const rows = await executeKw(uid, "res.currency", "search_read", [domain], {
    fields: ["id", "name", "symbol"],
    limit: 5,
  });
  if (!rows.length) throw new Error(`No encontré res.currency con name="${code}"`);
  return rows[0];
}

async function fetchB2CLocations(uid) {
  const domain = [
    ["usage", "=", "internal"],
    ["complete_name", "ilike", CFG.locationFilter],
  ];
  return executeKw(uid, "stock.location", "search_read", [domain], {
    fields: ["id", "name", "complete_name", "usage"],
    limit: 5000,
  });
}

async function fetchAllQuantsForLocations(uid, locationIds) {
  const fields = ["location_id", "product_id", "quantity", "reserved_quantity", "in_date", "company_id", "package_id"];
  const domain = [["location_id", "in", locationIds]];

  let offset = 0;
  const all = [];

  console.log(`⏳ Descargando quants (stock.quant) para ${locationIds.length} ubicaciones...`);
  while (true) {
    const batch = await executeKw(uid, "stock.quant", "search_read", [domain], {
      fields,
      offset,
      limit: CFG.batchSize,
    });
    all.push(...batch);
    offset += CFG.batchSize;
    process.stdout.write(`\r   ... ${all.length} quants descargados`);
    if (!batch.length || batch.length < CFG.batchSize) break;
  }
  process.stdout.write("\n");
  return all;
}

async function fetchProductsRead(uid, productIds, context = null) {
  if (!productIds.length) return [];
  const fields = ["id", "name", "default_code", "standard_price", "product_tmpl_id", "active", "company_id"];
  const kwargs = { fields };
  if (context) kwargs.context = context;

  const chunks = chunk(productIds, 2000);
  const out = [];
  for (const c of chunks) {
    const rows = await executeKw(uid, "product.product", "read", [c], kwargs);
    out.push(...rows);
  }
  return out;
}

/**
 * Lectura SEGURA de product.product:
 * si falla un lote por record rules, lo divide hasta aislar IDs bloqueados y continua.
 */
async function safeReadProducts(uid, ids, context, onBlocked) {
  const fields = ["id", "name", "default_code", "standard_price", "product_tmpl_id", "active", "company_id"];

  async function tryRead(batch) {
    return executeKw(uid, "product.product", "read", [batch], { fields, context });
  }

  async function recurse(batch) {
    if (!batch.length) return [];
    try {
      return await tryRead(batch);
    } catch (e) {
      const msg = e?.message || String(e);
      if (batch.length === 1) {
        onBlocked?.(batch[0], msg);
        return [];
      }
      const mid = Math.floor(batch.length / 2);
      const left = batch.slice(0, mid);
      const right = batch.slice(mid);
      const a = await recurse(left);
      const b = await recurse(right);
      return [...a, ...b];
    }
  }

  const chunksBig = chunk(ids, 2000);
  const out = [];
  for (const c of chunksBig) {
    const rows = await recurse(c);
    out.push(...rows);
  }
  return out;
}

/**
 * Supplierinfo: precio proveedor y moneda (currency_id)  ✅ (esto es lo de tu captura)
 * Lo descargamos por product_tmpl_id para luego elegir "la mejor" línea por template.
 */
async function fetchSupplierinfo(uid, tmplIds) {
  if (!tmplIds.length) return [];
  const domain = [["product_tmpl_id", "in", tmplIds]];

  return executeKw(uid, "product.supplierinfo", "search_read", [domain], {
    fields: [
      "product_tmpl_id",
      "price",
      "currency_id", // ✅ campo de tu captura
      "partner_id",
      "min_qty",
      "date_start",
      "date_end",
      "company_id",
    ],
    limit: CFG.supplierinfoLimit,
  });
}

/**
 * Selecciona la "mejor" supplierinfo por template:
 * - preferimos min_qty menor
 * - si empatan, date_start más reciente
 */
function pickBestSupplierinfo(rows) {
  if (!rows?.length) return null;
  const sorted = [...rows].sort((a, b) => {
    const mqA = toNum(a.min_qty);
    const mqB = toNum(b.min_qty);
    if (mqA !== mqB) return mqA - mqB;

    const da = a.date_start ? new Date(a.date_start).getTime() : 0;
    const db = b.date_start ? new Date(b.date_start).getTime() : 0;
    return db - da;
  });
  return sorted[0];
}

// -------------------- Conversión de moneda (a EUR) --------------------
/**
 * Odoo: res.currency._convert(amount, to_currency, company, date)
 * Se invoca sobre el "from_currency" recordset.
 *
 * Devuelve multiplicador m tal que: amount_target = amount_from * m
 * (cacheado)
 */
async function getMultiplier(uid, fromCurrencyId, toCurrencyId, companyId, dateStr, cache) {
  const key = `${fromCurrencyId}->${toCurrencyId}@c${companyId}@${dateStr}`;
  if (cache.has(key)) return cache.get(key);

  try {
    const res = await executeKw(
      uid,
      "res.currency",
      "_convert",
      [[fromCurrencyId], 1.0, toCurrencyId, companyId, dateStr],
      {}
    );
    const m = Number(res);
    const mult = Number.isFinite(m) && m > 0 ? m : null;
    cache.set(key, mult);
    return mult;
  } catch (e) {
    cache.set(key, null);
    return null;
  }
}

// -------------------- Excel --------------------
function buildWorkbook(sheets) {
  const wb = xlsx.utils.book_new();
  for (const [name, data] of Object.entries(sheets)) {
    const ws = xlsx.utils.json_to_sheet(data);
    xlsx.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  }
  return wb;
}
function saveWorkbook(wb, filePath) {
  xlsx.writeFile(wb, filePath);
}

// -------------------- MAIN --------------------
async function main() {
  assertCfg();
  const uid = await authenticate();

  console.log(`✅ Login OK (uid=${uid})`);
  console.log(`   - LOCATION_FILTER: ${CFG.locationFilter}`);
  console.log(`   - ONLY_POSITIVE_QTY: ${CFG.onlyPositiveQty ? "1" : "0"}`);
  console.log(`   - AUDIT_ALL_COMPANIES: ${CFG.auditAllCompanies ? "1" : "0"}`);
  console.log(`   - TARGET_CURRENCY: ${CFG.targetCurrencyCode}`);
  console.log(`   - CONVERSION_DATE: ${CFG.conversionDate}`);

  // Moneda objetivo
  const targetCurrency = await fetchCurrencyByCode(uid, CFG.targetCurrencyCode);
  const targetCurrencyId = targetCurrency.id;

  // Compañías y su moneda
  const companies = await fetchCompanies(uid);
  const companyById = new Map(companies.map((c) => [c.id, c]));
  console.log(`✅ Compañías detectadas: ${companies.length}`);

  // Ubicaciones B2C
  const locations = await fetchB2CLocations(uid);
  if (!locations.length) {
    console.error(`❌ No se encontraron ubicaciones internas con filtro "${CFG.locationFilter}".`);
    process.exit(1);
  }
  console.log(`✅ Ubicaciones encontradas: ${locations.length}`);
  const locationIds = locations.map((l) => l.id);

  // Quants
  let quants = await fetchAllQuantsForLocations(uid, locationIds);
  if (CFG.onlyPositiveQty) quants = quants.filter((q) => toNum(q.quantity) > 0);

  // Productos únicos
  const productIds = uniq(quants.map((q) => q.product_id?.[0]).filter(Boolean));
  console.log(`✅ Productos únicos en esos quants: ${productIds.length}`);

  // Leer products con contexto actual
  const productsDefault = await fetchProductsRead(uid, productIds);
  const productMapDefault = new Map(productsDefault.map((p) => [p.id, p]));

  // Templates
  const tmplIdsAll = uniq(
    productsDefault
      .map((p) => (Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id))
      .filter(Boolean)
  );

  // Supplierinfo (vendor prices + currency)
  console.log(`⏳ Descargando supplierinfo (product.supplierinfo) para ${tmplIdsAll.length} templates...`);
  let supplierinfo = [];
  try {
    supplierinfo = await fetchSupplierinfo(uid, tmplIdsAll);
    console.log(`✅ supplierinfo descargados: ${supplierinfo.length}`);
  } catch (e) {
    console.warn(`⚠️ No se pudo leer product.supplierinfo (posibles permisos). Error: ${e?.message || e}`);
  }

  // Index supplierinfo por template
  const supplierByTmpl = new Map();
  for (const s of supplierinfo) {
    const tid = Array.isArray(s.product_tmpl_id) ? s.product_tmpl_id[0] : s.product_tmpl_id;
    if (!tid) continue;
    if (!supplierByTmpl.has(tid)) supplierByTmpl.set(tid, []);
    supplierByTmpl.get(tid).push(s);
  }

  // Cache para multiplicadores de conversión
  const multCache = new Map();

  // Helper: conversión a moneda objetivo dado (fromCurrencyId, companyId)
  async function convertAmount(uidLocal, fromCurrencyId, amount, companyId) {
    if (!fromCurrencyId || !companyId) return { mult: null, converted: null };
    if (fromCurrencyId === targetCurrencyId) return { mult: 1.0, converted: amount };
    const mult = await getMultiplier(uidLocal, fromCurrencyId, targetCurrencyId, companyId, CFG.conversionDate, multCache);
    return { mult, converted: mult ? amount * mult : null };
  }

  // Enriquecer quants con:
  // - coste standard_price (contexto actual)
  // - moneda de la compañía del quant (moneda real del coste contable)
  // - conversión del coste a EUR (si se puede)
  // - supplier price + currency_id (lo de tu captura) + conversión a EUR
  const quantsEnriched = [];
  for (const q of quants) {
    const pid = q.product_id?.[0];
    const p = pid ? productMapDefault.get(pid) : null;

    const qty = toNum(q.quantity);
    const reserved = toNum(q.reserved_quantity);

    const quantCompanyId = Array.isArray(q.company_id) ? q.company_id[0] : q.company_id;
    const quantCompanyName = q.company_id?.[1] || "";
    const comp = quantCompanyId ? companyById.get(quantCompanyId) : null;

    // standard_price leído en contexto actual (puede venir 0 por multi-compañía)
    const costCtx = toNum(p?.standard_price);

    // moneda de la compañía del quant (si existe)
    const companyCurrencyId = comp?.currency_id || null;
    const companyCurrencyCode = comp?.currency_code || "";

    // conversion coste_ctx -> EUR (ojo: esto convierte el "costCtx" asumiendo que está en la moneda de la compañía del quant.
    // Si costCtx viene de un contexto diferente, puede no ser perfecto, pero te sirve para detectar monedas distintas.)
    const costCtxConv = await convertAmount(uid, companyCurrencyId, costCtx, quantCompanyId);

    // Supplierinfo (vendor price) por template
    const tmplId = Array.isArray(p?.product_tmpl_id) ? p.product_tmpl_id[0] : p?.product_tmpl_id;
    const supRows = tmplId ? (supplierByTmpl.get(tmplId) || []) : [];
    const bestSup = pickBestSupplierinfo(supRows);

    const supplier_price = bestSup ? toNum(bestSup.price) : null;
    const supplier_currency_id = bestSup && Array.isArray(bestSup.currency_id) ? bestSup.currency_id[0] : null;
    const supplier_currency = bestSup && Array.isArray(bestSup.currency_id) ? bestSup.currency_id[1] : null;
    const supplier_vendor = bestSup && Array.isArray(bestSup.partner_id) ? bestSup.partner_id[1] : null;
    const supplier_min_qty = bestSup ? toNum(bestSup.min_qty) : null;
    const supplier_company = bestSup && Array.isArray(bestSup.company_id) ? bestSup.company_id[1] : null;

    // Convert supplier price a EUR usando la compañía del quant si existe; si no, intenta con company_id del supplierinfo (si existe)
    const supplierCompanyIdForConvert =
      quantCompanyId ||
      (bestSup && Array.isArray(bestSup.company_id) ? bestSup.company_id[0] : null);

    const supplierConv = supplier_price !== null
      ? await convertAmount(uid, supplier_currency_id, supplier_price, supplierCompanyIdForConvert)
      : { mult: null, converted: null };

    quantsEnriched.push({
      location: q.location_id?.[1] || "",
      product_id: pid || "",
      default_code: p?.default_code || "",
      product_name: p?.name || q.product_id?.[1] || "",

      qty,
      reserved_qty: reserved,

      company_quant: quantCompanyName,
      company_currency: companyCurrencyCode,

      // COSTE (standard_price) - contexto actual
      cost_standard_price_context: costCtx,
      value_context: qty * costCtx,

      // COSTE convertido a EUR (si se pudo obtener rate)
      rate_company_to_target: costCtxConv.mult,
      cost_context_in_target: costCtxConv.converted,
      value_context_in_target: costCtxConv.converted !== null ? qty * costCtxConv.converted : null,

      // Supplierinfo (precio proveedor + moneda)
      supplier_price,
      supplier_currency,
      supplier_rate_to_target: supplierConv.mult,
      supplier_price_in_target: supplierConv.converted,

      supplier_vendor,
      supplier_min_qty,
      supplier_company,

      package: q.package_id?.[1] || "",
      in_date: q.in_date || "",
    });
  }

  // Coste 0 en contexto actual
  const zeroCostPids = uniq(productsDefault.filter((pp) => toNum(pp.standard_price) === 0).map((pp) => pp.id));
  console.log(`⚠️ Productos con coste 0 (compañía/ctx actual): ${zeroCostPids.length}`);

  const zeroCostProducts = zeroCostPids.map((pid) => {
    const p = productMapDefault.get(pid);
    const tmplId = Array.isArray(p?.product_tmpl_id) ? p.product_tmpl_id[0] : p?.product_tmpl_id;

    // monedas proveedor detectadas (puede haber varias)
    const supRows = tmplId ? (supplierByTmpl.get(tmplId) || []) : [];
    const supCurrencies = uniq(supRows.map((s) => (Array.isArray(s.currency_id) ? s.currency_id[1] : null)).filter(Boolean));

    return {
      product_id: pid,
      default_code: p?.default_code || "",
      name: p?.name || "",
      product_tmpl_id: tmplId || "",
      standard_price_context: toNum(p?.standard_price),
      supplier_currencies_seen: supCurrencies.join(" | "),
      supplierinfo_rows: supRows.length,
    };
  });

  // Diagnóstico multi-compañía para standard_price con lectura SEGURA
  const costsByCompany = new Map(); // pid -> { companyId: {cost, currency_code, cost_eur} }
  const blocked = [];

  if (CFG.auditAllCompanies && zeroCostPids.length) {
    console.log("🔎 Leyendo standard_price por compañía (allowed_company_ids) con modo SEGURO...");

    for (const c of companies) {
      const ctx = { allowed_company_ids: [c.id], company_id: c.id };

      const rows = await safeReadProducts(uid, zeroCostPids, ctx, (pid, err) => {
        blocked.push({ company_id: c.id, company: c.name, product_id: pid, error: err });
      });

      // multiplicador moneda compañía -> EUR
      const mult = c.currency_id
        ? await getMultiplier(uid, c.currency_id, targetCurrencyId, c.id, CFG.conversionDate, multCache)
        : null;

      for (const r of rows) {
        if (!costsByCompany.has(r.id)) costsByCompany.set(r.id, {});
        const cost = toNum(r.standard_price);
        costsByCompany.get(r.id)[c.id] = {
          company: c.name,
          currency: c.currency_code,
          cost_company_currency: cost,
          rate_to_target: mult,
          cost_target: mult ? cost * mult : null,
        };
      }

      const blockedCount = blocked.filter((b) => b.company_id === c.id).length;
      process.stdout.write(`\r   ... compañía ${c.id} (${c.name}) OK (leídos ${rows.length}, bloqueados ${blockedCount})`);
    }
    process.stdout.write("\n");
  }

  // Hoja diagnóstico
  const diagnostic = zeroCostPids.map((pid) => {
    const p = productMapDefault.get(pid);
    const tmplId = Array.isArray(p?.product_tmpl_id) ? p.product_tmpl_id[0] : p?.product_tmpl_id;

    // supplier currencies (todas las que existan)
    const supRows = tmplId ? (supplierByTmpl.get(tmplId) || []) : [];
    const supplierCurrencies = uniq(supRows.map((s) => (Array.isArray(s.currency_id) ? s.currency_id[1] : null)).filter(Boolean));
    const supplierCurrencyStr = supplierCurrencies.join(" | ");

    const perComp = costsByCompany.get(pid) || {};
    const nonZero = Object.values(perComp)
      .filter((x) => toNum(x.cost_company_currency) !== 0)
      .map((x) => {
        const ccy = x.currency || "";
        const base = `${x.company}:${toMoney4(x.cost_company_currency)} ${ccy}`;
        const eur = x.cost_target !== null ? ` (EUR:${toMoney4(x.cost_target)})` : "";
        return base + eur;
      });

    const currenciesSeenInCost = uniq(Object.values(perComp).map((x) => x.currency).filter(Boolean)).join(" | ");

    const suggestedCause = nonZero.length
      ? "MULTI-COMPANY / CONTEXTO (coste existe en otra compañía)"
      : "COSTE 0 REAL / O PERMISOS";

    return {
      product_id: pid,
      default_code: p?.default_code || "",
      name: p?.name || "",
      standard_price_context: toNum(p?.standard_price),
      currencies_seen_in_cost_by_company: currenciesSeenInCost,
      supplier_currencies_seen: supplierCurrencyStr,
      non_zero_companies_costs: nonZero.join(" | "),
      suggested_cause: suggestedCause,
    };
  });

  // Resumen y métricas de monedas
  const totalValueContext = quantsEnriched.reduce((acc, r) => acc + toNum(r.value_context), 0);
  const totalValueTargetKnown = quantsEnriched.reduce((acc, r) => acc + (r.value_context_in_target === null ? 0 : toNum(r.value_context_in_target)), 0);

  const companyCurrenciesInQuants = uniq(quantsEnriched.map((r) => r.company_currency).filter(Boolean));
  const supplierCurrenciesInQuants = uniq(quantsEnriched.map((r) => r.supplier_currency).filter(Boolean));

  const linesSupplierJPY = quantsEnriched.filter((r) => (r.supplier_currency || "").toUpperCase().includes("JPY") || (r.supplier_currency || "").toUpperCase().includes("YEN") || (r.supplier_currency || "").toUpperCase().includes("YN")).length;
  const linesSupplierUSD = quantsEnriched.filter((r) => (r.supplier_currency || "").toUpperCase().includes("USD")).length;

  const summary = [
    { metric: "Filtro ubicaciones (LOCATION_FILTER)", value: CFG.locationFilter },
    { metric: "ONLY_POSITIVE_QTY", value: CFG.onlyPositiveQty ? "1" : "0" },
    { metric: "AUDIT_ALL_COMPANIES", value: CFG.auditAllCompanies ? "1" : "0" },
    { metric: "CONVERSION_DATE", value: CFG.conversionDate },
    { metric: "TARGET_CURRENCY", value: CFG.targetCurrencyCode },

    { metric: "Quants descargados", value: quants.length },
    { metric: "Productos únicos en quants", value: productIds.length },
    { metric: "Templates únicos en quants", value: tmplIdsAll.length },

    { metric: "Productos con coste 0 (ctx actual)", value: zeroCostPids.length },
    { metric: "Bloqueados por seguridad (auditoría)", value: blocked.length },

    { metric: "Monedas compañía detectadas (quants)", value: companyCurrenciesInQuants.join(" | ") },
    { metric: "Monedas proveedor detectadas (supplierinfo)", value: supplierCurrenciesInQuants.join(" | ") },
    { metric: "Líneas con supplier_currency ~ JPY/YN", value: linesSupplierJPY },
    { metric: "Líneas con supplier_currency USD", value: linesSupplierUSD },

    { metric: "Valor total (qty * coste ctx)", value: totalValueContext },
    { metric: "Valor total en moneda objetivo (solo líneas con conversión)", value: totalValueTargetKnown },
  ];

  // Export
  const outFile = `odoo_audit_b2c_FULL_${new Date().toISOString().slice(0, 10)}.xlsx`;
  const wb = buildWorkbook({
    Resumen: summary,
    Quants_B2C: quantsEnriched,
    Productos_Coste_0: zeroCostProducts,
    Diagnostico_Coste_0: diagnostic,
    Bloqueados_por_seguridad: blocked,
  });
  saveWorkbook(wb, outFile);

  console.log(`✅ Export generado: ${outFile}`);
  console.log(`   - Filtra Quants_B2C por supplier_currency = USD / JPY para detectar conversiones de proveedor.`);
  console.log(`   - Filtra Diagnostico_Coste_0 para ver si el coste 0 es por MULTI-COMPANY.`);
}

main().catch((e) => {
  console.error("❌ Error fatal:", e?.message || e);
  process.exit(1);
});
