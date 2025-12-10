import 'dotenv/config';
import xmlrpc from 'xmlrpc';

// ==================================================================================
//  EXPLORADOR DE TEMPORADAS EN ODOO
//  Objetivo: Encontrar dónde está "temporada de venta" y "temporada de lanzamiento"
// ==================================================================================

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

async function exploreSeasons() {
    console.log('🔍 EXPLORADOR DE TEMPORADAS EN ODOO');
    console.log('====================================\n');
    
    const { common, models } = createClients();
    const uid = await authenticate(common);
    console.log('✅ Conectado a Odoo\n');

    // ==================================================================================
    // 1. BUSCAR CAMPOS EN product.template (modelo/plantilla)
    // ==================================================================================
    console.log('📦 1. CAMPOS EN product.template (Modelo del producto)');
    console.log('─────────────────────────────────────────────────────────');
    
    const templateFields = await executeKw(models, uid, 'product.template', 'fields_get', [], {
        attributes: ['string', 'type', 'relation']
    });
    
    // Filtrar campos que contengan "temporada", "season", "launch", "venta", "lanzamiento"
    const seasonKeywords = ['temporada', 'season', 'launch', 'venta', 'lanzamiento', 'collection', 'colec'];
    const relevantTemplateFields = Object.entries(templateFields).filter(([key, val]) => {
        const searchText = (key + ' ' + (val.string || '')).toLowerCase();
        return seasonKeywords.some(kw => searchText.includes(kw));
    });
    
    if (relevantTemplateFields.length > 0) {
        console.log('Campos relacionados con temporada encontrados:');
        relevantTemplateFields.forEach(([key, val]) => {
            console.log(`  ✓ ${key}`);
            console.log(`    Etiqueta: "${val.string}"`);
            console.log(`    Tipo: ${val.type}${val.relation ? ` → ${val.relation}` : ''}`);
        });
    } else {
        console.log('No se encontraron campos con palabras clave de temporada.');
        console.log('Buscando todos los campos many2one y selection...');
        
        const potentialFields = Object.entries(templateFields).filter(([key, val]) => {
            return val.type === 'many2one' || val.type === 'selection';
        }).slice(0, 20);
        
        potentialFields.forEach(([key, val]) => {
            console.log(`  - ${key}: "${val.string}" (${val.type}${val.relation ? ` → ${val.relation}` : ''})`);
        });
    }

    // ==================================================================================
    // 2. BUSCAR CAMPOS EN product.product (variante)
    // ==================================================================================
    console.log('\n📦 2. CAMPOS EN product.product (Variante del producto)');
    console.log('─────────────────────────────────────────────────────────');
    
    const productFields = await executeKw(models, uid, 'product.product', 'fields_get', [], {
        attributes: ['string', 'type', 'relation']
    });
    
    const relevantProductFields = Object.entries(productFields).filter(([key, val]) => {
        const searchText = (key + ' ' + (val.string || '')).toLowerCase();
        return seasonKeywords.some(kw => searchText.includes(kw));
    });
    
    if (relevantProductFields.length > 0) {
        console.log('Campos relacionados con temporada encontrados:');
        relevantProductFields.forEach(([key, val]) => {
            console.log(`  ✓ ${key}`);
            console.log(`    Etiqueta: "${val.string}"`);
            console.log(`    Tipo: ${val.type}${val.relation ? ` → ${val.relation}` : ''}`);
        });
    } else {
        console.log('No se encontraron campos específicos de temporada en variantes.');
    }

    // ==================================================================================
    // 3. MUESTRA DE DATOS REALES DE UN PRODUCTO
    // ==================================================================================
    console.log('\n📋 3. MUESTRA DE DATOS REALES DE PRODUCTOS');
    console.log('─────────────────────────────────────────────────────────');
    
    // Obtener todos los campos de unos productos de ejemplo
    const sampleProducts = await executeKw(models, uid, 'product.product', 'search_read', [
        [['type', '=', 'product'], ['default_code', '!=', false]]
    ], {
        fields: [], // Vacío = todos los campos
        limit: 3
    });
    
    if (sampleProducts.length > 0) {
        console.log(`\nAnalizando ${sampleProducts.length} productos de muestra...`);
        
        sampleProducts.forEach((prod, idx) => {
            console.log(`\n--- Producto ${idx + 1}: [${prod.default_code}] ${prod.name?.substring(0, 50)}... ---`);
            
            // Buscar campos que contengan valores de temporada
            Object.entries(prod).forEach(([key, val]) => {
                if (val && typeof val === 'string') {
                    const valLower = val.toLowerCase();
                    if (seasonKeywords.some(kw => valLower.includes(kw)) || 
                        /^[IViv]\d{2}$/.test(val) || // Patrón I24, V25, etc.
                        /^(SS|FW|AW)\d{2}$/i.test(val)) { // Patrón SS24, FW25, etc.
                        console.log(`  🎯 ${key}: "${val}"`);
                    }
                }
                // También buscar en arrays [id, name]
                if (Array.isArray(val) && val.length === 2 && typeof val[1] === 'string') {
                    const valLower = val[1].toLowerCase();
                    if (seasonKeywords.some(kw => valLower.includes(kw)) ||
                        /[IViv]\d{2}/.test(val[1]) ||
                        /(SS|FW|AW)\d{2}/i.test(val[1])) {
                        console.log(`  🎯 ${key}: [${val[0]}, "${val[1]}"]`);
                    }
                }
            });
        });
    }

    // ==================================================================================
    // 4. BUSCAR MODELOS RELACIONADOS CON TEMPORADA
    // ==================================================================================
    console.log('\n🔎 4. BUSCANDO MODELOS DE TEMPORADA EN ODOO');
    console.log('─────────────────────────────────────────────────────────');
    
    try {
        // Buscar si existe un modelo de temporadas
        const irModel = await executeKw(models, uid, 'ir.model', 'search_read', [
            [['model', 'ilike', 'season']]
        ], {
            fields: ['model', 'name'],
            limit: 10
        });
        
        if (irModel.length > 0) {
            console.log('Modelos de temporada encontrados:');
            irModel.forEach(m => {
                console.log(`  ✓ ${m.model}: "${m.name}"`);
            });
        }
        
        // Buscar modelos con "temporada"
        const irModelTemp = await executeKw(models, uid, 'ir.model', 'search_read', [
            [['model', 'ilike', 'temporada']]
        ], {
            fields: ['model', 'name'],
            limit: 10
        });
        
        if (irModelTemp.length > 0) {
            console.log('Modelos con "temporada":');
            irModelTemp.forEach(m => {
                console.log(`  ✓ ${m.model}: "${m.name}"`);
            });
        }
        
        // Buscar en campos de ir.model.fields
        const seasonFieldsInSystem = await executeKw(models, uid, 'ir.model.fields', 'search_read', [
            ['|', '|', '|',
                ['name', 'ilike', 'season'],
                ['name', 'ilike', 'temporada'],
                ['field_description', 'ilike', 'temporada'],
                ['field_description', 'ilike', 'season']
            ]
        ], {
            fields: ['model', 'name', 'field_description', 'ttype', 'relation'],
            limit: 20
        });
        
        if (seasonFieldsInSystem.length > 0) {
            console.log('\nCampos de temporada en todo el sistema:');
            seasonFieldsInSystem.forEach(f => {
                console.log(`  ✓ ${f.model}.${f.name}`);
                console.log(`    "${f.field_description}" (${f.ttype}${f.relation ? ` → ${f.relation}` : ''})`);
            });
        }
        
    } catch (e) {
        console.log('Error buscando modelos:', e.message);
    }

    // ==================================================================================
    // 5. VER ESTRUCTURA DE product.template CON TODOS LOS CAMPOS
    // ==================================================================================
    console.log('\n📊 5. TODOS LOS CAMPOS DE product.template');
    console.log('─────────────────────────────────────────────────────────');
    
    // Listar todos los campos que podrían ser relevantes
    const allTemplateFields = Object.entries(templateFields)
        .filter(([key, val]) => !key.startsWith('message_') && !key.startsWith('activity_'))
        .map(([key, val]) => ({ 
            name: key, 
            label: val.string, 
            type: val.type,
            relation: val.relation 
        }));
    
    console.log(`Total campos en product.template: ${allTemplateFields.length}`);
    console.log('\nCampos many2one (relaciones):');
    allTemplateFields
        .filter(f => f.type === 'many2one')
        .forEach(f => {
            console.log(`  - ${f.name}: "${f.label}" → ${f.relation}`);
        });

    console.log('\n============================================');
    console.log('📋 SIGUIENTE PASO:');
    console.log('Dime qué campos ves en la interfaz de Odoo');
    console.log('cuando vas a la variante del producto,');
    console.log('específicamente en "Información del modelo".');
    console.log('============================================');
}

exploreSeasons().catch(console.error);