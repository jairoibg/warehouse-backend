// test_movements.js
// Ejecutar: node test_movements.js

import 'dotenv/config';
import xmlrpc from 'xmlrpc';

const ODOO_CONFIG = {
    url: process.env.ODOO_URL,
    db: process.env.ODOO_DB,
    username: process.env.ODOO_USERNAME,
    password: process.env.ODOO_PASSWORD,
};

function createClients() {
    const urlObj = new URL(ODOO_CONFIG.url);
    return {
        common: xmlrpc.createSecureClient({ host: urlObj.hostname, port: 443, path: '/xmlrpc/2/common' }),
        models: xmlrpc.createSecureClient({ host: urlObj.hostname, port: 443, path: '/xmlrpc/2/object' })
    };
}

function authenticate(client) {
    return new Promise((resolve, reject) => {
        client.methodCall('authenticate', [ODOO_CONFIG.db, ODOO_CONFIG.username, ODOO_CONFIG.password, {}], (err, uid) => {
            if (err) reject(err);
            else resolve(uid);
        });
    });
}

function executeKw(client, uid, model, method, args, kwargs = {}) {
    return new Promise((resolve, reject) => {
        client.methodCall('execute_kw', [ODOO_CONFIG.db, uid, ODOO_CONFIG.password, model, method, args, kwargs], (err, result) => {
            if (err) reject(err);
            else resolve(result);
        });
    });
}

async function testMovements() {
    console.log('🔌 Conectando a Odoo...');
    const { common, models } = createClients();
    const uid = await authenticate(common);
    console.log('✅ Conectado (UID:', uid, ')\n');

    // Probar stock.move.line (historial detallado)
    console.log('📦 Probando stock.move.line...');
    try {
        const moveLines = await executeKw(models, uid, 'stock.move.line', 'search_read', [
            [['state', '=', 'done']]
        ], { 
            fields: ['location_id', 'location_dest_id', 'product_id', 'qty_done', 'date', 'reference', 'picking_id', 'package_id', 'result_package_id'], 
            limit: 5,
            order: 'date desc'
        });
        
        console.log(`\n✅ stock.move.line - Encontrados ${moveLines.length} registros:`);
        moveLines.forEach((m, i) => {
            console.log(`\n--- Movimiento ${i + 1} ---`);
            console.log(`  Fecha: ${m.date}`);
            console.log(`  Origen: ${m.location_id ? m.location_id[1] : 'N/A'}`);
            console.log(`  Destino: ${m.location_dest_id ? m.location_dest_id[1] : 'N/A'}`);
            console.log(`  Producto: ${m.product_id ? m.product_id[1] : 'N/A'}`);
            console.log(`  Cantidad: ${m.qty_done}`);
            console.log(`  Referencia: ${m.reference || 'N/A'}`);
            console.log(`  Paquete origen: ${m.package_id ? m.package_id[1] : 'N/A'}`);
            console.log(`  Paquete destino: ${m.result_package_id ? m.result_package_id[1] : 'N/A'}`);
        });
    } catch (e) {
        console.log('❌ Error en stock.move.line:', e.message);
    }

    // Probar búsqueda por ubicación específica
    console.log('\n\n📍 Probando búsqueda por ubicación específica (EXTB2B)...');
    try {
        const movesByLocation = await executeKw(models, uid, 'stock.move.line', 'search_read', [
            [
                ['state', '=', 'done'],
                '|',
                ['location_id.complete_name', 'ilike', 'EXTB2B'],
                ['location_dest_id.complete_name', 'ilike', 'EXTB2B']
            ]
        ], { 
            fields: ['location_id', 'location_dest_id', 'product_id', 'qty_done', 'date', 'reference', 'package_id'], 
            limit: 3,
            order: 'date desc'
        });
        
        console.log(`✅ Movimientos B2B encontrados: ${movesByLocation.length}`);
        movesByLocation.forEach((m, i) => {
            console.log(`  ${i + 1}. ${m.date} | ${m.location_id[1]} → ${m.location_dest_id[1]}`);
        });
    } catch (e) {
        console.log('❌ Error buscando por ubicación:', e.message);
    }

    console.log('\n✅ Test completado');
}

testMovements().catch(console.error);