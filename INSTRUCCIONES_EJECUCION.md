# 🚀 INSTRUCCIONES PARA EJECUTAR EL FRONTEND

## ✅ **ESTADO ACTUAL**

El frontend está configurado para ejecutarse. Sigue estos pasos:

---

## 📋 **PASOS PARA EJECUTAR**

### **1. Frontend (React + Vite)**

```powershell
# Navegar al directorio del frontend
cd C:\Users\j.bernabe\warehouse-frontend

# Instalar dependencias (si no están instaladas)
npm install

# Ejecutar servidor de desarrollo
npm run dev
```

**El frontend se ejecutará en:**
- **URL Local:** `http://localhost:5173`
- **URL Red:** `http://[TU_IP]:5173` (accesible desde otros dispositivos)

---

### **2. Backend (Node.js + Express)**

**En otra terminal PowerShell:**

```powershell
# Navegar al directorio del backend
cd C:\Users\j.bernabe\warehouse-backend

# Instalar dependencias (si no están instaladas)
npm install

# Ejecutar servidor
npm start
```

**El backend se ejecutará en:**
- **URL:** `http://localhost:4000`

---

## 🔧 **CONFIGURACIÓN**

### **Variables de Entorno del Frontend**

El frontend busca la URL del backend en:
- **Archivo:** `.env` (en `warehouse-frontend/`)
- **Variable:** `VITE_API_URL=http://localhost:4000`

Si no existe el archivo `.env`, el frontend usará `http://localhost:4000` por defecto.

### **Variables de Entorno del Backend**

El backend necesita un archivo `.env` con:
- Credenciales de Odoo
- API keys de Anthropic
- Configuración del servidor

---

## 🌐 **ACCESO**

Una vez que ambos servidores estén corriendo:

1. **Abre tu navegador**
2. **Ve a:** `http://localhost:5173`
3. **Verás el Gemelo Digital en acción**

---

## 📱 **FUNCIONALIDADES DISPONIBLES**

### **Vistas Principales:**

1. **Mapa y Datos** (Vista por defecto)
   - Mapa de calor interactivo
   - Filtros avanzados
   - Panel de detalles

2. **Dashboard Ejecutivo**
   - KPIs en tiempo real
   - Alertas activas
   - Resumen de riesgos

3. **Análisis Predictivo**
   - Riesgos de stock bajo
   - Stock muerto
   - Recomendaciones

4. **Zona Playa**
   - Cross-dock
   - Búsqueda de ubicaciones

5. **Análisis Avanzado**
   - Tendencias
   - Escenarios
   - Optimizaciones

6. **Análisis de Costos**
   - Rentabilidad
   - Costos por marca
   - ICC

7. **ICC Dashboard**
   - Inventory Carrying Cost
   - Análisis detallado

8. **Informes IA**
   - Análisis estratégico
   - Chat con IA
   - Reportes generados

---

## 🛠️ **SOLUCIÓN DE PROBLEMAS**

### **Frontend no carga:**
- Verifica que el puerto 5173 esté libre
- Revisa la consola del navegador (F12)
- Verifica que `npm install` se haya ejecutado correctamente

### **Backend no responde:**
- Verifica que el puerto 4000 esté libre
- Revisa el archivo `.env` del backend
- Verifica que Odoo esté accesible
- Revisa los logs del servidor

### **Error de conexión:**
- Verifica que ambos servidores estén corriendo
- Verifica la URL en `VITE_API_URL`
- Revisa CORS en el backend

### **Datos no aparecen:**
- Verifica la conexión con Odoo
- Revisa los logs del backend
- Verifica que `data/locations.json` exista

---

## 📊 **PUERTOS UTILIZADOS**

- **Frontend:** `5173` (Vite dev server)
- **Backend:** `4000` (Express server)
- **WebSocket:** `4000` (mismo puerto que backend)

---

## 🎯 **PRÓXIMOS PASOS**

Una vez que veas el frontend:

1. **Explora las diferentes vistas** usando las pestañas del navbar
2. **Prueba los filtros** en el mapa de calor
3. **Selecciona ubicaciones** para ver detalles
4. **Usa el Copilot IA** para hacer consultas
5. **Revisa el Dashboard Ejecutivo** para KPIs
6. **Explora el Análisis Predictivo** para ver riesgos

---

## ✅ **VERIFICACIÓN RÁPIDA**

```powershell
# Verificar que el frontend esté corriendo
netstat -ano | findstr ":5173"

# Verificar que el backend esté corriendo
netstat -ano | findstr ":4000"

# Ver procesos Node.js
Get-Process -Name node
```

---

**¡El frontend está listo para ejecutarse!** 🚀



