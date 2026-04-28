# tools/ — Scripts auxiliares

> Movidos aquí desde la raíz del backend en la **Fase 3.C de la auditoría 2026-04-28**
> para separar el código de producción (server.js + src/) de los scripts one-off.

Ninguno de estos scripts se importa desde `server.js` ni desde `src/`. Se ejecutan
manualmente para diagnóstico, mantenimiento o auditorías puntuales.

## Cómo ejecutar

Desde la raíz del backend (`warehouse-backend-git/`):

```bash
node tools/<script>.js
# o para .mjs:
node tools/<script>.mjs
```

Necesitas tener las variables de entorno configuradas (`.env` con `ODOO_URL`,
`ODOO_DATABASE`, `ODOO_USERNAME`, `ODOO_PASSWORD`).

## Inventario

### Diagnóstico (read-only — solo consultan datos)

| Script | Propósito |
|--------|-----------|
| `diagnose.js` | Diagnóstico genérico de conexión Odoo |
| `diagnose_abc.js` | Verificar clasificación ABC de productos |
| `diagnose_brand_mix.js` | Mix de marcas en almacén |
| `diagnose_inventory.js` | Estado general del inventario |
| `diagnose_rules.js` | Test de reglas de negocio |
| `diagnose_seasons.js` | Análisis por temporada (I/V25, I/V26) |
| `diagnostic_costes_variantes.js` | Diagnóstico de costes por variantes |
| `analyze_icc_data.js` | Validar fórmula ICC con datos reales |
| `analyze_single_product.js` | Inspeccionar 1 producto en profundidad |
| `analyze_zombie_stock.js` | Detectar stock antiguo sin movimiento |
| `audit_brands.js` | Análisis ABC por marca (BLACK/GOLD/WHITE) |
| `explore_product_season.js` | Exploración de productos por temporada |
| `explore_seasons.js` | Exploración profunda de temporadas |
| `query_b2b.js` | Consultar ubicaciones B2B |
| `search_tool.js` | Búsqueda en almacén |
| `odoo_cost_audit_b2c.js` | Auditoría de costes B2C (genera XLSX) |

### Mantenimiento (modifican datos — usar con cuidado)

| Script | Propósito |
|--------|-----------|
| `fix_costes_optimizado.js` | Recalcular costes de variantes (optimizado) |
| `fix_costes_variantes_optimizado.js` | Idem con lotes pequeños |
| `generate_b2b_from_odoo.js` | Sincronizar ubicaciones B2B desde Odoo |
| `generate_b2b_locations.js` | Generar `data/locations.json` con B2B (one-off) |
| `reporte_variantes_costes.js` | Generar Excel de variantes con costes |
| `process_data.js` | Procesamiento de datos (ad-hoc) |
| `fusion_locations.mjs` | Fusionar locations.json con datos externos |
| `ubicaciones.mjs` | Extraer ubicaciones de Odoo (genera CSV/JSON) |

### Tests ad-hoc

| Script | Propósito |
|--------|-----------|
| `test_antiguedad.mjs` | Test de antigüedad de paquetes (1 caso) |
| `test_antiguedad_masivo.mjs` | Test masivo de antigüedad |
| `test_movements.js` | Test de movimientos de stock |
| `test_variant_report.js` | Test del reporte de variantes |

## Notas de seguridad

Todos los scripts ahora leen credenciales **exclusivamente de variables de entorno**
(Fase 0 de la auditoría). Si se encuentra alguno con credenciales hardcodeadas,
hay que rotarlas y migrarlo.

## Excluido del build de producción

Para evitar que los scripts viajen al contenedor Docker en producción, conviene
añadir `tools/` a `.dockerignore` (no se ha hecho automáticamente para no
introducir un cambio de infraestructura sin aviso).
