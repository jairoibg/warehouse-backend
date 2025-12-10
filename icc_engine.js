// ==================================================================================
//  ICC ENGINE - Motor de Cálculo de Coste de Almacenamiento
//  Basado en datos reales de mercado (ver justificación en documentación)
// ==================================================================================
//
//  FUENTES DE LAS TASAS:
//  - Coste Capital (10%): WACC sector moda/retail 11.74% (Aditya Birla Fashion 2024)
//  - ICC Base (20-30%): NetSuite, Fishbowl, Zoho - "20% to 30% of total inventory value"
//  - Obsolescencia Moda (40%): "Over 40% of fashion goods are eventually sold at markdown"
//  - Sell-through (70-75%): "Industry benchmark sell-through rate for fashion retailer"
//
// ==================================================================================

import 'dotenv/config';
import xmlrpc from 'xmlrpc';

// ==================================================================================
//  CONFIGURACIÓN DE TASAS ICC (JUSTIFICADAS CON DATOS DE MERCADO)
// ==================================================================================

const ICC_CONFIG = {
    // Tasa base anual (aplica a TODO el stock)
    BASE_ANNUAL_RATE: {
        capitalCost: 0.10,      // 10% - WACC sector moda/retail
        obsolescenceBase: 0.06, // 6% - Riesgo base obsolescencia moda
        riskService: 0.02,      // 2% - Seguros, mermas, daños
    },
    
    // Depreciación adicional por temporada (basada en sell-through 70-75%)
    // El 25-30% del stock no vendido en temporada va a markdown
    SEASON_DEPRECIATION_ANNUAL: {
        current: 0.00,          // Temporada actual: sin depreciación adicional
        previous_1: 0.06,       // 1 temporada atrás: +6% anual
        previous_2: 0.12,       // 2 temporadas atrás: +12% anual
        previous_3: 0.18,       // 3 temporadas atrás: +18% anual
        previous_4_plus: 0.24,  // 4+ temporadas atrás: +24% anual (liquidación)
    },
    
    // Nomenclatura de temporadas (I = Invierno, V = Verano)
    SEASON_ORDER: ['I', 'V'], // I25 → V25 → I26 → V26...
};

// ==================================================================================
//  FUNCIONES AUXILIARES
// ==================================================================================

/**
 * Parsea una temporada string (ej: "I25", "V24") a un objeto comparable
 */
function parseSeason(seasonStr) {
    if (!seasonStr || typeof seasonStr !== 'string') return null;
    
    const match = seasonStr.match(/^([IV])(\d{2})$/i);
    if (!match) return null;
    
    const type = match[1].toUpperCase(); // I o V
    const year = parseInt(match[2], 10); // 25, 24, etc.
    
    // Convertir a número ordinal para comparación
    // I17=0, V17=1, I18=2, V18=3, ..., I25=16, V25=17, I26=18...
    const baseYear = 17; // Año base (2017)
    const ordinal = ((year - baseYear) * 2) + (type === 'V' ? 1 : 0);
    
    return { type, year, ordinal, original: seasonStr };
}

/**
 * Calcula cuántas temporadas de diferencia hay entre dos temporadas
 */
function getSeasonDistance(productSeason, currentSeason) {
    const prod = parseSeason(productSeason);
    const curr = parseSeason(currentSeason);
    
    if (!prod || !curr) return 999; // Si no se puede parsear, asumir muy antiguo
    
    return curr.ordinal - prod.ordinal;
}

/**
 * Determina la temporada actual basándose en la fecha
 */
function getCurrentSeason() {
    const now = new Date();
    const month = now.getMonth() + 1; // 1-12
    const year = now.getFullYear() % 100; // 25 para 2025
    
    // Convención: 
    // - Invierno (I): Agosto a Enero (se vende en otoño/invierno)
    // - Verano (V): Febrero a Julio (se vende en primavera/verano)
    
    if (month >= 2 && month <= 7) {
        return `V${year}`;
    } else if (month >= 8) {
        return `I${year + 1}`; // Agosto-Dic prepara Invierno del año siguiente
    } else {
        return `I${year}`; // Enero aún es Invierno del año actual
    }
}

/**
 * Calcula la tasa ICC mensual para un producto según su temporada
 */
function calculateMonthlyICCRate(productSeason, currentSeason = null) {
    const current = currentSeason || getCurrentSeason();
    const distance = getSeasonDistance(productSeason, current);
    
    // Tasa base mensual (suma de componentes / 12)
    const baseAnnual = ICC_CONFIG.BASE_ANNUAL_RATE.capitalCost + 
                       ICC_CONFIG.BASE_ANNUAL_RATE.obsolescenceBase + 
                       ICC_CONFIG.BASE_ANNUAL_RATE.riskService;
    
    // Depreciación por temporada
    let seasonDepreciation = 0;
    if (distance <= 0) {
        seasonDepreciation = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.current;
    } else if (distance === 1) {
        seasonDepreciation = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.previous_1;
    } else if (distance === 2) {
        seasonDepreciation = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.previous_2;
    } else if (distance === 3) {
        seasonDepreciation = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.previous_3;
    } else {
        seasonDepreciation = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.previous_4_plus;
    }
    
    const totalAnnual = baseAnnual + seasonDepreciation;
    const monthlyRate = totalAnnual / 12;
    
    return {
        monthlyRate,
        annualRate: totalAnnual,
        breakdown: {
            capitalCost: ICC_CONFIG.BASE_ANNUAL_RATE.capitalCost / 12,
            obsolescenceBase: ICC_CONFIG.BASE_ANNUAL_RATE.obsolescenceBase / 12,
            riskService: ICC_CONFIG.BASE_ANNUAL_RATE.riskService / 12,
            seasonDepreciation: seasonDepreciation / 12,
        },
        seasonDistance: distance,
        productSeason,
        currentSeason: current,
    };
}

/**
 * Calcula el coste ICC mensual para un valor de stock dado
 */
function calculateMonthlyCost(stockValue, productSeason, currentSeason = null) {
    const rates = calculateMonthlyICCRate(productSeason, currentSeason);
    const monthlyCost = stockValue * rates.monthlyRate;
    
    return {
        ...rates,
        stockValue,
        monthlyCost,
        annualCost: stockValue * rates.annualRate,
        costBreakdown: {
            capitalCost: stockValue * rates.breakdown.capitalCost,
            obsolescenceBase: stockValue * rates.breakdown.obsolescenceBase,
            riskService: stockValue * rates.breakdown.riskService,
            seasonDepreciation: stockValue * rates.breakdown.seasonDepreciation,
        }
    };
}

// ==================================================================================
//  CONEXIÓN ODOO Y CÁLCULO REAL
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

/**
 * Calcula el ICC completo del almacén consultando Odoo
 */
async function calculateWarehouseICC() {
    console.log('💰 CÁLCULO ICC - COSTE DE ALMACENAMIENTO');
    console.log('=========================================\n');
    
    const { common, models } = createClients();
    const uid = await authenticate(common);
    console.log('✅ Conectado a Odoo\n');
    
    const currentSeason = getCurrentSeason();
    console.log(`📅 Temporada actual: ${currentSeason}\n`);
    
    // 1. Obtener todo el stock con valoración y temporada
    console.log('📦 Descargando stock con temporadas...');
    
    const stockQuants = await executeKw(models, uid, 'stock.quant', 'search_read', [
        [
            ['location_id.usage', '=', 'internal'],
            ['quantity', '>', 0]
        ]
    ], {
        fields: ['product_id', 'quantity', 'value', 'location_id'],
        limit: 50000
    });
    
    console.log(`   Encontrados ${stockQuants.length} quants\n`);
    
    // 2. Obtener información de productos (temporada y coste)
    const productIds = [...new Set(stockQuants.map(q => q.product_id[0]))];
    console.log(`📋 Obteniendo datos de ${productIds.length} productos...`);
    
    const products = await executeKw(models, uid, 'product.product', 'search_read', [
        [['id', 'in', productIds]]
    ], {
        fields: ['id', 'default_code', 'sale_season_id', 'standard_price', 'list_price']
    });
    
    // Crear mapa de productos
    const productMap = {};
    products.forEach(p => {
        productMap[p.id] = {
            code: p.default_code,
            season: p.sale_season_id ? p.sale_season_id[1] : null,
            cost: p.standard_price > 0 ? p.standard_price : (p.list_price * 0.4), // Si no hay coste, estimar 40% del PVP
        };
    });
    
    // 3. Calcular ICC por producto
    console.log('🧮 Calculando ICC...\n');
    
    const results = {
        totalStockValue: 0,
        totalMonthlyCost: 0,
        totalAnnualCost: 0,
        bySeason: {},
        bySeasonDistance: {
            current: { value: 0, cost: 0, count: 0, units: 0 },
            previous_1: { value: 0, cost: 0, count: 0, units: 0 },
            previous_2: { value: 0, cost: 0, count: 0, units: 0 },
            previous_3: { value: 0, cost: 0, count: 0, units: 0 },
            previous_4_plus: { value: 0, cost: 0, count: 0, units: 0 },
            unknown: { value: 0, cost: 0, count: 0, units: 0 },
        },
        breakdown: {
            capitalCost: 0,
            obsolescenceBase: 0,
            riskService: 0,
            seasonDepreciation: 0,
        }
    };
    
    stockQuants.forEach(quant => {
        const product = productMap[quant.product_id[0]];
        if (!product) return;
        
        const qty = quant.quantity;
        const unitCost = product.cost;
        const stockValue = qty * unitCost;
        
        // Usar el valor de Odoo si existe, sino calcular
        const finalValue = quant.value > 0 ? quant.value : stockValue;
        
        const season = product.season;
        const iccResult = calculateMonthlyCost(finalValue, season, currentSeason);
        
        // Acumular totales
        results.totalStockValue += finalValue;
        results.totalMonthlyCost += iccResult.monthlyCost;
        results.totalAnnualCost += iccResult.annualCost;
        
        // Acumular breakdown
        results.breakdown.capitalCost += iccResult.costBreakdown.capitalCost;
        results.breakdown.obsolescenceBase += iccResult.costBreakdown.obsolescenceBase;
        results.breakdown.riskService += iccResult.costBreakdown.riskService;
        results.breakdown.seasonDepreciation += iccResult.costBreakdown.seasonDepreciation;
        
        // Por temporada
        const seasonKey = season || 'SIN_TEMPORADA';
        if (!results.bySeason[seasonKey]) {
            results.bySeason[seasonKey] = { value: 0, monthlyCost: 0, annualCost: 0, units: 0, rate: 0 };
        }
        results.bySeason[seasonKey].value += finalValue;
        results.bySeason[seasonKey].monthlyCost += iccResult.monthlyCost;
        results.bySeason[seasonKey].annualCost += iccResult.annualCost;
        results.bySeason[seasonKey].units += qty;
        results.bySeason[seasonKey].rate = iccResult.annualRate;
        
        // Por distancia de temporada
        const distance = iccResult.seasonDistance;
        let distanceKey;
        if (!season) distanceKey = 'unknown';
        else if (distance <= 0) distanceKey = 'current';
        else if (distance === 1) distanceKey = 'previous_1';
        else if (distance === 2) distanceKey = 'previous_2';
        else if (distance === 3) distanceKey = 'previous_3';
        else distanceKey = 'previous_4_plus';
        
        results.bySeasonDistance[distanceKey].value += finalValue;
        results.bySeasonDistance[distanceKey].cost += iccResult.monthlyCost;
        results.bySeasonDistance[distanceKey].count += 1;
        results.bySeasonDistance[distanceKey].units += qty; 
    });
    
    // 4. Mostrar resultados
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                    RESUMEN ICC - COSTE DE ALMACENAMIENTO');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    console.log(`📊 TOTALES:`);
    console.log(`   Valor total del stock:     €${results.totalStockValue.toLocaleString('es-ES', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`);
    console.log(`   Coste ICC MENSUAL:         €${results.totalMonthlyCost.toLocaleString('es-ES', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`);
    console.log(`   Coste ICC ANUAL:           €${results.totalAnnualCost.toLocaleString('es-ES', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`);
    console.log(`   Tasa ICC efectiva:         ${((results.totalAnnualCost / results.totalStockValue) * 100).toFixed(2)}% anual\n`);
    
    console.log(`💰 DESGLOSE DEL COSTE MENSUAL:`);
    console.log(`   Coste de capital (10%):    €${results.breakdown.capitalCost.toLocaleString('es-ES', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`);
    console.log(`   Obsolescencia base (6%):   €${results.breakdown.obsolescenceBase.toLocaleString('es-ES', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`);
    console.log(`   Riesgo/Servicio (2%):      €${results.breakdown.riskService.toLocaleString('es-ES', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`);
    console.log(`   Depreciación temporal:     €${results.breakdown.seasonDepreciation.toLocaleString('es-ES', {minimumFractionDigits: 2, maximumFractionDigits: 2})}\n`);
    
    console.log(`📅 COSTE POR ANTIGÜEDAD DE TEMPORADA:`);
    console.log(`   ┌─────────────────────┬──────────────────┬──────────────────┬──────────────────┬────────────┐`);
    console.log(`   │ Categoría           │ Stock (Uds)      │ Valor Stock      │ Coste Mensual    │ Tasa Anual │`);
    console.log(`   ├─────────────────────┼──────────────────┼──────────────────┼──────────────────┼────────────┤`);
    
    const distanceLabels = {
        current: 'Temp. actual',
        previous_1: '1 temp. atrás',
        previous_2: '2 temp. atrás',
        previous_3: '3 temp. atrás',
        previous_4_plus: '4+ temp. atrás',
        unknown: 'Sin temporada',
    };
    
    const distanceRates = {
        current: 18,
        previous_1: 24,
        previous_2: 30,
        previous_3: 36,
        previous_4_plus: 42,
        unknown: 18,
    };
    
    Object.entries(results.bySeasonDistance).forEach(([key, data]) => {
        if (data.value > 0) {
            const label = distanceLabels[key].padEnd(19);
            const units = `${data.units.toLocaleString('es-ES')}`.padStart(16);
            const value = `€${(data.value/1000).toFixed(1)}k`.padStart(14);
            const cost = `€${data.cost.toFixed(2)}`.padStart(14);
            const rate = `${distanceRates[key]}%`.padStart(8);
            console.log(`   │ ${label} │ ${units} │ ${value} │ ${cost} │ ${rate} │`);
        }
    });
    console.log(`   └─────────────────────┴──────────────────┴──────────────────┴──────────────────┴────────────┘\n`);
    
    // ==============================================================================
    // MODIFICACIÓN: LISTAR TODAS LAS TEMPORADAS (SIN LÍMITE)
    // ==============================================================================
    console.log(`🗓️ DESGLOSE COMPLETO POR TEMPORADA (Ordenado por mayor coste):`);
    
    const sortedSeasons = Object.entries(results.bySeason)
        .sort((a, b) => b[1].monthlyCost - a[1].monthlyCost); // Ordenar por coste descendente
    
    sortedSeasons.forEach(([season, data], idx) => {
        const ratePercent = (data.rate * 100).toFixed(0);
        console.log(`   ${idx + 1}. ${season.padEnd(8)} [${data.units.toLocaleString('es-ES').padStart(6)} uds] €${data.value.toLocaleString('es-ES', {minimumFractionDigits: 0, maximumFractionDigits: 0}).padStart(11)} → €${data.monthlyCost.toFixed(2).padStart(9)}/mes (${ratePercent}%)`);
    });
    // ==============================================================================
    
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                    MÉTRICAS PARA DASHBOARD');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    const totalUnits = stockQuants.reduce((sum, q) => sum + q.quantity, 0);
    const totalLocations = new Set(stockQuants.map(q => q.location_id[0])).size;
    
    console.log(`   💵 Coste por unidad almacenada:    €${(results.totalMonthlyCost / totalUnits).toFixed(4)}/mes`);
    console.log(`   📍 Coste por ubicación ocupada:    €${(results.totalMonthlyCost / totalLocations).toFixed(2)}/mes`);
    console.log(`   📉 Depreciación diaria del stock:  €${(results.totalMonthlyCost / 30).toFixed(2)}/día`);
    console.log(`   ⚠️  Si mantienes este stock 6 meses más: €${(results.totalMonthlyCost * 6).toLocaleString('es-ES', {minimumFractionDigits: 2})} de coste adicional`);
    
    return results;
}

// Ejecutar si es el script principal
calculateWarehouseICC().catch(console.error);

// Exportar funciones para uso en otros módulos
export {
    calculateMonthlyICCRate,
    calculateMonthlyCost,
    getCurrentSeason,
    getSeasonDistance,
    parseSeason,
    calculateWarehouseICC,
    ICC_CONFIG
};