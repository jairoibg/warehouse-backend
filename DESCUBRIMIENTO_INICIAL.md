# DESCUBRIMIENTO INICIAL - GEMELO DIGITAL LOGÍSTICA/ERP

**Fecha:** 2025-01-27  
**Estado:** Análisis inicial completo  
**Objetivo:** Mapa del repositorio actual y núcleo protegido identificado

---

## 1. RESUMEN EJECUTIVO

MVP de "Gemelo Digital" para visualización y gestión de logística/ERP con:

- **Backend:** Node.js + Express + WebSocket (puerto 4000, red LAN)
- **Frontend:** React + Vite + Tailwind CSS (puerto 5173)
- **Integración:** Odoo ERP (XML-RPC)
- **Exportación:** ExcelJS (exceljs 4.4.0) para reportes Excel
- **Arquitectura:** Modular con separación de rutas/servicios/middleware

**Funcionalidades críticas identificadas:**
- Historial de métricas (90 días, snapshots cada hora)
- Movimientos de ubicaciones (últimos 90 días, agrupados por fecha)
- Exportación Excel (inventario, ejecutivo, alertas, riesgos)
- Visualización 2D/3D de almacén
- Dashboard ejecutivo y analytics avanzado

---

## 2. ESTRUCTURA DEL REPOSITORIO

### 2.1 Backend (`warehouse-backend`)

```
warehouse-backend/
├── server.js                    # Punto de entrada principal
├── package.json                 # Dependencies: express, exceljs, ws, xmlrpc, @anthropic-ai/sdk
├── src/
│   ├── config/                  # Configuración (env.js, odooConfig.js)
│   ├── routes/                  # 15 módulos de rutas modulares
│   ├── services/                # 19 servicios de negocio
│   ├── middleware/              # errorHandler, logger
│   ├── erp/                     # Integración Odoo (erpCliente, syncService)
│   ├── model/                   # warehouseState.js
│   └── utils/                   # csvGenerator.js
├── data/                        # Datos persistentes (locations.json, history/)
├── exports/                     # Reportes generados
└── sync_odoo.js                # Sincronización automática con Odoo
```

**Rutas principales:**
- `/api/locations` - Ubicaciones y movimientos
- `/api/history` - Historial y comparativas
- `/api/reports` - Generación de reportes (Excel, PDF, CSV)
- `/api/dashboard` - KPIs y métricas
- `/api/ai` - Funciones de IA (Claude)
- `/api/analytics` - Analytics avanzado

### 2.2 Frontend (`warehouse-frontend`)

```
warehouse-frontend/
├── src/
│   ├── App.tsx                  # Componente principal (1200+ líneas)
│   ├── components/              # 20+ componentes React
│   ├── hooks/                   # useWarehouseData, useApi, useAppStore
│   ├── types/                   # WarehouseLocation, MovementEvent
│   └── utils/                   # calculateLocationOccupancy
├── package.json                 # Dependencies: react, three.js, d3, tailwindcss
└── vite.config.ts              # Config: host 0.0.0.0, port 5173
```

---

## 3. NÚCLEO PROTEGIDO (CONTRATOS CRÍTICOS)

### 3.1 Funcionalidades que NO deben romperse

#### ✅ Historial de Métricas
- **Archivo:** `src/services/historyService.js`
- **Rutas:** `GET /api/history/metrics?days=30`
- **Contrato:**
  - Snapshots cada hora (configurable)
  - Retención: 90 días
  - Formato: `{ timestamp, metrics: { totalValue, totalLocations, occupiedLocations, ... } }`
- **Dependencias:** `warehouseService.getWarehouseContext()`

#### ✅ Movimientos de Ubicaciones
- **Archivo:** `src/routes/locations.routes.js`
- **Rutas:** `GET /api/locations/movements/:locationId?days=90`
- **Contrato:**
  - Agrupación por fecha (`agruparPorFecha`)
  - Separación entradas/salidas
  - Campos: `fecha, producto, cantidad, referencia, paquete, origen, destino`
- **Dependencias:** Odoo `stock.move.line` model

#### ✅ Exportación Excel
- **Archivo:** `src/services/exportService.js`
- **Rutas:** `POST /api/reports/excel`
- **Contrato:**
  - Librería: `exceljs` 4.4.0
  - Formatos: `inventory`, `executive`
  - Columnas fijas (ver código líneas 40-48, 87-90, 104-109, 124-129)
  - Múltiples hojas en `executive`: Resumen, Alertas, Riesgos
- **Dependencias:** `warehouseService`, `alertService`, `costAnalysisService`

#### ✅ Sincronización Odoo
- **Archivo:** `server.js` (líneas 156-173), `sync_odoo.js`
- **Contrato:**
  - Polling cada 5 segundos (configurable: `POLLING_INTERVAL_MS`)
  - Broadcast WebSocket de actualizaciones
  - Variables de entorno: `ODOO_URL`, `ODOO_DB`, `ODOO_USERNAME`, `ODOO_PASSWORD`

#### ✅ Visualización 2D/3D
- **Archivo:** `src/components/Warehouse3DScene.tsx` (frontend)
- **Contrato:**
  - Capas: OCCUPANCY, AGING, BRANDS, ABC, SEASON
  - Filtros: marca, ABC, temporada, rango ocupación
  - Interacción: selección de ubicación, tooltips

### 3.2 Rutas de compatibilidad (mantener)

En `server.js` líneas 112-133 hay rutas de compatibilidad:
- `/api/strategic-analysis` → `/api/ai/strategic-analysis`
- `/api/strategic-chat` → `/api/ai/strategic-chat`
- `/api/movements` → `/api/locations/movements`

**Estas rutas deben mantenerse para no romper el frontend existente.**

---

## 4. ESTADO ACTUAL DE CALIDAD

### 4.1 Fortalezas
- ✅ Arquitectura modular (rutas separadas, servicios independientes)
- ✅ Middleware de errores estructurado
- ✅ Logger con niveles
- ✅ Validación de entorno estricta
- ✅ WebSocket para actualizaciones en tiempo real
- ✅ Separación frontend/backend clara

### 4.2 Áreas de Mejora Identificadas

#### 🔴 CRÍTICO: Funcionalidades mencionadas no encontradas
- **"historial por día, agrupación por usuario/operación, duración por operación"**
  - **Estado:** NO encontradas en el código actual
  - **Acción requerida:** Aclarar si:
    1. Están planificadas pero no implementadas
    2. Existen en otra parte del código
    3. Son requerimientos nuevos

#### ⚠️ MEDIO: Testing
- No se encontraron tests unitarios ni de integración
- No hay validación automatizada de contratos

#### ⚠️ MEDIO: Tipado TypeScript
- Backend: JavaScript puro (sin tipos)
- Frontend: TypeScript (parcialmente tipado)

#### ⚠️ MEDIO: Event Log / Gemelo Digital
- Historial actual es snapshot de métricas agregadas
- No hay event log de operaciones individuales (OperationStarted, OperationCompleted, etc.)
- No hay trazabilidad de actor (userId) en movimientos

#### ⚠️ BAJO: Documentación
- Sin README principal
- Documentación fragmentada en archivos .md de roadmap

---

## 5. DEPENDENCIAS CLAVE

### Backend
```json
{
  "express": "^4.19.2",      // Framework web
  "exceljs": "^4.4.0",       // ⚠️ CRÍTICO: Export Excel
  "ws": "^8.17.0",           // WebSocket
  "xmlrpc": "^1.3.2",        // Integración Odoo
  "@anthropic-ai/sdk": "^0.71.2",  // IA (Claude)
  "compression": "^1.8.1",   // Gzip
  "cors": "^2.8.5"           // CORS
}
```

### Frontend
```json
{
  "react": "^18.2.0",
  "three": "^0.161.0",       // Visualización 3D
  "d3": "^7.9.0",            // Gráficos
  "tailwindcss": "^3.4.13"   // Estilos
}
```

**Nota:** Frontend menciona `xlsx` en el contexto pero no está en package.json (solo exceljs en backend).

---

## 6. CONFIGURACIÓN ACTUAL

### Variables de Entorno (Requeridas)
- `ODOO_URL` - URL de instancia Odoo
- `ODOO_DB` - Nombre de base de datos
- `ODOO_USERNAME` - Usuario Odoo
- `ODOO_PASSWORD` - Password Odoo

### Variables de Entorno (Opcionales)
- `PORT` - Puerto servidor (default: 4000)
- `SERVER_HOST` - Host servidor (default: localhost)
- `ANTHROPIC_API_KEY` - API Key para IA
- `POLLING_INTERVAL_MS` - Intervalo sincronización (default: 5000ms)
- `NODE_ENV` - Entorno (development/production)

### Configuración LAN
- Backend: `0.0.0.0:4000` (accesible desde red local)
- Frontend: `0.0.0.0:5173` (Vite dev server)
- WebSocket: Mismo puerto que backend (4000)

---

## 7. PUNTOS DE ENTRADA Y FLUJOS CRÍTICOS

### 7.1 Flujo de Sincronización Odoo
```
server.js (línea 159)
  → sync_odoo.js
    → odooService.odooExecute()
      → XML-RPC call a Odoo
        → Actualización locations.json
          → Broadcast WebSocket (UPDATE_LOCATIONS)
```

### 7.2 Flujo de Historial
```
server.js (línea 190)
  → historyService.startHistoryCollection(60min)
    → saveMetricsSnapshot() cada hora
      → warehouseService.getWarehouseContext()
        → Escritura a data/history/metrics_history.json
```

### 7.3 Flujo de Export Excel
```
POST /api/reports/excel
  → exportService.generateExcelReport(type)
    → exceljs.Workbook()
      → Múltiples hojas según tipo
        → Escritura a exports/*.xlsx
          → Respuesta con download_url
```

---

## 8. RIESGOS IDENTIFICADOS

### 🔴 ALTO
1. **Funcionalidades críticas no encontradas** (historial por día/usuario/operación/duración)
   - **Impacto:** No claro si existe o es requerimiento nuevo
   - **Mitigación:** Aclarar con usuario antes de refactorizar

### ⚠️ MEDIO
2. **Sin tests automatizados**
   - **Impacto:** Alto riesgo de regresiones en refactorizaciones
   - **Mitigación:** Crear tests mínimos para contratos críticos antes de cambios grandes

3. **Estado compartido en memoria** (`movements = []` en locations.routes.js línea 19)
   - **Impacto:** Se pierde en reinicios, no escalable
   - **Mitigación:** Migrar a persistencia si se usa activamente

4. **Sin validación de esquemas de datos**
   - **Impacto:** Errores silenciosos en transformaciones
   - **Mitigación:** Añadir Zod u otro validador para contratos API

### 🟢 BAJO
5. **Documentación fragmentada**
   - **Impacto:** Dificulta onboarding y mantenimiento
   - **Mitigación:** Consolidar en README principal

---

## 9. PRÓXIMOS PASOS RECOMENDADOS

### Paso 1: Aclaración de Requerimientos
**Objetivo:** Confirmar estado de funcionalidades críticas mencionadas

**Acciones:**
- Validar si "historial por día, agrupación por usuario/operación, duración por operación" existen
- Si no existen: ¿Son requerimientos nuevos?
- Si existen: ¿Dónde están implementadas?

**Prioridad:** 🔴 CRÍTICA (antes de cualquier cambio)

### Paso 2: Inventario de Contratos (si Paso 1 resuelto)
**Objetivo:** Documentar todos los contratos API y formatos de datos

**Acciones:**
- Documentar schemas de respuestas API
- Documentar formato exacto de export Excel (columnas, tipos, orden)
- Documentar estructura de movimientos históricos
- Crear tipos TypeScript compartidos (si aplica)

**Prioridad:** ⚠️ ALTA

### Paso 3: Tests Mínimos de Regresión
**Objetivo:** Crear safety net antes de refactorizaciones

**Acciones:**
- Tests unitarios para: historialService, exportService
- Tests de integración para: rutas críticas (/api/history, /api/reports/excel)
- Snapshot tests para: formato Excel exportado

**Prioridad:** ⚠️ ALTA

### Paso 4: Primer Micro-Mejora Incremental
**Objetivo:** Mejora pequeña y segura que demuestre metodología

**Candidatos seguros:**
- Añadir validación de esquemas (Zod) en rutas críticas sin cambiar lógica
- Mejorar logging estructurado (añadir correlationId)
- Documentar contratos existentes (sin cambiar código)

**Prioridad:** 🟢 MEDIA

---

## 10. PREGUNTAS PENDIENTES

1. **Funcionalidades críticas:** ¿Dónde están implementadas "historial por día, agrupación por usuario/operación, duración por operación"?
2. **Event Log:** ¿Se desea implementar event log como fuente de verdad (según estándar Gemelo Digital del prompt)?
3. **Testing:** ¿Existe infraestructura de testing o debemos crear desde cero?
4. **Frontend xlsx:** ¿Se usa `xlsx` en frontend o solo exceljs en backend?
5. **Usuarios/Operaciones:** ¿Existe modelo de usuarios/operaciones en Odoo o debe crearse?

---

**Estado:** ✅ DESCUBRIMIENTO COMPLETO  
**Siguiente Paso:** Aclarar requerimientos críticos antes de propuesta de implementación

