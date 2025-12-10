// generate_b2b_locations.js
// Ejecutar UNA SOLA VEZ para añadir ubicaciones B2B al locations.json
// Uso: node generate_b2b_locations.js

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCATIONS_FILE = path.join(__dirname, 'data', 'locations.json');

// Configuración B2B basada en datos de Odoo
const B2B_CONFIG = {
    // Pasillos operativos (sin el 004 que es B2C)
    aisles: ['001', '002', '003', '005', '006', '007', '008', '009', '010', 
             '011', '012', '013', '014', '015', '016', '017', '018', '019', 
             '020', '021', '031'],
    
    // Bloques por pasillo (01-09 y 17-19)
    blocks: ['01', '02', '03', '04', '05', '06', '07', '08', '09', '17', '18', '19'],
    
    // Niveles (alturas)
    levels: ['01', '02', '03'],
    
    // Posiciones por nivel
    positions: ['01', '02', '03'],
    
    // Marcas y sus prefijos de ubicación
    brands: {
        'BD': 'BLACK',   // EXTB2BBD
        'GD': 'GOLD',    // EXTB2BGD
        'WD': 'WHITE'    // EXTB2BWD
    }
};

// Configuración visual (coordenadas base para el frontend)
const VISUAL_CONFIG = {
    startX: 50,
    startY: 400,  // Debajo del área B2C
    spacingX: 15,
    spacingY: 20,
    aisleGap: 30
};

function generateB2BLocations() {
    const locations = [];
    let locationCount = 0;

    // Para cada marca (BD, GD, WD)
    for (const [brandSuffix, brandName] of Object.entries(B2B_CONFIG.brands)) {
        console.log(`\n📦 Generando ubicaciones para ${brandName} (${brandSuffix})...`);
        
        let aisleIndex = 0;
        
        for (const aisle of B2B_CONFIG.aisles) {
            for (const block of B2B_CONFIG.blocks) {
                for (const level of B2B_CONFIG.levels) {
                    for (const position of B2B_CONFIG.positions) {
                        const locationId = `CLABD/Stock/EXTB2B${brandSuffix}/CLA-${aisle}-${block}-${level}-${position}`;
                        
                        // Calcular coordenadas visuales
                        const blockNum = parseInt(block);
                        const posNum = parseInt(position);
                        const levelNum = parseInt(level);
                        
                        const x = VISUAL_CONFIG.startX + 
                                  (aisleIndex * VISUAL_CONFIG.aisleGap) + 
                                  (blockNum * VISUAL_CONFIG.spacingX) + 
                                  (posNum * 5);
                        
                        const y = VISUAL_CONFIG.startY + 
                                  (Object.keys(B2B_CONFIG.brands).indexOf(brandSuffix) * 150) +
                                  (levelNum * VISUAL_CONFIG.spacingY);

                        locations.push({
                            id: locationId,
                            aisle: aisle,
                            block: block,
                            level: level,
                            position: position,
                            totalStock: 0,
                            totalReserved: 0,
                            status: "FREE",
                            packages: [],
                            x: x,
                            y: y,
                            type: "B2B",
                            sinDatos: false,
                            brand: brandName,
                            occupancyPercentage: 0,
                            velocityScore: 0
                        });
                        
                        locationCount++;
                    }
                }
            }
            aisleIndex++;
        }
    }

    console.log(`\n✅ Generadas ${locationCount} ubicaciones B2B`);
    return locations;
}

async function main() {
    try {
        // 1. Leer locations.json existente
        console.log('📖 Leyendo locations.json existente...');
        const rawData = await fs.readFile(LOCATIONS_FILE, 'utf-8');
        const existingLocations = JSON.parse(rawData);
        
        // 2. Filtrar para quedarnos solo con B2C (Storage)
        const b2cLocations = existingLocations.filter(loc => 
            loc.id.includes('Storage') && !loc.id.includes('B2B')
        );
        console.log(`📍 Encontradas ${b2cLocations.length} ubicaciones B2C existentes`);

        // 3. Verificar si ya hay ubicaciones B2B
        const existingB2B = existingLocations.filter(loc => loc.id.includes('EXTB2B'));
        if (existingB2B.length > 0) {
            console.log(`⚠️  Ya existen ${existingB2B.length} ubicaciones B2B. ¿Regenerar?`);
            console.log('   Si quieres regenerar, elimina las ubicaciones B2B manualmente primero.');
            console.log('   O ejecuta con: node generate_b2b_locations.js --force');
            
            if (!process.argv.includes('--force')) {
                console.log('\n❌ Abortando. Usa --force para sobrescribir.');
                process.exit(1);
            }
            console.log('\n🔄 --force detectado. Regenerando...');
        }

        // 4. Generar nuevas ubicaciones B2B
        const b2bLocations = generateB2BLocations();

        // 5. Combinar B2C + B2B
        const allLocations = [...b2cLocations, ...b2bLocations];
        console.log(`\n📊 Total combinado: ${allLocations.length} ubicaciones`);
        console.log(`   - B2C: ${b2cLocations.length}`);
        console.log(`   - B2B: ${b2bLocations.length}`);

        // 6. Guardar
        const backupFile = LOCATIONS_FILE.replace('.json', '_backup_' + Date.now() + '.json');
        await fs.writeFile(backupFile, rawData);
        console.log(`\n💾 Backup guardado en: ${backupFile}`);

        await fs.writeFile(LOCATIONS_FILE, JSON.stringify(allLocations, null, 2));
        console.log(`✅ locations.json actualizado con ${allLocations.length} ubicaciones`);

    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

main();