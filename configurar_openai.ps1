# Script para añadir OPENAI_API_KEY al archivo .env
# Uso:
#   $env:OPENAI_API_KEY = "sk-..."; .\configurar_openai.ps1
# O bien pasa la key como argumento:
#   .\configurar_openai.ps1 -OpenAIKey "sk-..."

param(
    [string]$OpenAIKey = $env:OPENAI_API_KEY
)

$envFile = ".env"

if (-not $OpenAIKey) {
    Write-Host "❌ Error: No se proporcionó la API key." -ForegroundColor Red
    Write-Host "   Opciones:" -ForegroundColor Yellow
    Write-Host "     a) Define la variable de entorno: `$env:OPENAI_API_KEY = 'sk-...'" -ForegroundColor Yellow
    Write-Host "     b) Pásala como argumento: .\configurar_openai.ps1 -OpenAIKey 'sk-...'" -ForegroundColor Yellow
    exit 1
}

Write-Host "🔧 Configurando OPENAI_API_KEY..." -ForegroundColor Cyan

if (Test-Path $envFile) {
    $content = Get-Content $envFile -Raw

    if ($content -match "OPENAI_API_KEY=") {
        Write-Host "⚠️  OPENAI_API_KEY ya existe en .env, actualizando..." -ForegroundColor Yellow
        $content = $content -replace "OPENAI_API_KEY=.*", "OPENAI_API_KEY=$OpenAIKey"
    } else {
        Write-Host "✅ Añadiendo OPENAI_API_KEY..." -ForegroundColor Green
        if ($content -match "(SERVER_HOST=.*)") {
            $content = $content -replace "(SERVER_HOST=.*\r?\n)", "`$1`r`n# OPENAI (INTELIGENCIA ARTIFICIAL - CHATGPT GPT-4o)`r`nOPENAI_API_KEY=$OpenAIKey`r`n`r`n"
        } else {
            $content = "# OPENAI (INTELIGENCIA ARTIFICIAL - CHATGPT GPT-4o)`r`nOPENAI_API_KEY=$OpenAIKey`r`n`r`n$content"
        }
    }

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
