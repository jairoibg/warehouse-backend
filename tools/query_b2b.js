// query_b2b.js - Ejecutar en warehouse-backend para ver ubicaciones B2B
// Uso: node query_b2b.js

import 'dotenv/config';
import xmlrpc from 'xmlrpc';

// --- CONFIGURACIÓN ODOO ---
const ODOO_CONFIG = {
    url: process.env.ODOO_URL,
    db: process.env.ODOO_DB,
    username: process.env.ODOO_USERNAME,
    password: process.env.ODOO_PASSWORD,
};

// Crear clientes XML-RPC
function createClients() {
    const urlObj = new URL(ODOO_CONFIG.url);
    const isSecure = urlObj.protocol === 'https:';
    const clientCreator = isSecure ? xmlrpc.createSecureClient : xmlrpc.createClient;
    
    return {
        common: clientCreator({ host: urlObj.hostname, port: urlObj.port || (isSecure ? 443 : 80), path: '/xmlrpc/2/common' }),
        models: clientCreator({ host: urlObj.hostname, port: urlObj.port || (isSecure ? 443 : 80), path: '/xmlrpc/2/object' })
    };
}

// Autenticar
function authenticate(client) {
    return new Promise((resolve, reject) => {
        client.methodCall('authenticate', [ODOO_CONFIG.db, ODOO_CONFIG.username, ODOO_CONFIG.password, {}], (err, uid) => {
            if (err) reject(err);
            else resolve(uid);
        });
    });
}

// Ejecutar consulta
function executeKw(client, uid, model, method, args, kwargs = {}) {
    return new Promise((resolve, reject) => {
        client.methodCall('execute_kw', [ODOO_CONFIG.db, uid, ODOO_CONFIG.password, model, method, args, kwargs], (err, result) => {
            if (err) reject(err);
            else resolve(result);
        });
    });
}

async function queryB2BLocations() {
    console.log('🔌 Conectando a Odoo...');
    const { common, models } = createClients();
    
    const uid = await authenticate(common);
    console.log('✅ Conectado a Odoo (UID:', uid, ')\n');

    // Buscar ubicaciones que contengan "B2B"
    const locations = await executeKw(models, uid, 'stock.location', 'search_read', [
        [['usage', '=', 'internal'], ['complete_name', 'ilike', 'B2B']]
    ], { fields: ['id', 'name', 'complete_name', 'barcode'] });

    console.log(`📦 Encontradas ${locations.length} ubicaciones B2B:\n`);

    // Extraer patrones únicos
    const aisles = new Set();
    const blocks = new Set();
    const levels = new Set();
    const positions = new Set();

    locations.forEach(loc => {
        const match = loc.complete_name.match(/CLA-(\d{3})-(\d{2})-(\d{2})-(\d{2})/);
        if (match) {
            aisles.add(match[1]);
            blocks.add(match[2]);
            levels.add(match[3]);
            positions.add(match[4]);
        }
    });

    console.log('📊 RESUMEN DE RANGOS B2B:');
    console.log('========================');
    console.log(`Pasillos: ${[...aisles].sort().join(', ')}`);
    console.log(`Bloques: ${[...blocks].sort().join(', ')}`);
    console.log(`Niveles: ${[...levels].sort().join(', ')}`);
    console.log(`Posiciones: ${[...positions].sort().join(', ')}`);
    console.log(`\nTotal ubicaciones: ${locations.length}`);

    // Mostrar primeras 20 como ejemplo
    console.log('\n📋 Primeras 20 ubicaciones (ejemplo):');
    locations.slice(0, 20).forEach(loc => {
        console.log(`  ${loc.complete_name}`);
    });

    return locations;
}

queryB2BLocations()
    .then(() => {
        console.log('\n✅ Consulta completada');
        process.exit(0);
    })
    .catch(err => {
        console.error('❌ Error:', err);
        process.exit(1);
    });