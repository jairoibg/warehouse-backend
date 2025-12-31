# PROPUESTA MICRO-PASO 01: VALIDACIÓN DE CONTRATOS API CON ZOD

**Fecha:** 2025-01-27  
**Estado:** Propuesta pendiente de aprobación  
**Prioridad:** 🟢 MEDIA (segura, no rompe nada existente)

---

## A) OBJETIVO EXACTO

Añadir validación de esquemas de datos en rutas críticas usando Zod, **sin cambiar la lógica existente**, para:
1. Detectar errores de transformación de datos tempranamente
2. Documentar contratos API de forma ejecutable
3. Preparar base para refactorizaciones seguras

**Alcance:** Solo validación de respuestas (no validación de entrada por ahora).

---

## B) ALCANCE Y LÍMITES

### ✅ QUÉ SE TOCA:
- **Archivo nuevo:** `src/utils/schemas.js` - Definiciones Zod de contratos
- **Archivos modificados:** 
  - `src/routes/history.routes.js` - Añadir validación de respuesta
  - `src/services/historyService.js` - Opcional: validación interna (sin romper)
- **Dependencias:** Añadir `zod` a package.json

### ⛔ QUÉ NO SE TOCA:
- **Lógica de negocio:** Cero cambios en cálculos o transformaciones
- **Formatos de salida:** Las respuestas JSON son idénticas
- **Frontend:** Sin cambios
- **Export Excel:** No se toca en este paso
- **Sincronización Odoo:** No se toca
- **Otras rutas:** Solo se valida `/api/history/metrics` como prueba

---

## C) CONTRATOS AFECTADOS

### C.1 Tipos TypeScript (No aplica en backend JS, pero documentamos estructura)

**Respuesta `/api/history/metrics`:**
```typescript
{
  success: true,
  days: number,
  count: number,
  data: Array<{
    timestamp: string,  // ISO 8601
    metrics: {
      totalValue: number,
      totalLocations: number,
      occupiedLocations: number,
      totalStock: number,
      avgOccupancy: number,
      abcDistribution: {
        A: number,
        B: number,
        C: number,
        D: number
      }
    }
  }>
}
```

**Respuesta `/api/history/comparison`:**
```typescript
{
  success: true,
  comparison: {
    period1: { days: number, average: {...}, snapshots: number },
    period2: { days: number, average: {...}, snapshots: number },
    changes: { ... }
  }
} | {
  success: false,
  error: string
}
```

### C.2 Rutas afectadas
- `GET /api/history/metrics` - Validación de respuesta
- `GET /api/history/comparison` - Validación de respuesta (opcional, solo si tiempo)

### C.3 Formatos Export (NO se tocan en este paso)
- Excel: Sin cambios
- CSV: Sin cambios

### C.4 Esquemas de datos
- `data/history/metrics_history.json`: Formato se mantiene idéntico
- Validación solo en memoria, no afecta persistencia

---

## D) DEPENDENCIAS E IMPACTOS

### D.1 Dependencias nuevas
- **`zod`** (versión 3.x)
  - Tamaño: ~50KB minified
  - Licencia: MIT
  - Compatibilidad: Node 18+ ✅
  - Justificación: Standard de facto para validación de esquemas en JS/TS

### D.2 Impactos

#### UI
- **Ninguno** - Validación es transparente al frontend

#### Estado
- **Ninguno** - No se cambia estado compartido

#### Servicios
- **Historial:** Se añade wrapper de validación, lógica interna intacta

#### Build
- **Ninguno** - Solo dependencia nueva, no cambios en configuración

#### Rendimiento
- **Mínimo** - Validación Zod es rápida (~1-2ms por respuesta)
- Solo afecta rutas `/api/history/*`

#### Bundle Size
- **Backend:** +50KB (zod)
- **Frontend:** Sin cambios

---

## E) RIESGOS DE REGRESIÓN + MITIGACIONES

### 🔴 ALTO: Validación demasiado estricta rompe respuestas válidas
**Mitigación:**
- Validación solo en modo desarrollo inicialmente (env flag)
- Log de warnings si falla validación (no falla la request)
- Ajustar esquema Zod para ser permisivo con campos opcionales

### ⚠️ MEDIO: Zod añade overhead de validación
**Mitigación:**
- Validación solo en desarrollo (por defecto)
- Opcional en producción via env: `ENABLE_SCHEMA_VALIDATION=true`
- Si problemas de rendimiento, desactivar sin afectar funcionalidad

### 🟢 BAJO: Dependencia nueva introduce vulnerabilidad
**Mitigación:**
- Zod es maduro y mantenido activamente
- Revisar `npm audit` después de instalar
- Usar versión pinned en package.json

**Plan de rollback:**
- Eliminar validación (comentar líneas)
- Remover `zod` de package.json
- Sistema funciona igual que antes

---

## F) PLAN DE IMPLEMENTACIÓN INCREMENTAL

### Paso F.1: Instalar dependencia
```bash
cd warehouse-backend
npm install zod
```

### Paso F.2: Crear archivo de esquemas
**Archivo:** `src/utils/schemas.js`

```javascript
import { z } from 'zod';

// Esquema para snapshot de métricas
export const MetricsSnapshotSchema = z.object({
  timestamp: z.string().datetime(),
  metrics: z.object({
    totalValue: z.number(),
    totalLocations: z.number(),
    occupiedLocations: z.number(),
    totalStock: z.number(),
    avgOccupancy: z.number(),
    abcDistribution: z.object({
      A: z.number(),
      B: z.number(),
      C: z.number(),
      D: z.number()
    })
  })
});

// Esquema para respuesta de historial
export const HistoryMetricsResponseSchema = z.object({
  success: z.literal(true),
  days: z.number().int().positive(),
  count: z.number().int().nonnegative(),
  data: z.array(MetricsSnapshotSchema)
});
```

### Paso F.3: Añadir validación opcional a historyService
**Archivo:** `src/services/historyService.js`

```javascript
// Al final del archivo, función helper
import { MetricsSnapshotSchema } from '../utils/schemas.js';
import { getConfig } from '../config/env.js';

function validateSnapshot(snapshot) {
  const config = getConfig();
  const enableValidation = process.env.ENABLE_SCHEMA_VALIDATION === 'true';
  
  if (!enableValidation) return snapshot;
  
  try {
    return MetricsSnapshotSchema.parse(snapshot);
  } catch (error) {
    logger.warn('Snapshot validation failed', { 
      error: error.message, 
      snapshot: snapshot 
    });
    return snapshot; // No falla, solo log
  }
}

// Usar en saveMetricsSnapshot() antes de push
// history.push(validateSnapshot(snapshot));
```

### Paso F.4: Añadir validación a history.routes.js
**Archivo:** `src/routes/history.routes.js`

```javascript
import { HistoryMetricsResponseSchema } from '../utils/schemas.js';
import { getConfig } from '../config/env.js';

router.get('/metrics', asyncHandler(async (req, res) => {
  const { days = 30 } = req.query;
  const history = await getMetricsHistory(parseInt(days));
  
  const response = {
    success: true,
    days: parseInt(days),
    count: history.length,
    data: history
  };
  
  // Validación opcional (solo en desarrollo o si está habilitada)
  const enableValidation = process.env.ENABLE_SCHEMA_VALIDATION === 'true' || 
                           process.env.NODE_ENV === 'development';
  
  if (enableValidation) {
    try {
      HistoryMetricsResponseSchema.parse(response);
    } catch (error) {
      logger.warn('History response validation failed', { 
        error: error.message,
        errors: error.errors 
      });
      // No falla la request, solo log
    }
  }
  
  res.json(response);
}));
```

### Paso F.5: Testing manual
1. Iniciar servidor: `npm start`
2. Llamar: `GET http://localhost:4000/api/history/metrics?days=30`
3. Verificar respuesta JSON idéntica
4. Verificar logs (no debe haber warnings si datos son válidos)
5. Activar validación: `ENABLE_SCHEMA_VALIDATION=true npm start`
6. Repetir llamada, verificar que sigue funcionando

---

## G) PLAN DE VALIDACIÓN

### G.1 Comandos

```bash
# 1. Instalar dependencia
cd warehouse-backend
npm install zod

# 2. Verificar que no rompe build
npm start
# Debe iniciar sin errores

# 3. Test manual de endpoint
curl http://localhost:4000/api/history/metrics?days=30
# Debe responder JSON válido idéntico al anterior

# 4. Test con validación activada
ENABLE_SCHEMA_VALIDATION=true npm start
curl http://localhost:4000/api/history/metrics?days=30
# Debe responder igual, verificar logs (no warnings si datos válidos)

# 5. Verificar que frontend sigue funcionando
# Abrir frontend, navegar a página "Histórico"
# Debe cargar sin errores
```

### G.2 Pruebas unitarias (si existieran)
- Test: `HistoryMetricsResponseSchema.parse()` con datos válidos → debe pasar
- Test: `HistoryMetricsResponseSchema.parse()` con datos inválidos → debe lanzar error

**Nota:** Como no hay infraestructura de testing, no se crean tests en este paso (es seguro sin tests porque no cambia lógica).

### G.3 Casos manuales

**Caso 1: Historial con datos válidos**
1. Servidor con datos históricos existentes
2. GET `/api/history/metrics?days=7`
3. ✅ Respuesta 200, JSON válido
4. ✅ Sin warnings en logs (si validación activa)

**Caso 2: Historial sin datos**
1. Servidor nuevo sin historial
2. GET `/api/history/metrics?days=7`
3. ✅ Respuesta 200, `data: []`
4. ✅ Sin warnings en logs

**Caso 3: Frontend consume endpoint**
1. Abrir frontend en navegador
2. Navegar a vista "Histórico"
3. ✅ Datos se cargan correctamente
4. ✅ Gráficos se renderizan (si aplica)

---

## H) PLAN DE OBSERVABILIDAD

### H.1 Logs estructurados

**Nuevos logs (solo si validación falla):**
```javascript
logger.warn('Snapshot validation failed', { 
  error: error.message,
  errors: error.errors,  // Array de errores Zod
  snapshot: snapshot      // Snapshot completo para debugging
});

logger.warn('History response validation failed', {
  error: error.message,
  errors: error.errors,
  responseKeys: Object.keys(response)  // Para debugging
});
```

**Niveles:**
- `warn` - Validación falla pero no rompe funcionalidad
- `error` - Solo si hay error inesperado (no debería pasar)

### H.2 Métricas (opcional, futuro)
- No se añaden métricas en este paso (es micro-paso)

### H.3 Debug mode
- Variable de entorno: `ENABLE_SCHEMA_VALIDATION=true`
- Por defecto: Solo en desarrollo (`NODE_ENV=development`)
- Permite activar/desactivar sin recompilar

---

## I) PLAN DE MIGRACIÓN/COMPATIBILIDAD

### I.1 Compatibilidad hacia atrás
- **100% compatible** - Las respuestas JSON son idénticas
- Frontend no necesita cambios
- Validación es transparente (solo log interno)

### I.2 Versionado
- No se versiona API (no cambia contrato)
- Esquemas Zod son internos

### I.3 Deprecación
- No aplica (no hay código deprecado)

### I.4 Adaptadores
- No se necesitan adaptadores

---

## J) PLAN DE ROLLBACK

### Escenario 1: Validación causa problemas de rendimiento
**Acción:**
```bash
# Desactivar validación (por defecto ya está desactivada en producción)
unset ENABLE_SCHEMA_VALIDATION
npm start
```

**Tiempo:** < 1 minuto

### Escenario 2: Zod introduce vulnerabilidad
**Acción:**
```bash
npm uninstall zod
# Comentar imports y validaciones en:
# - src/routes/history.routes.js
# - src/services/historyService.js (si se añadió)
npm start
```

**Tiempo:** < 5 minutos

### Escenario 3: Validación rompe respuesta válida
**Acción:**
1. Revisar logs para identificar error de esquema
2. Ajustar esquema Zod para ser más permisivo
3. O desactivar validación temporalmente (ver Escenario 1)

**Tiempo:** < 15 minutos

### Escenario 4: Rollback completo (volver estado anterior)
**Acción:**
```bash
git checkout HEAD -- src/routes/history.routes.js
git checkout HEAD -- src/services/historyService.js  # Si se modificó
rm -f src/utils/schemas.js
npm uninstall zod
```

**Tiempo:** < 2 minutos

---

## RESUMEN DE CAMBIOS

### Archivos nuevos
- `src/utils/schemas.js` - Esquemas Zod

### Archivos modificados
- `src/routes/history.routes.js` - Validación opcional de respuesta
- `package.json` - Dependencia `zod`

### Archivos NO modificados (garantía)
- `src/services/historyService.js` - Opcional (solo si tiempo)
- Todos los demás archivos intactos

---

## CRITERIOS DE ÉXITO

✅ Servidor inicia sin errores  
✅ Endpoint `/api/history/metrics` responde idéntico a antes  
✅ Frontend carga datos de historial sin errores  
✅ Validación opcional funciona (con env flag)  
✅ Sin degradación de rendimiento observable  
✅ Rollback posible en < 5 minutos  

---

## PRÓXIMOS PASOS (después de este)

1. **Si este paso es exitoso:**
   - Extender validación a otras rutas críticas
   - Añadir validación de entrada (req.body, req.query)
   - Crear tipos TypeScript compartidos basados en Zod

2. **Si hay problemas:**
   - Revisar logs de validación
   - Ajustar esquemas o desactivar validación
   - Documentar lecciones aprendidas

---

**Estado:** ⏳ PENDIENTE DE APROBACIÓN  
**Riesgo:** 🟢 BAJO  
**Esfuerzo:** 🟢 BAJO (1-2 horas)  
**Valor:** 🟡 MEDIO (preparación para mejoras futuras)

