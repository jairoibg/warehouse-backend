# Script para añadir OPENAI_API_KEY al archivo .env
# Ejecutar: .\configurar_openai.ps1

$envFile = ".env"
$openaiKey = "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"

Write-Host "🔧 Configurando OPENAI_API_KEY..." -ForegroundColor Cyan

if (Test-Path $envFile) {
    $content = Get-Content $envFile -Raw
    
    # Verificar si ya existe OPENAI_API_KEY
    if ($content -match "OPENAI_API_KEY=") {
        Write-Host "⚠️  OPENAI_API_KEY ya existe en .env" -ForegroundColor Yellow
        Write-Host "   Actualizando el valor..." -ForegroundColor Yellow
        
        # Reemplazar la línea existente
        $content = $content -replace "OPENAI_API_KEY=.*", "OPENAI_API_KEY=$openaiKey"
    } else {
        Write-Host "✅ Añadiendo OPENAI_API_KEY..." -ForegroundColor Green
        
        # Añadir después de la sección de configuración del servidor
        if ($content -match "(SERVER_HOST=.*)") {
            $content = $content -replace "(SERVER_HOST=.*\r?\n)", "`$1`r`n# OPENAI (INTELIGENCIA ARTIFICIAL - CHATGPT GPT-4o)`r`nOPENAI_API_KEY=$openaiKey`r`n`r`n"
        } else {
            # Si no encuentra SERVER_HOST, añadir al principio
            $content = "# OPENAI (INTELIGENCIA ARTIFICIAL - CHATGPT GPT-4o)`r`nOPENAI_API_KEY=$openaiKey`r`n`r`n$content"
        }
    }
    
    # Guardar el archivo
    Set-Content -Path $envFile -Value $content -NoNewline
    Write-Host "✅ OPENAI_API_KEY configurada correctamente!" -ForegroundColor Green
    Write-Host ""
    Write-Host "🔄 AHORA DEBES REINICIAR EL SERVIDOR:" -ForegroundColor Yellow
    Write-Host "   1. Detén el servidor (Ctrl+C)" -ForegroundColor Yellow
    Write-Host "   2. Ejecuta: npm start" -ForegroundColor Yellow
} else {
    Write-Host "❌ Error: No se encontró el archivo .env" -ForegroundColor Red
    Write-Host "   El archivo .env debe existir en: $PWD\$envFile" -ForegroundColor Red
    exit 1
}

