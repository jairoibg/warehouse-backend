// generate_b2b_from_odoo.js
// Descarga las ubicaciones B2B REALES de Odoo y las añade al locations.json
// Uso: node generate_b2b_from_odoo.js

import 'dotenv/config';
import xmlrpc from 'xmlrpc';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCATIONS_FILE = path.join(__dirname, 'data', 'locations.json');

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

// Detectar marca desde el ID de ubicación
function detectBrandFromLocationId(locationId) {
    if (locationId.includes('BD')) return 'BLACK';
    if (locationId.includes('GD')) return 'GOLD';
    if (locationId.includes('WD') || locationId.includes('WH')) return 'WHITE';
    return 'GENERIC';
}

// Configuración visual (coordenadas base para el frontend)
function calculateCoordinates(aisle, block, level, position, brand) {
    const aisleNum = parseInt(aisle);
    const blockNum = parseInt(block);
    const levelNum = parseInt(level);
    const posNum = parseInt(position);
    
    // Offset Y según marca para separar visualmente
    const brandOffset = { 'BLACK': 0, 'GOLD': 200, 'WHITE': 400, 'GENERIC': 600 };
    
    const x = 50 + (aisleNum * 30) + (blockNum * 3) + (posNum * 1);
    const y = 400 + (brandOffset[brand] || 0) + (levelNum * 20);
    
    return { x, y };
}

async function fetchB2BLocationsFromOdoo() {
    console.log('🔌 Conectando a Odoo...');
    const { common, models } = createClients();
    
    const uid = await authenticate(common);
    console.log('✅ Conectado a Odoo (UID:', uid, ')\n');

    // Buscar ubicaciones B2B con patrón CLA-XXX-XX-XX-XX
    console.log('📥 Descargando ubicaciones B2B de Odoo...');
    const locations = await executeKw(models, uid, 'stock.location', 'search_read', [
        [
            ['usage', '=', 'internal'], 
            ['complete_name', 'ilike', 'EXTB2B'],
            ['complete_name', 'ilike', 'CLA-']  // Solo las que tienen código de ubicación
        ]
    ], { fields: ['id', 'name', 'complete_name', 'barcode'] });

    console.log(`📦 Encontradas ${locations.length} ubicaciones B2B en Odoo\n`);

    // Procesar y convertir al formato del JSON
    const b2bLocations = [];
    const stats = { BD: 0, GD: 0, WD: 0, OTHER: 0 };

    locations.forEach(loc => {
        // Extraer el código CLA-XXX-XX-XX-XX
        const match = loc.complete_name.match(/CLA-(\d{3})-(\d{2})-(\d{2})-(\d{2})/);
        if (!match) return; // Saltar ubicaciones sin código válido

        const [, aisle, block, level, position] = match;
        const brand = detectBrandFromLocationId(loc.complete_name);
        const coords = calculateCoordinates(aisle, block, level, position, brand);

        // Contabilizar por marca
        if (loc.complete_name.includes('EXTB2BBD')) stats.BD++;
        else if (loc.complete_name.includes('EXTB2BGD')) stats.GD++;
        else if (loc.complete_name.includes('EXTB2BWD')) stats.WD++;
        else stats.OTHER++;

        b2bLocations.push({
            id: loc.complete_name,
            aisle: aisle,
            block: block,
            level: level,
            position: position,
            totalStock: 0,
            totalReserved: 0,
            status: "FREE",
            packages: [],
            x: coords.x,
            y: coords.y,
            type: "B2B",
            sinDatos: false,
            brand: brand,
            occupancyPercentage: 0,
            velocityScore: 0
        });
    });

    console.log('📊 Ubicaciones B2B por marca:');
    console.log(`   - EXTB2BBD (Black): ${stats.BD}`);
    console.log(`   - EXTB2BGD (Gold): ${stats.GD}`);
    console.log(`   - EXTB2BWD (White): ${stats.WD}`);
    if (stats.OTHER > 0) console.log(`   - Otras: ${stats.OTHER}`);

    return b2bLocations;
}

async function main() {
    try {
        // 1. Descargar ubicaciones B2B de Odoo
        const b2bLocations = await fetchB2BLocationsFromOdoo();

        if (b2bLocations.length === 0) {
            console.log('❌ No se encontraron ubicaciones B2B válidas en Odoo');
            process.exit(1);
        }

        // 2. Leer locations.json existente
        console.log('\n📖 Leyendo locations.json existente...');
        const rawData = await fs.readFile(LOCATIONS_FILE, 'utf-8');
        const existingLocations = JSON.parse(rawData);
        
        // 3. Filtrar para quedarnos solo con B2C (Storage)
        const b2cLocations = existingLocations.filter(loc => 
            loc.id.includes('Storage') && !loc.id.includes('EXTB2B')
        );
        console.log(`📍 Ubicaciones B2C existentes: ${b2cLocations.length}`);

        // 4. Combinar B2C + B2B
        const allLocations = [...b2cLocations, ...b2bLocations];
        console.log(`\n📊 RESUMEN FINAL:`);
        console.log(`   - B2C (Storage): ${b2cLocations.length}`);
        console.log(`   - B2B (EXTB2B): ${b2bLocations.length}`);
        console.log(`   - TOTAL: ${allLocations.length}`);

        // 5. Backup
        const backupFile = LOCATIONS_FILE.replace('.json', '_backup_' + Date.now() + '.json');
        await fs.writeFile(backupFile, rawData);
        console.log(`\n💾 Backup guardado en: ${backupFile}`);

        // 6. Guardar
        await fs.writeFile(LOCATIONS_FILE, JSON.stringify(allLocations, null, 2));
        console.log(`✅ locations.json actualizado con ${allLocations.length} ubicaciones`);

    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

main();