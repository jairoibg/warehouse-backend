// ==================================================================================
//  PACKING INTELLIGENCE SYSTEM v4.0
//  Sistema de aprendizaje que mejora con cada análisis
// ==================================================================================

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================================================================================
//  BASE DE CONOCIMIENTO PERSISTENTE
// ==================================================================================
const KNOWLEDGE_FILE = path.join(__dirname, 'data', 'packing_knowledge.json');
const ANALYSIS_HISTORY_FILE = path.join(__dirname, 'data', 'packing_analysis_history.json');

class PackingIntelligence {
  constructor() {
    // Base de conocimiento
    this.knowledge = {
      // Reglas de empaque por tipo de producto
      packingRules: {
        // Calzado
        'DFSH': { type: 'FOOTWEAR', boxesPerPallet: { adult: 14, kids: 28 }, defaultPrsPerCtn: 12 },
        'COSH': { type: 'FOOTWEAR', boxesPerPallet: { adult: 14, kids: 28 }, defaultPrsPerCtn: 12 },
        'BWSH': { type: 'FOOTWEAR', boxesPerPallet: { adult: 14, kids: 28 }, defaultPrsPerCtn: 12 },
        'BJSH': { type: 'FOOTWEAR', boxesPerPallet: { adult: 14, kids: 28 }, defaultPrsPerCtn: 12 },
        'TESH': { type: 'FOOTWEAR', boxesPerPallet: { adult: 14, kids: 28 }, defaultPrsPerCtn: 12 },
        // Gafas
        'DFKSUN': { type: 'SUNGLASSES', udsPerBox: 50, boxesPerPallet: 22 },
        'DFSU': { type: 'SUNGLASSES', udsPerBox: 50, boxesPerPallet: 22 },
        // Calcetines
        'DFTXSOCO': { type: 'SOCKS', udsPerBox: 50, boxesPerPallet: 50 },
      },
      
      // Surtidos conocidos (distribución de tallas)
      knownAssortments: {
        '36-41_12': { sizes: [36,37,38,39,40,41], distribution: [1,2,3,3,2,1], prsPerCtn: 12, type: 'adult' },
        '36-41_14': { sizes: [36,37,38,39,40,41], distribution: [1,2,3,4,3,1], prsPerCtn: 14, type: 'adult' },
        '36-42_14': { sizes: [36,37,38,39,40,41,42], distribution: [1,2,2,3,3,2,1], prsPerCtn: 14, type: 'adult' },
        '25-35_12': { sizes: [25,26,27,28,29,30,31,32,33,34,35], distribution: [1,1,1,1,1,1,1,1,1,1,2], prsPerCtn: 12, type: 'kids' },
        '25-32_14': { sizes: [25,26,27,28,29,30,31,32], distribution: [1,1,2,2,2,2,2,2], prsPerCtn: 14, type: 'kids' },
      },
      
      // Normalización de colores
      colorNormalization: {
        'BLACK': 'BLAC', 'WHITE': 'WHIT', 'BURGUNDY': 'BURG', 'BEIGE': 'BEIG',
        'BROWN': 'BROW', 'GREEN': 'GREE', 'BLUE': 'BLUE', 'GREY': 'GREY',
        'GRAY': 'GREY', 'PINK': 'PINK', 'GOLD': 'GOLD', 'SILVER': 'SILV',
        'PEWTER': 'PEWT', 'ORANGE': 'ORAN', 'YELLOW': 'YELL', 'PURPLE': 'PURP',
        'NAVY': 'NAVY', 'CREAM': 'CREA', 'TAUPE': 'TAUP', 'OLIVE': 'OLIV',
        'CORAL': 'CORA', 'LEOPARD': 'LEOP', 'MULTI': 'MULT', 'OFFWHITE': 'OFFW',
      },
      
      // Referencias aprendidas (se actualiza con cada análisis)
      learnedReferences: {},
      
      // Proveedores/fábricas conocidas
      knownFactories: {},
      
      // Estadísticas de uso
      stats: {
        totalAnalyses: 0,
        successfulAnalyses: 0,
        failedAnalyses: 0,
        lastAnalysis: null,
        referencesLearned: 0,
      }
    };
    
    // Historial de análisis
    this.analysisHistory = [];
    
    // Cargar conocimiento previo
    this.loadKnowledge();
  }

  // ==================================================================================
  //  PERSISTENCIA
  // ==================================================================================
  
  async loadKnowledge() {
    try {
      if (fsSync.existsSync(KNOWLEDGE_FILE)) {
        const data = JSON.parse(await fs.readFile(KNOWLEDGE_FILE, 'utf8'));
        // Merge con conocimiento base (no sobreescribir reglas hardcodeadas)
        this.knowledge.learnedReferences = data.learnedReferences || {};
        this.knowledge.knownFactories = data.knownFactories || {};
        this.knowledge.stats = data.stats || this.knowledge.stats;
        
        // Añadir surtidos aprendidos
        if (data.knownAssortments) {
          this.knowledge.knownAssortments = { ...this.knowledge.knownAssortments, ...data.knownAssortments };
        }
        
        console.log(`📚 [INTELLIGENCE] Cargado: ${Object.keys(this.knowledge.learnedReferences).length} referencias aprendidas`);
      }
      
      if (fsSync.existsSync(ANALYSIS_HISTORY_FILE)) {
        this.analysisHistory = JSON.parse(await fs.readFile(ANALYSIS_HISTORY_FILE, 'utf8'));
        console.log(`📜 [INTELLIGENCE] Historial: ${this.analysisHistory.length} análisis previos`);
      }
    } catch (err) {
      console.warn('⚠️ [INTELLIGENCE] Error cargando conocimiento:', err.message);
    }
  }
  
  async saveKnowledge() {
    try {
      await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
      
      // Guardar solo datos aprendidos (no reglas hardcodeadas)
      const toSave = {
        learnedReferences: this.knowledge.learnedReferences,
        knownFactories: this.knowledge.knownFactories,
        knownAssortments: this.knowledge.knownAssortments,
        stats: this.knowledge.stats,
        lastSaved: new Date().toISOString()
      };
      
      await fs.writeFile(KNOWLEDGE_FILE, JSON.stringify(toSave, null, 2));
      
      // Guardar historial (últimos 500 análisis)
      const historyToSave = this.analysisHistory.slice(-500);
      await fs.writeFile(ANALYSIS_HISTORY_FILE, JSON.stringify(historyToSave, null, 2));
      
      console.log(`💾 [INTELLIGENCE] Conocimiento guardado`);
    } catch (err) {
      console.warn('⚠️ [INTELLIGENCE] Error guardando:', err.message);
    }
  }

  // ==================================================================================
  //  NORMALIZACIÓN Y DETECCIÓN
  // ==================================================================================
  
  normalizeColor(color) {
    if (!color) return '';
    const upper = color.toUpperCase().trim();
    return this.knowledge.colorNormalization[upper] || upper.substring(0, 4);
  }
  
  detectProductType(reference) {
    const ref = (reference || '').toUpperCase();
    
    for (const [prefix, rules] of Object.entries(this.knowledge.packingRules)) {
      if (ref.startsWith(prefix)) {
        return { prefix, ...rules };
      }
    }
    
    // Si no coincide, intentar detectar por patrón
    if (ref.includes('SUN') || ref.includes('GAFA')) return { type: 'SUNGLASSES', udsPerBox: 50, boxesPerPallet: 22 };
    if (ref.includes('SOC') || ref.includes('CALCE')) return { type: 'SOCKS', udsPerBox: 50, boxesPerPallet: 50 };
    
    // Default: calzado
    return { type: 'FOOTWEAR', boxesPerPallet: { adult: 14, kids: 28 }, defaultPrsPerCtn: 12 };
  }
  
  detectAssortmentType(minSize, maxSize, prsPerCtn) {
    // Determinar si es adulto o niño por las tallas
    const isKids = minSize < 36;
    
    // Buscar surtido conocido
    const key = `${minSize}-${maxSize}_${prsPerCtn}`;
    if (this.knowledge.knownAssortments[key]) {
      return this.knowledge.knownAssortments[key];
    }
    
    // Crear surtido estimado
    return {
      sizes: this.generateSizeRange(minSize, maxSize),
      prsPerCtn: prsPerCtn,
      type: isKids ? 'kids' : 'adult',
      estimated: true
    };
  }
  
  generateSizeRange(min, max) {
    const sizes = [];
    for (let i = min; i <= max; i++) {
      sizes.push(i);
    }
    return sizes;
  }
  
  calculatePallets(boxes, productType, sizeType) {
    if (!boxes || boxes <= 0) return 0;
    
    let boxesPerPallet = 14; // Default adulto
    
    if (productType === 'SUNGLASSES') {
      boxesPerPallet = 22;
    } else if (productType === 'SOCKS') {
      boxesPerPallet = 50;
    } else if (sizeType === 'kids') {
      boxesPerPallet = 28;
    }
    
    return Math.round((boxes / boxesPerPallet) * 100) / 100;
  }

  // ==================================================================================
  //  APRENDIZAJE
  // ==================================================================================
  
  learnFromAnalysis(containerNumber, items, success = true) {
    this.knowledge.stats.totalAnalyses++;
    this.knowledge.stats.lastAnalysis = new Date().toISOString();
    
    if (success) {
      this.knowledge.stats.successfulAnalyses++;
    } else {
      this.knowledge.stats.failedAnalyses++;
      return;
    }
    
    // Aprender de cada item
    items.forEach(item => {
      const baseRef = item.reference?.split('-')[0];
      if (!baseRef) return;
      
      // Actualizar o crear entrada
      if (!this.knowledge.learnedReferences[baseRef]) {
        this.knowledge.learnedReferences[baseRef] = {
          firstSeen: new Date().toISOString(),
          seenCount: 0,
          colors: [],
          sizeRanges: [],
          prsPerCtnValues: [],
          avgUnitsPerContainer: 0,
          containers: []
        };
        this.knowledge.stats.referencesLearned++;
      }
      
      const ref = this.knowledge.learnedReferences[baseRef];
      ref.seenCount++;
      ref.lastSeen = new Date().toISOString();
      
      // Registrar color si es nuevo
      const color = item.reference?.split('-')[1];
      if (color && !ref.colors.includes(color)) {
        ref.colors.push(color);
      }
      
      // Registrar surtido
      if (item.sizeRange && !ref.sizeRanges.includes(item.sizeRange)) {
        ref.sizeRanges.push(item.sizeRange);
      }
      
      // Registrar prsPerCtn
      if (item.prsPerCtn && !ref.prsPerCtnValues.includes(item.prsPerCtn)) {
        ref.prsPerCtnValues.push(item.prsPerCtn);
      }
      
      // Registrar contenedor
      if (!ref.containers.includes(containerNumber)) {
        ref.containers.push(containerNumber);
      }
      
      // Calcular promedio de unidades
      ref.avgUnitsPerContainer = Math.round(
        (ref.avgUnitsPerContainer * (ref.seenCount - 1) + (item.totalUnits || 0)) / ref.seenCount
      );
    });
    
    // Añadir al historial
    this.analysisHistory.push({
      timestamp: new Date().toISOString(),
      containerNumber,
      itemCount: items.length,
      totalUnits: items.reduce((sum, i) => sum + (i.totalUnits || 0), 0),
      totalBoxes: items.reduce((sum, i) => sum + (i.totalBoxes || 0), 0),
      references: [...new Set(items.map(i => i.reference?.split('-')[0]).filter(Boolean))]
    });
    
    // Guardar conocimiento de forma asíncrona
    this.saveKnowledge().catch(console.warn);
  }
  
  learnNewAssortment(sizeRange, distribution, prsPerCtn, type) {
    const key = `${sizeRange}_${prsPerCtn}`;
    if (!this.knowledge.knownAssortments[key]) {
      this.knowledge.knownAssortments[key] = {
        sizes: this.parseSizeRange(sizeRange),
        distribution: distribution,
        prsPerCtn: prsPerCtn,
        type: type,
        learned: true,
        learnedAt: new Date().toISOString()
      };
      console.log(`📝 [INTELLIGENCE] Nuevo surtido aprendido: ${key}`);
    }
  }
  
  parseSizeRange(sizeRange) {
    if (!sizeRange || !sizeRange.includes('-')) return [];
    const [min, max] = sizeRange.split('-').map(Number);
    return this.generateSizeRange(min, max);
  }

  // ==================================================================================
  //  GENERACIÓN DE PROMPT INTELIGENTE
  // ==================================================================================
  
  generateSmartPrompt(contentForAI) {
    // Construir contexto de conocimiento previo
    const recentRefs = Object.entries(this.knowledge.learnedReferences)
      .sort((a, b) => new Date(b[1].lastSeen) - new Date(a[1].lastSeen))
      .slice(0, 20)
      .map(([ref, data]) => `${ref}: ${data.colors.join(',')} | ${data.sizeRanges.join(',')} | ${data.prsPerCtnValues.join(',')} prs/ctn`)
      .join('\n');
    
    const knownAssortments = Object.entries(this.knowledge.knownAssortments)
      .map(([key, data]) => `${key}: tallas ${data.sizes?.join('-') || 'N/A'}, ${data.prsPerCtn} prs/ctn, ${data.type}`)
      .join('\n');

    return `Eres un experto en logística de almacén de moda y calzado. Analiza este Packing List y extrae CADA LÍNEA como un item separado.

## CONTEXTO DEL NEGOCIO
Este es un almacén de Illice Internacional que maneja 3 divisiones: Black (DF*), Gold (CO*, BW*), White (KA*).

## REFERENCIAS CONOCIDAS (del histórico)
${recentRefs || 'Sin historial previo'}

## SURTIDOS CONOCIDOS
${knownAssortments}

## ESTRUCTURA DEL PACKING LIST
Las columnas típicas son:
- **Order No / P.O.**: Número de pedido (ej: P05979)
- **Item No / Art.**: Código del producto (ej: DFSH370011)
- **Colour / Color**: Color (ej: BEIG, BLAC, BROW)
- **Size breakdown**: Columnas de tallas (36, 37, 38, 39, 40, 41, 42...)
- **PRS/CTN**: Pares por caja (MUY IMPORTANTE - suele ser 12 o 14)
- **CTNS**: Número de CAJAS (NO confundir con unidades)
- **PRS**: Total de PARES/UNIDADES
- **CBM**: Metros cúbicos
- **Container Number**: Número del contenedor

## REGLAS CRÍTICAS

### 1. CADA COLOR ES UNA LÍNEA SEPARADA
Si hay DFSH370011 en BEIG, BLAC y BROW → son 3 items diferentes.

### 2. NORMALIZACIÓN DE COLORES (4 letras)
BLACK → BLAC | WHITE → WHIT | BURGUNDY → BURG | BEIGE → BEIG
BROWN → BROW | PEWTER → PEWT | GOLD → GOLD | SILVER → SILV

### 3. REFERENCIA COMPLETA
Código + guión + color: DFSH370011 + BEIG = "DFSH370011-BEIG"

### 4. DISTINGUIR CAJAS vs UNIDADES
- **CTNS** = número de CAJAS
- **PRS** = número de UNIDADES/PARES
- NUNCA confundirlos. Si CTNS=312 y PRS=3744, entonces hay 312 cajas con 3744 pares.

### 5. SURTIDO DE TALLAS
- Detectar rango: columnas 36-41 con valores = sizeRange "36-41"
- La distribución (1,2,3,3,2,1) indica cuántos pares de cada talla por caja

### 6. TIPOS DE PRODUCTO
- DFSH*, COSH*, BWSH*, BJSH*, TESH*: Calzado
  - Tallas 36-46: Adulto → 14 cajas/palet
  - Tallas 25-35: Infantil → 28 cajas/palet
- DFKSUN*, DFSU*: Gafas → 50 uds/caja, 22 cajas/palet
- DFTXSOCO*: Calcetines → 50 uds/caja, 50 cajas/palet

## RESPUESTA JSON (OBLIGATORIO)
{
  "container_number": "PONU8243928",
  "items": [
    {
      "reference": "DFSH370011-BEIG",
      "quantity": 3744,
      "cartons": 312,
      "sizeRange": "36-41",
      "minSize": 36,
      "maxSize": 41,
      "prsPerCtn": 12,
      "sizeDistribution": [1,2,3,3,2,1],
      "productType": "FOOTWEAR"
    },
    {
      "reference": "DFSH370011-BLAC",
      "quantity": 1872,
      "cartons": 156,
      "sizeRange": "36-41",
      "minSize": 36,
      "maxSize": 41,
      "prsPerCtn": 12,
      "sizeDistribution": [1,2,3,3,2,1],
      "productType": "FOOTWEAR"
    },
    {
      "reference": "DFSH370011-BROW",
      "quantity": 1320,
      "cartons": 110,
      "sizeRange": "36-41",
      "minSize": 36,
      "maxSize": 41,
      "prsPerCtn": 12,
      "sizeDistribution": [1,2,3,3,2,1],
      "productType": "FOOTWEAR"
    }
  ],
  "total_units": 6936,
  "total_cartons": 578,
  "confidence": "HIGH"
}

## VALIDACIÓN
- total_units DEBE ser la suma de quantity de todos los items
- total_cartons DEBE ser la suma de cartons de todos los items
- quantity = cartons × prsPerCtn

DOCUMENTO A ANALIZAR:
${contentForAI}`;
  }

  // ==================================================================================
  //  ENRIQUECIMIENTO POST-IA
  // ==================================================================================
  
  enrichParsedData(parsedData, odooCache) {
    if (!parsedData.items || parsedData.items.length === 0) {
      return parsedData;
    }
    
    const enrichedItems = parsedData.items.map(item => {
      const reference = (item.reference || '').toUpperCase().trim();
      const baseRef = reference.split('-')[0];
      const color = reference.split('-')[1];
      
      // Detectar tipo de producto
      const productInfo = this.detectProductType(reference);
      
      // Determinar si es adulto o niño
      const isKids = (item.minSize || 36) < 36;
      const sizeType = isKids ? 'kids' : 'adult';
      
      // Calcular palets
      const pallets = this.calculatePallets(
        item.cartons || 0,
        productInfo.type,
        sizeType
      );
      
      // Buscar en caché de Odoo
      let odooData = null;
      let abcClass = 'NEW';
      let currentStock = 0;
      let stockLocations = [];
      
      if (odooCache) {
        // Buscar producto
        const product = this.findInOdooCache(reference, odooCache.products);
        if (product) {
          odooData = product;
          abcClass = odooCache.abc?.get(product.id) || 'D';
          const stock = odooCache.stock?.get(product.id);
          if (stock) {
            currentStock = stock.total;
            stockLocations = (stock.locations || []).map(loc => ({
              location: loc.name || 'Desconocida',
              qty: loc.qty || 0
            })).filter(loc => loc.qty > 0);
          }
        }
      }
      
      // Buscar conocimiento previo de esta referencia
      const priorKnowledge = this.knowledge.learnedReferences[baseRef];
      
      return {
        ...item,
        reference,
        productType: productInfo.type,
        sizeType,
        totalPallets: pallets,
        boxesPerPallet: productInfo.type === 'SUNGLASSES' ? 22 : 
                        productInfo.type === 'SOCKS' ? 50 :
                        isKids ? 28 : 14,
        abcClass,
        currentStock,
        stockLocations: stockLocations.slice(0, 5),
        productName: odooData?.name || (priorKnowledge ? `Ref. conocida (visto ${priorKnowledge.seenCount}x)` : 'No encontrado'),
        odooId: odooData?.id || null,
        // Datos de aprendizaje
        priorKnowledge: priorKnowledge ? {
          seenCount: priorKnowledge.seenCount,
          avgUnits: priorKnowledge.avgUnitsPerContainer,
          knownColors: priorKnowledge.colors
        } : null
      };
    });
    
    return {
      ...parsedData,
      items: enrichedItems
    };
  }
  
  findInOdooCache(reference, productCache) {
    if (!productCache) return null;
    
    // Intento 1: Exacto
    let product = productCache.get(reference);
    if (product) return product;
    
    // Intento 2: Sin guiones
    product = productCache.get(reference.replace(/-/g, ''));
    if (product) return product;
    
    // Intento 3: Solo código base
    const baseCode = reference.split('-')[0];
    product = productCache.get(baseCode);
    if (product) return product;
    
    // Intento 4: Búsqueda parcial
    for (const [key, value] of productCache.entries()) {
      if (key.includes(baseCode)) {
        return value;
      }
    }
    
    return null;
  }

  // ==================================================================================
  //  GENERACIÓN DE RESUMEN
  // ==================================================================================
  
  generateSummary(items) {
    const summary = {
      totalUnits: 0,
      totalBoxes: 0,
      totalPallets: 0,
      byABC: { A: 0, B: 0, C: 0, D: 0, NEW: 0 },
      byType: { SUNGLASSES: 0, SOCKS: 0, FOOTWEAR: 0 },
      byColor: {},
      newReferences: [],
      consolidationAlerts: [],
      groupedTotals: []
    };
    
    // Agrupar por referencia
    const grouped = new Map();
    
    items.forEach(item => {
      const qty = item.quantity || item.totalUnits || 0;
      const boxes = item.cartons || item.totalBoxes || 0;
      const pallets = item.totalPallets || 0;
      
      summary.totalUnits += qty;
      summary.totalBoxes += boxes;
      summary.totalPallets += pallets;
      
      // Por ABC
      const abc = item.abcClass || 'NEW';
      summary.byABC[abc] = (summary.byABC[abc] || 0) + qty;
      
      // Por tipo
      const type = item.productType || 'FOOTWEAR';
      summary.byType[type] = (summary.byType[type] || 0) + qty;
      
      // Por color
      const color = item.reference?.split('-')[1] || 'N/A';
      summary.byColor[color] = (summary.byColor[color] || 0) + qty;
      
      // Agrupar
      const ref = item.reference || 'UNKNOWN';
      if (!grouped.has(ref)) {
        grouped.set(ref, {
          reference: ref,
          productName: item.productName,
          totalUnits: 0,
          totalBoxes: 0,
          totalPallets: 0,
          abcClass: item.abcClass,
          currentStock: item.currentStock || 0,
          stockLocations: item.stockLocations || [],
          lines: 0
        });
      }
      
      const g = grouped.get(ref);
      g.totalUnits += qty;
      g.totalBoxes += boxes;
      g.totalPallets += pallets;
      g.lines++;
      
      // Alertas
      if (item.abcClass === 'NEW') {
        summary.newReferences.push(ref);
      }
      
      if ((item.currentStock || 0) > 0) {
        summary.consolidationAlerts.push({
          itemNo: ref,
          currentStock: item.currentStock,
          incomingUnits: qty,
          locations: item.stockLocations,
          message: `⚠️ Stock existente: ${item.currentStock} uds en almacén`
        });
      }
    });
    
    summary.groupedTotals = Array.from(grouped.values());
    summary.totalPallets = Math.round(summary.totalPallets * 100) / 100;
    summary.uniqueReferences = grouped.size;
    
    return summary;
  }

  // ==================================================================================
  //  API PÚBLICA
  // ==================================================================================
  
  getStats() {
    return {
      ...this.knowledge.stats,
      referencesInMemory: Object.keys(this.knowledge.learnedReferences).length,
      assortmentsKnown: Object.keys(this.knowledge.knownAssortments).length,
      analysisHistoryCount: this.analysisHistory.length
    };
  }
  
  getRecentAnalyses(limit = 10) {
    return this.analysisHistory.slice(-limit).reverse();
  }
  
  getReferenceInfo(reference) {
    const baseRef = reference.split('-')[0].toUpperCase();
    return this.knowledge.learnedReferences[baseRef] || null;
  }
  
  searchReferences(query) {
    const q = query.toUpperCase();
    return Object.entries(this.knowledge.learnedReferences)
      .filter(([ref]) => ref.includes(q))
      .map(([ref, data]) => ({ reference: ref, ...data }))
      .slice(0, 20);
  }
}

// Exportar instancia singleton
export const packingIntelligence = new PackingIntelligence();

