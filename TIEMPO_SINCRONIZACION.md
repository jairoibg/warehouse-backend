# ⏱️ Tiempo Estimado de Sincronización

## Datos a Procesar

- **Stock (quants):** ~124,508 registros
- **Productos únicos:** ~19,618 productos
- **Templates únicos:** ~10,000 templates

## Desglose de Tiempo

### 1. Descarga de Stock (`fetchAllStock`)
- **Lotes:** 124,508 ÷ 5,000 = ~25 lotes
- **Tiempo por lote:** 2-3 segundos
- **Total:** ~1-2 minutos

### 2. Procesamiento Paralelo (Promise.all)

Las siguientes 4 operaciones se ejecutan en paralelo:

#### a) `fetchProductDetails`
- **Lotes:** 19,618 ÷ 500 = ~40 lotes
- **Tiempo por lote:** 0.5-1 segundo + 50ms pausa
- **Total:** ~20-40 segundos

#### b) `fetchABCData`
- **Consulta única:** Todos los productos
- **Total:** ~5-10 segundos

#### c) `fetchSalesVelocity`
- **Lotes:** 19,618 ÷ 1,000 = ~20 lotes
- **Tiempo por lote:** 1-2 segundos + 100ms pausa
- **Total:** ~20-40 segundos

#### d) `fetchSupplierInfo`
- **Productos:** 19,618 ÷ 500 = ~40 lotes
- **Templates:** ~10,000 ÷ 200 = ~50 lotes
- **Tiempo por lote:** 0.5-1 segundo + 50ms pausa
- **Total:** ~45-90 segundos

**Tiempo máximo (paralelo):** ~1-2 minutos (la más lenta)

### 3. Procesamiento Secuencial

#### Tasas de Cambio
- **Monedas únicas:** Generalmente 0-3 monedas
- **Tiempo:** ~5-10 segundos

#### Cálculo ABC Huérfanos (`calculateOrphanABC`)
- **Productos huérfanos:** ~5,655 productos
- **Lotes:** 5,655 ÷ 1,000 = ~6 lotes
- **Tiempo:** ~30-60 segundos

#### Mapeo y Guardado
- **Agrupación por clave única:** ~10-15 segundos
- **Actualización de ubicaciones:** ~5-10 segundos
- **Guardado en JSON:** ~2-5 segundos
- **Total:** ~10-20 segundos

## ⏱️ Tiempo Total Estimado

**Optimista:** ~2-3 minutos
**Realista:** ~3-5 minutos
**Pesimista (con errores/retry):** ~5-8 minutos

## 📊 Factores que Afectan el Tiempo

1. **Velocidad de conexión con Odoo**
2. **Carga del servidor Odoo**
3. **Número de productos sin clasificación ABC** (requiere cálculo adicional)
4. **Errores temporales** (causan retry y aumentan el tiempo)

## ✅ Indicadores de Progreso

Durante la sincronización, los logs mostrarán:
- `⏳ Iniciando descarga de stock...` → Progreso de descarga
- `🧬 Cruzando datos para X productos...` → Inicio de procesamiento paralelo
- `💰 [COSTES] Costes desde supplierinfo: X productos` → Progreso de costes
- `📊 [ABC] Procesando...` → Progreso de clasificación ABC
- `🚑 [MACD] Calculando ABC para X productos huérfanos...` → Cálculo adicional
- `✅ Sync Completo` → Finalización

## 🔍 Monitoreo

Para ver el progreso en tiempo real, revisa los logs del servidor. Si el proceso tarda más de 10 minutos, podría haber un problema que requiere revisión.

