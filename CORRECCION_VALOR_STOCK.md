# Corrección del Valor del Stock

## Problema Identificado
El valor del stock bajó drásticamente de ~3 millones a ~40, indicando que muchos productos quedaron sin coste o con coste incorrecto.

## Cambios Realizados

### 1. Eliminación del Límite en `fetchSupplierInfo`
**Problema**: El límite `limit: TEMPLATE_BATCH_SIZE * 5` (1000 registros) estaba truncando los resultados de `supplierinfo`, causando que muchos productos no tuvieran coste desde `supplierinfo`.

**Solución**: Se eliminó el límite para obtener todos los registros de `supplierinfo`:
```javascript
// ANTES:
{ fields: ['product_tmpl_id', 'price', 'currency_id', 'sequence'], limit: TEMPLATE_BATCH_SIZE * 5 }

// DESPUÉS:
{ fields: ['product_tmpl_id', 'price', 'currency_id', 'sequence'] }
```

### 2. Mejora de la Lógica de Fallback
**Problema**: Si `supplierinfo` no estaba disponible, algunos productos podían quedar sin coste.

**Solución**: Se mejoró la lógica para asegurar que siempre se use `standard_price` como fallback cuando `supplierinfo` no esté disponible:
```javascript
// Ahora verifica explícitamente que supplierCostMap[p.id] > 0
if (supplierCostMap[p.id] && supplierCostMap[p.id] > 0) {
  const currency = currencyMap[p.id] || 'EUR';
  const rate = currencyRates[currency] || 1.0;
  productCost = supplierCostMap[p.id] * rate;
} else if (p.standard_price && p.standard_price > 0) {
  // standard_price ya está en EUR (moneda base de la compañía)
  productCost = p.standard_price;
} else {
  productCost = 0;
}
```

### 3. Agregado de Logging para Diagnóstico
Se agregaron logs para diagnosticar cuántos productos usan cada fuente de coste:
- Estadísticas después de obtener `supplierinfo`
- Estadísticas finales después de mapear todos los productos

## Nota sobre Conversión de Moneda
La conversión de moneda se mantiene usando multiplicación (`price * rate`), consistente con otros archivos del proyecto. Si el valor sigue siendo incorrecto después de estos cambios, será necesario revisar cómo Odoo almacena las tasas de cambio en `res.currency.rate`.

## Próximos Pasos
1. Reiniciar el servidor
2. Ejecutar la sincronización completa
3. Verificar los logs para ver las estadísticas de costes
4. Comparar el valor total del stock con el valor esperado (~3 millones)

