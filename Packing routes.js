// ==================================================================================
//  ⭐ MÓDULO PACKING LIST ANALYZER - AÑADIR AL SERVER.JS DEL GEMELO
// ==================================================================================
//
//  INSTRUCCIONES:
//  1. Añade estos imports al principio del server.js (después de los otros imports):
//
//     import multer from 'multer';
//     import { exec } from 'child_process';
//     import { promisify } from 'util';
//     const execPromise = promisify(exec);
//
//  2. Añade esta configuración de multer después de las otras configuraciones:
//
//     // Configurar multer para uploads de Packing List
//     const packingStorage = multer.diskStorage({
//       destination: './uploads/',
//       filename: (req, file, cb) => {
//         cb(null, `${Date.now()}-${file.originalname}`);
//       }
//     });
//     const packingUpload = multer({ storage: packingStorage, limits: { fileSize: 50 * 1024 * 1024 } });
//
//     // Crear carpetas para packing
//     if (!fsSync.existsSync('./uploads')) fsSync.mkdirSync('./uploads', { recursive: true });
//     if (!fsSync.existsSync('./packing-outputs')) fsSync.mkdirSync('./packing-outputs', { recursive: true });
//
//  3. Copia todo el código de abajo y pégalo antes de los endpoints de WebSocket
//
// ==================================================================================

// ==================================================================================
//  CACHE DE PRODUCTOS PARA PACKING LIST
// ==================================================================================
let packingProductCache = new Map();
let packingAbcCache = new Map();
let packingStockCache = new Map();
let packingLastCacheUpdate = null;

async function refreshPackingCache() {
  console.log('📦 [PACKING] Actualizando caché...');
  const startTime = Date.now();

  try {
    const common = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/common` });
    const models = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/object` });
    
    const uid = await new Promise((resolve, reject) => {
      common.methodCall('authenticate', [
        process.env.ODOO_DB, process.env.ODOO_USERNAME, process.env.ODOO_PASSWORD, {}
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    // 1. Productos
    console.log('  📦 Descargando productos...');
    const products = await new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        process.env.ODOO_DB, uid, process.env.ODOO_PASSWORD,
        'product.product', 'search_read',
        [[['default_code', '!=', false], ['active', '=', true]]],
        { fields: ['id', 'default_code', 'name', 'standard_price'], limit: 50000 }
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    packingProductCache.clear();
    products.forEach(p => {
      if (p.default_code) {
        packingProductCache.set(p.default_code.toUpperCase().trim(), {
          id: p.id,
          name: p.name,
          code: p.default_code,
          cost: p.standard_price || 0
        });
      }
    });
    console.log(`    ✅ ${packingProductCache.size} productos`);

    // 2. Clasificación ABC
    console.log('  📊 Descargando clasificación ABC...');
    try {
      const abcData = await new Promise((resolve, reject) => {
        models.methodCall('execute_kw', [
          process.env.ODOO_DB, uid, process.env.ODOO_PASSWORD,
          'abc.classification.product.level', 'search_read',
          [[]],
          { fields: ['product_id', 'level_id'], limit: 100000 }
        ], (err, res) => err ? reject(err) : resolve(res));
      });

      packingAbcCache.clear();
      abcData.forEach(row => {
        if (row.product_id && row.level_id) {
          const productId = row.product_id[0];
          const level = row.level_id[1] || 'D';
          packingAbcCache.set(productId, level.charAt(0).toUpperCase());
        }
      });
      console.log(`    ✅ ${packingAbcCache.size} clasificaciones ABC`);
    } catch (e) {
      console.log(`    ⚠️ No se pudo cargar ABC: ${e.message}`);
    }

    // 3. Stock
    console.log('  📍 Descargando stock...');
    const quants = await new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        process.env.ODOO_DB, uid, process.env.ODOO_PASSWORD,
        'stock.quant', 'search_read',
        [[['location_id.usage', '=', 'internal'], ['quantity', '>', 0]]],
        { fields: ['product_id', 'location_id', 'quantity'], limit: 100000 }
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    packingStockCache.clear();
    quants.forEach(q => {
      if (q.product_id) {
        const productId = q.product_id[0];
        if (!packingStockCache.has(productId)) {
          packingStockCache.set(productId, { total: 0, locations: [] });
        }
        const entry = packingStockCache.get(productId);
        entry.total += q.quantity;
        entry.locations.push({
          id: q.location_id[0],
          name: q.location_id[1],
          qty: q.quantity
        });
      }
    });
    console.log(`    ✅ ${packingStockCache.size} productos con stock`);

    packingLastCacheUpdate = new Date();
    console.log(`✅ [PACKING] Caché actualizada en ${((Date.now() - startTime) / 1000).toFixed(1)}s\n`);

    return { products: packingProductCache.size, abc: packingAbcCache.size, stock: packingStockCache.size };

  } catch (error) {
    console.error('❌ [PACKING] Error actualizando caché:', error.message);
    throw error;
  }
}

// ==================================================================================
//  PARSER DE PDF PARA PACKING LIST
// ==================================================================================
async function parsePackingPDF(filePath) {
  // Usar pdfplumber de Python para extraer tablas
  const pythonScript = `
import pdfplumber
import json
import re

def extract_number(val):
    if not val:
        return 0
    match = re.search(r'[\\d.,]+', str(val).replace(',', '.'))
    if match:
        try:
            return float(match.group().replace(',', '.'))
        except:
            return 0
    return 0

results = []
with pdfplumber.open("${filePath.replace(/\\/g, '\\\\')}") as pdf:
    for page_num, page in enumerate(pdf.pages):
        tables = page.extract_tables()
        for table in tables:
            if not table or len(table) < 2:
                continue

            headers = [str(h).strip().replace('\\n', ' ') if h else '' for h in table[0]]

            for row in table[1:]:
                if not row or all(cell is None or str(cell).strip() == '' for cell in row):
                    continue

                row_data = {}
                for i, cell in enumerate(row):
                    if i < len(headers):
                        key = headers[i]
                        val = str(cell).strip() if cell else ''
                        row_data[key] = val

                item_no = row_data.get('Item No', '')
                if item_no and not item_no.startswith('Total'):
                    row_data['_PRS'] = int(extract_number(row_data.get('PRS', '0')))
                    row_data['_CTNS'] = int(extract_number(row_data.get('CTNS', '0')))
                    row_data['_CBM'] = extract_number(row_data.get('CBM', '0'))
                    row_data['_TTL_GW'] = extract_number(row_data.get('TTL G.W.', '0'))
                    results.append(row_data)

print(json.dumps(results, ensure_ascii=False))
`;

  const { stdout } = await execPromise(`python3 -c '${pythonScript.replace(/'/g, "'\"'\"'")}'`);
  return JSON.parse(stdout);
}

// ==================================================================================
//  MOTOR DE ENRIQUECIMIENTO PACKING LIST
// ==================================================================================
function enrichPackingList(parsedRows) {
  const enriched = [];
  const summary = {
    totalUnits: 0,
    totalCartons: 0,
    totalCBM: 0,
    totalWeight: 0,
    byABC: { A: 0, B: 0, C: 0, D: 0, NEW: 0 },
    newReferences: [],
    consolidationAlerts: [],
    excessAlerts: []
  };

  const byReference = new Map();

  parsedRows.forEach(row => {
    const itemNo = row['Item No'] || '';
    if (!itemNo) return;

    const units = row['_PRS'] || 0;
    const cartons = row['_CTNS'] || 0;
    const cbm = row['_CBM'] || 0;
    const grossWeight = row['_TTL_GW'] || 0;

    if (!byReference.has(itemNo)) {
      byReference.set(itemNo, {
        itemNo,
        orderNos: new Set(),
        descriptions: new Set(),
        totalUnits: 0,
        totalCartons: 0,
        totalCBM: 0,
        totalWeight: 0,
        lines: []
      });
    }

    const ref = byReference.get(itemNo);
    ref.orderNos.add(row['Order No.'] || '');
    ref.descriptions.add(row['Order Description'] || '');
    ref.totalUnits += units;
    ref.totalCartons += cartons;
    ref.totalCBM += cbm;
    ref.totalWeight += grossWeight;
    ref.lines.push(row);

    summary.totalUnits += units;
    summary.totalCartons += cartons;
    summary.totalCBM += cbm;
    summary.totalWeight += grossWeight;
  });

  // Enriquecer cada referencia
  byReference.forEach((ref, itemNo) => {
    const productInfo = packingProductCache.get(itemNo.toUpperCase().trim());

    let abcClass = 'NEW';
    let currentStock = 0;
    let stockLocations = [];
    let zoneRecommendation = 'Por asignar';
    let alerts = [];

    if (productInfo) {
      const abc = packingAbcCache.get(productInfo.id);
      abcClass = abc || 'D';

      const stock = packingStockCache.get(productInfo.id);
      if (stock) {
        currentStock = stock.total;
        stockLocations = stock.locations;
      }

      // Zona según ABC
      switch (abcClass) {
        case 'A': zoneRecommendation = 'Pasillos 1-3 (Alta rotación)'; break;
        case 'B': zoneRecommendation = 'Pasillos 4-6 (Media rotación)'; break;
        case 'C': zoneRecommendation = 'Pasillos 7-9 (Baja rotación)'; break;
        case 'D': zoneRecommendation = 'Pasillos 10+ o Fondo'; break;
      }

      // Alertas
      if (currentStock > 0) {
        const mainLocation = stockLocations.sort((a, b) => b.qty - a.qty)[0];
        if (mainLocation) {
          alerts.push({
            type: 'consolidar',
            message: `Ya tiene ${currentStock} uds en ${mainLocation.name}. Consolidar.`
          });
          summary.consolidationAlerts.push({
            itemNo,
            currentStock,
            incomingUnits: ref.totalUnits,
            location: mainLocation.name
          });
        }

        if (ref.totalUnits > currentStock * 3) {
          alerts.push({
            type: 'exceso',
            message: `⚠️ Exceso: ${ref.totalUnits} uds entrando vs ${currentStock} en stock`
          });
          summary.excessAlerts.push({ itemNo, incoming: ref.totalUnits, current: currentStock });
        }
      }
    } else {
      alerts.push({ type: 'nuevo', message: '🆕 Nueva referencia - No existe en Odoo' });
      summary.newReferences.push(itemNo);
    }

    const estimatedPalets = Math.ceil(ref.totalCBM / 0.5);

    if (abcClass === 'NEW') {
      summary.byABC.NEW += ref.totalUnits;
    } else {
      summary.byABC[abcClass] = (summary.byABC[abcClass] || 0) + ref.totalUnits;
    }

    enriched.push({
      itemNo,
      productName: productInfo?.name || 'Desconocido',
      orderNos: Array.from(ref.orderNos).filter(Boolean).join(', '),
      descriptions: Array.from(ref.descriptions).filter(Boolean).join(', '),
      totalUnits: ref.totalUnits,
      totalCartons: ref.totalCartons,
      totalCBM: ref.totalCBM.toFixed(3),
      totalWeight: ref.totalWeight.toFixed(2),
      estimatedPalets,
      abcClass,
      zoneRecommendation,
      currentStock,
      stockLocations: stockLocations.slice(0, 3),
      alerts,
      lines: ref.lines.length
    });
  });

  // Ordenar por ABC
  const abcOrder = { A: 1, B: 2, C: 3, D: 4, NEW: 5 };
  enriched.sort((a, b) => {
    const abcDiff = (abcOrder[a.abcClass] || 99) - (abcOrder[b.abcClass] || 99);
    if (abcDiff !== 0) return abcDiff;
    return b.totalUnits - a.totalUnits;
  });

  return { items: enriched, summary };
}

// ==================================================================================
//  GENERADOR DE EXCEL PARA PACKING LIST
// ==================================================================================
async function generatePackingExcel(enrichedData, containerNumber) {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.default.Workbook();

  // Hoja 1: Resumen
  const summarySheet = workbook.addWorksheet('Resumen');
  summarySheet.columns = [
    { header: 'Métrica', key: 'metric', width: 30 },
    { header: 'Valor', key: 'value', width: 20 }
  ];

  const { summary } = enrichedData;
  summarySheet.addRows([
    { metric: 'Contenedor', value: containerNumber },
    { metric: 'Total Unidades', value: summary.totalUnits },
    { metric: 'Total Cajas', value: summary.totalCartons },
    { metric: 'Total CBM', value: summary.totalCBM.toFixed(2) },
    { metric: 'Peso Total (kg)', value: summary.totalWeight.toFixed(2) },
    { metric: '', value: '' },
    { metric: 'Unidades ABC A', value: summary.byABC.A },
    { metric: 'Unidades ABC B', value: summary.byABC.B },
    { metric: 'Unidades ABC C', value: summary.byABC.C },
    { metric: 'Unidades ABC D', value: summary.byABC.D },
    { metric: 'Unidades NUEVAS', value: summary.byABC.NEW },
    { metric: '', value: '' },
    { metric: 'Referencias Nuevas', value: summary.newReferences.length },
    { metric: 'Alertas Consolidación', value: summary.consolidationAlerts.length },
    { metric: 'Alertas Exceso', value: summary.excessAlerts.length }
  ]);

  summarySheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  summarySheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };

  // Hoja 2: Detalle
  const detailSheet = workbook.addWorksheet('Packing List Enriquecido');
  detailSheet.columns = [
    { header: 'Referencia', key: 'itemNo', width: 20 },
    { header: 'Producto', key: 'productName', width: 35 },
    { header: 'Unidades', key: 'totalUnits', width: 12 },
    { header: 'Cajas', key: 'totalCartons', width: 10 },
    { header: 'CBM', key: 'totalCBM', width: 10 },
    { header: 'Peso (kg)', key: 'totalWeight', width: 12 },
    { header: 'Palets Est.', key: 'estimatedPalets', width: 12 },
    { header: 'ABC', key: 'abcClass', width: 8 },
    { header: 'Zona Recomendada', key: 'zoneRecommendation', width: 25 },
    { header: 'Stock Actual', key: 'currentStock', width: 12 },
    { header: 'Ubicación Principal', key: 'mainLocation', width: 20 },
    { header: 'Alertas', key: 'alertsText', width: 40 }
  ];

  detailSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  detailSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };

  const abcColors = {
    A: 'FF92D050', B: 'FFFFFF00', C: 'FFFFC000', D: 'FFFF6B6B', NEW: 'FF00B0F0'
  };

  enrichedData.items.forEach((item) => {
    const row = detailSheet.addRow({
      itemNo: item.itemNo,
      productName: item.productName,
      totalUnits: item.totalUnits,
      totalCartons: item.totalCartons,
      totalCBM: item.totalCBM,
      totalWeight: item.totalWeight,
      estimatedPalets: item.estimatedPalets,
      abcClass: item.abcClass,
      zoneRecommendation: item.zoneRecommendation,
      currentStock: item.currentStock,
      mainLocation: item.stockLocations[0]?.name || '-',
      alertsText: item.alerts.map(a => a.message).join(' | ')
    });

    const abcCell = row.getCell('abcClass');
    abcCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: abcColors[item.abcClass] || 'FFFFFFFF' } };
    abcCell.font = { bold: true };

    if (item.alerts.length > 0) {
      row.getCell('alertsText').font = { color: { argb: 'FFFF0000' } };
    }
  });

  const outputPath = `./packing-outputs/PL_ENRIQUECIDO_${containerNumber}_${Date.now()}.xlsx`;
  await workbook.xlsx.writeFile(outputPath);

  return outputPath;
}

// ==================================================================================
//  ⭐ ENDPOINTS PACKING LIST - AÑADIR AL SERVER.JS
// ==================================================================================

// Health check
app.get("/api/packing/health", (req, res) => {
  res.json({
    status: 'ok',
    odooConnected: !!process.env.ODOO_URL,
    cache: {
      products: packingProductCache.size,
      abc: packingAbcCache.size,
      stock: packingStockCache.size,
      lastUpdate: packingLastCacheUpdate
    }
  });
});

// Refrescar caché manualmente
app.post("/api/packing/cache/refresh", async (req, res) => {
  try {
    const stats = await refreshPackingCache();
    res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Analizar PDF
app.post("/api/packing/analyze", packingUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió archivo' });
    }

    console.log(`📄 [PACKING] Analizando: ${req.file.originalname}`);

    // Refrescar caché si tiene más de 1 hora
    if (process.env.ODOO_URL && (!packingLastCacheUpdate || (Date.now() - packingLastCacheUpdate.getTime()) > 3600000)) {
      try {
        await refreshPackingCache();
      } catch (e) {
        console.warn('⚠️ [PACKING] No se pudo actualizar caché Odoo:', e.message);
      }
    }

    // Parsear PDF
    const parsed = await parsePackingPDF(req.file.path);
    console.log(`  📊 ${parsed.length} líneas extraídas`);

    // Detectar contenedor
    const containerNumber = parsed[0]?.['CONTAINER NUMBER'] ||
                           parsed[0]?.['CONTAINER  NUMBER'] ||
                           req.file.originalname.match(/[A-Z]{4}\d{7}/)?.[0] ||
                           'UNKNOWN';

    // Enriquecer
    const enriched = enrichPackingList(parsed);
    console.log(`  📍 ${enriched.items.length} referencias procesadas`);

    // Generar Excel
    const excelPath = await generatePackingExcel(enriched, containerNumber);
    console.log(`  📁 Excel: ${excelPath}`);

    // Limpiar archivo temporal
    await fs.unlink(req.file.path).catch(() => {});

    res.json({
      success: true,
      containerNumber,
      summary: enriched.summary,
      items: enriched.items,
      excelFile: path.basename(excelPath)
    });

  } catch (error) {
    console.error('❌ [PACKING] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Descargar Excel generado
app.get("/api/packing/download/:filename", (req, res) => {
  const filePath = path.join(__dirname, 'packing-outputs', req.params.filename);
  res.download(filePath);
});

// Servir archivos estáticos de packing-outputs
app.use("/packing-outputs", express.static(path.join(__dirname, 'packing-outputs')));