# 🔧 Corrección del Error "Unknown XML-RPC tag 'TITLE'"

## Problema Detectado

En los logs aparecían múltiples errores:
- `Error obteniendo ventas: Unknown XML-RPC tag 'TITLE'`
- `⚠️  Error en lote de productos X: Unknown XML-RPC tag 'TITLE'`
- `⚠️  Error en lote de templates X: Unknown XML-RPC tag 'TITLE'`

## Causa

El error "Unknown XML-RPC tag 'TITLE'" ocurre cuando Odoo devuelve datos que el cliente XML-RPC no puede parsear correctamente. Esto puede suceder cuando:

1. **Campos many2one complejos**: El campo `name` en `product.supplierinfo` es un many2one a `res.partner` que puede contener datos complejos que causan problemas de parsing.
2. **Consultas masivas**: Consultas con demasiados productos (19618) de una vez pueden causar problemas.
3. **Campos con datos HTML o caracteres especiales**: Algunos campos pueden contener datos que no se serializan bien en XML-RPC.

## Soluciones Implementadas

### 1. Eliminación del campo `name` en supplierinfo

**Antes:**
```javascript
{ fields: ['product_tmpl_id', 'price', 'currency_id', 'name', 'sequence'] }
```

**Después:**
```javascript
{ fields: ['product_tmpl_id', 'price', 'currency_id', 'sequence'] }
```

El campo `name` (proveedor) no es necesario para obtener el coste, solo necesitamos `price`, `currency_id` y `sequence`.

### 2. Optimización de `fetchSalesVelocity`

**Antes:** Consulta única con todos los productos (19618)

**Después:** Procesamiento en lotes de 1000 productos

```javascript
async function fetchSalesVelocity(uid, productIds) {
  // Procesar en lotes de 1000
  const VELOCITY_BATCH_SIZE = 1000;
  for (let i = 0; i < productIds.length; i += VELOCITY_BATCH_SIZE) {
    const batch = productIds.slice(i, i + VELOCITY_BATCH_SIZE);
    // ... procesar lote
  }
}
```

### 3. Optimización de `calculateOrphanABC`

**Antes:** Consulta única con todos los productos huérfanos (5655)

**Después:** Procesamiento en lotes de 1000 productos

```javascript
const BATCH_SIZE_SALES = 1000;
for (let i = 0; i < orphanIds.length; i += BATCH_SIZE_SALES) {
  const batch = orphanIds.slice(i, i + BATCH_SIZE_SALES);
  // ... procesar lote
}
```

### 4. Mejor manejo de errores

- Si un lote falla, continúa con el siguiente
- Los errores se registran pero no detienen el proceso completo
- Validación de datos antes de procesarlos

## Resultados Esperados

- ✅ No más errores "Unknown XML-RPC tag 'TITLE'"
- ✅ Procesamiento más robusto y estable
- ✅ Mejor rendimiento al procesar en lotes
- ✅ Continuidad del proceso aunque falle un lote

## Verificación

Después de reiniciar el servidor, los logs deberían mostrar:
- ✅ Procesamiento por lotes sin errores XML-RPC
- ✅ Costes obtenidos correctamente desde supplierinfo
- ✅ Velocidad de ventas calculada correctamente
- ✅ Clasificación ABC funcionando correctamente

