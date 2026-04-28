import xmlrpc from 'xmlrpc';
import { getOdooConfig } from './src/config/odooConfig.js';

// Obtener configuración de variables de entorno
const ODOO_CONFIG = getOdooConfig();

async function diagnoseLocation(locationName) {
  console.log(` 🕵️  Iniciando diagnóstico para: ${locationName}...`);
  
  const common = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/common` });
  const models = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/object` });

  try {
    // 1. Autenticación
    console.log(" 🔑  Autenticando...");
    const uid = await new Promise((resolve, reject) => {
      common.methodCall('authenticate', [
        ODOO_CONFIG.db, ODOO_CONFIG.username, ODOO_CONFIG.password, {}
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    if (!uid) {
        console.error(" ❌  Fallo de autenticación. Revisa usuario/contraseña.");
        return;
    }
    console.log(" ✅  Conectado.");

    // 2. Buscar el ID de la ubicación por nombre exacto
    console.log(` 🔎  Buscando ID de la ubicación '${locationName}'...`);
    const locs = await new Promise((resolve) => {
        models.methodCall('execute_kw', [
            ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
            'stock.location', 'search_read', 
            [[['name', '=', locationName]]], // Búsqueda exacta
            { fields: ['id', 'name'] }
        ], (err, res) => resolve(res || []));
    });

    if (locs.length === 0) {
        console.log(" ❌  Ubicación NO encontrada en Odoo. ¿Está bien escrito el nombre?");
        return;
    }
    
    const locationId = locs[0].id;
    console.log(` ✅  Ubicación encontrada. ID interno: ${locationId}`);

    // 3. Sacar todo el stock (Quants) de esa ubicación
    console.log(" 📦  Descargando contenido...");
    const quants = await new Promise((resolve) => {
        models.methodCall('execute_kw', [
            ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
            'stock.quant', 'search_read', 
            [[['location_id', '=', locationId]]],
            { fields: ['package_id', 'product_id', 'quantity'] }
        ], (err, res) => resolve(res || []));
    });

    if (quants.length === 0) {
        console.log(" ⚠️  La ubicación aparece VACÍA en Odoo (0 quants).");
    } else {
        console.log(`\n 📊  RESULTADOS (${quants.length} líneas de stock):`);
        console.log(" ==================================================");
        
        quants.forEach(q => {
            const pkgName = q.package_id ? q.package_id[1] : "SIN PAQUETE";
            const prodName = q.product_id[1];
            
            // Simulación de nuestra nueva lógica de detección
            let detectedBrand = "GENERIC";
            const searchStr = (pkgName + " " + prodName).toUpperCase();
            
            if (searchStr.includes("IBGB") || searchStr.includes("BLACK") || searchStr.includes("DF")) detectedBrand = "BLACK";
            else if (searchStr.includes("IBGG") || searchStr.includes("GOLD") || searchStr.includes("CO")) detectedBrand = "GOLD";
            else if (searchStr.includes("IBGW") || searchStr.includes("WHITE") || searchStr.includes("KA")) detectedBrand = "WHITE";

            // Coloreamos la salida para ver claro el problema
            const icon = detectedBrand === "BLACK" ? "⚫" : detectedBrand === "GOLD" ? "🟡" : "⚪";
            
            console.log(` ${icon} MARCA: ${detectedBrand.padEnd(7)} | PAQ: ${pkgName.padEnd(25)} | REF: ${prodName} (${q.quantity}u)`);
        });
        console.log(" ==================================================");
    }

  } catch (error) {
    console.error(" ❌  ERROR FATAL:", error);
  }
}

// Ejecutamos
diagnoseLocation('CLA-009-05-03-03');