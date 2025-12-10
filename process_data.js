import fs from 'fs';
import path from 'path';
import readline from 'readline';

// Función para convertir CSV a JSON usando streams
function csvToJSON(filePath) {
  return new Promise((resolve, reject) => {
    const result = [];
    const fileStream = fs.createReadStream(filePath, { encoding: 'latin1' });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let headers;
    let locationIndex, packageIndex, surtidoIndex, qtyIndex, reservedIndex, productCodeIndex;

    rl.on('line', (line) => {
      if (!line.trim()) return;

      if (!headers) {
        headers = line.split(';').map(h => h.trim());
        locationIndex = headers.indexOf('Ubicación');
        packageIndex = headers.indexOf('Paquete');
        surtidoIndex = headers.indexOf('Surtido');
        qtyIndex = headers.indexOf('Cantidad inventariada');
        reservedIndex = headers.indexOf('Reserved Quantity');
        productCodeIndex = headers.indexOf('Producto');

        if (locationIndex === -1 || packageIndex === -1 || surtidoIndex === -1) {
          console.error('Faltan columnas esenciales en el CSV. Verifica que existan "Ubicacion", "Paquete" y "Surtido".');
          console.error('Encabezados encontrados:', headers.join(', '));
          rl.close();
          fileStream.destroy();
          return reject(new Error('Faltan columnas esenciales en el CSV.'));
        }
        return;
      }

      const currentline = line.split(';');
      const obj = {
        location_id: currentline[locationIndex]?.trim(),
        packageId: currentline[packageIndex]?.trim(),
        surtido: currentline[surtidoIndex]?.trim(),
        qty: parseFloat(currentline[qtyIndex]?.replace(',', '.') || '0'),
        reservedQty: parseFloat(currentline[reservedIndex]?.replace(',', '.') || '0'),
        productCode: currentline[productCodeIndex]?.trim()
      };

      if (obj.location_id && obj.packageId) {
        result.push(obj);
      }
    });

    rl.on('close', () => {
      resolve(result);
    });

    rl.on('error', (err) => {
      reject(err);
    });
  });
}


// --- SCRIPT PRINCIPAL ---

async function main() {
  // 1. Leer el archivo CSV de datos de stock
  const csvPath = path.resolve('..', 'Downloads', 'Quants (stock.quant) (35).csv');
  let stockData;
  try {
    stockData = await csvToJSON(csvPath);
  } catch (error) {
    console.error(`Error al leer o procesar el archivo CSV en ${csvPath}:`, error);
    process.exit(1); // Salir si no se pueden cargar los datos
  }


  // 2. Agrupar paquetes por ubicación
  const packagesByLocation = {};
  for (const item of stockData) {
    if (!item.location_id) continue;

    if (!packagesByLocation[item.location_id]) {
      packagesByLocation[item.location_id] = [];
    }
    packagesByLocation[item.location_id].push({
      packageId: item.packageId,
      surtido: item.surtido,
      qty: item.qty,
      reservedQty: item.reservedQty,
      productCode: item.productCode,
    });
  }

  // 3. Leer el `locations.json` original para obtener la estructura base del almacén
  const baseLocationsPath = path.resolve('data', 'locations.json');
  let finalLocations = [];
  try {
    const locationsFile = fs.readFileSync(baseLocationsPath, 'utf8');
    finalLocations = JSON.parse(locationsFile);
  } catch (error) {
    console.error(`No se pudo leer el archivo base de ubicaciones en ${baseLocationsPath}. Asegúrate de que exista y sea un JSON válido.`, error);
    // Si no existe, podríamos optar por crearlo desde cero, pero por ahora es un error.
    process.exit(1);
  }


  // 4. Enriquecer las ubicaciones con los datos de paquetes del CSV
  finalLocations.forEach(loc => {
    const packages = packagesByLocation[loc.id];
    if (packages) {
      loc.packages = packages;
      loc.totalStock = packages.reduce((sum, pkg) => sum + pkg.qty, 0);
      loc.totalReserved = packages.reduce((sum, pkg) => sum + pkg.reservedQty, 0);
      loc.sinDatos = false;

      // Actualizar el estado de la ubicación basado en el stock
      if (loc.totalStock > 0) {
        loc.status = 'OCCUPIED';
      } else {
        loc.status = 'FREE';
      }
    } else {
      // No hay datos para esta ubicación en el CSV
      loc.packages = [];
      loc.totalStock = 0;
      loc.totalReserved = 0;
      loc.sinDatos = true;
      loc.status = 'FREE'; // O un nuevo estado 'NO_DATA' si se prefiere
    }
  });


  // 5. Guardar el nuevo archivo `locations.json` enriquecido
  const outputPath = path.resolve('data', 'locations.json');
  try {
    fs.writeFileSync(outputPath, JSON.stringify(finalLocations, null, 2));
    console.log(`'locations.json' actualizado con éxito en ${outputPath}. Se procesaron ${finalLocations.length} ubicaciones.`);
  } catch (error) {
    console.error(`Error al escribir el nuevo 'locations.json' en ${outputPath}:`, error);
  }
}

main();