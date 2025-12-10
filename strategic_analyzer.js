import OpenAI from 'openai';

// Asegúrate de que esto pille la key del entorno
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ============================================
// SISTEMA DE CONTEXTO ESTRATÉGICO
// ============================================

class StrategicAnalyzer {
  constructor() {
    this.businessContext = {
      industry: "Fashion & Accessories",
      businessModel: "Multi-brand warehouse (BLACK, GOLD, WHITE)",
      strategy: {
        core: "Maximizar rotación, minimizar stock muerto, optimizar espacio",
        abcPhilosophy: "A=Alta rotación (80% ventas, 20% items), B=Media, C=Baja, D=Sin movimiento",
        spaceCost: "Cada ubicación tiene coste. Ubicaciones semi-vacías = dinero perdido",
        seasonality: "Producto de temporada pasada pierde valor. V26=Actual, I25=Antiguo",
        picking: "Productos A deben estar cerca. D pueden estar lejos o eliminarse"
      },
      kpis: {
        primary: ["Rotación de inventario", "Ocupación efectiva", "Edad promedio del stock"],
        secondary: ["Mix ABC óptimo", "Compactación", "Cobertura de ventas"]
      }
    };
    
    this.analysisMemory = new Map(); // Para evitar repeticiones
  }

  // RECOPILACIÓN INTELIGENTE DE DATOS
  async gatherIntelligence(locations, salesData = null) {
    console.log('🔵 [IA] Recopilando inteligencia del almacén...');
    
    const intelligence = {
      // MÉTRICAS BÁSICAS
      basic: this.calculateBasicMetrics(locations),
      
      // ANÁLISIS ABC
      abc: this.analyzeABCDistribution(locations),
      
      // ANÁLISIS DE TEMPORADAS
      seasons: this.analyzeSeasonality(locations),
      
      // ANÁLISIS DE ESPACIO
      space: this.analyzeSpaceUtilization(locations),
      
      // ANÁLISIS DE VELOCIDAD
      velocity: this.analyzeVelocity(locations),
      
      // PROBLEMAS DETECTADOS
      issues: this.detectStrategicIssues(locations),
      
      // OPORTUNIDADES
      opportunities: this.detectOpportunities(locations),
      
      // DATOS DE VENTAS (si disponibles)
      sales: salesData ? this.analyzeSales(salesData) : null
    };
    
    return intelligence;
  }

  calculateBasicMetrics(locations) {
    const withStock = locations.filter(l => l.totalStock > 0);
    
    // Evitar división por cero
    const totalLocs = locations.length || 1;
    const occupiedLocs = withStock.length || 0;

    return {
      totalLocations: totalLocs,
      occupied: occupiedLocs,
      empty: totalLocs - occupiedLocs,
      occupancyRate: ((occupiedLocs / totalLocs) * 100).toFixed(1),
      totalUnits: withStock.reduce((sum, l) => sum + l.totalStock, 0),
      totalValue: withStock.reduce((sum, l) => 
        sum + (l.packages || []).reduce((s, p) => s + (p.qty * (p.cost || 0)), 0), 0
      ),
      avgUnitsPerLocation: occupiedLocs > 0 
        ? (withStock.reduce((sum, l) => sum + l.totalStock, 0) / occupiedLocs).toFixed(0)
        : 0
    };
  }

  analyzeABCDistribution(locations) {
    const abc = { A: 0, B: 0, C: 0, D: 0 };
    const abcValue = { A: 0, B: 0, C: 0, D: 0 };
    
    locations.forEach(loc => {
      (loc.packages || []).forEach(pkg => {
        const cls = pkg.abcClass || 'D';
        // Asegurarnos de que la clase existe en el objeto, si no, asignar a D
        const safeCls = abc[cls] !== undefined ? cls : 'D';
        
        abc[safeCls] += pkg.qty;
        abcValue[safeCls] += pkg.qty * (pkg.cost || 0);
      });
    });
    
    const total = Object.values(abc).reduce((a, b) => a + b, 0) || 1;
    const totalValue = Object.values(abcValue).reduce((a, b) => a + b, 0) || 1;
    
    return {
      distribution: {
        A: { units: abc.A, percentage: ((abc.A / total) * 100).toFixed(1) },
        B: { units: abc.B, percentage: ((abc.B / total) * 100).toFixed(1) },
        C: { units: abc.C, percentage: ((abc.C / total) * 100).toFixed(1) },
        D: { units: abc.D, percentage: ((abc.D / total) * 100).toFixed(1) }
      },
      valueDistribution: {
        A: { value: abcValue.A, percentage: ((abcValue.A / totalValue) * 100).toFixed(1) },
        B: { value: abcValue.B, percentage: ((abcValue.B / totalValue) * 100).toFixed(1) },
        C: { value: abcValue.C, percentage: ((abcValue.C / totalValue) * 100).toFixed(1) },
        D: { value: abcValue.D, percentage: ((abcValue.D / totalValue) * 100).toFixed(1) }
      },
      ideal: { A: 20, B: 30, C: 30, D: 20 } // Pareto ideal
    };
  }

  analyzeSeasonality(locations) {
    const seasons = {};
    let oldStock = 0;
    const currentSeason = 'V26'; // Parametrizar esto según la fecha real
    
    locations.forEach(loc => {
      (loc.packages || []).forEach(pkg => {
        const season = pkg.season || 'N/A';
        seasons[season] = (seasons[season] || 0) + pkg.qty;
        
        if (season !== currentSeason && season !== 'N/A' && !season.includes('26')) {
          oldStock += pkg.qty;
        }
      });
    });
    
    const total = Object.values(seasons).reduce((a, b) => a + b, 0) || 1;
    
    return {
      bySeason: Object.entries(seasons).map(([season, qty]) => ({
        season,
        units: qty,
        percentage: ((qty / total) * 100).toFixed(1),
        isCurrent: season === currentSeason
      })).sort((a, b) => b.units - a.units),
      oldStockUnits: oldStock,
      oldStockPercentage: ((oldStock / total) * 100).toFixed(1),
      currentSeason
    };
  }

  analyzeSpaceUtilization(locations) {
    const withStock = locations.filter(l => l.totalStock > 0);
    if (withStock.length === 0) return { averageOccupancy: 0, semiEmptyCount: 0, underutilizedCount: 0 };

    const semiEmpty = withStock.filter(l => (l.occupancyPercentage || 0) < 50);
    const underutilized = withStock.filter(l => (l.occupancyPercentage || 0) < 30);
    
    return {
      averageOccupancy: (withStock.reduce((sum, l) => sum + (l.occupancyPercentage || 0), 0) / withStock.length).toFixed(1),
      semiEmptyCount: semiEmpty.length,
      underutilizedCount: underutilized.length,
      potentialCompaction: Math.ceil(semiEmpty.length * 0.3), // Podrías liberar 30%
      wastedSpace: semiEmpty.length * 0.5 // Ubicaciones equivalentes desperdiciadas
    };
  }

  analyzeVelocity(locations) {
    const products = [];
    
    locations.forEach(loc => {
      (loc.packages || []).forEach(pkg => {
        if (pkg.velocity) {
          products.push({
            code: pkg.productCode,
            velocity: pkg.velocity,
            stock: pkg.qty,
            coverage: pkg.velocity > 0 ? (pkg.qty / pkg.velocity).toFixed(1) : 'Infinito'
          });
        }
      });
    });
    
    if (products.length === 0) return { averageVelocity: 0, fastMovers: 0, slowMovers: 0, topProducts: [] };

    const avgVelocity = products.reduce((sum, p) => sum + p.velocity, 0) / products.length;
    const fastMovers = products.filter(p => p.velocity > avgVelocity * 1.5);
    const slowMovers = products.filter(p => p.velocity < avgVelocity * 0.3);
    
    return {
      averageVelocity: avgVelocity.toFixed(2),
      fastMovers: fastMovers.length,
      slowMovers: slowMovers.length,
      topProducts: products.sort((a, b) => b.velocity - a.velocity).slice(0, 5)
    };
  }

  analyzeSales(salesData) {
      // Adaptador simple si llega info de ventas
      return salesData.summary || {};
  }

  detectStrategicIssues(locations) {
    const issues = [];
    
    // ISSUE 1: Stock Zombie (D con más de 180 días)
    const zombies = locations.filter(l => 
      (l.packages || []).some(p => p.abcClass === 'D' && p.daysOld > 180)
    ).length;
    
    if (zombies > 10) {
      issues.push({
        type: 'critical',
        category: 'dead_stock',
        title: 'Stock Zombie Crítico',
        impact: 'high',
        description: `${zombies} ubicaciones con producto D >180 días`,
        consequence: 'Capital inmovilizado, espacio desperdiciado',
        urgency: 'immediate'
      });
    }
    
    // ISSUE 2: Productos A mal ubicados
    const misplacedA = locations.filter(l => 
      l.id.match(/03-03$/) && (l.packages || []).some(p => p.abcClass === 'A')
    ).length; 
    
    if (misplacedA > 5) {
      issues.push({
        type: 'warning',
        category: 'slotting',
        title: 'Productos A en altura',
        impact: 'medium',
        description: `${misplacedA} ubicaciones con A en posiciones altas`,
        consequence: 'Picking lento',
        urgency: 'short_term'
      });
    }
    
    return issues;
  }

  detectOpportunities(locations) {
    const opportunities = [];
    
    // OPORTUNIDAD 1: Compactación
    const compactable = locations.filter(l => 
      l.totalStock > 0 && (l.occupancyPercentage || 0) < 40
    ).length;
    
    if (compactable > 20) {
      opportunities.push({
        type: 'space_optimization',
        title: 'Compactación de ubicaciones',
        potential: `Liberar ~${Math.ceil(compactable * 0.4)} huecos`,
        benefit: 'Reducción de costes',
        effort: 'medium',
        roi: 'high'
      });
    }
    
    return opportunities;
  }

  // ============================================
  // GENERACIÓN DE ANÁLISIS CON GPT-4o
  // ============================================
  
  async generateStrategicReport(intelligence, conversationHistory = []) {
    console.log('🧠 [IA] Generando reporte con GPT-4o...');
    
    // PROMPT MASTER
    const systemPrompt = `Eres un Director de Operaciones experto en logística.

    CONTEXTO DE NEGOCIO:
    ${JSON.stringify(this.businessContext, null, 2)}

    TU ROL:
    - Analizar datos profundamente
    - Pensar en el IMPACTO FINANCIERO
    - Priorizar por ROI y urgencia
    - Dar recomendaciones ACCIONABLES (No digas "optimizar", di "mover X palets")

    ESTILO DE RESPUESTA (Markdown):
    - Encabezados claros con emojis
    - Secciones: 🎯 Situación Actual | ⚠️ Problemas Críticos | 💡 Oportunidades | 📋 Plan de Acción
    - Bloques de pensamiento visibles (quotes)
    `;

    // Construir el mensaje con TODA la inteligencia
    const userMessage = `
    # DATOS DEL ALMACÉN
    - Métricas Básicas: ${JSON.stringify(intelligence.basic)}
    - Distribución ABC: ${JSON.stringify(intelligence.abc)}
    - Temporadas: ${JSON.stringify(intelligence.seasons)}
    - Espacio: ${JSON.stringify(intelligence.space)}
    - Problemas Sistema: ${JSON.stringify(intelligence.issues)}
    - Oportunidades Sistema: ${JSON.stringify(intelligence.opportunities)}

    INSTRUCCIÓN:
    Analiza estos datos. Dame insights que yo no vea a simple vista. Calcula impactos en Euros.`;

    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          ...conversationHistory.slice(-4), 
          { role: "user", content: userMessage }
        ],
        temperature: 0.7,
        max_tokens: 2500
      });

      const analysis = response.choices[0].message.content;
      
      // Guardar en memoria simple
      this.analysisMemory.set(Date.now(), { summary: analysis.substring(0, 50) });
      
      console.log('✅ [IA] Análisis generado correctamente.');
      
      return {
        text: analysis,
        intelligence, // Datos crudos para gráficos
        metadata: {
          generated: new Date().toISOString(),
          model: 'gpt-4o'
        }
      };
      
    } catch (error) {
      console.error('❌ [IA] Error generando análisis:', error.message);
      return {
          text: "⚠️ **Error generando el análisis.** \n\nHubo un problema conectando con la IA. Por favor verifica tu API Key y conexión.",
          intelligence: intelligence,
          metadata: { error: true }
      };
    }
  }
}

// Exportar instancia singleton
export const strategicAnalyzer = new StrategicAnalyzer();