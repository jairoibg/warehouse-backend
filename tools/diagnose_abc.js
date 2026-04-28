import xmlrpc from 'xmlrpc';
import { getOdooConfig } from './src/config/odooConfig.js';

// Obtener configuración de variables de entorno
const ODOO_CONFIG = getOdooConfig();

async function diagnose() {
    const common = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/common` });
    const models = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/object` });

    const uid = await new Promise((resolve, reject) => {
        common.methodCall('authenticate', [
            ODOO_CONFIG.db, ODOO_CONFIG.username, ODOO_CONFIG.password, {}
        ], (err, res) => err ? reject(err) : resolve(res));
    });

    console.log("✅ Conectado. Analizando tabla 'abc.classification.product.level'...");

    // 1. OBTENER CAMPOS DE LA TABLA
    const fields = await new Promise((resolve) => {
        models.methodCall('execute_kw', [
            ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
            'abc.classification.product.level', 'fields_get', [], 
            { attributes: ['string', 'type'] }
        ], (err, res) => resolve(res));
    });

    console.log("\n📋 CAMPOS DISPONIBLES:");
    Object.keys(fields).forEach(key => {
        console.log(`   - [${key}]: ${fields[key].string} (${fields[key].type})`);
    });

    // 2. LEER UN REGISTRO DE EJEMPLO
    const sample = await new Promise((resolve) => {
        models.methodCall('execute_kw', [
            ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
            'abc.classification.product.level', 'search_read', [[]], 
            { limit: 1 }
        ], (err, res) => resolve(res));
    });

    console.log("\n📦 EJEMPLO DE DATOS:", sample);
}

diagnose().catch(console.error);