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

async function exploreProductSeason() {
    console.log('🗓️ EXPLORADOR DE TEMPORADAS (product.season)');
    console.log('=============================================\n');
    
    const { common, models } = createClients();
    const uid = await authenticate(common);
    console.log('✅ Conectado a Odoo\n');

    // 1. Ver estructura del modelo product.season
    console.log('📋 1. CAMPOS DE product.season');
    console.log('─────────────────────────────────');
    
    try {
        const seasonFields = await executeKw(models, uid, 'product.season', 'fields_get', [], {
            attributes: ['string', 'type']
        });
        
        Object.entries(seasonFields).forEach(([key, val]) => {
            if (!key.startsWith('__') && !key.startsWith('message_') && !key.startsWith('activity_')) {
                console.log(`  - ${key}: "${val.string}" (${val.type})`);
            }
        });
    } catch (e) {
        console.log('Error:', e.message);
    }

    // 2. Ver todos los valores de temporadas disponibles
    console.log('\n📅 2. TEMPORADAS DISPONIBLES');
    console.log('─────────────────────────────────');
    
    try {
        const seasons = await executeKw(models, uid, 'product.season', 'search_read', [
            []
        ], {
            fields: ['id', 'name', 'code', 'active'],
            order: 'name desc'
        });
        
        console.log(`Total temporadas: ${seasons.length}\n`);
        seasons.forEach(s => {
            const status = s.active === false ? ' (INACTIVA)' : '';
            console.log(`  [${s.id}] ${s.name} ${s.code ? `(${s.code})` : ''}${status}`);
        });
    } catch (e) {
        console.log('Error:', e.message);
    }

    // 3. Ver productos con su temporada
    console.log('\n📦 3. MUESTRA DE PRODUCTOS CON TEMPORADA');
    console.log('─────────────────────────────────────────────');
    
    try {
        const products = await executeKw(models, uid, 'product.template', 'search_read', [
            [['sale_season_id', '!=', false]]
        ], {
            fields: ['name', 'default_code', 'sale_season_id', 'launch_season', 'standard_price', 'list_price'],
            limit: 10
        });
        
        console.log(`Mostrando ${products.length} productos con temporada:\n`);
        products.forEach((p, i) => {
            console.log(`${i+1}. ${p.name?.substring(0, 50)}...`);
            console.log(`   Temp. Venta: ${p.sale_season_id ? p.sale_season_id[1] : 'N/A'}`);
            console.log(`   Temp. Lanzamiento: ${p.launch_season ? p.launch_season[1] : 'N/A'}`);
            console.log(`   Coste: €${p.standard_price?.toFixed(2)} | PVP: €${p.list_price?.toFixed(2)}`);
        });
    } catch (e) {
        console.log('Error:', e.message);
    }

    // 4. Contar productos por temporada de venta
    console.log('\n📊 4. DISTRIBUCIÓN DE STOCK POR TEMPORADA');
    console.log('─────────────────────────────────────────────');
    
    try {
        const seasons = await executeKw(models, uid, 'product.season', 'search_read', [
            []
        ], {
            fields: ['id', 'name']
        });
        
        for (const season of seasons.slice(0, 10)) {
            const count = await executeKw(models, uid, 'product.template', 'search_count', [
                [['sale_season_id', '=', season.id]]
            ]);
            if (count > 0) {
                console.log(`  ${season.name}: ${count} productos`);
            }
        }
    } catch (e) {
        console.log('Error:', e.message);
    }

    // 5. Identificar temporada actual
    console.log('\n🎯 5. DETERMINAR TEMPORADA ACTUAL');
    console.log('─────────────────────────────────────────────');
    
    const now = new Date();
    const month = now.getMonth() + 1; // 1-12
    const year = now.getFullYear() % 100; // 24, 25, etc.
    
    // En moda: Primavera/Verano (SS) = Feb-Jul, Otoño/Invierno (FW) = Ago-Ene
    let currentSeason;
    if (month >= 2 && month <= 7) {
        currentSeason = `V${year}`; // Verano
    } else {
        currentSeason = `I${month >= 8 ? year : year + 1}`; // Invierno
    }
    
    console.log(`  Fecha actual: ${now.toLocaleDateString('es-ES')}`);
    console.log(`  Temporada estimada: ${currentSeason} (Verano) o I${year + 1} (Invierno)`);
    console.log(`  \n  NOTA: Verifica cuál es vuestra nomenclatura real (V25, I25, SS25, FW25, etc.)`);
}

exploreProductSeason().catch(console.error);