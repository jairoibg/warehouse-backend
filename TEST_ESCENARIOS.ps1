# Script de prueba para escenarios
Write-Host "=== PRUEBA DE ESCENARIOS ===" -ForegroundColor Cyan

# Prueba 1: Aumento de ventas
Write-Host "`n1. Probando Aumento de Ventas..." -ForegroundColor Yellow
try {
    $body = @{percentage=20; days=30} | ConvertTo-Json
    $result = Invoke-RestMethod -Uri "http://localhost:4000/api/advanced/scenarios/sales-increase" -Method POST -Body $body -ContentType "application/json" -ErrorAction Stop
    Write-Host "✅ ÉXITO - Aumento de Ventas" -ForegroundColor Green
    Write-Host "   Escenario: $($result.scenario)"
    Write-Host "   Productos totales: $($result.totalProducts)"
    Write-Host "   En riesgo: $($result.atRisk)"
} catch {
    Write-Host "❌ ERROR - Aumento de Ventas" -ForegroundColor Red
    Write-Host "   $($_.Exception.Message)"
    if ($_.ErrorDetails) {
        Write-Host "   $($_.ErrorDetails.Message)"
    }
}

# Prueba 2: Reducción de inventario
Write-Host "`n2. Probando Reducción de Inventario..." -ForegroundColor Yellow
try {
    $body = @{percentage=10} | ConvertTo-Json
    $result = Invoke-RestMethod -Uri "http://localhost:4000/api/advanced/scenarios/inventory-reduction" -Method POST -Body $body -ContentType "application/json" -ErrorAction Stop
    Write-Host "✅ ÉXITO - Reducción de Inventario" -ForegroundColor Green
    Write-Host "   Escenario: $($result.scenario)"
    Write-Host "   Ahorro mensual: €$($result.monthlySavings)"
    Write-Host "   Ahorro anual: €$($result.annualSavings)"
} catch {
    Write-Host "❌ ERROR - Reducción de Inventario" -ForegroundColor Red
    Write-Host "   $($_.Exception.Message)"
    if ($_.ErrorDetails) {
        Write-Host "   $($_.ErrorDetails.Message)"
    }
}

# Prueba 3: Optimización de espacio
Write-Host "`n3. Probando Optimización de Espacio..." -ForegroundColor Yellow
try {
    $result = Invoke-RestMethod -Uri "http://localhost:4000/api/advanced/scenarios/space-optimization" -Method GET -ErrorAction Stop
    Write-Host "✅ ÉXITO - Optimización de Espacio" -ForegroundColor Green
    Write-Host "   Escenario: $($result.scenario)"
    Write-Host "   Ubicaciones liberadas: $($result.totalLocationsFreed)"
    Write-Host "   Ahorro mensual: €$($result.estimatedMonthlySavings)"
} catch {
    Write-Host "❌ ERROR - Optimización de Espacio" -ForegroundColor Red
    Write-Host "   $($_.Exception.Message)"
    if ($_.ErrorDetails) {
        Write-Host "   $($_.ErrorDetails.Message)"
    }
}

Write-Host "`n=== FIN DE PRUEBAS ===" -ForegroundColor Cyan



